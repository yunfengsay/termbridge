package com.termbridge.android.notifications

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.TaskStackBuilder
import androidx.core.content.ContextCompat
import com.termbridge.android.MainActivity
import com.termbridge.android.R
import com.termbridge.android.TerminalActivity
import com.termbridge.android.brain.BrainActivity
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.peer.AndroidPeerIdentity
import com.termbridge.android.peer.PhoneActionOutbox
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.SessionInfo
import com.termbridge.android.watch.WatchGatewayService
import com.termbridge.android.watch.WatchNotificationPayload
import com.termbridge.android.watch.WatchWorkSnapshot
import com.termbridge.android.watch.ZeppBridgeAlert
import com.termbridge.android.watch.ZeppBridgeAlertStore
import com.termbridge.android.watch.ZeppBridgeStateStore
import com.termbridge.android.watch.ZeppBridgeTokenStore
import com.termbridge.android.watch.ZeppGlobalVoiceController
import com.termbridge.android.watch.ZeppLocalBridge
import com.termbridge.android.watch.VoiceUnavailableException
import com.termbridge.android.watch.ZeppWatchAction
import com.termbridge.android.watch.ZeppWatchActionController
import com.termbridge.android.watch.ZeppWatchActionSnapshot
import com.termbridge.android.watch.ZeppWatchActivity
import com.termbridge.android.watch.ZeppWatchActivityStore
import com.termbridge.android.watch.ZeppWatchPreferencesStore
import com.termbridge.android.watch.ZeppWatchSnoozeStore
import java.util.UUID

class AgentMonitorService : Service(), TermbridgeClient.Listener {
    private val handler = Handler(Looper.getMainLooper())
    private val completionTracker = AgentCompletionTracker()
    private val stateAlertTracker = AgentStateAlertTracker()
    private var client: TermbridgeClient? = null
    private var connectionGeneration = 0L
    private val notificationDetails = NotificationTranscriptReader(
        send = { fields -> client?.sendControl(*fields.map { it.key to it.value }.toTypedArray()) == true },
        scheduleTimeout = { expire ->
            val task = Runnable(expire)
            handler.postDelayed(task, 5_000L)
            val cancel: () -> Unit = { handler.removeCallbacks(task) }
            cancel
        },
        onContent = ::updateNotificationContent,
    )
    private var monitoredHostId = ""
    private var lastPublishedWorkIdentity = ""
    private var zeppBridge: ZeppLocalBridge? = null
    private var zeppVoice: ZeppGlobalVoiceController? = null
    private var zeppActions: ZeppWatchActionController? = null
    @Volatile private var hostReady = false
    private val poll = Runnable { client?.sendControl("t" to "session_list") }
    private val reconnect = Runnable { connect() }

    override fun onCreate() {
        super.onCreate()
        val settings = SettingsStore.load(this)
        ZeppBridgeStateStore.updateConnection(false, settings.displayName)
        ZeppBridgeStateStore.replaceAlerts(ZeppBridgeAlertStore.load(this))
        zeppVoice = ZeppGlobalVoiceController(
            context = this,
            isHostReady = { hostReady },
            sendControl = { fields -> client?.sendControl(*fields.toTypedArray()) == true },
            shouldConfirmBeforeSend = { ZeppWatchPreferencesStore.load(this).confirmVoiceBeforeSend },
            onReceipt = ::recordWatchVoiceReceipt,
        )
        zeppActions = ZeppWatchActionController(
            isHostReady = { hostReady },
            sendControl = { fields -> client?.sendControl(*fields.toTypedArray()) == true },
            onReceipt = ::recordWatchActionReceipt,
        )
        zeppBridge = ZeppLocalBridge(
            expectedToken = { ZeppBridgeTokenStore.getOrCreate(this) },
            currentSnapshot = ::watchSnapshot,
            submitVoice = { audio, sourceSessionId ->
                zeppVoice?.submit(audio, sourceSessionId) ?: error("Voice controller unavailable")
            },
            currentVoice = { id -> zeppVoice?.snapshot(id) },
            decideVoice = { id, decision -> zeppVoice?.decide(id, decision) },
            openSession = ::publishWatchHandoff,
            submitAction = ::submitWatchAction,
            currentAction = { id -> zeppActions?.snapshot(id) },
        ).also { it.start() }
        createChannels(this)
        startForeground(MONITOR_NOTIFICATION_ID, monitoringNotification())
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SWITCH_HOST -> {
                notificationDetails.clear()
                completionTracker.reset()
                stateAlertTracker.reset()
                lastPublishedWorkIdentity = ""
                client?.disconnect()
                client = null
                PhoneActionOutbox.detach()
                handler.removeCallbacksAndMessages(null)
                connect()
                val manager = getSystemService(NotificationManager::class.java)
                manager.notify(MONITOR_NOTIFICATION_ID, monitoringNotification())
            }
            ACTION_ZEPP_SNOOZE -> {
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID).orEmpty()
                if (sessionId.isNotBlank()) submitWatchAction(ZeppWatchAction.SNOOZE, sessionId)
                intent.getIntExtra(EXTRA_NOTIFICATION_ID, 0).takeIf { it != 0 }?.let {
                    NotificationManagerCompat.from(this).cancel(it)
                }
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        connectionGeneration++
        notificationDetails.clear()
        handler.removeCallbacksAndMessages(null)
        client?.disconnect()
        client = null
        hostReady = false
        PhoneActionOutbox.detach()
        zeppBridge?.close()
        zeppBridge = null
        zeppVoice?.close()
        zeppVoice = null
        zeppActions?.close()
        zeppActions = null
        ZeppBridgeStateStore.updateConnection(false, SettingsStore.load(this).displayName)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onConnectionState(state: ConnectionState) {
        val settings = SettingsStore.load(this)
        ZeppBridgeStateStore.updateConnection(state == ConnectionState.Connected, settings.displayName)
        if (state == ConnectionState.Disconnected || state is ConnectionState.Failed) {
            notificationDetails.clear()
            hostReady = false
            zeppVoice?.onHostUnavailable()
            zeppActions?.onHostUnavailable()
            PhoneActionOutbox.detach()
            if (!SettingsStore.load(this).connectionEnabled) return
            handler.removeCallbacks(reconnect)
            handler.postDelayed(reconnect, RECONNECT_DELAY_MS)
        }
    }

    override fun onReady(client: TermbridgeClient) {
        client.sendControl("t" to "desktop_subscribe", "deviceId" to com.termbridge.android.peer.AndroidPeerIdentity.deviceId(this), "foreground" to false)
        hostReady = true
        ZeppBridgeStateStore.updateConnection(true, SettingsStore.load(this).displayName)
        client.sendControl(
            "t" to "peer_register",
            "deviceId" to AndroidPeerIdentity.deviceId(this),
            "platform" to "android",
            "name" to AndroidPeerIdentity.displayName(),
            "role" to "manager",
            "capabilities" to listOf(
                "android.logcat.app",
                "android.logcat.system.optional",
                "artifact.apk.e2ee",
                "android.packageInstaller.userConfirmed",
                "phone.actions.alarm",
                "phone.actions.calendar",
                "phone.actions.status",
                "phone.actions.audio",
                "phone.actions.todo",
                "phone.photos.selected.multiple",
                "phone.asset.read.e2ee",
                "phone.photos.edited.publish.e2ee",
            ),
        )
        PhoneActionOutbox.attach(this) { fields ->
            client.sendControl(*fields.map { it.key to it.value }.toTypedArray())
        }
        client.sendControl("t" to "session_list")
    }

    override fun onControl(message: ControlMessage) {
        notificationDetails.accept(message)
        zeppVoice?.handle(message)
        zeppActions?.handle(message)
        when (message.type) {
            "desktop_attention" -> message.string("id")?.let { com.termbridge.android.desktop.DesktopAttention.notify(this, it, monitoredHostId) }
            "brain_text_result" -> notifyTextResult(message)
            "client_stream_policy_result" -> {
                handler.removeCallbacks(poll)
                if (message.boolean("background") != true) client?.sendControl("t" to "session_list")
            }
            "host_list_result" -> {
                message.string("selectedHostId")?.takeIf(String::isNotBlank)?.let { monitoredHostId = it }
            }
            "session_list_result" -> {
                val sessions = message.sessions()
                notificationDetails.retain(sessions)
                val settings = SettingsStore.load(this)
                ZeppBridgeStateStore.updateSessions(
                    connected = true,
                    host = settings.displayName,
                    sessions = sessions,
                )
                completionTracker.update(sessions).forEach(::notifyCompletion)
                stateAlertTracker.update(sessions).forEach(::notifyStateAlert)
                publishPriorityWork(sessions)
                handler.removeCallbacks(poll)
                if (client?.backgroundTrafficAcknowledged != true) {
                    handler.postDelayed(poll, WatchWorkSelector.pollIntervalMillis(sessions))
                }
            }
            "phone_action_event_ack" -> {
                message.string("eventId")?.takeIf(String::isNotBlank)?.let {
                    PhoneActionOutbox.acknowledge(this, it)
                }
            }
        }
    }

    override fun onPtyOutput(sid: Int, data: ByteArray) = Unit

    private fun connect() {
        handler.removeCallbacks(reconnect)
        notificationDetails.clear()
        val generation = ++connectionGeneration
        client?.disconnect()
        client = null
        hostReady = false
        PhoneActionOutbox.detach()
        val settings = SettingsStore.load(this)
        if (!settings.connectionEnabled) {
            stopSelf()
            return
        }
        monitoredHostId = settings.hostId
        // Socket callbacks originate on OkHttp threads. Serialize state, detail reads and lifecycle
        // on the main thread, and drop queued events from an old connection after a switch/exit.
        val listener = object : TermbridgeClient.Listener {
            override fun onConnectionState(state: ConnectionState) {
                handler.post { if (generation == connectionGeneration) this@AgentMonitorService.onConnectionState(state) }
            }
            override fun onReady(client: TermbridgeClient) {
                handler.post { if (generation == connectionGeneration) this@AgentMonitorService.onReady(client) }
            }
            override fun onControl(message: ControlMessage) {
                handler.post { if (generation == connectionGeneration) this@AgentMonitorService.onControl(message) }
            }
            override fun onPtyOutput(sid: Int, data: ByteArray) = Unit
        }
        client = TermbridgeClient(settings, listener, backgroundMonitor = true, context = this).also(TermbridgeClient::connect)
    }

    private fun updateNotificationContent(request: NotificationTranscriptReader.Request, content: AgentNotificationContent) {
        ExpandableNotification.updateIfCurrent(this, request.notificationId, request.token, content)
    }

    private fun notifyTextResult(message: ControlMessage) {
        if (com.termbridge.android.brain.VoiceAppVisibility.isForeground()) return
        val requestId = message.string("requestId") ?: return
        val status = getString(when (message.string("status")) {
                "failed" -> R.string.silent_failed
                "cancelled" -> R.string.silent_cancelled
                else -> R.string.silent_completed
            })
        val text = message.string("text").orEmpty().ifBlank { status }
        val notification = ExpandableNotification.apply(this, NotificationCompat.Builder(this, COMPLETION_CHANNEL_ID),
            AgentNotificationContent.title(text, status), text, status)
            .setSmallIcon(R.drawable.ic_notification)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(this, requestId.hashCode(),
                com.termbridge.android.brain.BrainActivity.intent(this),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .build()
        try { NotificationManagerCompat.from(this).notify(requestId.hashCode(), notification) }
        catch (_: SecurityException) { /* User can disable notifications; result remains in History. */ }
    }

    private fun monitoringNotification() = NotificationCompat.Builder(this, MONITOR_CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_notification)
        .setContentTitle(getString(R.string.monitoring_agents))
        .setContentText(getString(R.string.monitoring_host, SettingsStore.load(this).hostId.ifBlank { "Termbridge" }))
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .setOngoing(true)
        .setSilent(true)
        .build()

    private fun notifyCompletion(session: SessionInfo) {
        val settings = SettingsStore.load(this)
        val occurredAt = session.completedAt ?: System.currentTimeMillis()
        val payload = WatchNotificationPayload.fromSession(
            monitoredHostId.ifBlank { settings.hostId },
            session,
        )
        rememberZeppAlert(ZeppBridgeAlert.fromSession(session, "done", occurredAt))
        if (ZeppWatchPreferencesStore.load(this).allows("done") && !ZeppWatchSnoozeStore.isSnoozed(this, session.sessionId)) {
            val token = UUID.randomUUID().toString()
            publishCompletion(this, payload.copy(body = session.preview.orEmpty()), detailsToken = token)
            notificationDetails.enqueue(NotificationTranscriptReader.Request(token,
                CompletionNotificationRoute(payload.hostId, payload.sessionId).requestCode, session))
            WatchGatewayService.pushCompletion(this, payload)
        }
    }

    private fun notifyStateAlert(alert: AgentStateAlert) {
        val settings = SettingsStore.load(this)
        val hostId = monitoredHostId.ifBlank { settings.hostId }
        val zeppAlert = ZeppBridgeAlert.fromSession(alert.session, alert.status, alert.occurredAt)
        rememberZeppAlert(zeppAlert)
        if (ZeppWatchPreferencesStore.load(this).allows(alert.status) &&
            !ZeppWatchSnoozeStore.isSnoozed(this, alert.session.sessionId)
        ) {
            val token = UUID.randomUUID().toString()
            publishStateAlert(this, hostId, zeppAlert, alert.session.preview.orEmpty(), token)
            notificationDetails.enqueue(NotificationTranscriptReader.Request(token,
                "$hostId\u0000${alert.session.sessionId}\u0000${alert.status}".hashCode(), alert.session))
        }
    }

    private fun rememberZeppAlert(alert: ZeppBridgeAlert) {
        ZeppBridgeStateStore.replaceAlerts(ZeppBridgeAlertStore.append(this, alert))
    }

    private fun watchSnapshot() = ZeppBridgeStateStore.snapshot().let { snapshot ->
        snapshot.copy(alerts = snapshot.alerts.filterNot { ZeppWatchSnoozeStore.isSnoozed(this, it.sessionId) })
    }

    private fun submitWatchAction(action: ZeppWatchAction, sessionId: String): ZeppWatchActionSnapshot {
        val controller = zeppActions ?: throw VoiceUnavailableException("action_unavailable")
        if (action != ZeppWatchAction.SNOOZE) return controller.submit(action, sessionId)
        ZeppWatchSnoozeStore.snooze(this, sessionId, System.currentTimeMillis() + SNOOZE_MILLIS)
        val hostId = monitoredHostId.ifBlank { SettingsStore.load(this).hostId }
        NotificationManagerCompat.from(this).cancel(CompletionNotificationRoute(hostId, sessionId).requestCode)
        ZeppBridgeStateStore.snapshot().alerts.filter { it.sessionId == sessionId }.forEach { alert ->
            NotificationManagerCompat.from(this).cancel("$hostId\u0000${alert.sessionId}\u0000${alert.status}".hashCode())
        }
        return controller.recordLocal(action, sessionId, getString(R.string.watch_snoozed_receipt))
    }

    private fun recordWatchActionReceipt(snapshot: ZeppWatchActionSnapshot) {
        val title = ZeppBridgeStateStore.snapshot().agents.firstOrNull { it.sessionId == snapshot.sessionId }?.title
            ?: getString(R.string.app_name)
        ZeppWatchActivityStore.append(
            this,
            ZeppWatchActivity(
                kind = "action:${snapshot.action.wireName}",
                state = snapshot.state,
                title = title,
                summary = snapshot.summary.ifBlank { snapshot.error },
                sessionId = snapshot.sessionId,
                occurredAt = snapshot.updatedAt,
            ),
        )
    }

    private fun recordWatchVoiceReceipt(snapshot: com.termbridge.android.watch.ZeppVoiceSnapshot, sessionId: String?) {
        ZeppWatchActivityStore.append(
            this,
            ZeppWatchActivity(
                kind = "voice",
                state = snapshot.state,
                title = sessionId?.let { id -> ZeppBridgeStateStore.snapshot().agents.firstOrNull { it.sessionId == id }?.title }
                    ?: getString(R.string.watch_activity_global),
                summary = snapshot.reply.ifBlank { snapshot.error.ifBlank { snapshot.transcript } },
                sessionId = sessionId.orEmpty(),
                occurredAt = snapshot.updatedAt,
            ),
        )
    }

    private fun publishWatchHandoff(sessionId: String): Boolean {
        if (sessionId.isBlank()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        createChannels(this)
        val snapshot = ZeppBridgeStateStore.snapshot()
        val title = snapshot.alerts.firstOrNull { it.sessionId == sessionId }?.title
            ?: snapshot.agents.firstOrNull { it.sessionId == sessionId }?.title
            ?: getString(R.string.app_name)
        val contentIntent = TaskStackBuilder.create(this)
            .addNextIntentWithParentStack(BrainActivity.fromSessionIntent(this, sessionId))
            .getPendingIntent(
                "zepp-handoff:$sessionId".hashCode(),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ) ?: return false
        val notification = NotificationCompat.Builder(this, COMPLETION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.watch_handoff_title))
            .setContentText(getString(R.string.watch_handoff_detail, title))
            .setContentIntent(contentIntent)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        NotificationManagerCompat.from(this).notify("zepp-handoff:$sessionId".hashCode(), notification)
        return true
    }

    private fun publishPriorityWork(sessions: List<SessionInfo>) {
        val now = System.currentTimeMillis()
        val settings = SettingsStore.load(this)
        val hostId = monitoredHostId.ifBlank { settings.hostId }
        val snoozes = getSharedPreferences("watch_work", MODE_PRIVATE)
        val session = WatchWorkSelector.select(sessions) {
            snoozes.getLong("later:$hostId:${it.sessionId}", 0L) > now
        }
        if (session == null) {
            val identity = "$hostId\u0000clear"
            if (identity == lastPublishedWorkIdentity) return
            lastPublishedWorkIdentity = identity
            WatchGatewayService.pushWork(
                this,
                WatchWorkSnapshot(hostId, "", "", "", "idle", 0, now),
            )
            return
        }
        val status = session.status.orEmpty().ifBlank { "unknown" }
        val statusPriority = when (status.lowercase()) {
            "waiting", "approval", "blocked" -> 1
            "working", "running", "active" -> 2
            else -> 3
        }
        val identity = listOf(
            hostId, session.sessionId, status,
            session.completedAt ?: session.createdAt, session.preview.orEmpty(),
        ).joinToString("\u0000")
        if (identity == lastPublishedWorkIdentity) return
        lastPublishedWorkIdentity = identity
        WatchGatewayService.pushWork(
            this,
            WatchWorkSnapshot(
                hostId = hostId,
                sessionId = session.sessionId,
                title = session.displayName,
                summary = (session.preview ?: session.command).take(1_024),
                status = status,
                priority = statusPriority,
                updatedAt = session.completedAt ?: session.createdAt,
            ),
        )
    }

    companion object {
        private const val MONITOR_CHANNEL_ID = "agent_monitor"
        private const val COMPLETION_CHANNEL_ID = "agent_completion_v2"
        private const val ATTENTION_CHANNEL_ID = "agent_attention_v2"
        private const val FAILURE_CHANNEL_ID = "agent_failure_v2"
        private const val MONITOR_NOTIFICATION_ID = 41
        private const val RECONNECT_DELAY_MS = 5_000L
        private const val SNOOZE_MILLIS = 30 * 60_000L
        private const val ACTION_SWITCH_HOST = "com.termbridge.android.SWITCH_MONITOR_HOST"
        private const val ACTION_ZEPP_SNOOZE = "com.termbridge.android.ZEPP_SNOOZE"
        private const val EXTRA_SESSION_ID = "sessionId"
        private const val EXTRA_NOTIFICATION_ID = "notificationId"

        fun publishCompletion(
            context: Context,
            payload: WatchNotificationPayload,
            openImmediately: Boolean = false,
            detailsToken: String? = null,
        ) {
            createChannels(context)
            val route = CompletionNotificationRoute(payload.hostId, payload.sessionId)
            val host = hostLabel(context, route.hostId)
            // The view is chosen when this is clicked, not now: the default can
            // change between publishing a notification and opening it.
            val openSession = TerminalActivity.notificationIntent(
                context,
                payload.sessionId,
                payload.title,
                true,
                route.hostId,
            )
            val contentIntent = TaskStackBuilder.create(context)
                .addNextIntentWithParentStack(openSession)
                .getPendingIntent(
                    route.requestCode,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            if (openImmediately) runCatching { contentIntent?.send() }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) return
            val notification = ExpandableNotification.apply(context,
                NotificationCompat.Builder(context, COMPLETION_CHANNEL_ID), payload.title,
                payload.body.ifBlank { context.getString(R.string.notification_open_for_details) },
                "${context.getString(R.string.task_complete)} · $host")
                .setSmallIcon(R.drawable.ic_notification)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .addExtras(Bundle().apply { putString(ExpandableNotification.DETAILS_TOKEN, detailsToken) })
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .addAction(
                    0,
                    context.getString(R.string.watch_action_snooze),
                    snoozeIntent(context, payload.sessionId, route.requestCode),
                )
                .addAction(
                    0,
                    context.getString(R.string.watch_handoff_open_global),
                    globalIntent(context, payload.sessionId, route.requestCode),
                )
                .build()
            NotificationManagerCompat.from(context).notify(route.requestCode, notification)
        }

        internal fun publishStateAlert(context: Context, hostId: String, alert: ZeppBridgeAlert,
                                      body: String = alert.summary, detailsToken: String? = null) {
            createChannels(context)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
            ) return
            val route = CompletionNotificationRoute(hostId, alert.sessionId)
            val openSession = TerminalActivity.notificationIntent(
                context,
                alert.sessionId,
                alert.title,
                true,
                route.hostId,
            )
            val contentIntent = TaskStackBuilder.create(context)
                .addNextIntentWithParentStack(openSession)
                .getPendingIntent(
                    route.requestCode,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
            val title = when (alert.status) {
                "waiting", "approval" -> context.getString(R.string.agent_attention_required)
                "blocked" -> context.getString(R.string.agent_blocked)
                else -> context.getString(R.string.agent_failed)
            }
            val host = hostLabel(context, hostId)
            val notificationId = "$hostId\u0000${alert.sessionId}\u0000${alert.status}".hashCode()
            val channelId = if (alert.status == "failed" || alert.status == "error") {
                FAILURE_CHANNEL_ID
            } else {
                ATTENTION_CHANNEL_ID
            }
            val notification = ExpandableNotification.apply(context,
                NotificationCompat.Builder(context, channelId), alert.title,
                body.ifBlank { context.getString(R.string.notification_open_for_details) }, "$title · $host")
                .setSmallIcon(R.drawable.ic_notification)
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .addExtras(Bundle().apply { putString(ExpandableNotification.DETAILS_TOKEN, detailsToken) })
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .addAction(
                    0,
                    context.getString(R.string.watch_action_snooze),
                    snoozeIntent(context, alert.sessionId, notificationId),
                )
                .addAction(
                    0,
                    context.getString(R.string.watch_handoff_open_global),
                    globalIntent(context, alert.sessionId, notificationId),
                )
                .build()
            NotificationManagerCompat.from(context).notify(notificationId, notification)
        }

        private fun hostLabel(context: Context, hostId: String): String =
            SettingsStore.profiles(context).firstOrNull { it.hostId == hostId }?.displayName
                ?: context.getString(R.string.notification_host)

        private fun snoozeIntent(context: Context, sessionId: String, notificationId: Int): PendingIntent {
            val intent = Intent(context, AgentMonitorService::class.java)
                .setAction(ACTION_ZEPP_SNOOZE)
                .putExtra(EXTRA_SESSION_ID, sessionId)
                .putExtra(EXTRA_NOTIFICATION_ID, notificationId)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) PendingIntent.getForegroundService(
                context,
                "zepp-snooze:$sessionId".hashCode(),
                intent,
                flags,
            ) else PendingIntent.getService(context, "zepp-snooze:$sessionId".hashCode(), intent, flags)
        }

        private fun globalIntent(context: Context, sessionId: String, notificationId: Int): PendingIntent =
            TaskStackBuilder.create(context)
                .addNextIntentWithParentStack(BrainActivity.fromSessionIntent(context, sessionId))
                .getPendingIntent(
                    "zepp-global:$sessionId:$notificationId".hashCode(),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )!!

        fun start(context: Context) {
            if (!SettingsStore.load(context).connectionEnabled) {
                stop(context)
                return
            }
            ContextCompat.startForegroundService(context, Intent(context, AgentMonitorService::class.java))
        }

        fun switchHost(context: Context) {
            if (!SettingsStore.load(context).connectionEnabled) {
                stop(context)
                return
            }
            ContextCompat.startForegroundService(
                context,
                Intent(context, AgentMonitorService::class.java).setAction(ACTION_SWITCH_HOST),
            )
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, AgentMonitorService::class.java))
        }

        fun createChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(
                    MONITOR_CHANNEL_ID,
                    context.getString(R.string.monitor_channel_name),
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    COMPLETION_CHANNEL_ID,
                    context.getString(R.string.completion_channel_name),
                    NotificationManager.IMPORTANCE_DEFAULT,
                ).apply {
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 140)
                },
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    ATTENTION_CHANNEL_ID,
                    context.getString(R.string.watch_attention_channel_name),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 220, 100, 220)
                },
            )
            manager.createNotificationChannel(
                NotificationChannel(
                    FAILURE_CHANNEL_ID,
                    context.getString(R.string.watch_failure_channel_name),
                    NotificationManager.IMPORTANCE_HIGH,
                ).apply {
                    enableVibration(true)
                    vibrationPattern = longArrayOf(0, 420, 120, 180)
                },
            )
        }
    }
}
