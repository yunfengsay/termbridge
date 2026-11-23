package com.termbridge.android.brain

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.format.DateUtils
import android.view.ViewGroup
import android.view.WindowManager
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.StringRes
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.PopupMenu
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.core.widget.doAfterTextChanged
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import com.termbridge.android.R
import com.termbridge.android.TerminalActivity
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.databinding.ActivityBrainBinding
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.peer.PhoneActionRequest
import com.termbridge.android.protocol.BrainMessageInfo
import com.termbridge.android.protocol.BrainConversationSummaryInfo
import com.termbridge.android.protocol.BrainDeliverableInfo
import com.termbridge.android.protocol.BrainTaskInfo
import com.termbridge.android.protocol.BrainToolResultInfo
import com.termbridge.android.protocol.BrainToolDescriptorInfo
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.ExecutionForkEventInfo
import com.termbridge.android.protocol.VoiceUsageInfo
import com.termbridge.android.protocol.VoiceToolViewInfo
import com.termbridge.android.protocol.VoiceToolViewItemInfo
import com.termbridge.android.ui.applyWindowInsets
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors

class BrainActivity : AppCompatActivity(), TermbridgeClient.Listener {
    private data class PendingSynthesis(val messageId: String)

    private lateinit var binding: ActivityBrainBinding
    private lateinit var adapter: BrainTimelineAdapter
    private val contentReader by lazy { com.termbridge.android.content.ArtifactReader(
        SettingsStore.load(this), com.termbridge.android.protocol.SessionFileProtocol.GLOBAL_SESSION, this) }
    private val contentMarkdown by lazy { com.termbridge.android.content.ArtifactMarkdown(this, contentReader::read, ::openContent) }
    private lateinit var speaker: BrainSpeaker
    private lateinit var realtimePlayer: RealtimePcmPlayer
    private lateinit var voiceToolCue: VoiceToolCue
    private lateinit var callAudioSession: CallAudioSession
    @Volatile private var voiceSettings = VoiceSettings()
    private val wakeSession = VoiceWakeSession()
    private val controlObservation = com.termbridge.android.brain.personalization.ControlObservation()
    private var controlGroup = UUID.randomUUID().toString()
    private var boundaryPreviousUser = ""
    private var boundaryPreviousAssistant = ""
    private val wakeTicker = object : Runnable {
        override fun run() {
            if (!voiceConversation.active) return
            if (wakeSession.shouldSealInput(android.os.SystemClock.elapsedRealtime()) &&
                wakeSession.finishInput(wakeSession.generation, ::sealWakeInput)) {
                finishWakeInput(null)
            }
            if (wakeSession.shouldPark(android.os.SystemClock.elapsedRealtime(), realtimePlayer.hasPendingOutput(), omniResponding)) {
                parkForWakeWord()
            }
            handler.postDelayed(this, 250)
        }
    }
    private val handler = Handler(Looper.getMainLooper())
    private var client: TermbridgeClient? = null
    private val personalSync by lazy { com.termbridge.android.brain.personalization.PersonalControlSync(applicationContext) }
    private var started = false
    private var connected = false
    private var brainReady = false
    private var adaptiveControlSupported: Boolean? = null
    private var loaded = false
    private var pendingRequestId: String? = null
    private var pendingWorkflow = "standard"
    private var renderingDictation = false
    private val dictation by lazy {
        ComposerDictation(this,
            send = { fields -> client?.sendControl(*fields) == true },
            render = { text, active, finishing, level ->
                if (active && binding.composerInput.text?.toString() != text) {
                    renderingDictation = true
                    binding.composerInput.setText(text)
                    binding.composerInput.setSelection(text.length)
                    renderingDictation = false
                }
                binding.dictationPanel.isVisible = active
                binding.dictationStatus.text = if (finishing) getString(R.string.dictation_finishing)
                    else getString(R.string.dictation_listening, voiceSettings.sendKeyword)
                binding.dictationLevel.setLevel(level)
                binding.silentModeButton.setText(if (active) R.string.dictation_stop else R.string.dictation_title)
                updateComposerState()
            },
            submit = {
                if (pendingRequestId == null) sendMessage()
                else Snackbar.make(binding.root, R.string.dictation_waiting, Snackbar.LENGTH_LONG).show()
            },
            reportError = { Snackbar.make(binding.root, it, Snackbar.LENGTH_LONG).show() },
        )
    }
    private val dictationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && started) startDictation()
        else if (!granted) Snackbar.make(binding.root, R.string.brain_microphone_permission, Snackbar.LENGTH_LONG).show()
    }
    private var awaitingSilentCapability = false
    private var pendingModelTier = "advanced"
    private var silentSupported = false
    private var dictationSupported = false
    private var silentCallSupported = false
    private var timelineHasItems = false
    private var pendingText: String? = null
    private var pendingImageAttachment: BrainImageAttachment? = null
    private var pendingAccepted = false
    private val entryContext = BrainEntryContext()
    private var voiceListening = false
    private var voiceModels: OnDeviceVoiceModels? = null
    private var voiceModelsLoading = false
    private var voiceCapture: OnDeviceVoiceCapture? = null
    private var voiceCaptureId: String? = null
    private val voiceModelExecutor = Executors.newSingleThreadExecutor()
    private val boundaryDownloadExecutor = Executors.newSingleThreadExecutor()
    private var boundaryDownloadRunning = false
    private val imageExecutor = Executors.newSingleThreadExecutor()
    private lateinit var imageAttachmentStore: BrainImageAttachmentStore
    private var imageAttachment: BrainImageAttachment? = null
    private var lastVoicePresentation: Pair<String, String>? = null
    private val presentationListener: (VoiceCallUiState.Snapshot) -> Unit = {
        runOnUiThread { syncVoicePresentation() }
    }

    private fun syncVoicePresentation() {
        val requestId = transcriptionRequestId ?: return
        if (!voiceRemoteReady || !voiceConversation.active || !VoiceCallOwnership.shared.owns(this)) return
        val state = VoiceCallUiState.current()
        val presentation = when {
            state.overlayVisible -> "overlay"
            state.surfaceVisible -> "foreground"
            else -> return // Capture temporarily hides the orb; this is not returning to the call page.
        }
        val next = requestId to presentation
        if (lastVoicePresentation == next) return
        if (client?.sendControl("t" to "brain_voice_presentation", "requestId" to requestId,
                "presentation" to presentation) == true) lastVoicePresentation = next
    }
    private var imageImporting = false
    private val floatingAttachmentListener: (VoiceCallAttachmentEvent) -> Unit = { event ->
        runOnUiThread {
            when (event) {
                is VoiceCallAttachmentEvent.Imported -> acceptFloatingAttachment(event.attachment)
                is VoiceCallAttachmentEvent.Failed -> Snackbar.make(
                    binding.root,
                    getString(R.string.voice_overlay_attachment_failed, event.message),
                    Snackbar.LENGTH_LONG,
                ).show()
            }
        }
    }
    private val voiceAudioOutbox = VoiceAudioOutbox(MAX_OFFLINE_VOICE_BYTES)
    private val voiceStatusCaptionState = VoiceStatusCaptionState()
    private val voiceConversation = VoiceConversation()
    private val globalCallLaunchGate = GlobalCallLaunchGate()
    private val voiceBargeInGate = VoiceBargeInGate()
    @Volatile private var transcriptionRequestId: String? = null
    @Volatile private var voiceRemoteReady = false
    private var voiceQueueFullNotified = false
    private var retainingVoiceForChild = false
    private var voiceRetainedInChild = false
    private var voiceDraft = ""
    private var omniReplyDraft = ""
    private var voiceTurnRequestId: String? = null
    private var voiceCompletionMessageId: String? = null
    @Volatile private var omniResponding = false
    @Volatile private var voiceInterruptionPending = false
    private var voiceTextOnly = false
    private var activeVoiceProvider: String? = null
    private var activeVoiceModel: String? = null
    private var voiceConnectLatencyMs = 0
    private var bypassOverlayPermissionOnce = false
    private var latestBrainTasks: List<BrainTaskInfo> = emptyList()
    private var latestBrainHistory: List<BrainConversationSummaryInfo> = emptyList()
    private var latestBrainMessages: List<BrainMessageInfo> = emptyList()
    private var latestAllBrainMessages: List<BrainMessageInfo> = emptyList()
    private var latestBrainToolResults: List<BrainToolResultInfo> = emptyList()
    private var latestBrainDeliverables: List<BrainDeliverableInfo> = emptyList()
    private var latestBrainExecutionEvents: List<ExecutionForkEventInfo> = emptyList()
    private var latestVoiceUsage: VoiceUsageInfo? = null
    private val pendingSpeechIds = mutableSetOf<String>()
    private val pendingSyntheses = mutableMapOf<String, PendingSynthesis>()
    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startVoiceInput() else {
            Snackbar.make(binding.root, R.string.brain_microphone_permission, Snackbar.LENGTH_LONG).show()
        }
    }
    private val overlayPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        bypassOverlayPermissionOnce = true
        if (!Settings.canDrawOverlays(this)) {
            Snackbar.make(binding.root, R.string.voice_overlay_permission_denied, Snackbar.LENGTH_LONG).show()
        }
        startVoiceInput()
    }
    private val imagePicker = registerForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(PhoneActionRequest.MAX_PHOTO_SELECTION),
    ) { uris ->
        if (uris.isNotEmpty()) importImageAttachment(uris)
    }
    private val reconnect = Runnable { if (started) connectNow() }
    private val restartVoiceRemote = Runnable {
        if (started && connected && brainReady && voiceConversation.active) startRemoteVoiceSession()
    }

    // On-screen voice pipeline diagnostics: capture/send counters plus the last
    // gate decision, so a stalled turn shows exactly which stage blocked it.
    @Volatile private var voiceDbgFrames = 0L
    @Volatile private var voiceDbgCapturedBytes = 0L
    @Volatile private var voiceDbgSentBytes = 0L
    @Volatile private var voiceDbgLastEvent = "等待通话"
    @Volatile private var voiceDbgLastEventAt = 0L
    @Volatile private var voiceDbgAudible = false
    @Volatile private var voiceDbgProbability = 0f
    @Volatile private var voiceDbgProbabilityPeak = 0f
    @Volatile private var voiceDbgThreshold = 0f
    private val voiceDebugTicker = object : Runnable {
        override fun run() {
            renderVoiceDebug()
            handler.postDelayed(this, 500)
        }
    }

    private fun noteVoiceEvent(event: String) {
        voiceDbgLastEvent = event
        voiceDbgLastEventAt = System.currentTimeMillis()
    }

    private fun renderVoiceDebug() {
        if (!voiceConversation.active) {
            binding.voiceDebugStatus.text = ""
            return
        }
        val req = if (transcriptionRequestId != null) "有" else "无"
        val ready = if (voiceRemoteReady) "是" else "否"
        val age = if (voiceDbgLastEventAt == 0L) "" else " · ${(System.currentTimeMillis() - voiceDbgLastEventAt) / 1000}s前"
        val gate = if (voiceDbgAudible) "语音▶" else "静音·"
        val peak = voiceDbgProbabilityPeak
        voiceDbgProbabilityPeak = voiceDbgProbability
        binding.voiceDebugStatus.text =
            "采集 ${voiceDbgFrames}帧/${voiceDbgCapturedBytes / 1024}KB → 已发 ${voiceDbgSentBytes / 1024}KB [$gate]\n" +
            "VAD p=%.2f 峰值=%.2f 阈值=%.2f · 会话:%s 就绪:%s".format(
                voiceDbgProbability, peak, voiceDbgThreshold, req, ready) + "\n" +
            "最近: $voiceDbgLastEvent$age"
    }
    private val restorePotentialSpeechPlayback = Runnable {
        if (voiceBargeInGate.onPotentialSpeechTimedOut()) {
            realtimePlayer.resumeAfterRejectedSpeech()
            restoreVoiceStateAfterRejectedSpeech()
        }
    }
    private val snapshotRefresh = object : Runnable {
        override fun run() {
            if (!started || !connected) return
            client?.sendControl("t" to "brain_snapshot")
            handler.postDelayed(this, SNAPSHOT_REFRESH_MS)
        }
    }
    private val confirmationTimeout = Runnable {
        if (pendingRequestId != null && !pendingAccepted) {
            clearPendingRequest()
            Snackbar.make(binding.root, R.string.brain_send_unconfirmed, Snackbar.LENGTH_LONG).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityBrainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyWindowInsets(
            binding.root,
            includeKeyboard = true,
            drawBehindSystemBars = { voiceConversation.active },
        )
        applyVoiceTopActionInsets()
        voiceSettings = VoiceSettingsStore(this).load()
        imageAttachmentStore = BrainImageAttachmentStore(this)
        imageAttachment = imageAttachmentStore.current()
        VoiceCallAttachmentEvents.addListener(floatingAttachmentListener)
        VoiceCallUiState.addListener(presentationListener)
        callAudioSession = CallAudioSession(this) {
            runOnUiThread { if (::binding.isInitialized) renderSpeakerphoneButton() }
        }
        speaker = BrainSpeaker(
            this,
            initialPlaybackRate = voiceSettings.playbackRate,
            onUnavailable = {
                runOnUiThread {
                    Snackbar.make(binding.root, R.string.brain_tts_unavailable, Snackbar.LENGTH_LONG).show()
                    stopVoiceConversation()
                }
            },
            onStarted = { messageId ->
                runOnUiThread {
                    if (messageId == voiceCompletionMessageId && voiceConversation.active) {
                        ensureCallAudioRoute()
                        voiceConversation.brainAnswerStarted()
                        showVoiceState(R.string.brain_voice_speaking, VoiceLevelView.Mode.SPEAKING)
                        updateComposerState()
                    }
                }
            },
            onCompleted = { messageId ->
                runOnUiThread {
                    pendingSpeechIds.remove(messageId)
                    saveSpokenMessageIds(loadSpokenMessageIds() + messageId, latestBrainMessages)
                    if (messageId == voiceCompletionMessageId) {
                        voiceCompletionMessageId = null
                        voiceTurnRequestId = null
                        if (voiceConversation.speechFinished() && started && connected) beginListening()
                    }
                }
            },
        )
        realtimePlayer = RealtimePcmPlayer(
            initialPlaybackRate = voiceSettings.playbackRate,
            onStarted = {
                runOnUiThread {
                    if (voiceConversation.active) {
                        ensureCallAudioRoute()
                        voiceConversation.brainAnswerStarted()
                        showVoiceState(R.string.brain_voice_speaking, VoiceLevelView.Mode.SPEAKING)
                    }
                }
            },
            onDrained = {
                runOnUiThread {
                    if (voiceConversation.active && !omniResponding) {
                        voiceConversation.speechFinished()
                        showListeningStatus()
                    }
                }
            },
        )
        voiceToolCue = VoiceToolCue()
        adapter = BrainTimelineAdapter(::openTask, ::openVoiceToolItem, ::openDeliverable, contentMarkdown)
        binding.timeline.layoutManager = LinearLayoutManager(this).apply { stackFromEnd = true }
        binding.timeline.adapter = adapter
        binding.toolbar.setNavigationOnClickListener { navigateBack() }
        binding.toolbar.inflateMenu(R.menu.brain_menu)
        com.termbridge.android.ui.MenuAppearance.apply(this, binding.toolbar.menu)
        binding.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_brain_new -> {
                    startNewConversation()
                    true
                }
                R.id.action_brain_history -> {
                    showHistoryPicker()
                    true
                }
                R.id.action_brain_clear -> {
                    confirmClearConversation()
                    true
                }
                R.id.action_voice_profile -> {
                    startActivity(VoiceProfileActivity.intent(this, latestVoiceUsage)
                        .setClass(this, com.termbridge.android.GlobalSettingsActivity::class.java))
                    true
                }
                R.id.action_side_button_setup -> {
                    openSideButtonSettings()
                    true
                }
                else -> false
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = navigateBack()
        })
        binding.modeButton.setOnClickListener {
            dictation.cancel()
            startVoiceInput()
        }
        binding.silentModeButton.setOnClickListener { if (dictation.active) dictation.finish(false) else startDictation() }
        binding.voiceSilentButton.setOnClickListener {
            setTextOnlyReplies(!voiceTextOnly)
        }
        binding.silentCancelButton.setOnClickListener { cancelSilentExecution() }
        binding.attachmentButton.setOnClickListener { chooseOrManageImages() }
        binding.attachmentButton.setOnLongClickListener {
            discardImageAttachment()
            true
        }
        binding.voiceAttachButton.setOnClickListener { chooseOrManageImages() }
        binding.voiceAttachButton.setOnLongClickListener {
            discardImageAttachment()
            true
        }
        binding.voiceProviderStatus.setOnClickListener { showVoiceProviderMenu() }
        binding.voiceInteractionMode.setOnClickListener { showVoiceInteractionMenu() }
        binding.voiceTextButton.isCheckable = true
        binding.voiceTextButton.setOnClickListener {
            setTextOnlyReplies(binding.voiceTextButton.isChecked)
        }
        binding.voiceSpeakerButton.isCheckable = true
        binding.voiceSpeakerButton.setOnClickListener {
            setSpeakerphoneEnabled(binding.voiceSpeakerButton.isChecked)
        }
        binding.voiceEndButton.setOnClickListener { stopVoiceConversation() }
        binding.sendButton.setOnClickListener { sendMessage() }
        binding.composerInput.doAfterTextChanged {
            if (!renderingDictation && dictation.active) dictation.cancel()
            updateComposerState()
        }

        val configuredHost = SettingsStore.load(this).hostId
        if (configuredHost.isNotBlank()) binding.hostLabel.text = getString(R.string.brain_host, configuredHost)
        entryContext.accept(savedInstanceState?.getString(STATE_SOURCE_SESSION_ID), clear = false)
        if (savedInstanceState == null) acceptSourceIntent(intent)
        acceptLaunchIntent(intent)
        renderTextReplyButton()
        renderSpeakerphoneButton()
        updateComposerState()
    }

    private fun applyVoiceTopActionInsets() {
        val layoutParams = binding.voiceTopActions.layoutParams as ViewGroup.MarginLayoutParams
        val baseTopMargin = layoutParams.topMargin
        val baseEndMargin = layoutParams.marginEnd
        ViewCompat.setOnApplyWindowInsetsListener(binding.voiceTopActions) { view, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.updateLayoutParams<ViewGroup.MarginLayoutParams> {
                topMargin = baseTopMargin + systemBars.top
                marginEnd = baseEndMargin + systemBars.right
            }
            insets
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        acceptSourceIntent(intent)
        acceptLaunchIntent(intent)
        maybeStartGlobalCall()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        entryContext.sourceSessionId?.let { outState.putString(STATE_SOURCE_SESSION_ID, it) }
        super.onSaveInstanceState(outState)
    }

    override fun onStart() {
        super.onStart()
        client?.sendControl("t" to "desktop_subscribe", "deviceId" to com.termbridge.android.peer.AndroidPeerIdentity.deviceId(this), "foreground" to true)
        VoiceCallUiState.setSurfaceVisible(this,
            !VoiceCallUiState.current().active || VoiceCallOwnership.shared.owns(this))
        imageAttachmentStore.current()?.takeIf { it.actionId != imageAttachment?.actionId }?.let {
            acceptFloatingAttachment(it)
        }
        val previousVoiceSettings = voiceSettings
        voiceSettings = VoiceSettingsStore(this).load()
        renderVoiceCall()
        if (voiceConversation.active && (previousVoiceSettings.interactionMode != voiceSettings.interactionMode ||
                previousVoiceSettings.wakeWord != voiceSettings.wakeWord)) {
            switchVoiceInteractionMode(voiceSettings.interactionMode)
        }
        speaker.setPlaybackRate(voiceSettings.playbackRate)
        realtimePlayer.setPlaybackRate(voiceSettings.playbackRate)
        started = true
        if (voiceRetainedInChild && voiceConversation.active && client != null) {
            voiceRetainedInChild = false
            updateKeepScreenAwake()
            updateComposerState()
            return
        }
        voiceRetainedInChild = false
        connectNow()
        maybeStartGlobalCall()
    }

    override fun onStop() {
        client?.sendControl("t" to "desktop_subscribe", "deviceId" to com.termbridge.android.peer.AndroidPeerIdentity.deviceId(this), "foreground" to false)
        dictation.cancel()
        VoiceCallUiState.setSurfaceVisible(this, false)
        val presentation = VoiceCallUiState.current()
        if (VoiceOverlayPolicy.canRetain(voiceConversation.active, presentation.surfaceVisible, presentation.overlayVisible) &&
            !isFinishing && !isChangingConfigurations) {
            retainingVoiceForChild = false
            voiceRetainedInChild = true
            super.onStop()
            return
        }
        started = false
        handler.removeCallbacks(reconnect)
        handler.removeCallbacks(restartVoiceRemote)
        handler.removeCallbacks(restorePotentialSpeechPlayback)
        handler.removeCallbacks(snapshotRefresh)
        handler.removeCallbacks(confirmationTimeout)
        // Tell the Host to stop while the connection is still usable.
        stopVoiceConversation(if (isFinishing) "page_closed" else "not_visible")
        client?.disconnect()
        client = null
        connected = false
        brainReady = false
        speaker.stop()
        pendingSpeechIds.clear()
        pendingSyntheses.clear()
        updateComposerState()
        super.onStop()
    }

    override fun onDestroy() {
        contentMarkdown.close()
        contentReader.close()
        personalSync.close()
        dictation.close()
        boundaryDownloadExecutor.shutdownNow()
        if (VoiceCallOwnership.shared.owns(this)) stopVoiceConversation("destroyed")
        VoiceCallUiState.setSurfaceVisible(this, false)
        VoiceCallAttachmentEvents.removeListener(floatingAttachmentListener)
        VoiceCallUiState.removeListener(presentationListener)
        voiceCapture?.stop()
        voiceCapture = null
        voiceModelExecutor.execute {
            voiceModels?.close()
            voiceModels = null
        }
        voiceModelExecutor.shutdown()
        speaker.shutdown()
        realtimePlayer.close()
        voiceToolCue.close()
        VoiceCallSpeakerController.detach(callAudioSession)
        callAudioSession.stop()
        imageExecutor.shutdownNow()
        super.onDestroy()
    }

    override fun onConnectionState(state: ConnectionState) = runOnUiThread {
        when (state) {
            ConnectionState.Connecting -> showConnection(R.string.connecting, R.drawable.status_dot_idle)
            ConnectionState.Authenticating -> showConnection(R.string.authenticating, R.drawable.status_dot_idle)
            ConnectionState.Connected -> {
                connected = true
                showConnection(R.string.connected, R.drawable.status_dot_active)
                updateComposerState()
                maybeStartGlobalCall()
            }
            ConnectionState.Disconnected -> showConnectionFailure(getString(R.string.disconnected))
            is ConnectionState.Failed -> showConnectionFailure(state.message)
        }
    }

    override fun onReady(client: TermbridgeClient) {
        client.sendControl("t" to "desktop_subscribe", "deviceId" to com.termbridge.android.peer.AndroidPeerIdentity.deviceId(this), "foreground" to true)
        brainReady = true
        client.sendControl("t" to "peer_register", "deviceId" to com.termbridge.android.peer.AndroidPeerIdentity.deviceId(this),
            "platform" to "android", "name" to com.termbridge.android.peer.AndroidPeerIdentity.displayName(), "role" to "manager",
            "capabilities" to listOf("voice.personalization", "peer.control-only"))
        client.sendControl("t" to "brain_snapshot")
        handler.removeCallbacks(snapshotRefresh)
        handler.postDelayed(snapshotRefresh, SNAPSHOT_REFRESH_MS)
        runOnUiThread {
            if (pendingRequestId != null && pendingWorkflow == "silent") awaitingSilentCapability = true
            else resendPendingRequest()
            if (voiceConversation.active) startRemoteVoiceSession()
            maybeStartGlobalCall()
        }
    }

    override fun onControl(message: ControlMessage) = runOnUiThread {
        if (message.type == "desktop_attention") {
            startActivity(com.termbridge.android.desktop.RemoteDesktopActivity.intent(this, SettingsStore.load(this).hostId))
            return@runOnUiThread
        }
        if (personalSync.accept(SettingsStore.load(this).hostId, message)) return@runOnUiThread
        if (dictation.accept(message)) return@runOnUiThread
        if (message.type == "brain_snapshot_result" && message.fields.containsKey("workflows")) {
            adaptiveControlSupported = (message.int("voiceLearning") ?: 0) >= 1
            val connection = client
            personalSync.connected(SettingsStore.load(this).hostId, message.int("voiceLearning") ?: 0) { wire ->
                connection?.sendControl(*wire.map { it.key to it.value }.toTypedArray()) == true
            }
            if (voiceConversation.active && voiceSettings.adaptiveTurnControl && !voiceRemoteReady) startRemoteVoiceSession()
        }
        if (message.type == "brain_snapshot_result" && message.fields.containsKey("workflows")) {
            silentSupported = "silent" in message.stringList("workflows")
        }
        if (message.type == "brain_snapshot_result") dictationSupported = message.boolean("dictation") == true
        if (message.type == "brain_snapshot_result") silentCallSupported = message.boolean("silentCall") == true
        if (message.type == "brain_snapshot_result" && awaitingSilentCapability) {
            awaitingSilentCapability = false
            if (silentSupported) resendPendingRequest()
            else {
                clearPendingRequest()
                Snackbar.make(binding.root, R.string.silent_host_required, Snackbar.LENGTH_LONG).show()
            }
        }
        when (message.type) {
            com.termbridge.android.protocol.CompletionReviewProtocol.RESULT -> {
                Snackbar.make(binding.root, if (message.boolean("ok") == true) getString(R.string.completion_sent)
                    else message.string("error") ?: getString(R.string.content_failed), Snackbar.LENGTH_LONG).show()
                client?.sendControl("t" to "brain_snapshot")
            }
            "brain_cancel_result" -> if (message.boolean("cancelled") != true) {
                Snackbar.make(binding.root, R.string.silent_cancel_unavailable, Snackbar.LENGTH_LONG).show()
            }
            "brain_text_result" -> {
                if (message.string("status") != "completed") {
                    Snackbar.make(binding.root, message.string("text").orEmpty(), Snackbar.LENGTH_LONG).show()
                }
                if (message.string("requestId") == pendingRequestId) clearPendingRequest()
                client?.sendControl("t" to "brain_snapshot")
            }
            "brain_snapshot_result" -> renderSnapshot(
                message.brainMessages(),
                message.brainTasks(),
                message.brainToolResults(),
                message.brainDeliverables(),
                message.brainToolCatalog(),
                message.brainExecutionEvents(),
                message.brainHistory(),
                message.voiceUsage(),
            )
            "brain_execution_event" -> message.brainExecutionEvent()?.let(::renderExecutionEvent)
            "brain_voice_ready" -> handleRealtimeVoiceReady(message)
            "brain_voice_transcript" -> handleRealtimeTranscript(message)
            "brain_voice_text" -> handleRealtimeText(message)
            "brain_voice_output_audio" -> handleRealtimeAudio(message)
            "brain_voice_status" -> handleRealtimeStatus(message)
            "brain_voice_tool_result" -> handleRealtimeToolResult(message)
            "brain_voice_error" -> handleRealtimeVoiceError(message)
            "brain_voice_stopped" -> handleRealtimeVoiceStopped(message)
            "brain_transcribe_result" -> handleTranscriptionResult(message)
            "brain_synthesize_result" -> handleSynthesisResult(message)
            "brain_accepted" -> {
                if (message.string("requestId") == pendingRequestId) {
                    pendingAccepted = true
                    handler.removeCallbacks(confirmationTimeout)
                    binding.composerStatus.setText(
                        if (voiceConversation.active) R.string.brain_voice_waiting
                        else if (pendingWorkflow == "silent") R.string.silent_running else R.string.brain_planning,
                    )
                }
            }
            "host_list_result" -> {
                val selected = message.string("selectedHostId") ?: SettingsStore.load(this).hostId
                val host = message.hosts().firstOrNull { it.hostId == selected }
                val label = host?.name ?: selected
                if (label.isNotBlank()) binding.hostLabel.text = getString(R.string.brain_host, label)
            }
            "error" -> {
                binding.progress.isVisible = false
                if (voiceConversation.active) {
                    markVoiceRemoteUnavailable(
                        message.string("message") ?: getString(R.string.brain_voice_remote_unavailable),
                    )
                    return@runOnUiThread
                }
                clearPendingRequest()
                Snackbar.make(
                    binding.root,
                    message.string("message") ?: getString(R.string.brain_send_failed),
                    Snackbar.LENGTH_LONG,
                ).show()
            }
            "tool_request" -> rejectToolRequest(message)
        }
    }

    override fun onPtyOutput(sid: Int, data: ByteArray) = Unit

    private fun connectNow() {
        adaptiveControlSupported = null
        silentSupported = false
        dictationSupported = false
        silentCallSupported = false
        handler.removeCallbacks(reconnect)
        client?.disconnect()
        connected = false
        brainReady = false
        if (!loaded) binding.progress.isVisible = true
        val settings = SettingsStore.load(this)
        settings.validationError()?.let {
            showConnectionFailure(it, retry = false)
            return
        }
        client = TermbridgeClient(settings, this).also(TermbridgeClient::connect)
    }

    private fun renderSnapshot(
        messages: List<BrainMessageInfo>,
        tasks: List<BrainTaskInfo>,
        toolResults: List<BrainToolResultInfo>,
        deliverables: List<BrainDeliverableInfo>,
        toolCatalog: List<BrainToolDescriptorInfo>,
        executionEvents: List<ExecutionForkEventInfo>,
        history: List<BrainConversationSummaryInfo>,
        voiceUsage: VoiceUsageInfo?,
    ) {
        val firstRender = !loaded
        loaded = true
        binding.progress.isVisible = false
        latestBrainMessages = messages.filter { it.role == "brain" }
        latestAllBrainMessages = messages
        latestBrainTasks = tasks
        latestBrainToolResults = toolResults
        latestBrainDeliverables = deliverables
        BrainToolCatalogState.update(toolCatalog)
        latestBrainExecutionEvents = executionEvents
        latestBrainHistory = history
        latestVoiceUsage = voiceUsage
        renderTimeline(messages, tasks, toolResults, deliverables, executionEvents, firstRender)
        if (voiceConversation.active) {
            val voiceRequestPrefix = "$transcriptionRequestId-voice-"
            toolResults.lastOrNull {
                it.requestId == transcriptionRequestId || it.requestId.startsWith(voiceRequestPrefix)
            }?.let { showVoiceToolView(it.view) }
            executionEvents.lastOrNull {
                it.requestId.startsWith(voiceRequestPrefix)
            }?.let { showVoiceExecutionTrace(it.forkId) }
        }

        val requestId = pendingRequestId
        if (requestId != null) {
            val confirmed = snapshotCompletesPendingRequest(requestId, messages, tasks)
            if (confirmed && binding.composerInput.text?.toString() == pendingText) {
                binding.composerInput.text?.clear()
            }
            if (confirmed) {
                pendingImageAttachment?.let { attachment ->
                    imageAttachmentStore.consume(attachment.actionId)
                    if (imageAttachment?.actionId == attachment.actionId) imageAttachment = null
                    updateImageAttachmentUi()
                }
                entryContext.consume()
                clearPendingRequest()
            }
        }
        val voiceRequest = voiceTurnRequestId
        if (voiceConversation.active && voiceRequest != null && voiceCompletionMessageId == null) {
            val task = tasks.firstOrNull { it.requestId == voiceRequest }
            if (task?.status == "completed" || task?.status == "failed") {
                val answer = latestBrainMessages.lastOrNull { it.taskId == task.taskId }
                if (answer != null && answer.id !in pendingSpeechIds) {
                    if (voiceTextOnly) {
                        voiceTurnRequestId = null
                        if (voiceConversation.speechFinished() && started && connected) beginListening()
                    } else {
                        voiceCompletionMessageId = answer.id
                        if (speak(answer.id, answer.text)) {
                            pendingSpeechIds += answer.id
                        } else {
                            voiceCompletionMessageId = null
                            stopVoiceConversation()
                        }
                    }
                }
            }
        }
        updateComposerState()
    }

    private fun renderTimeline(
        messages: List<BrainMessageInfo>,
        tasks: List<BrainTaskInfo>,
        toolResults: List<BrainToolResultInfo>,
        deliverables: List<BrainDeliverableInfo>,
        executionEvents: List<ExecutionForkEventInfo>,
        firstRender: Boolean,
    ) {
        val wasAtBottom = !binding.timeline.canScrollVertically(1)
        val previousLastId = adapter.currentList.lastOrNull()?.stableId
        val items = buildBrainTimelineItems(messages, tasks, toolResults, deliverables, executionEvents)
        val followLatest = shouldFollowLatestTimelineItem(
            firstRender = firstRender,
            wasAtBottom = wasAtBottom,
            previousLastId = previousLastId,
            nextLastId = items.lastOrNull()?.stableId,
        )
        adapter.submitList(items) {
            if (followLatest && items.isNotEmpty()) binding.timeline.scrollToPosition(items.lastIndex)
        }
        timelineHasItems = items.isNotEmpty()
        renderConversationSurface()
    }

    private fun renderExecutionEvent(event: ExecutionForkEventInfo) {
        latestBrainExecutionEvents = (latestBrainExecutionEvents.filterNot { it.eventId == event.eventId } + event)
            .sortedBy(ExecutionForkEventInfo::createdAt)
            .takeLast(300)
        renderTimeline(
            latestAllBrainMessages,
            latestBrainTasks,
            latestBrainToolResults,
            latestBrainDeliverables,
            latestBrainExecutionEvents,
            firstRender = false,
        )
        if (voiceConversation.active) showVoiceExecutionTrace(event.forkId)
    }

    private fun showVoiceExecutionTrace(forkId: String) {
        val trace = buildBrainExecutionTraces(latestBrainExecutionEvents).lastOrNull { it.forkId == forkId } ?: return
        val items = trace.tools.map { step ->
            VoiceToolViewItemInfo(
                id = step.callId,
                title = step.name,
                subtitle = step.summary,
                status = step.phase.removePrefix("tool_"),
            )
        }
        showVoiceToolView(VoiceToolViewInfo("receipt", trace.model, items.take(8)))
    }

    private fun sendMessage() {
        if (dictation.active) { dictation.finish(true); return }
        val text = binding.composerInput.text?.toString()?.trim().orEmpty()
        if (text.isEmpty() || pendingRequestId != null) return
        if (!silentSupported) {
            Snackbar.make(binding.root, R.string.silent_host_required, Snackbar.LENGTH_LONG).show()
            return
        }
        if (!connected || !brainReady) {
            Snackbar.make(binding.root, R.string.disconnected, Snackbar.LENGTH_LONG).show()
            return
        }
        val requestId = UUID.randomUUID().toString()
        pendingRequestId = requestId
        pendingWorkflow = "silent"
        pendingModelTier = voiceSettings.silentModelTier.wireValue
        pendingText = text
        pendingImageAttachment = imageAttachment
        pendingAccepted = false
        val sent = sendBrainRequest(requestId, text, pendingImageAttachment)
        if (!sent) {
            clearPendingRequest()
            Snackbar.make(binding.root, R.string.brain_send_failed, Snackbar.LENGTH_LONG).show()
            return
        }
        pendingImageAttachment?.let { imageAttachmentStore.markUsed(it.actionId) }
        binding.composerStatus.setText(R.string.brain_sending)
        if (voiceConversation.active) {
            voiceTurnRequestId = requestId
            voiceConversation.transcriptionSent()
            binding.composerStatus.setText(R.string.brain_voice_waiting)
        }
        handler.removeCallbacks(confirmationTimeout)
        handler.postDelayed(confirmationTimeout, CONFIRMATION_TIMEOUT_MS)
        updateComposerState()
    }

    private fun sendBrainRequest(
        requestId: String,
        text: String,
        attachment: BrainImageAttachment? = imageAttachment,
    ): Boolean {
        val fields = mutableListOf<Pair<String, Any?>>(
            "t" to "brain_send",
            "requestId" to requestId,
            "text" to text,
            "clientPlatform" to "android",
            "workflow" to pendingWorkflow,
            "modelTier" to pendingModelTier,
        )
        attachment?.let { fields += "imageAttachment" to it.toWireMap() }
        entryContext.appendTo(fields)
        return client?.sendControl(*fields.toTypedArray()) == true
    }

    private fun acceptSourceIntent(intent: Intent?) {
        entryContext.accept(
            sourceSessionId = intent?.getStringExtra(EXTRA_SOURCE_SESSION_ID),
            clear = intent?.getBooleanExtra(EXTRA_CLEAR_SOURCE_SESSION, false) == true,
        )
    }

    private fun resendPendingRequest() {
        val requestId = pendingRequestId ?: return
        val text = pendingText ?: return
        pendingAccepted = false
        if (sendBrainRequest(requestId, text, pendingImageAttachment)) {
            binding.composerStatus.setText(R.string.brain_sending)
            handler.removeCallbacks(confirmationTimeout)
            handler.postDelayed(confirmationTimeout, CONFIRMATION_TIMEOUT_MS)
        }
    }

    private fun clearPendingRequest() {
        handler.removeCallbacks(confirmationTimeout)
        awaitingSilentCapability = false
        pendingRequestId = null
        pendingText = null
        pendingImageAttachment = null
        pendingAccepted = false
        if (!voiceConversation.active) binding.composerStatus.text = ""
        updateComposerState()
    }

    private fun startNewConversation() {
        if (!canChangeConversation()) return
        if (client?.sendControl("t" to "brain_new") != true) {
            Snackbar.make(binding.root, R.string.brain_send_failed, Snackbar.LENGTH_LONG).show()
        }
    }

    private fun confirmClearConversation() {
        if (!canChangeConversation()) return
        if (latestBrainTasks.any { it.status == "queued" || it.status == "dispatched" }) {
            Snackbar.make(binding.root, R.string.brain_action_busy, Snackbar.LENGTH_LONG).show()
            return
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.brain_clear_title)
            .setMessage(R.string.brain_clear_detail)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.brain_clear_confirm) { _, _ ->
                client?.sendControl("t" to "brain_clear")
            }
            .show()
    }

    private fun showHistoryPicker() {
        if (voiceConversation.active || dictation.active || pendingRequestId != null) {
            Snackbar.make(binding.root, R.string.brain_action_busy, Snackbar.LENGTH_LONG).show()
            return
        }
        if (latestBrainHistory.isEmpty()) {
            Snackbar.make(binding.root, R.string.brain_history_empty, Snackbar.LENGTH_SHORT).show()
            return
        }
        val labels = latestBrainHistory.map { summary ->
            val relative = DateUtils.getRelativeTimeSpanString(
                summary.updatedAt,
                System.currentTimeMillis(),
                DateUtils.MINUTE_IN_MILLIS,
                DateUtils.FORMAT_ABBREV_RELATIVE,
            )
            "${getString(R.string.brain_history_item, summary.title, summary.messageCount)}\n$relative"
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.brain_history)
            .setItems(labels.toTypedArray()) { _, index ->
                val conversation = latestBrainHistory[index]
                binding.progress.isVisible = true
                val sent = client?.sendControl(
                    "t" to "brain_restore",
                    "conversationId" to conversation.id,
                ) == true
                if (!sent) binding.progress.isVisible = false
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun navigateBack() {
        finish()
    }

    private fun canChangeConversation(): Boolean {
        if (!connected || !brainReady) {
            Snackbar.make(binding.root, R.string.disconnected, Snackbar.LENGTH_LONG).show()
            return false
        }
        if (voiceConversation.active || pendingRequestId != null) {
            Snackbar.make(binding.root, R.string.brain_action_busy, Snackbar.LENGTH_LONG).show()
            return false
        }
        return true
    }

    private fun openTask(task: BrainTaskInfo) {
        val sessionId = task.sessionId ?: return
        retainingVoiceForChild = voiceConversation.active
        startActivity(
            TerminalActivity.attachIntent(
                this,
                sessionId,
                task.agent,
                false,
                SettingsStore.load(this).hostId,
            ),
        )
    }

    private fun openVoiceToolItem(item: VoiceToolViewItemInfo) {
        if (com.termbridge.android.peer.PhoneActionNavigation.canOpen(this, item.id)) {
            retainingVoiceForChild = voiceConversation.active
            com.termbridge.android.peer.PhoneActionNavigation.open(this, item.id)
            return
        }
        com.termbridge.android.protocol.CompletionReviewProtocol.approvalId(item.id)?.let { id ->
            Snackbar.make(binding.root, R.string.completion_confirm, Snackbar.LENGTH_INDEFINITE)
                .setAction(R.string.completion_approve) {
                    val sent = client?.sendControl("t" to com.termbridge.android.protocol.CompletionReviewProtocol.ACTION,
                        "requestId" to java.util.UUID.randomUUID().toString(), "id" to id, "action" to "approve") == true
                    if (!sent) Snackbar.make(binding.root, R.string.content_failed, Snackbar.LENGTH_LONG).show()
                }.show()
            return
        }
        val sessionId = item.sessionId ?: return
        retainingVoiceForChild = voiceConversation.active
        startActivity(
            TerminalActivity.attachIntent(
                this,
                sessionId,
                item.title,
                item.source == "herdr" || sessionId.startsWith("herdr:"),
                SettingsStore.load(this).hostId,
            ),
        )
    }

    private fun openDeliverable(deliverable: BrainDeliverableInfo) {
        val location = deliverable.url ?: deliverable.path ?: return
        retainingVoiceForChild = voiceConversation.active
        com.termbridge.android.content.ArtifactPreviewActivity.open(this, location, deliverable.sessionId, SettingsStore.load(this).hostId)
    }

    private fun openContent(location: String) {
        retainingVoiceForChild = voiceConversation.active
        com.termbridge.android.content.ArtifactPreviewActivity.open(this, location, hostId = SettingsStore.load(this).hostId)
    }

    private fun showConnection(label: Int, dot: Int) {
        binding.connectionStatus.setText(label)
        binding.connectionStatus.setTextColor(ContextCompat.getColor(this, R.color.ink_muted))
        binding.connectionDot.setBackgroundResource(dot)
    }

    private fun showConnectionFailure(message: String, retry: Boolean = true) {
        dictation.cancel()
        connected = false
        brainReady = false
        voiceRemoteReady = false
        transcriptionRequestId = null
        voiceAudioOutbox.beginNewRemoteSession()
        handler.removeCallbacks(snapshotRefresh)
        handler.removeCallbacks(confirmationTimeout)
        binding.progress.isVisible = false
        if (!loaded && adapter.currentList.isEmpty()) {
            renderConversationSurface()
        }
        binding.connectionStatus.text = if (retry) getString(R.string.reconnecting) else message
        binding.connectionStatus.setTextColor(ContextCompat.getColor(this, R.color.red))
        binding.connectionDot.setBackgroundResource(R.drawable.status_dot_error)
        if (voiceConversation.active) showVoiceOfflineQueue()
        updateComposerState()
        if (retry && started) {
            handler.removeCallbacks(reconnect)
            handler.postDelayed(reconnect, RECONNECT_DELAY_MS)
        }
    }

    private fun updateComposerState() {
        val hasInput = !binding.composerInput.text.isNullOrBlank()
        val canSend = connected && brainReady &&
            pendingRequestId == null && !voiceConversation.active && hasInput
        binding.sendButton.isEnabled = canSend
        binding.composerInput.isEnabled = !voiceConversation.active
        binding.sendButton.setImageResource(R.drawable.ic_send)
        binding.sendButton.contentDescription = getString(R.string.brain_send)
        binding.modeButton.isEnabled = !voiceConversation.active
        binding.silentCancelButton.isVisible = activeSilentRequest() != null
        updateKeepScreenAwake()
        updateImageAttachmentUi()
    }

    private fun chooseOrManageImages() {
        if (imageImporting || pendingRequestId != null) return
        val current = imageAttachment
        if (current == null) {
            launchImagePicker()
            return
        }
        MaterialAlertDialogBuilder(this)
            .setMessage(getString(R.string.brain_images_remove, current.assets.size))
            .setNegativeButton(R.string.brain_images_remove_action) { _, _ -> discardImageAttachment() }
            .setPositiveButton(R.string.brain_images_replace) { _, _ -> launchImagePicker() }
            .setNeutralButton(R.string.cancel, null)
            .show()
    }

    private fun launchImagePicker() {
        imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
    }

    private fun importImageAttachment(uris: List<Uri>) {
        if (imageImporting) return
        imageImporting = true
        updateImageAttachmentUi()
        imageExecutor.execute {
            runCatching { imageAttachmentStore.import(uris) }
                .onSuccess { attachment ->
                    runOnUiThread {
                        imageAttachment = attachment
                        imageImporting = false
                        if (voiceConversation.active) {
                            imageAttachmentStore.markUsed(attachment.actionId)
                            sendVoiceImageAttachmentUpdate(attachment)
                        }
                        updateImageAttachmentUi()
                    }
                }
                .onFailure { error ->
                    runOnUiThread {
                        imageImporting = false
                        updateImageAttachmentUi()
                        Snackbar.make(
                            binding.root,
                            getString(R.string.brain_images_failed, error.message ?: "unknown error"),
                            Snackbar.LENGTH_LONG,
                        ).show()
                    }
                }
        }
    }

    private fun acceptFloatingAttachment(attachment: BrainImageAttachment) {
        imageAttachment = attachment
        imageImporting = false
        if (voiceConversation.active) {
            imageAttachmentStore.markUsed(attachment.actionId)
            sendVoiceImageAttachmentUpdate(attachment)
        }
        updateImageAttachmentUi()
    }

    private fun discardImageAttachment() {
        if (imageAttachment == null) return
        imageAttachmentStore.discardCurrent()
        imageAttachment = null
        if (voiceConversation.active) sendVoiceImageAttachmentUpdate(null)
        updateImageAttachmentUi()
    }

    private fun sendVoiceImageAttachmentUpdate(attachment: BrainImageAttachment?) {
        val requestId = transcriptionRequestId ?: return
        client?.sendControl(
            "t" to "brain_voice_image_attachment",
            "requestId" to requestId,
            "imageAttachment" to attachment?.toWireMap(),
        )
    }

    private fun updateImageAttachmentUi() {
        val count = imageAttachment?.assets?.size ?: 0
        binding.attachmentButton.text = when {
            imageImporting -> getString(R.string.brain_images_importing)
            count > 0 -> getString(R.string.brain_images_selected, count)
            else -> getString(R.string.brain_images)
        }
        binding.attachmentButton.isEnabled = !imageImporting && pendingRequestId == null
        binding.voiceAttachButton.isEnabled = !imageImporting
        binding.voiceAttachButton.contentDescription = if (count > 0) {
            getString(R.string.brain_images_selected, count)
        } else {
            getString(R.string.brain_attach_images)
        }
        if (VoiceCallOwnership.shared.owns(this) || !VoiceCallUiState.current().active) {
            VoiceCallUiState.setAttachmentCount(count)
        }
    }

    private fun startVoiceInput() {
        dictation.cancel()
        if (voiceConversation.active) return
        // Reject a known incompatible host before acquiring audio or starting
        // the foreground service. Keep the later check for delayed handshakes.
        if (connected && brainReady && adaptiveControlSupported == false &&
            voiceSettings.adaptiveTurnControl && voiceSettings.provider != VoiceProviderPreference.VOLCENGINE) {
            Snackbar.make(binding.root, R.string.voice_learning_host_old, Snackbar.LENGTH_LONG).show()
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        if (!Settings.canDrawOverlays(this) && !bypassOverlayPermissionOnce) {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.voice_overlay_permission_title)
                .setMessage(R.string.voice_overlay_permission_detail)
                .setPositiveButton(R.string.voice_overlay_permission_allow) { _, _ ->
                    overlayPermission.launch(
                        Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:$packageName"),
                        ),
                    )
                }
                .setNegativeButton(R.string.cancel) { _, _ ->
                    bypassOverlayPermissionOnce = true
                    startVoiceInput()
                }
                .show()
            return
        }
        bypassOverlayPermissionOnce = false
        if (!ensureWakeBoundaryModel(voiceSettings.interactionMode)) return
        if (voiceSettings.speakerVerificationEnabled && VoiceProfileStore(this).load() == null) {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.voice_profile_title)
                .setMessage(R.string.brain_voice_profile_required)
                .setPositiveButton(R.string.voice_profile_record) { _, _ ->
                    startActivity(VoiceProfileActivity.intent(this))
                }
                .setNegativeButton(R.string.cancel, null)
                .show()
            return
        }
        speaker.stop()
        pendingSyntheses.values.forEach { pendingSpeechIds.remove(it.messageId) }
        pendingSyntheses.clear()
        voiceTextOnly = false
        VoiceCallOwnership.shared.acquire(this) { reason -> stopVoiceConversation(reason) }
        VoiceCallUiState.setSurfaceVisible(this, true)
        callAudioSession.start(voiceSettings.speakerphoneEnabled,
            acquireFocus = voiceSettings.interactionMode == VoiceInteractionMode.CONTINUOUS)
        VoiceCallSpeakerController.attach(callAudioSession)
        voiceConversation.start()
        wakeSession.start(voiceSettings.interactionMode, android.os.SystemClock.elapsedRealtime())
        handler.removeCallbacks(wakeTicker)
        handler.post(wakeTicker)
        imageAttachment?.let { imageAttachmentStore.markUsed(it.actionId) }
        renderTextReplyButton()
        renderSpeakerphoneButton()
        voiceQueueFullNotified = false
        VoiceCallUiState.setActive(true)
        try {
            VoiceCallOverlayService.start(this)
        } catch (_: RuntimeException) {
            stopVoiceConversation("overlay_service_start_failed")
            Snackbar.make(binding.root, R.string.voice_overlay_permission_denied, Snackbar.LENGTH_LONG).show()
            return
        }
        updateKeepScreenAwake()
        beginListening()
    }

    private fun acceptLaunchIntent(intent: Intent?) {
        if (
            intent?.action == ACTION_GLOBAL_CALL ||
            intent?.getBooleanExtra(EXTRA_START_GLOBAL_CALL, false) == true
        ) {
            globalCallLaunchGate.request()
            intent.action = null
            intent.removeExtra(EXTRA_START_GLOBAL_CALL)
        }
    }

    private fun maybeStartGlobalCall() {
        if (globalCallLaunchGate.consumeIfReady(ready = true, callActive = voiceConversation.active)) {
            startVoiceInput()
        }
    }

    private fun openSideButtonSettings() {
        try {
            startActivity(Intent(ACTION_SAMSUNG_SIDE_KEY_DOUBLE_PRESS_SETTINGS))
        } catch (_: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
        }
    }

    private fun setSpeakerphoneEnabled(enabled: Boolean) {
        if (!voiceConversation.active) return
        val route = VoiceCallSpeakerController.set(this, enabled)
        if (!route.applied) {
            renderSpeakerphoneButton()
            Snackbar.make(binding.root, R.string.voice_call_speaker_unavailable, Snackbar.LENGTH_LONG).show()
            return
        }
        voiceSettings = VoiceSettingsStore(this).load()
        renderSpeakerphoneButton()
    }

    private fun renderSpeakerphoneButton() {
        val enabled = if (voiceConversation.active) {
            callAudioSession.isSpeakerphoneEnabled()
        } else {
            voiceSettings.speakerphoneEnabled
        }
        binding.voiceSpeakerButton.isChecked = enabled
        binding.voiceSpeakerButton.contentDescription = getString(
            if (enabled) R.string.voice_call_speaker_on else R.string.voice_call_speaker_off,
        )
    }

    private fun ensureCallAudioRoute() {
        if (!voiceConversation.active) return
        callAudioSession.ensureRoute()
        renderSpeakerphoneButton()
    }

    private fun beginListening() {
        if (!voiceConversation.active || !started) return
        voiceDbgFrames = 0
        voiceDbgCapturedBytes = 0
        voiceDbgSentBytes = 0
        noteVoiceEvent("通话开始")
        activeVoiceProvider = null
        activeVoiceModel = null
        voiceConnectLatencyMs = 0
        renderVoiceProviderStatus()
        recordVoiceDiagnostic("call_started")
        handler.removeCallbacks(voiceDebugTicker)
        handler.post(voiceDebugTicker)
        speaker.stop()
        realtimePlayer.interrupt()
        omniResponding = false
        voiceInterruptionPending = false
        voiceBargeInGate.onListening()
        voiceDraft = ""
        omniReplyDraft = ""
        showVoiceCall()
        showVoiceState(
            if (connected && brainReady) R.string.brain_voice_connecting else R.string.brain_voice_offline,
            VoiceLevelView.Mode.CONNECTING,
        )
        startLocalVoiceCapture()
        startRemoteVoiceSession()
        updateComposerState()
    }

    private fun startRemoteVoiceSession() {
        handler.removeCallbacks(restartVoiceRemote)
        if (wakeSession.state != VoiceWakeSession.State.ACTIVE) {
            if (voiceConversation.active) showWakeStandby()
            return
        }
        if (!voiceConversation.active || !connected || !brainReady || transcriptionRequestId != null) {
            if (voiceConversation.active && (!connected || !brainReady)) showVoiceOfflineQueue()
            return
        }
        callAudioSession.setStandby(false)
        if (voiceSettings.adaptiveTurnControl && !voiceTextOnly && voiceSettings.provider != VoiceProviderPreference.VOLCENGINE) {
            if (adaptiveControlSupported == null) return
            if (adaptiveControlSupported != true) {
                stopVoiceConversation("adaptive_host_update_required")
                Snackbar.make(binding.root, R.string.voice_learning_host_old, Snackbar.LENGTH_LONG).show()
                return
            }
        }
        val requestId = UUID.randomUUID().toString()
        transcriptionRequestId = requestId
        voiceRemoteReady = false
        voiceAudioOutbox.beginNewRemoteSession()
        val fields = mutableListOf<Pair<String, Any?>>(
            "t" to "brain_voice_start",
            "requestId" to requestId,
            "locale" to Locale.getDefault().toLanguageTag(),
            "sendKeyword" to voiceSettings.sendKeyword,
            "turnControl" to "provider",
            "mode" to "call",
            "workflow" to if (voiceTextOnly) "silent" else "standard",
            "modelTier" to voiceSettings.silentModelTier.wireValue,
            "outputMode" to if (voiceTextOnly) "text" else "voice",
            "provider" to voiceSettings.provider.wireValue,
            "technicalTerms" to voiceSettings.technicalTerms,
        )
        imageAttachment?.let { fields += "imageAttachment" to it.toWireMap() }
        noteVoiceEvent("发起远端会话")
        recordVoiceDiagnostic("remote_start_requested", mapOf("preference" to voiceSettings.provider.wireValue))
        val remoteStarted = client?.sendControl(*fields.toTypedArray()) == true
        if (!remoteStarted) {
            transcriptionRequestId = null
            voiceRemoteReady = false
            showVoiceOfflineQueue()
            return
        }
        showVoiceState(R.string.brain_voice_connecting, VoiceLevelView.Mode.CONNECTING)
    }

    private fun startLocalVoiceCapture() {
        if (voiceCapture != null || voiceModelsLoading) return
        val captureId = UUID.randomUUID().toString()
        voiceCaptureId = captureId
        ensureVoiceModels(captureId)
    }

    private fun stopVoiceInput() {
        handler.removeCallbacks(voiceDebugTicker)
        binding.voiceDebugStatus.text = ""
        voiceListening = false
        voiceCapture?.stop()
        voiceCapture = null
        voiceCaptureId = null
        transcriptionRequestId?.let { requestId ->
            client?.sendControl("t" to "brain_voice_stop", "requestId" to requestId)
        }
        transcriptionRequestId = null
        voiceRemoteReady = false
        voiceAudioOutbox.clear()
        handler.removeCallbacks(restartVoiceRemote)
        handler.removeCallbacks(restorePotentialSpeechPlayback)
        voiceQueueFullNotified = false
        omniResponding = false
        voiceInterruptionPending = false
        voiceBargeInGate.onListening()
        voiceDraft = ""
        omniReplyDraft = ""
        realtimePlayer.interrupt()
        voiceToolCue.stopActivity()
        binding.voiceCallLevel.clear()
        binding.voiceUserCaption.setText(R.string.voice_call_waiting_caption)
        voiceStatusCaptionState.clear()
        binding.voiceBrainCaption.text = ""
        binding.voiceBrainCaption.isVisible = false
        clearVoiceToolView()
        binding.composerStatus.text = ""
        renderVoiceCall()
        updateComposerState()
    }

    private fun stopVoiceConversation(reason: String = "hangup", preserveAttachment: Boolean = false) {
        controlObservation.reset()
        controlGroup = UUID.randomUUID().toString()
        wakeSession.stop()
        handler.removeCallbacks(wakeTicker)
        val wasOwner = VoiceCallOwnership.shared.release(this)
        if (voiceConversation.active) recordVoiceDiagnostic("call_stopped", mapOf("reason" to reason))
        voiceConversation.stop()
        voiceCompletionMessageId = null
        voiceTurnRequestId = null
        pendingSyntheses.values.forEach { pendingSpeechIds.remove(it.messageId) }
        pendingSyntheses.clear()
        stopVoiceInput()
        speaker.stop()
        VoiceCallSpeakerController.detach(callAudioSession)
        callAudioSession.stop()
        if (wasOwner) {
            VoiceCallUiState.setActive(false)
            VoiceCallOverlayService.stop()
        }
        updateKeepScreenAwake()
        voiceTextOnly = false
        renderTextReplyButton()
        if (!preserveAttachment) imageAttachment?.let { attachment ->
            imageAttachmentStore.consume(attachment.actionId)
            imageAttachment = null
        }
        updateImageAttachmentUi()
    }

    private fun startDictation() {
        if (!started || dictation.active || voiceConversation.active) return
        if (!connected || !brainReady || !silentSupported || !dictationSupported) {
            Snackbar.make(binding.root, R.string.silent_host_required, Snackbar.LENGTH_LONG).show()
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            dictationPermission.launch(Manifest.permission.RECORD_AUDIO)
            return
        }
        dictation.start(binding.composerInput.text?.toString().orEmpty(), voiceSettings,
            resources.configuration.locales[0].toLanguageTag())
    }

    private fun activeSilentRequest(): String? =
        pendingRequestId?.takeIf { pendingWorkflow == "silent" }
            ?: SilentModePolicy.activeRequest(latestBrainExecutionEvents)

    private fun cancelSilentExecution() {
        val requestId = activeSilentRequest() ?: return
        MaterialAlertDialogBuilder(this).setMessage(R.string.silent_cancel_detail)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.silent_cancel) { _, _ ->
                if (client?.sendControl("t" to "brain_cancel", "requestId" to requestId) != true) {
                    Snackbar.make(binding.root, R.string.disconnected, Snackbar.LENGTH_LONG).show()
                }
            }.show()
    }

    private fun setTextOnlyReplies(enabled: Boolean) {
        if (!voiceConversation.active) return
        if (enabled && !silentCallSupported) {
            binding.voiceTextButton.isChecked = voiceTextOnly
            Snackbar.make(binding.root, R.string.silent_host_required, Snackbar.LENGTH_LONG).show()
            return
        }
        if (enabled == voiceTextOnly) return
        // Keep call ownership, overlay, history and attachments; replace only its audio/AI lane.
        stopVoiceInput()
        speaker.stop()
        finishPendingSpeechSilently()
        voiceTextOnly = enabled
        renderTextReplyButton()
        beginListening()
    }

    private fun renderTextReplyButton() {
        binding.voiceTextButton.isChecked = voiceTextOnly
        binding.voiceSilentButton.setText(
            if (voiceTextOnly) R.string.voice_silent_execution_active else R.string.voice_silent_execution,
        )
        binding.voiceTextButton.contentDescription = getString(
            if (voiceTextOnly) R.string.voice_silent_execution_active else R.string.voice_silent_execution,
        )
    }

    private fun ensureVoiceModels(captureId: String) {
        voiceModels?.let { startVoiceCapture(captureId, it) } ?: run {
            if (voiceModelsLoading) return
            voiceModelsLoading = true
            voiceModelExecutor.execute {
                val loaded = runCatching { OnDeviceVoiceModels(applicationContext) }
                runOnUiThread {
                    voiceModelsLoading = false
                    if (voiceCaptureId != captureId || !voiceConversation.active) {
                        loaded.getOrNull()?.close()
                        voiceCaptureId?.takeIf { voiceConversation.active }?.let(::ensureVoiceModels)
                        return@runOnUiThread
                    }
                    loaded.onSuccess {
                        voiceModels = it
                        startVoiceCapture(captureId, it)
                    }.onFailure {
                        handleVoiceFailure(it.message ?: getString(R.string.brain_voice_unavailable))
                    }
                }
            }
        }
    }

    private fun startVoiceCapture(captureId: String, models: OnDeviceVoiceModels) {
        val verifySpeaker = voiceSettings.speakerVerificationEnabled
        val profile = VoiceProfileStore(this).load()
        if (verifySpeaker && profile == null) {
            handleVoiceFailure(getString(R.string.brain_voice_profile_required))
            return
        }
        val capture = OnDeviceVoiceCapture(
            models = models,
            profile = profile,
            enrollment = false,
            verifySpeaker = verifySpeaker,
            // Realtime mode keeps cloud semantic endpointing, while the local
            // GTCRN + Silero gate replaces non-speech with digital silence.
            passthrough = !voiceTextOnly,
            noiseFilterEnabled = voiceSettings.noiseFilterEnabled,
            noiseSensitivity = voiceSettings.noiseSensitivity,
            listener = object : OnDeviceVoiceCapture.Listener {
                private val localGate = WakeWordCaptureGate(applicationContext, wakeSession, { voiceSettings.wakeWord }) {
                    runOnUiThread {
                        if (voiceCaptureId == captureId && wakeSession.state == VoiceWakeSession.State.ACTIVE) {
                            recordVoiceDiagnostic("local_wake_detected")
                            startRemoteVoiceSession()
                        }
                    }
                }
                private var frameEpoch = -1L
                private val boundaryMonitor by lazy {
                    LocalBoundaryAudioMonitor(
                        createDecoder = {
                            val files = BoundaryModelFiles(applicationContext)
                            check(files.verify()) { "Local boundary model verification failed" }
                            LocalBoundarySpeechDecoder(files.directory)
                        },
                        onTranscript = { epoch, text ->
                            if (VoiceStopWords.match(text, voiceSettings.stopWords) != null &&
                                voiceCaptureId == captureId && wakeSession.finishInput(epoch) {
                                    // Semantic VAD ignores explicit commit; close the already-authorized
                                    // utterance with digital silence, never more microphone audio.
                                    sealWakeInput()
                                }) {
                                runOnUiThread { finishWakeInput(text) }
                            }
                        },
                        onError = { error -> runOnUiThread {
                            if (voiceCaptureId == captureId) handleVoiceFailure(error.message ?: "Local boundary detector failed")
                        } },
                    )
                }
                private var boundaryMonitorUsed = false

                override fun onLocalFrame(samples: ShortArray): Boolean {
                    if (voiceCaptureId != captureId || wakeSession.state == VoiceWakeSession.State.STOPPED) return false
                    frameEpoch = localGate.accept(samples, android.os.SystemClock.elapsedRealtime()) ?: return false
                    if (voiceSettings.interactionMode == VoiceInteractionMode.WAKE_WORD && BoundaryModelFiles(applicationContext).isReady()) {
                        boundaryMonitorUsed = true
                        boundaryMonitor.accept(samples, frameEpoch)
                    }
                    return true
                }

                override fun onCaptureClosed() {
                    localGate.close()
                    if (boundaryMonitorUsed) boundaryMonitor.close()
                }
                override fun takeAuthorizedPreRoll() = localGate.takeApprovedPreRoll()

                override fun onLevel(level: Float) = runOnUiThread {
                    if (voiceCaptureId == captureId) {
                        voiceDbgFrames += 1
                        val visibleLevel = if (wakeSession.localStandby) level * 0.08f else level
                        binding.voiceCallLevel.setLevel(visibleLevel)
                        VoiceCallUiState.setLevel(visibleLevel)
                    }
                }

                override fun onSpeechGate(audible: Boolean) {
                    voiceDbgAudible = audible
                }

                override fun onSpeechProbability(probability: Float, threshold: Float) {
                    if (voiceSettings.boundaryLearningEnabled && wakeSession.state == VoiceWakeSession.State.ACTIVE) {
                        controlObservation.frame(probability, android.os.SystemClock.elapsedRealtime())
                    }
                    voiceDbgProbability = probability
                    voiceDbgThreshold = threshold
                    if (probability > voiceDbgProbabilityPeak) voiceDbgProbabilityPeak = probability
                }

                override fun onSpeechDetected() = runOnUiThread {
                    if (voiceCaptureId == captureId && wakeSession.state == VoiceWakeSession.State.ACTIVE) {
                        recordVoiceDiagnostic(
                            "speech_candidate",
                            mapOf(
                                "vadProbability" to voiceDbgProbability,
                                "vadThreshold" to voiceDbgThreshold,
                            ),
                        )
                        if (
                            voiceBargeInGate.onPotentialSpeechStarted(
                                assistantResponding = omniResponding,
                                localPlaybackActive = realtimePlayer.hasPendingOutput(),
                            )
                        ) {
                            realtimePlayer.muteForVerification()
                            handler.removeCallbacks(restorePotentialSpeechPlayback)
                            handler.postDelayed(
                                restorePotentialSpeechPlayback,
                                POTENTIAL_SPEECH_MUTE_MS,
                            )
                        }
                        showVoiceState(R.string.brain_voice_verifying, VoiceLevelView.Mode.LISTENING)
                    }
                }

                override fun onAuthorizedSpeechDetected() = runOnUiThread {
                    if (voiceCaptureId == captureId && wakeSession.state == VoiceWakeSession.State.ACTIVE) {
                        wakeSession.userSpeech()
                        recordVoiceDiagnostic("speech_accepted")
                        handler.removeCallbacks(restorePotentialSpeechPlayback)
                        if (
                            voiceBargeInGate.onAuthorizedSpeechStarted(
                                assistantResponding = omniResponding,
                                localPlaybackActive = realtimePlayer.hasPendingOutput(),
                            )
                        ) {
                            voiceInterruptionPending = true
                            realtimePlayer.interrupt()
                            speaker.stop()
                            omniResponding = false
                        }
                        showListeningStatus()
                    }
                }

                override fun onAuthorizedAudio(pcm16: ByteArray) {
                    wakeSession.forward(frameEpoch) {
                        if (voiceCaptureId != captureId) return@forward
                        if (!voiceAudioOutbox.offerAudio(pcm16)) {
                            runOnUiThread {
                                noteVoiceEvent("丢弃: 本机缓存满")
                                recordVoiceDiagnostic("audio_queue_full")
                                if (!voiceQueueFullNotified && voiceCaptureId == captureId) {
                                    voiceQueueFullNotified = true
                                    Snackbar.make(binding.root, R.string.brain_voice_queue_full, Snackbar.LENGTH_LONG).show()
                                }
                            }
                            return@forward
                        }
                        voiceDbgCapturedBytes += pcm16.size
                        flushVoiceAudioOutbox()
                    }
                }

                override fun onUtteranceCommitted() {
                    if (!wakeSession.forward(frameEpoch) {
                        if (voiceCaptureId == captureId) {
                            voiceAudioOutbox.offerCommit()
                            flushVoiceAudioOutbox()
                        }
                    }) return
                    runOnUiThread {
                        if (voiceCaptureId == captureId) {
                            recordVoiceDiagnostic(
                                "utterance_committed",
                                mapOf("capturedBytes" to voiceDbgCapturedBytes, "sentBytes" to voiceDbgSentBytes),
                            )
                            if (voiceRemoteReady) showListeningStatus() else showVoiceOfflineQueue()
                        }
                    }
                }

                override fun onVoiceRejected() = runOnUiThread {
                    if (voiceCaptureId != captureId) return@runOnUiThread
                    recordVoiceDiagnostic("speech_rejected")
                    handler.removeCallbacks(restorePotentialSpeechPlayback)
                    if (voiceBargeInGate.onPotentialSpeechRejected()) {
                        realtimePlayer.resumeAfterRejectedSpeech()
                    }
                    voiceInterruptionPending = false
                    showVoiceState(R.string.brain_voice_ignored, VoiceLevelView.Mode.LISTENING)
                    handler.postDelayed({
                        if (voiceCaptureId == captureId) {
                            restoreVoiceStateAfterRejectedSpeech()
                        }
                    }, VOICE_REJECTED_MESSAGE_MS)
                }

                override fun onEnrollmentSample(embedding: FloatArray) = Unit

                override fun onError(message: String) = runOnUiThread {
                    if (voiceCaptureId == captureId) handleVoiceFailure(
                        if (message == OnDeviceVoiceCapture.SPEAKER_MODEL_UNAVAILABLE)
                            getString(R.string.brain_voice_speaker_unavailable) else message,
                    )
                }
            },
        )
        voiceCapture = capture
        voiceListening = capture.start()
        if (!voiceListening) {
            voiceCapture = null
            handleVoiceFailure(getString(R.string.brain_voice_unavailable))
            return
        }
        if (voiceRemoteReady) showListeningStatus() else showVoiceOfflineQueue()
    }

    private fun flushVoiceAudioOutbox() {
        if (!wakeSession.canDrainAuthorizedAudio) return
        val requestId = transcriptionRequestId
        if (requestId == null) {
            noteVoiceEvent("拦截: 无远端会话(requestId=null)")
            return
        }
        if (!voiceRemoteReady) {
            noteVoiceEvent("拦截: 远端未就绪(ready=false)")
            return
        }
        val sent = voiceAudioOutbox.flush(
            sendAudio = { pcm16 ->
                val ok = client?.sendControl(
                    "t" to "brain_voice_input_audio",
                    "requestId" to requestId,
                    "data" to pcm16,
                ) == true
                if (ok) voiceDbgSentBytes += pcm16.size
                ok
            },
            sendCommit = {
                client?.sendControl("t" to "brain_voice_commit", "requestId" to requestId) == true
            },
        )
        if (!sent) runOnUiThread {
            noteVoiceEvent("发送失败: 连接断开")
            if (transcriptionRequestId == requestId && voiceConversation.active) {
                showConnectionFailure(getString(R.string.disconnected))
            }
        }
    }

    private fun handleRealtimeVoiceReady(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        if (requestId != transcriptionRequestId || !voiceConversation.active) return
        voiceRemoteReady = true
        syncVoicePresentation()
        activeVoiceProvider = message.string("provider")
        activeVoiceModel = message.string("model")
        voiceConnectLatencyMs = message.int("connectLatencyMs") ?: 0
        noteVoiceEvent("远端就绪: ${voiceProviderDisplayName(activeVoiceProvider)}")
        renderVoiceProviderStatus()
        recordVoiceDiagnostic(
            "remote_ready",
            mapOf(
                "model" to activeVoiceModel,
                "connectLatencyMs" to voiceConnectLatencyMs,
            ),
        )
        flushVoiceAudioOutbox()
        showListeningStatus()
    }

    private fun handleRealtimeTranscript(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        if (requestId != transcriptionRequestId || !voiceConversation.active) return
        val text = message.string("text")?.trim().orEmpty()
        if (text.isEmpty()) return
        noteVoiceEvent("转写: ${text.take(14)}")
        if (message.boolean("final") != true) {
            voiceDraft = text
            showVoiceDraft(voiceDraft)
            return
        }
        voiceAudioOutbox.acknowledgeTranscript()
        flushVoiceAudioOutbox()
        val features = controlObservation.snapshot(android.os.SystemClock.elapsedRealtime(),
            realtimePlayer.hasPendingOutput(), boundaryPreviousUser.isNotEmpty(),
            voiceSettings.interactionMode == VoiceInteractionMode.WAKE_WORD)
        val group = controlGroup
        val previousContext = boundaryPreviousUser
        if (features != null) voiceModelExecutor.execute {
            runCatching {
                val learning = com.termbridge.android.brain.personalization.PersonalControlStore(applicationContext)
                if (learning.record(group, features, text = text, context = previousContext)) {
                    val model = learning.model()
                    // Local diagnostics only. This head cannot open the microphone or modify a caption.
                    VoiceDiagnostics.record(applicationContext, "control_shadow", null, "local",
                        mapOf("version" to model.version, "samples" to model.samples,
                            "addressedProbability" to model.probability("addressed", features),
                            "finishedProbability" to model.probability("finished", features)))
                }
            }
        }
        boundaryPreviousUser = text.takeLast(1000)
        voiceDraft = text
        realtimePlayer.interrupt()
        omniResponding = false
        voiceInterruptionPending = false
        showVoiceDraft(voiceDraft)
        voiceConversation.transcriptionSent()
        showVoiceState(R.string.brain_voice_waiting, VoiceLevelView.Mode.THINKING)
    }

    private fun handleRealtimeAudio(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        if (requestId != transcriptionRequestId || !voiceConversation.active) return
        if (voiceInterruptionPending || voiceTextOnly) return
        val audio = message.bytes("data") ?: return
        if (!realtimePlayer.enqueue(audio, message.int("sampleRate") ?: 24_000)) {
            handleVoiceFailure(getString(R.string.brain_voice_audio_failed))
        }
    }

    private fun handleRealtimeText(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        if (requestId != transcriptionRequestId || !voiceConversation.active) return
        val text = message.string("text").orEmpty()
        if (message.boolean("final") == true) {
            omniReplyDraft = text.trim()
        } else {
            omniReplyDraft += text
        }
        val preview = omniReplyDraft.trim().takeLast(MAX_REALTIME_REPLY_PREVIEW_CHARS)
        if (preview.isNotEmpty()) {
            voiceStatusCaptionState.showContent()
            contentMarkdown.bind(binding.voiceBrainCaption, preview)
            binding.voiceBrainCaption.isVisible = true
        }
    }

    private fun handleRealtimeStatus(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        if (requestId != transcriptionRequestId || !voiceConversation.active) return
        when (message.string("status")) {
            "responding" -> {
                wakeSession.responseStarted()
                noteVoiceEvent("远端回复中")
                val latencyMs = message.int("latencyMs")
                if (latencyMs != null) {
                    renderVoiceProviderStatus(latencyMs)
                    recordVoiceDiagnostic("response_started", mapOf("latencyMs" to latencyMs))
                }
                handler.removeCallbacks(restorePotentialSpeechPlayback)
                voiceToolCue.stopActivity()
                realtimePlayer.resumeAfterRejectedSpeech()
                omniResponding = true
                voiceInterruptionPending = false
                voiceBargeInGate.onResponseStarted()
                omniReplyDraft = ""
                voiceConversation.transcriptionSent()
                showVoiceState(R.string.brain_voice_waiting, VoiceLevelView.Mode.THINKING)
            }
            "listening" -> {
                if (message.string("turnWaitReason") != null) {
                    // A pause decision is not response.done: retain captions and the pending thought.
                    voiceConversation.speechFinished()
                    omniResponding = false
                    showVoiceState(if (message.string("turnWaitReason") == "incomplete")
                        R.string.voice_learning_waiting else R.string.voice_learning_judge_unavailable, VoiceLevelView.Mode.LISTENING)
                    return
                }
                if (omniReplyDraft.isNotBlank()) boundaryPreviousAssistant = omniReplyDraft.takeLast(1000)
                wakeSession.responseFinished(omniReplyDraft.isNotBlank(), android.os.SystemClock.elapsedRealtime())
                noteVoiceEvent("远端聆听中")
                handler.removeCallbacks(restorePotentialSpeechPlayback)
                voiceToolCue.stopActivity()
                realtimePlayer.resumeAfterRejectedSpeech()
                omniResponding = false
                voiceInterruptionPending = false
                voiceBargeInGate.onListening()
                voiceDraft = ""
                omniReplyDraft = ""
                realtimePlayer.finishResponse()
                flushVoiceAudioOutbox()
            }
            "tool" -> {
                wakeSession.toolActivity(message.string("toolPhase") == "started")
                recordVoiceDiagnostic(
                    "tool_${message.string("toolPhase") ?: "active"}",
                    mapOf("toolName" to (message.string("toolName") ?: "unknown")),
                )
                binding.voiceCallLevel.setMode(VoiceLevelView.Mode.TOOL)
                VoiceCallUiState.setMode(VoiceLevelView.Mode.TOOL)
                if (message.string("toolPhase") == "started" && !voiceTextOnly) {
                    voiceToolCue.startActivity()
                } else {
                    voiceToolCue.stopActivity()
                }
                val summary = message.string("toolSummary")?.trim().orEmpty()
                if (summary.isNotEmpty()) {
                    voiceStatusCaptionState.showContent()
                    contentMarkdown.bind(binding.voiceBrainCaption, summary)
                    binding.voiceBrainCaption.isVisible = true
                } else {
                    showVoiceState(R.string.brain_voice_using_tool, VoiceLevelView.Mode.TOOL)
                }
            }
            "notification" -> {
                if (message.string("notificationKind") == "agent_completion" && !voiceTextOnly) {
                    voiceToolCue.playNotification()
                }
            }
            "echo" -> {
                voiceInterruptionPending = false
                voiceDraft = ""
                binding.voiceUserCaption.setText(R.string.voice_call_waiting_caption)
                if (omniResponding) {
                    showVoiceState(R.string.brain_voice_speaking, VoiceLevelView.Mode.SPEAKING)
                } else {
                    showListeningStatus()
                }
            }
        }
    }

    private fun handleRealtimeToolResult(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        if (requestId != transcriptionRequestId || !voiceConversation.active) return
        val view = message.voiceToolView() ?: return
        showVoiceToolView(view)
    }

    private fun showVoiceToolView(view: VoiceToolViewInfo) {
        binding.voiceToolResult.bind(view, ::openVoiceToolItem, contentMarkdown)
        binding.voiceToolResultPanel.isVisible = view.items.isNotEmpty()
    }

    private fun clearVoiceToolView() {
        binding.voiceToolResult.clear()
        binding.voiceToolResultPanel.isVisible = false
    }

    private fun handleRealtimeVoiceError(message: ControlMessage) {
        noteVoiceEvent("远端错误: ${message.string("error")?.take(24) ?: "未知"}")
        val requestId = message.string("requestId") ?: return
        if (requestId != transcriptionRequestId) return
        recordVoiceDiagnostic("remote_failed", mapOf("failure" to "host_realtime_error"))
        markVoiceRemoteUnavailable(
            message.string("error") ?: getString(R.string.brain_voice_remote_unavailable),
        )
    }

    private fun handleRealtimeVoiceStopped(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        if (requestId != transcriptionRequestId || !voiceConversation.active) return
        noteVoiceEvent("远端停止了会话")
        recordVoiceDiagnostic("remote_stopped")
        markVoiceRemoteUnavailable(getString(R.string.brain_voice_remote_unavailable))
    }

    private fun handleTranscriptionResult(message: ControlMessage) {
        val requestId = message.string("requestId")
        if (requestId == null || requestId != transcriptionRequestId) return
        val error = message.string("error")
        if (error != null) {
            handleVoiceFailure(error)
            return
        }
        val text = message.string("text")?.trim().orEmpty()
        if (text.isEmpty()) return
        if (message.boolean("final") != true) {
            showVoiceDraft(VoiceSendCommand.append(voiceDraft, text))
            return
        }
        val command = VoiceSendCommand.parse(text, voiceSettings.sendKeyword)
        voiceDraft = VoiceSendCommand.append(voiceDraft, command.text)
        showVoiceDraft(voiceDraft)
        if (!command.shouldSend) {
            showListeningStatus()
            return
        }
        if (voiceDraft.isBlank()) {
            showListeningStatus()
            return
        }
        finishTranscriptionForSend(requestId)
        sendMessage()
    }

    private fun showListeningStatus() {
        if (wakeSession.state == VoiceWakeSession.State.DRAINING) {
            showVoiceState(R.string.voice_boundary_input_closed, VoiceLevelView.Mode.WAITING_WAKE)
            return
        }
        if (wakeSession.state == VoiceWakeSession.State.WAITING) { showWakeStandby(); return }
        if (voiceRemoteReady) {
            if (voiceStatusCaptionState.clearOfflineForRemoteReady()) {
                binding.voiceBrainCaption.text = ""
                binding.voiceBrainCaption.isVisible = false
            }
            showVoiceState(R.string.brain_voice_listening, VoiceLevelView.Mode.LISTENING)
        } else {
            showVoiceOfflineQueue()
        }
    }

    private fun restoreVoiceStateAfterRejectedSpeech() {
        if (!voiceConversation.active) return
        if (omniResponding || realtimePlayer.hasPendingOutput()) {
            showVoiceState(R.string.brain_voice_speaking, VoiceLevelView.Mode.SPEAKING)
        } else {
            showListeningStatus()
        }
    }

    private fun showVoiceState(@StringRes label: Int, mode: VoiceLevelView.Mode) {
        binding.voiceCallPanel.contentDescription = getString(label)
        binding.voiceCallLevel.setMode(mode)
        if (VoiceCallOwnership.shared.owns(this)) VoiceCallUiState.setMode(mode)
    }

    private fun showVoiceOfflineQueue() {
        if (!voiceConversation.active) return
        if (wakeSession.state == VoiceWakeSession.State.WAITING) { showWakeStandby(); return }
        showVoiceState(R.string.brain_voice_offline, VoiceLevelView.Mode.CONNECTING)
        voiceStatusCaptionState.showOffline()
        binding.voiceBrainCaption.text = getString(
            R.string.brain_voice_offline_queueing,
            voiceAudioOutbox.pendingTurnCount,
        )
        binding.voiceBrainCaption.isVisible = true
    }

    private fun showVoiceDraft(text: String) {
        binding.voiceUserCaption.text = text.ifBlank { getString(R.string.voice_call_waiting_caption) }
    }

    private fun finishTranscriptionForSend(requestId: String) {
        voiceListening = false
        voiceCapture?.stop()
        voiceCapture = null
        client?.sendControl("t" to "brain_transcribe_finish", "requestId" to requestId)
        transcriptionRequestId = null
        binding.voiceCallLevel.clear()
    }

    private fun showVoiceCall() {
        binding.voiceUserCaption.setText(R.string.voice_call_waiting_caption)
        voiceStatusCaptionState.clear()
        binding.voiceBrainCaption.text = ""
        binding.voiceBrainCaption.isVisible = false
        clearVoiceToolView()
        renderVoiceProviderStatus()
        renderVoiceCall()
    }

    private fun renderConversationSurface() {
        val visible = BrainSurfaceVisibility.resolve(voiceConversation.active, timelineHasItems)
        binding.voiceCallPanel.isVisible = visible.call
        binding.timeline.isVisible = visible.timeline
        binding.emptyState.isVisible = visible.empty
    }

    private fun renderVoiceCall() {
        val active = voiceConversation.active
        renderConversationSurface()
        binding.voiceInteractionMode.setText(interactionModeLabel(voiceSettings.interactionMode))
        binding.voiceProviderStatus.isVisible = active
        binding.toolbar.isVisible = !active
        binding.connectionBar.isVisible = !active
        binding.topDivider.isVisible = !active
        binding.bottomDivider.isVisible = !active
        binding.composerPanel.isVisible = !active
        binding.root.setBackgroundColor(ContextCompat.getColor(
            this,
            if (active) R.color.voice_stage_background else R.color.paper,
        ))
        ViewCompat.requestApplyInsets(binding.root)
        window.statusBarColor = ContextCompat.getColor(
            this,
            if (active) android.R.color.transparent else R.color.paper,
        )
        window.navigationBarColor = ContextCompat.getColor(
            this,
            if (active) android.R.color.transparent else R.color.navigation_bar,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = !active
            window.navigationBarDividerColor = if (active) Color.TRANSPARENT else ContextCompat.getColor(
                this,
                R.color.navigation_bar,
            )
        }
        WindowCompat.getInsetsController(window, binding.root).apply {
            isAppearanceLightStatusBars = !active && resources.getBoolean(R.bool.light_system_bars)
            isAppearanceLightNavigationBars = false
        }
        updateKeepScreenAwake()
    }

    private fun renderVoiceProviderStatus(responseLatencyMs: Int? = null) {
        val model = activeVoiceModel.orEmpty().ifBlank { "—" }
        val latency = responseLatencyMs ?: voiceConnectLatencyMs
        val provider = activeVoiceProvider ?: voiceSettings.provider.wireValue
        binding.voiceProviderStatus.text = when (provider) {
            "bailian" -> getString(R.string.voice_provider_compact_bailian)
            "volcengine" -> getString(R.string.voice_provider_compact_volcengine)
            else -> getString(R.string.voice_provider_compact_auto)
        }
        binding.voiceProviderStatus.contentDescription = when (activeVoiceProvider) {
            "bailian" -> getString(R.string.voice_provider_active_bailian, model, latency)
            "volcengine" -> getString(R.string.voice_provider_active_volcengine, model, latency)
            else -> getString(R.string.voice_provider_connecting, voiceProviderDisplayName(provider))
        }
    }

    private fun showVoiceProviderMenu() {
        val current = voiceSettings.provider
        PopupMenu(this, binding.voiceProviderStatus).apply {
            VoiceProviderPreference.entries.forEachIndexed { index, provider ->
                menu.add(0, index + 1, index, voiceProviderDisplayName(provider.wireValue)).apply {
                    isCheckable = true
                    isChecked = provider == current
                }
            }
            setOnMenuItemClickListener { item ->
                val provider = VoiceProviderPreference.entries.getOrNull(item.itemId - 1)
                    ?: return@setOnMenuItemClickListener false
                switchVoiceProvider(provider)
                true
            }
            show()
        }
    }

    private fun interactionModeLabel(mode: VoiceInteractionMode): Int = when (mode) {
        VoiceInteractionMode.CONTINUOUS -> R.string.voice_mode_continuous
        VoiceInteractionMode.WAKE_WORD -> R.string.voice_mode_wake_word
    }

    private fun showVoiceInteractionMenu() {
        PopupMenu(this, binding.voiceInteractionMode).apply {
            VoiceInteractionMode.entries.forEachIndexed { index, mode ->
                menu.add(0, index, index, interactionModeLabel(mode)).apply {
                    isCheckable = true
                    isChecked = voiceSettings.interactionMode == mode
                }
            }
            setOnMenuItemClickListener { item ->
                VoiceInteractionMode.entries.getOrNull(item.itemId)?.let(::switchVoiceInteractionMode)
                true
            }
            show()
        }
    }

    private fun switchVoiceInteractionMode(mode: VoiceInteractionMode) {
        if (!ensureWakeBoundaryModel(mode)) return
        // Revoke first; old frames, offline turns and delayed remote events must not cross modes.
        wakeSession.stop()
        closeWakeRemoteSession()
        voiceSettings = VoiceSettingsStore(this).setInteractionMode(mode)
        if (voiceConversation.active) {
            wakeSession.start(mode, android.os.SystemClock.elapsedRealtime())
            callAudioSession.setStandby(mode == VoiceInteractionMode.WAKE_WORD)
            if (mode == VoiceInteractionMode.WAKE_WORD) showWakeStandby() else startRemoteVoiceSession()
        }
        renderVoiceCall()
    }

    private fun ensureWakeBoundaryModel(mode: VoiceInteractionMode): Boolean {
        if (mode != VoiceInteractionMode.WAKE_WORD || BoundaryModelFiles(this).isReady()) return true
        showWakeBoundaryPreparation()
        return false
    }

    /** Never launch Settings or silently fall back to continuous cloud capture. */
    private fun showWakeBoundaryPreparation() {
        binding.boundaryPreparation.isVisible = true
        binding.boundaryPrepareButton.setOnClickListener {
            if (BoundaryModelFiles(this).isReady()) {
                binding.boundaryPreparation.isVisible = false
                switchVoiceInteractionMode(VoiceInteractionMode.WAKE_WORD)
                startVoiceInput()
            } else downloadWakeBoundaryModel()
        }
        binding.boundaryContinuousButton.setOnClickListener {
            binding.boundaryPreparation.isVisible = false
            switchVoiceInteractionMode(VoiceInteractionMode.CONTINUOUS)
            startVoiceInput()
        }
    }

    private fun downloadWakeBoundaryModel() {
        if (boundaryDownloadRunning) return
        boundaryDownloadRunning = true
        binding.boundaryPrepareButton.isEnabled = false
        // Explicit tap authorizes this large download on the user's current network.
        binding.boundaryPreparationStatus.text = getString(R.string.voice_boundary_prepare_progress, 0)
        val files = BoundaryModelFiles(applicationContext)
        boundaryDownloadExecutor.execute {
            var lastPercent = -1
            val result = runCatching {
                files.install { percent ->
                    if (percent != lastPercent) {
                        lastPercent = percent
                        runOnUiThread {
                            if (!isDestroyed) binding.boundaryPreparationStatus.text =
                                getString(R.string.voice_boundary_prepare_progress, percent)
                        }
                    }
                }
            }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                boundaryDownloadRunning = false
                binding.boundaryPrepareButton.isEnabled = true
                binding.boundaryPrepareButton.setText(if (result.isSuccess)
                    R.string.voice_boundary_prepare_start else R.string.voice_boundary_prepare_download)
                binding.boundaryPreparationStatus.setText(if (result.isSuccess)
                    R.string.voice_boundary_prepare_ready else R.string.voice_boundary_prepare_failed)
                // Do not open the microphone after a background download or a mode switch.
            }
        }
    }

    private fun closeWakeRemoteSession() {
        val requestId = transcriptionRequestId
        transcriptionRequestId = null
        voiceRemoteReady = false
        if (requestId != null) client?.sendControl("t" to "brain_voice_stop", "requestId" to requestId)
        voiceAudioOutbox.clear()
        handler.removeCallbacks(restartVoiceRemote)
        handler.removeCallbacks(restorePotentialSpeechPlayback)
        realtimePlayer.interrupt()
        speaker.stop()
        voiceToolCue.stopActivity()
        omniResponding = false
        voiceInterruptionPending = false
        voiceBargeInGate.onListening()
        activeVoiceProvider = null
        activeVoiceModel = null
    }

    private fun parkForWakeWord() {
        wakeSession.park()
        closeWakeRemoteSession()
        callAudioSession.setStandby(true)
        recordVoiceDiagnostic("local_wake_standby", mapOf("sentBytes" to voiceDbgSentBytes))
        showWakeStandby()
    }

    private fun sealWakeInput() {
        voiceAudioOutbox.offerAudio(ByteArray(16_000 * 2 * 2))
        voiceAudioOutbox.offerCommit()
    }

    private fun finishWakeInput(localTranscript: String?) {
        if (!voiceConversation.active || wakeSession.state != VoiceWakeSession.State.DRAINING) return
        flushVoiceAudioOutbox()
        recordVoiceDiagnostic("local_input_stopped", mapOf("detector" to if (localTranscript == null) "privacy_timeout" else "sensevoice-2024-stop-v1"))
        // Text samples only; recording rechecks the persisted consent at write time.
        if (localTranscript != null) {
            val example = VoiceBoundaryLearningStore.Example(
                UUID.randomUUID().toString(), VoiceBoundaryLearningStore.Label.MANUAL_END,
                boundaryPreviousUser, boundaryPreviousAssistant, localTranscript,
                "sensevoice-2024-stop-v1",
            )
            voiceModelExecutor.execute { runCatching { VoiceBoundaryLearningStore(applicationContext).record(example) } }
        }
        binding.voiceUserCaption.setText(R.string.voice_boundary_input_closed)
        if (!omniResponding && !realtimePlayer.hasPendingOutput()) {
            callAudioSession.setStandby(true)
            showVoiceState(R.string.voice_boundary_input_closed, VoiceLevelView.Mode.WAITING_WAKE)
        }
        // Keep requestId, tool state, playback, and remote session: only new input was revoked.
    }

    private fun showWakeStandby() {
        showVoiceState(R.string.voice_wake_standby, VoiceLevelView.Mode.WAITING_WAKE)
        binding.voiceUserCaption.text = getString(R.string.voice_wake_hint, voiceSettings.wakeWord)
        binding.voiceProviderStatus.setText(R.string.voice_wake_local)
        if (voiceStatusCaptionState.clearOfflineForRemoteReady()) {
            binding.voiceBrainCaption.text = ""
            binding.voiceBrainCaption.isVisible = false
        }
    }

    private fun switchVoiceProvider(provider: VoiceProviderPreference) {
        if (provider == voiceSettings.provider) return
        voiceSettings = VoiceSettingsStore(this).setProvider(provider)
        renderVoiceProviderStatus()
        if (!voiceConversation.active) return

        val previousRequestId = transcriptionRequestId
        previousRequestId?.let { requestId ->
            client?.sendControl("t" to "brain_voice_stop", "requestId" to requestId)
        }
        transcriptionRequestId = null
        voiceRemoteReady = false
        activeVoiceProvider = null
        activeVoiceModel = null
        voiceConnectLatencyMs = 0
        realtimePlayer.interrupt()
        speaker.stop()
        renderVoiceProviderStatus()
        showVoiceState(R.string.brain_voice_connecting, VoiceLevelView.Mode.CONNECTING)
        startRemoteVoiceSession()
    }

    private fun voiceProviderDisplayName(provider: String?): String = getString(
        when (provider) {
            "bailian" -> R.string.voice_provider_bailian
            "volcengine" -> R.string.voice_provider_volcengine
            else -> R.string.voice_provider_auto
        },
    )

    private fun recordVoiceDiagnostic(event: String, fields: Map<String, Any?> = emptyMap()) {
        val provider = activeVoiceProvider ?: voiceSettings.provider.wireValue
        VoiceDiagnostics.record(
            this,
            event,
            transcriptionRequestId,
            provider,
            fields,
        )
        if (!connected) return
        val wire = mutableListOf<Pair<String, Any?>>(
            "t" to "brain_voice_diagnostic",
            "event" to event,
            "provider" to provider,
            "fields" to fields,
        )
        transcriptionRequestId?.let { wire += "requestId" to it }
        client?.sendControl(*wire.toTypedArray())
    }

    private fun updateKeepScreenAwake() {
        if (SilentModePolicy.keepAwake(voiceSettings.keepScreenAwake, started, voiceConversation.active || dictation.active, activeSilentRequest() != null)) {
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    private fun speak(messageId: String, text: String): Boolean {
        if (!connected) return false
        val requestId = UUID.randomUUID().toString()
        val sent = client?.sendControl(
            "t" to "brain_synthesize",
            "requestId" to requestId,
            "text" to BrainSpeechText.normalize(text),
            "locale" to BrainSpeechText.localeFor(text).toLanguageTag(),
        ) == true
        if (sent) {
            pendingSyntheses[requestId] = PendingSynthesis(messageId)
            return true
        }
        return false
    }

    private fun handleSynthesisResult(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        val speech = pendingSyntheses.remove(requestId) ?: return
        if (voiceTextOnly && voiceConversation.active) {
            pendingSpeechIds.remove(speech.messageId)
            finishPendingSpeechSilently()
            return
        }
        val audio = message.bytes("data")
        if (message.string("error") == null && audio != null && speaker.play(speech.messageId, audio)) return
        pendingSpeechIds.remove(speech.messageId)
        if (speech.messageId == voiceCompletionMessageId) stopVoiceConversation()
        Snackbar.make(binding.root, R.string.brain_tts_unavailable, Snackbar.LENGTH_LONG).show()
    }

    private fun finishPendingSpeechSilently() {
        pendingSyntheses.values.forEach { pendingSpeechIds.remove(it.messageId) }
        pendingSyntheses.clear()
        if (voiceCompletionMessageId == null) return
        voiceCompletionMessageId = null
        voiceTurnRequestId = null
        if (voiceConversation.speechFinished() && started && connected) beginListening()
    }

    private fun handleVoiceFailure(message: String) {
        stopVoiceConversation()
        Snackbar.make(binding.root, message, Snackbar.LENGTH_LONG).show()
    }

    private fun markVoiceRemoteUnavailable(message: String) {
        voiceRemoteReady = false
        transcriptionRequestId = null
        voiceAudioOutbox.beginNewRemoteSession()
        if (!voiceConversation.active) return
        showVoiceOfflineQueue()
        binding.voiceBrainCaption.text = message
        if (!message.contains("not configured", ignoreCase = true)) {
            handler.removeCallbacks(restartVoiceRemote)
            handler.postDelayed(restartVoiceRemote, VOICE_REMOTE_RETRY_MS)
        }
    }

    private fun spokenPreferenceKey(): String = "spoken:${SettingsStore.load(this).hostId.ifBlank { "default" }}"

    private fun loadSpokenMessageIds(): Set<String> =
        getSharedPreferences(PREFERENCES, MODE_PRIVATE).getStringSet(spokenPreferenceKey(), emptySet())?.toSet().orEmpty()

    private fun saveSpokenMessageIds(ids: Set<String>, currentMessages: List<BrainMessageInfo>) {
        val currentIds = currentMessages.takeLast(MAX_SPOKEN_MESSAGES).map { it.id }.toSet()
        getSharedPreferences(PREFERENCES, MODE_PRIVATE).edit {
            putStringSet(spokenPreferenceKey(), (ids intersect currentIds).toSet())
        }
    }

    private fun rejectToolRequest(message: ControlMessage) {
        val id = message.string("id") ?: return
        client?.sendControl(
            "t" to "tool_response",
            "id" to id,
            "ok" to false,
            "error" to "The Android Brain does not expose peer tools",
        )
    }

    companion object {
        private const val PREFERENCES = "brain_preferences"
        private const val MAX_REALTIME_REPLY_PREVIEW_CHARS = 96
        private const val RECONNECT_DELAY_MS = 3_000L
        private const val SNAPSHOT_REFRESH_MS = 1_500L
        private const val CONFIRMATION_TIMEOUT_MS = 15_000L
        private const val MAX_SPOKEN_MESSAGES = 200
        private const val VOICE_REJECTED_MESSAGE_MS = 1_200L
        private const val POTENTIAL_SPEECH_MUTE_MS = 750L
        private const val VOICE_REMOTE_RETRY_MS = 3_000L
        private const val MAX_OFFLINE_VOICE_BYTES = 64 * 1024 * 1024
        private const val STATE_SOURCE_SESSION_ID = "brain_source_session_id"

        private const val ACTION_GLOBAL_CALL = "com.termbridge.android.action.GLOBAL_CALL"
        private const val ACTION_SAMSUNG_SIDE_KEY_DOUBLE_PRESS_SETTINGS =
            "com.samsung.android.intent.action.SIDE_KEY_DOUBLE_PRESS_SETTINGS"
        private const val EXTRA_START_GLOBAL_CALL = "com.termbridge.android.extra.START_GLOBAL_CALL"
        private const val EXTRA_SOURCE_SESSION_ID = "com.termbridge.android.extra.SOURCE_SESSION_ID"
        private const val EXTRA_CLEAR_SOURCE_SESSION = "com.termbridge.android.extra.CLEAR_SOURCE_SESSION"

        fun intent(context: Context): Intent = Intent(context, BrainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP)

        fun globalIntent(context: Context): Intent = intent(context).apply {
            putExtra(EXTRA_CLEAR_SOURCE_SESSION, true)
        }

        fun fromSessionIntent(context: Context, sessionId: String): Intent =
            intent(context).putExtra(EXTRA_SOURCE_SESSION_ID, sessionId.take(256))

        fun globalCallIntent(context: Context): Intent = globalIntent(context).apply {
            putExtra(EXTRA_START_GLOBAL_CALL, true)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }
}
