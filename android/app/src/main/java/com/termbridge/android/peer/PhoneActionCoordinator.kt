package com.termbridge.android.peer

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.CancellationSignal
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.termbridge.android.R
import com.termbridge.android.brain.VoiceAppVisibility
import java.util.concurrent.Executors
import java.util.concurrent.ConcurrentHashMap

object PhoneActionCoordinator {
    fun submit(context: Context, args: Map<String, Any?>): PhoneActionResult {
        val appContext = context.applicationContext
        val request = PhoneActionRequest.fromArgs(args)
        val store = PhoneActionStore(appContext)
        store.result(request.actionId)?.let { return it }
        val isNew = store.save(request)
        if (!isNew) return pendingResult(appContext, request)
        when (PhoneActionPolicyStore(appContext).decision(request)) {
            PhoneActionAuthorizationDecision.DENY -> return finishImmediate(
                appContext,
                request,
                PhoneActionResult(
                    request.actionId,
                    request.action,
                    "denied",
                    appContext.getString(R.string.phone_action_policy_denied),
                ),
            )
            PhoneActionAuthorizationDecision.ALLOW -> return executeWithoutApproval(appContext, request)
            PhoneActionAuthorizationDecision.REQUIRE_APPROVAL -> Unit
        }
        val pending = pendingResult(appContext, request)
        PhoneActionNotifier.show(appContext, request)
        if (VoiceAppVisibility.isForeground() ||
            (request.action == "screen.capture" && com.termbridge.android.brain.VoiceCallUiState.current().overlayVisible)) {
            Handler(Looper.getMainLooper()).post { PhoneActionActivity.open(appContext, request.actionId) }
        }
        return pending
    }

    /** Read-only recovery path for an approval result whose push event was lost during reconnect. */
    fun status(context: Context, args: Map<String, Any?>): PhoneActionResult {
        val actionId = (args["actionId"] as? String)
            ?.trim()
            ?.takeIf { it.isNotEmpty() && it.length <= 128 }
            ?: error("missing actionId")
        val appContext = context.applicationContext
        val store = PhoneActionStore(appContext)
        store.result(actionId)?.let { return it }
        return store.load(actionId)?.let { pendingResult(appContext, it) }
            ?: error("unknown phone action")
    }

    /** Cancels only reversible pending approval/picker work; completed native mutations are never faked as undone. */
    fun cancel(context: Context, args: Map<String, Any?>): PhoneActionResult {
        val actionId = (args["actionId"] as? String)?.trim()?.takeIf { it.isNotEmpty() && it.length <= 128 }
            ?: error("missing actionId")
        val appContext = context.applicationContext
        val store = PhoneActionStore(appContext)
        val existing = store.result(actionId)
        if (existing?.state == "running") {
            val cancel = runningCancellations.remove(actionId)
                ?: error("phone action is not cancellable after native execution started")
            cancel()
        } else if (existing != null && existing.state != "awaiting_user") {
            error("phone action is not cancellable after state ${existing.state}")
        }
        val request = store.load(actionId) ?: error("phone action is not pending or no longer exists")
        val result = PhoneActionResult(actionId, request.action, "cancelled", "已取消手机操作")
        store.complete(result)
        PhoneActionOutbox.enqueue(
            appContext,
            PhoneActionEvent.create(request, AndroidPeerIdentity.deviceId(appContext), result.state, result.summary),
        )
        PhoneActionNotifier.dismiss(appContext, actionId)
        return result
    }

    private fun pendingResult(context: Context, request: PhoneActionRequest) = PhoneActionResult(
        request.actionId,
        request.action,
        "awaiting_user",
        if (request.action == "photo.edit") {
            context.getString(R.string.phone_action_photo_edit)
        } else {
            context.getString(R.string.phone_action_notification_detail, phoneActionLabel(context, request.action))
        },
    )

    private fun executeWithoutApproval(context: Context, request: PhoneActionRequest): PhoneActionResult = when {
        request.action.startsWith("calendar.") -> {
            val missing = calendarPermissions(request).filter {
                ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
            }
            if (missing.isNotEmpty()) {
                finishImmediate(context, request, PhoneActionResult(
                    request.actionId,
                    request.action,
                    "denied",
                    context.getString(R.string.phone_action_calendar_permission_settings),
                    mapOf("missingPermissions" to missing),
                ))
            } else {
                val cancellation = if (request.action == "calendar.list") CancellationSignal() else null
                executeAsync(
                    context,
                    request,
                    cancellation?.let { signal -> { signal.cancel() } },
                ) { PhoneCalendarActions.execute(context, request, cancellation) }
            }
        }
        request.action.startsWith("todo.") -> executeAsync(context, request) {
            PhoneTodoStore(context).execute(request)
        }
        request.action == "photo.count" || request.action == "photo.fetch" -> {
            val cancellation = CancellationSignal()
            executeAsync(context, request, { cancellation.cancel() }) {
                PhonePhotoLibrary(context).execute(request, cancellation)
            }
        }
        request.action == "call.speaker.set" -> runCatching { PhoneSpeakerAction.execute(context, request) }
            .fold(
                { finishImmediate(context, request, it) },
                { finishImmediate(context, request, failedResult(context, request, it)) },
            )
        else -> {
            Handler(Looper.getMainLooper()).post {
                PhoneActionActivity.open(context, request.actionId, approvedByPolicy = true)
            }
            pendingResult(context, request)
        }
    }

    private fun executeAsync(
        context: Context,
        request: PhoneActionRequest,
        cancel: (() -> Unit)? = null,
        block: () -> PhoneActionResult,
    ): PhoneActionResult {
        val running = PhoneActionResult(
            request.actionId,
            request.action,
            "running",
            context.getString(R.string.phone_action_running, phoneActionLabel(context, request.action)),
        )
        PhoneActionStore(context).complete(running)
        PhoneActionOutbox.enqueue(
            context,
            PhoneActionEvent.create(
                request,
                AndroidPeerIdentity.deviceId(context),
                running.state,
                running.summary,
            ),
        )
        cancel?.let { runningCancellations[request.actionId] = it }
        actionExecutor.execute {
            try {
                runCatching(block).fold(
                    { finishImmediate(context, request, it) },
                    { finishImmediate(context, request, failedResult(context, request, it)) },
                )
            } finally {
                runningCancellations.remove(request.actionId)
            }
        }
        return running
    }

    private fun finishImmediate(
        context: Context,
        request: PhoneActionRequest,
        result: PhoneActionResult,
    ): PhoneActionResult {
        val store = PhoneActionStore(context)
        store.result(request.actionId)?.takeIf { it.state == "cancelled" && result.state != "cancelled" }?.let {
            return it
        }
        store.complete(result)
        PhoneActionOutbox.enqueue(
            context,
            PhoneActionEvent.create(
                request,
                AndroidPeerIdentity.deviceId(context),
                result.state,
                result.summary,
                result.data,
                (result.data["error"] as? String),
            ),
        )
        return result
    }

    private fun failedResult(context: Context, request: PhoneActionRequest, error: Throwable) = PhoneActionResult(
        request.actionId,
        request.action,
        "failed",
        context.getString(R.string.phone_action_failed),
        mapOf("error" to (error.message ?: error.javaClass.simpleName).take(1_000)),
    )

    internal fun calendarPermissions(request: PhoneActionRequest): List<String> = buildList {
        add(Manifest.permission.READ_CALENDAR)
        if (request.action != "calendar.list") add(Manifest.permission.WRITE_CALENDAR)
    }

    private val actionExecutor = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "termbridge-phone-native-action").apply { isDaemon = true }
    }
    private val runningCancellations = ConcurrentHashMap<String, () -> Unit>()
}

object PhoneActionNotifier {
    private const val CHANNEL_ID = "phone_action_approval"

    fun show(context: Context, request: PhoneActionRequest) {
        createChannel(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return
        val intent = PhoneActionActivity.intent(context, request.actionId)
        val pending = PendingIntent.getActivity(
            context,
            request.actionId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val label = phoneActionLabel(context, request.action)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(R.string.phone_action_notification_title))
            .setContentText(context.getString(R.string.phone_action_notification_detail, label))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        NotificationManagerCompat.from(context).notify(request.actionId.hashCode(), notification)
    }

    fun dismiss(context: Context, actionId: String) {
        NotificationManagerCompat.from(context).cancel(actionId.hashCode())
    }

    private fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.phone_action_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ),
        )
    }
}

internal fun phoneActionLabel(context: Context, action: String): String = context.getString(
    when (action) {
        "alarm.create" -> R.string.phone_action_alarm_create
        "calendar.list" -> R.string.phone_action_calendar_list
        "calendar.create" -> R.string.phone_action_calendar_create
        "calendar.update" -> R.string.phone_action_calendar_update
        "calendar.delete" -> R.string.phone_action_calendar_delete
        "todo.list" -> R.string.phone_action_todo_list
        "todo.create" -> R.string.phone_action_todo_create
        "todo.update" -> R.string.phone_action_todo_update
        "todo.complete" -> R.string.phone_action_todo_complete
        "todo.delete" -> R.string.phone_action_todo_delete
        "photo.count" -> R.string.phone_action_photo_count
        "photo.fetch" -> R.string.phone_action_photo_fetch
        "photo.edit" -> R.string.phone_action_photo_edit
        "call.speaker.set" -> R.string.phone_action_speaker_set
        "screen.capture" -> R.string.voice_overlay_capture_screen
        else -> R.string.app_name
    },
)
