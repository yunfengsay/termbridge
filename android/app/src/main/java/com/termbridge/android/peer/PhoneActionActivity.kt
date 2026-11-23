package com.termbridge.android.peer

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.Gravity
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.termbridge.android.R
import java.util.concurrent.Executors

class PhoneActionActivity : AppCompatActivity() {
    private lateinit var request: PhoneActionRequest
    private var approvedByPolicy = false
    private var executionStarted = false
    private var resultFinished = false
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "termbridge-phone-action").apply { isDaemon = true }
    }
    private val photoPicker = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(PhoneActionRequest.MAX_PHOTO_SELECTION),
    ) { uris ->
        if (uris.isEmpty()) {
            finishDenied()
        } else {
            showProgress()
            worker.execute {
                runCatching {
                    PhoneSelectedAssetStore(this).import(request.actionId, uris, request.maxItems)
                }.onSuccess { assets ->
                    val result = PhoneActionResult(
                        request.actionId,
                        request.action,
                        "running",
                        "已选择 ${assets.size} 张照片，等待执行修改",
                        mapOf(
                            "selectedCount" to assets.size,
                            "instructions" to request.instructions,
                            "assets" to assets.map(PhoneSelectedAsset::toMap),
                        ),
                    )
                    runOnUiThread { finishWithResult(result) }
                }.onFailure { error ->
                    runOnUiThread { finishFailed(error) }
                }
            }
        }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val actionId = intent.getStringExtra(EXTRA_ACTION_ID).orEmpty()
        request = PhoneActionStore(this).load(actionId) ?: run {
            finish()
            return
        }
        approvedByPolicy = intent.getBooleanExtra(EXTRA_APPROVED_BY_POLICY, false)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (resultFinished || executionStarted) finish() else finishDenied()
            }
        })
        if (savedInstanceState == null) {
            if (approvedByPolicy) executeApproved() else showApproval()
        }
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    private fun showApproval() {
        val label = phoneActionLabel(this, request.action)
        val detail = if (request.action == "photo.edit") {
            getString(R.string.phone_action_photo_detail, request.maxItems, request.instructions.orEmpty())
        } else {
            getString(R.string.phone_action_detail, label, requestDetail())
        }
        setContentView(R.layout.activity_phone_action)
        findViewById<MaterialToolbar>(R.id.phoneActionToolbar).setNavigationOnClickListener { finishDenied() }
        findViewById<TextView>(R.id.phoneActionTitle).text = label
        findViewById<TextView>(R.id.phoneActionDetail).text = detail
        findViewById<MaterialButton>(R.id.phoneActionDeny).setOnClickListener { finishDenied() }
        findViewById<MaterialButton>(R.id.phoneActionApprove).setOnClickListener { executeApproved() }
    }

    private fun executeApproved() {
        if (executionStarted || resultFinished) return
        if (PhoneActionStore(this).result(request.actionId)?.state == "cancelled") {
            resultFinished = true
            finish()
            return
        }
        val policyStore = PhoneActionPolicyStore(this)
        if (!approvedByPolicy && policyStore.policy(request.action) == PhoneActionApprovalPolicy.DENY) {
            finishWithResult(PhoneActionResult(
                request.actionId,
                request.action,
                "denied",
                getString(R.string.phone_action_policy_denied),
            ))
            return
        }
        executionStarted = true
        if (!approvedByPolicy &&
            policyStore.policy(request.action) == PhoneActionApprovalPolicy.ONCE_PER_CONVERSATION) {
            policyStore.grantConversation(request)
        }
        when {
            request.action == "screen.capture" -> {
                runCatching {
                    startActivity(com.termbridge.android.brain.VoiceOverlayActionActivity.captureScreenIntent(this)
                        .putExtra(com.termbridge.android.brain.PhoneScreenCaptureReceipt.EXTRA_ACTION_ID, request.actionId))
                    finish() // Capture service owns the final durable receipt, not this approval Activity.
                }.onFailure(::finishFailed)
            }
            request.action == "photo.edit" -> photoPicker.launch(
                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly),
            )
            request.action == "alarm.create" -> {
                runCatching { startActivity(PhoneAlarmAction.createIntent(this, request)) }
                    .onSuccess {
                        finishWithResult(PhoneActionResult(
                            request.actionId,
                            request.action,
                            "completed",
                            "已打开系统闹钟确认页",
                            mapOf("scheduledAt" to request.scheduledAt),
                        ))
                    }
                    .onFailure(::finishFailed)
            }
            request.action.startsWith("calendar.") -> requestCalendarPermissions()
            request.action.startsWith("todo.") -> executeInBackground {
                PhoneTodoStore(this).execute(request)
            }
            request.action == "photo.count" || request.action == "photo.fetch" -> executeInBackground {
                PhonePhotoLibrary(this).execute(request)
            }
            request.action == "call.speaker.set" -> executeInBackground {
                PhoneSpeakerAction.execute(this, request)
            }
            else -> finishFailed(IllegalArgumentException("unsupported phone action"))
        }
    }

    private fun requestCalendarPermissions() {
        if (missingCalendarPermissions().isEmpty()) {
            executeCalendar()
        } else {
            finishWithResult(PhoneActionResult(
                request.actionId,
                request.action,
                "denied",
                getString(R.string.phone_action_calendar_permission_settings),
                mapOf("missingPermissions" to missingCalendarPermissions()),
            ))
        }
    }

    private fun calendarPermissions(): Array<String> =
        PhoneActionCoordinator.calendarPermissions(request).toTypedArray()

    private fun missingCalendarPermissions(): List<String> = calendarPermissions().filter {
        ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
    }

    private fun executeCalendar() = executeInBackground {
        PhoneCalendarActions.execute(this, request)
    }

    private fun executeInBackground(block: () -> PhoneActionResult) {
        showProgress()
        worker.execute {
            runCatching(block)
                .onSuccess { runOnUiThread { finishWithResult(it) } }
                .onFailure { runOnUiThread { finishFailed(it) } }
        }
    }

    private fun showProgress() {
        setContentView(FrameLayout(this).apply {
            addView(ProgressBar(context), FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            ))
        })
    }

    private fun requestDetail(): String = listOfNotNull(
        request.title,
        request.scheduledAt,
        request.startsAt,
        request.endsAt,
        request.dueAt,
        request.eventId?.let { "Event $it" },
        request.todoId?.let { "Todo $it" },
        request.description,
        request.notes,
        request.location,
        request.enabled?.let { if (it) getString(R.string.voice_call_speaker_on) else getString(R.string.voice_call_speaker_off) },
    ).joinToString("\n").ifBlank { phoneActionLabel(this, request.action) }

    private fun finishDenied() = finishWithResult(
        PhoneActionResult(request.actionId, request.action, "denied", "用户未授权该手机操作"),
    )

    private fun finishFailed(error: Throwable) = finishWithResult(
        PhoneActionResult(
            request.actionId,
            request.action,
            "failed",
            getString(R.string.phone_action_failed),
            mapOf("error" to (error.message ?: error.javaClass.simpleName).take(1_000)),
        ),
        error.message,
    )

    private fun finishWithResult(result: PhoneActionResult, error: String? = null) {
        if (resultFinished) return
        if (result.state != "cancelled" && PhoneActionStore(this).result(request.actionId)?.state == "cancelled") {
            resultFinished = true
            finish()
            return
        }
        resultFinished = true
        PhoneActionStore(this).complete(result)
        PhoneActionOutbox.enqueue(
            this,
            PhoneActionEvent.create(
                request,
                AndroidPeerIdentity.deviceId(this),
                result.state,
                result.summary,
                result.data,
                error,
            ),
        )
        PhoneActionNotifier.dismiss(this, request.actionId)
        finish()
    }

    companion object {
        private const val EXTRA_ACTION_ID = "phone_action_id"
        private const val EXTRA_APPROVED_BY_POLICY = "phone_action_approved_by_policy"

        fun intent(context: Context, actionId: String, approvedByPolicy: Boolean = false): Intent =
            Intent(context, PhoneActionActivity::class.java)
                .putExtra(EXTRA_ACTION_ID, actionId)
                .putExtra(EXTRA_APPROVED_BY_POLICY, approvedByPolicy)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        fun open(context: Context, actionId: String, approvedByPolicy: Boolean = false) {
            context.startActivity(intent(context, actionId, approvedByPolicy))
        }
    }
}
