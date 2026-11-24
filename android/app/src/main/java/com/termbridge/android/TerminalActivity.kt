package com.termbridge.android

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.widget.doAfterTextChanged
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.button.MaterialButton
import com.google.android.material.snackbar.Snackbar
import com.termbridge.android.desktop.RemoteDesktopActivity
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.chat.AgentChatActivity
import com.termbridge.android.chat.SessionHostPin
import com.termbridge.android.chat.SessionPin
import com.termbridge.android.chat.SessionPinHandoff
import com.termbridge.android.chat.SessionUi
import com.termbridge.android.chat.SessionUiSettings
import com.termbridge.android.brain.BrainActivity
import com.termbridge.android.brain.VoiceCallUiState
import com.termbridge.android.brain.VoiceSettingsStore
import com.termbridge.android.databinding.ActivityTerminalBinding
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.notifications.AgentMonitorService
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.review.ReviewActivity
import com.termbridge.android.terminal.TerminalWebView
import com.termbridge.android.ui.applyWindowInsets
import com.termbridge.android.watch.WatchGatewayService
import java.util.UUID
import java.util.concurrent.Executors

class TerminalActivity : AppCompatActivity(), TermbridgeClient.Listener, TerminalWebView.Listener {
    private lateinit var binding: ActivityTerminalBinding
    private val handler = Handler(Looper.getMainLooper())
    private var client: TermbridgeClient? = null
    private var started = false
    private var terminalReady = false
    private var fatal = false
    private var sid: Int? = null
    private var sessionId: String? = null
    private var hostId: String? = null
    /** The Host identity this window keeps, independent of the app's current profile. */
    private var pin: SessionPin? = null
    private var cols = 80
    private var rows = 24
    private var connectGeneration = 0
    private lateinit var agent: String
    private lateinit var displayName: String
    private var isHerdr = false
    private var reconnectingMode = false
    private var deleteRequested = false
    private var reviewProbeRequestId: String? = null
    private var reviewAvailable = false
    private var reviewMode = "working"
    private var keepVoiceScreenAwake = true
    private var voiceMiniActive: Boolean? = null
    /** Retained across rotation, so the terminal keeps its uploads too. */
    private val attachmentsModel: ComposerAttachmentsViewModel by viewModels()
    private lateinit var attachments: ComposerAttachments
    private val imagePicker = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        uris.forEach { attachments.queue(it) }
    }
    /**
     * The terminal earns the right to upload by having this session attached:
     * the Host refuses an upload aimed at a session this socket does not hold.
     */
    private val composerOwner = object : ComposerAttachments.Owner {
        override fun attachmentSessionId(): String? = sessionId
        override fun uploadReady(): Boolean = started && sid != null && client != null
        override fun sendUpload(requestId: String, sessionId: String, image: EncodedImage): Boolean =
            client?.sendControl(
                "t" to "session_upload", "id" to requestId, "sessionId" to sessionId,
                "mime" to image.mime, "data" to image.data,
            ) == true
        override fun onAttachmentsChanged() = renderSendButton()
    }
    private val reconnect = Runnable { if (started && terminalReady && !fatal) connectNow() }
    private val hideStatus = Runnable { binding.terminalStatusBar.visibility = View.GONE }
    private val voiceCallUiListener: (VoiceCallUiState.Snapshot) -> Unit = { snapshot ->
        runOnUiThread { renderVoiceMiniOrb(snapshot) }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (resolveSessionInterface(savedInstanceState)) return
        binding = ActivityTerminalBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyWindowInsets(binding.root, includeKeyboard = true, bottomInsetTarget = binding.composer.root)

        sessionId = savedInstanceState?.getString(STATE_SESSION_ID) ?: intent.getStringExtra(EXTRA_SESSION_ID)
        // Pin the Host now, and restore the pin rather than recomputing it after a
        // rotation: another Activity selecting a different profile must not move
        // this session ID onto a machine where the pane ID repeats.
        pin = savedInstanceState
            ?.let { SessionHostPin.restore(it.getString(STATE_HOST_ID), it.getString(STATE_ENDPOINT_KEY)) }
            ?: SessionPinHandoff.receive(
                forwarded = intent.hasExtra(EXTRA_ENDPOINT_KEY),
                hostId = intent.getStringExtra(EXTRA_HOST_ID),
                endpointKey = intent.getStringExtra(EXTRA_ENDPOINT_KEY),
                current = SettingsStore.load(this),
                profiles = SettingsStore.profiles(this),
            )
        hostId = pin?.hostId?.takeIf { it.isNotEmpty() }
        navigateToPinnedHost()
        agent = intent.getStringExtra(EXTRA_AGENT) ?: "shell"
        displayName = intent.getStringExtra(EXTRA_DISPLAY_NAME) ?: agent
        isHerdr = savedInstanceState?.getBoolean(STATE_IS_HERDR)
            ?: intent.getBooleanExtra(EXTRA_IS_HERDR, false)

        binding.toolbar.title = displayName
        binding.toolbar.subtitle = sessionId ?: getString(R.string.connecting)
        updateToolbarMenu()
        binding.toolbar.setNavigationOnClickListener { finish() }
        com.termbridge.android.ui.MenuAppearance.apply(this, binding.toolbar.menu)
        binding.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_agent_chat -> {
                    sessionId?.let { target ->
                        SessionUiSettings.setOverride(this, target, SessionUi.CHAT)
                        startActivity(attachIntent(this, target, displayName, isHerdr, hostId,
                            forceTerminal = true, endpointKey = pin?.endpointKey)
                            .setClass(this, AgentChatActivity::class.java)
                            .putExtra("explicit_chat", true).putExtra("return_to_terminal", true))
                    }
                    true
                }
                R.id.action_desktop -> {
                    val target = SessionHostPin.resolve(pin, SettingsStore.load(this), SettingsStore.profiles(this))
                    if (target == null) showStatus(getString(R.string.session_host_missing), true)
                    else startActivity(RemoteDesktopActivity.intent(this, target.hostId, target.endpointKey))
                    true
                }
                R.id.action_keyboard -> {
                    showKeyboard()
                    true
                }
                R.id.action_copy -> {
                    binding.terminalView.copySelection()
                    true
                }
                R.id.action_paste -> {
                    pasteClipboard()
                    true
                }
                R.id.action_review -> {
                    sessionId?.let {
                        startActivity(ReviewActivity.intent(this, it, displayName, hostId, reviewMode, pin?.endpointKey))
                    }
                    true
                }
                R.id.action_global -> {
                    sessionId?.let {
                        startActivity(
                            BrainActivity.fromSessionIntent(this, it).addFlags(
                                Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP,
                            ),
                        )
                    }
                    true
                }
                R.id.action_reconnect -> {
                    fatal = false
                    connectNow()
                    true
                }
                R.id.action_close_session -> {
                    confirmDeleteSession()
                    true
                }
                else -> false
            }
        }
        binding.deleteSession.setOnClickListener { confirmDeleteSession() }
        binding.terminalView.listener = this
        binding.voiceMiniOrb.setCompactMode(true)
        binding.voiceMiniOrb.setOnClickListener {
            startActivity(
                BrainActivity.intent(this).addFlags(
                    Intent.FLAG_ACTIVITY_REORDER_TO_FRONT or Intent.FLAG_ACTIVITY_SINGLE_TOP,
                ),
            )
        }
        bindExtraKeys()
        bindComposer()
        renderVoiceMiniOrb(VoiceCallUiState.current())
    }

    override fun onStart() {
        super.onStart()
        started = true
        keepVoiceScreenAwake = VoiceSettingsStore(this).load().keepScreenAwake
        voiceMiniActive = null
        VoiceCallUiState.addListener(voiceCallUiListener)
        VoiceCallUiState.setSurfaceVisible(this, true)
        if (terminalReady) connectNow()
    }

    override fun onStop() {
        started = false
        VoiceCallUiState.setSurfaceVisible(this, false)
        VoiceCallUiState.removeListener(voiceCallUiListener)
        connectGeneration += 1
        handler.removeCallbacks(reconnect)
        client?.disconnect()
        client = null
        sid = null
        interruptUploads()
        updateComposerState()
        super.onStop()
    }

    private fun renderVoiceMiniOrb(snapshot: VoiceCallUiState.Snapshot) {
        if (voiceMiniActive != snapshot.active) {
            voiceMiniActive = snapshot.active
            binding.voiceMiniOrb.isVisible = snapshot.active
            val keepAwake = !snapshot.active || keepVoiceScreenAwake
            if (keepAwake) {
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
        if (snapshot.active) {
            binding.voiceMiniOrb.setMode(snapshot.mode)
            binding.voiceMiniOrb.setLevel(snapshot.level)
        }
    }

    override fun onDestroy() {
        if (::attachments.isInitialized) attachments.dispose()
        // A notification that resolved to the chat view finishes before the
        // layout is inflated, so there is no terminal to release.
        if (::binding.isInitialized) binding.terminalView.release()
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_SESSION_ID, sessionId)
        outState.putString(STATE_HOST_ID, pin?.hostId)
        outState.putString(STATE_ENDPOINT_KEY, pin?.endpointKey)
        outState.putBoolean(STATE_IS_HERDR, isHerdr)
        super.onSaveInstanceState(outState)
    }

    override fun onTerminalReady(cols: Int, rows: Int) {
        terminalReady = true
        this.cols = cols
        this.rows = rows
        if (started) connectNow()
    }

    override fun onTerminalResize(cols: Int, rows: Int) {
        this.cols = cols
        this.rows = rows
        sid?.let { client?.sendResize(it, cols, rows) }
    }

    override fun onTerminalTitle(title: String) {
        if (title.isNotBlank()) binding.toolbar.title = title.take(80)
    }

    override fun onSelectionCopied() {
        Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
    }

    override fun onTerminalTouched() {
        val keyboardWasVisible = ViewCompat.getRootWindowInsets(binding.root)
            ?.isVisible(WindowInsetsCompat.Type.ime()) == true
        binding.composer.composerInput.requestFocus()
        if (!keyboardWasVisible) {
            binding.composer.composerInput.post {
                val input = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
                input.hideSoftInputFromWindow(binding.composer.composerInput.windowToken, 0)
            }
        }
    }

    override fun onTranscriptResync(revision: Int) {
        val attachedSid = sid ?: return
        if (revision >= 0) {
            client?.sendControl(
                "t" to "terminal_mobile_resync",
                "sid" to attachedSid,
                "revision" to revision,
            )
        } else {
            client?.sendControl("t" to "terminal_mobile_resync", "sid" to attachedSid)
        }
    }

    override fun onOpenFile(path: String) {
        val targetSession = sessionId ?: return
        com.termbridge.android.content.ArtifactPreviewActivity.open(
            context = this,
            location = path,
            sessionId = targetSession,
            hostId = hostId,
            endpointKey = pin?.endpointKey,
        )
    }

    override fun onConnectionState(state: ConnectionState) = runOnUiThread {
        when (state) {
            ConnectionState.Connecting -> showStatus(
                getString(
                    when {
                        deleteRequested -> R.string.deleting_session
                        reconnectingMode -> R.string.reconnecting
                        else -> R.string.connecting
                    },
                ),
                true,
                reconnectingMode,
            )
            ConnectionState.Authenticating -> showStatus(
                getString(if (deleteRequested) R.string.deleting_session else R.string.authenticating),
                true,
                reconnectingMode,
            )
            ConnectionState.Connected -> showStatus(getString(R.string.terminal_waiting), true)
            ConnectionState.Disconnected -> onTransientDisconnect(getString(R.string.disconnected))
            is ConnectionState.Failed -> {
                fatal = !shouldRetry(state.message)
                onTransientDisconnect(state.message)
            }
        }
    }

    override fun onReady(client: TermbridgeClient) {
        val knownSession = sessionId
        if (deleteRequested && knownSession != null) {
            if (client.sendControl("t" to "kill", "sessionId" to knownSession)) finishAfterDelete()
            return
        }
        if (knownSession != null) {
            client.sendControl(
                "t" to "attach",
                "sessionId" to knownSession,
                "cols" to cols,
                "rows" to rows,
                "presentation" to if (isHerdr) "mobile" else "terminal",
                "mobilePatches" to (isHerdr),
            )
        } else {
            client.sendControl(
                "t" to "session_create",
                "agent" to agent,
                "cols" to cols,
                "rows" to rows,
                "clientPlatform" to "android",
                "clientName" to Build.MODEL,
            )
        }
    }

    override fun onControl(message: ControlMessage) {
        when (message.type) {
            "session_created", "attach_ok" -> {
                val attachedSession = message.string("sessionId") ?: return
                val attachedSid = message.int("sid") ?: return
                sessionId = attachedSession
                sid = attachedSid
                reconnectingMode = false
                runOnUiThread {
                    binding.toolbar.subtitle = attachedSession
                    updateToolbarMenu()
                    showStatus(getString(R.string.terminal_attached), false)
                    flushImageUploads()
                    updateComposerState()
                }
                requestReviewProbe()
            }
            "session_exit" -> {
                val exitCode = message.int("exitCode") ?: 0
                fatal = true
                runOnUiThread {
                    showStatus(getString(R.string.terminal_exited, exitCode), true)
                    Snackbar.make(binding.root, getString(R.string.terminal_exited, exitCode), Snackbar.LENGTH_INDEFINITE)
                        .setAction(android.R.string.ok) { finish() }
                        .show()
                }
            }
            "terminal_mobile_snapshot" -> {
                val attachedSid = message.int("sid") ?: return
                val revision = message.int("revision") ?: return
                val payload = message.bytes("payload") ?: return
                if (attachedSid == sid) binding.terminalView.applyMobileSnapshot(revision, payload)
            }
            "terminal_mobile_patch" -> {
                val attachedSid = message.int("sid") ?: return
                val baseRevision = message.int("baseRevision") ?: return
                val revision = message.int("revision") ?: return
                val payload = message.bytes("payload") ?: return
                if (attachedSid == sid) binding.terminalView.applyMobilePatch(baseRevision, revision, payload)
            }
            "error" -> {
                val detail = message.string("message") ?: "Host rejected the request"
                fatal = detail.contains("no session", true) || detail.contains("unknown agent", true)
                runOnUiThread { showStatus(detail, true) }
                if (fatal) client?.disconnect()
            }
            "tool_request" -> rejectToolRequest(message)
            "session_upload_result" -> runOnUiThread { handleUploadResult(message) }
            "review_probe_result" -> handleReviewProbe(message)
        }
    }

    override fun onPtyOutput(sid: Int, data: ByteArray) {
        if (sid == this.sid) binding.terminalView.write(data)
    }

    private fun connectNow() {
        handler.removeCallbacks(reconnect)
        client?.disconnect()
        sid = null
        interruptUploads()
        reviewProbeRequestId = null
        reviewAvailable = false
        updateToolbarMenu()
        val settings = SessionHostPin.resolve(pin, SettingsStore.load(this), SettingsStore.profiles(this))
        if (settings != null) {
            // Once the pinned profile reports a Host, keep that stronger identity.
            pin = SessionHostPin.negotiated(pin, settings)
            hostId = pin?.hostId?.takeIf { it.isNotEmpty() } ?: hostId
        }
        if (settings == null) {
            // The profile this window was opened against is gone. Reconnecting
            // through another one would attach this session ID elsewhere.
            fatal = true
            reconnectingMode = false
            showStatus(getString(R.string.session_host_missing), true)
            binding.toolbar.subtitle = getString(R.string.session_host_missing)
            updateComposerState()
            return
        }
        if (!settings.connectionEnabled) {
            fatal = true
            reconnectingMode = false
            showStatus(getString(R.string.connection_paused), true)
            binding.toolbar.subtitle = getString(R.string.connection_paused)
            updateComposerState()
            return
        }
        settings.validationError()?.let {
            fatal = true
            showStatus(it, true)
            return
        }
        val generation = ++connectGeneration
        val startConnection = {
            if (started && generation == connectGeneration) {
                client = TermbridgeClient(settings, this).also(TermbridgeClient::connect)
            }
        }
        if (sessionId != null) {
            // Clear before reconnecting, so the host's ordered scrollback replay cannot
            // race a later terminal reset and disappear from the screen.
            binding.terminalView.resetTerminal(startConnection)
        } else {
            startConnection()
        }
    }

    /**
     * A notification's PendingIntent is fixed when the notification is created,
     * so the view is chosen here, when it is activated. One hop only: the
     * forwarded Intent does not carry the flag, and every route back into the
     * terminal passes `forceTerminal`.
     */
    private fun resolveSessionInterface(savedInstanceState: Bundle?): Boolean {
        if (savedInstanceState != null || !intent.getBooleanExtra(EXTRA_RESOLVE_UI, false)) return false
        intent.removeExtra(EXTRA_RESOLVE_UI)
        val target = intent.getStringExtra(EXTRA_SESSION_ID)?.takeIf { it.isNotBlank() } ?: return false
        val herdr = intent.getBooleanExtra(EXTRA_IS_HERDR, false)
        if (!SessionUiSettings.startsInChat(this, target, herdr)) return false
        // The chat view inherits this window's pin whole; deriving one there
        // would pick up whichever profile is current at that moment.
        val (forwardedHost, forwardedEndpoint) = SessionPinHandoff.extras(
            SessionPinHandoff.receive(
                forwarded = intent.hasExtra(EXTRA_ENDPOINT_KEY),
                hostId = intent.getStringExtra(EXTRA_HOST_ID),
                endpointKey = intent.getStringExtra(EXTRA_ENDPOINT_KEY),
                current = SettingsStore.load(this),
                profiles = SettingsStore.profiles(this),
            ),
        )
        startActivity(
            Intent(this, AgentChatActivity::class.java)
                .setData(intent.data)
                .putExtra(EXTRA_SESSION_ID, target)
                .putExtra(EXTRA_DISPLAY_NAME, intent.getStringExtra(EXTRA_DISPLAY_NAME) ?: target)
                .putExtra(EXTRA_IS_HERDR, herdr)
                .putExtra(EXTRA_HOST_ID, forwardedHost)
                .apply { if (forwardedEndpoint != null) putExtra(EXTRA_ENDPOINT_KEY, forwardedEndpoint) },
        )
        finish()
        return true
    }

    /**
     * Moves the app to the profile that owns this session, and only ever to one
     * the user has saved. The previous path asked `CompletionNotificationRoute`
     * to apply the wanted Host to whatever profile was current, which rebuilt a
     * deleted Host out of an unrelated relay and credentials and then saved it —
     * after which the pin check could not tell the difference.
     */
    private fun navigateToPinnedHost() {
        val key = SessionHostPin.navigate(pin, SettingsStore.load(this), SettingsStore.profiles(this))
            .selectProfileKey ?: return
        if (!SettingsStore.select(this, key)) return
        WatchGatewayService.sync(this)
        AgentMonitorService.switchHost(this)
    }

    private fun onTransientDisconnect(message: String) {
        sid = null
        interruptUploads()
        if (deleteRequested && started && !fatal) {
            showStatus(getString(R.string.deleting_session), true)
            binding.toolbar.subtitle = getString(R.string.deleting_session)
            handler.removeCallbacks(reconnect)
            handler.postDelayed(reconnect, RECONNECT_DELAY_MS)
            return
        }
        showStatus(message, true)
        updateComposerState()
        if (started && !fatal) {
            reconnectingMode = true
            binding.toolbar.subtitle = getString(R.string.reconnecting)
            showStatus(getString(R.string.reconnecting), true, canDeleteSession())
            handler.removeCallbacks(reconnect)
            handler.postDelayed(reconnect, RECONNECT_DELAY_MS)
        }
    }

    private fun shouldRetry(message: String): Boolean {
        val fatalWords = listOf("password", "fingerprint", "authentication", "host not found", "multiple hosts", "invalid")
        return fatalWords.none { message.contains(it, ignoreCase = true) }
    }

    private fun showStatus(message: String, persistent: Boolean, allowDelete: Boolean = false) {
        binding.terminalStatus.text = message
        binding.terminalStatusBar.visibility = View.VISIBLE
        binding.deleteSession.isVisible = allowDelete && !deleteRequested
        handler.removeCallbacks(hideStatus)
        if (!persistent) handler.postDelayed(hideStatus, STATUS_HIDE_DELAY_MS)
    }

    private fun updateToolbarMenu() {
        binding.toolbar.menu.findItem(R.id.action_agent_chat)?.isVisible = !sessionId.isNullOrBlank()
        binding.toolbar.menu.findItem(R.id.action_desktop)?.isVisible = true
        binding.toolbar.menu.findItem(R.id.action_close_session)?.isVisible = canDeleteSession()
        binding.toolbar.menu.findItem(R.id.action_review)?.apply {
            isVisible = !sessionId.isNullOrBlank()
            isEnabled = reviewAvailable
        }
        binding.toolbar.menu.findItem(R.id.action_global)?.isVisible = !sessionId.isNullOrBlank()
    }

    private fun requestReviewProbe() {
        val target = sessionId ?: return
        val requestId = UUID.randomUUID().toString()
        reviewProbeRequestId = requestId
        client?.sendControl(
            "t" to "review_probe",
            "requestId" to requestId,
            "sessionId" to target,
        )
    }

    private fun handleReviewProbe(message: ControlMessage) {
        if (message.string("requestId") != reviewProbeRequestId || message.string("sessionId") != sessionId) return
        reviewProbeRequestId = null
        reviewAvailable = message.boolean("available") == true
        reviewMode = message.string("mode")?.takeIf { it == "working" || it == "branch" || it == "files" } ?: "files"
        runOnUiThread(::updateToolbarMenu)
    }

    private fun canDeleteSession(): Boolean = !sessionId.isNullOrBlank()

    private fun confirmDeleteSession() {
        if (!canDeleteSession() || deleteRequested) return
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.close_session)
            .setMessage(getString(R.string.delete_session_message, displayName))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.delete_session) { _, _ -> deleteSession() }
            .show()
    }

    private fun deleteSession() {
        val target = sessionId ?: return
        deleteRequested = true
        fatal = false
        reconnectingMode = true
        handler.removeCallbacks(reconnect)
        showStatus(getString(R.string.deleting_session), true)
        binding.toolbar.menu.findItem(R.id.action_close_session)?.isEnabled = false
        if (sid != null && client?.sendControl("t" to "kill", "sessionId" to target) == true) {
            finishAfterDelete()
        } else {
            connectNow()
        }
    }

    private fun finishAfterDelete() {
        fatal = true
        handler.removeCallbacks(reconnect)
        handler.postDelayed({ if (!isFinishing) finish() }, DELETE_FINISH_DELAY_MS)
    }

    private fun bindExtraKeys() {
        binding.keyEsc.setOnClickListener { sendSequence(byteArrayOf(0x1b)) }
        binding.keyTab.setOnClickListener { sendSequence(byteArrayOf(0x09)) }
        binding.keyHome.setOnClickListener { sendSequence("\u001b[H".toByteArray()) }
        binding.keyUp.setOnClickListener { sendSequence("\u001b[A".toByteArray()) }
        binding.keyDown.setOnClickListener { sendSequence("\u001b[B".toByteArray()) }
        binding.keyLeft.setOnClickListener { sendSequence("\u001b[D".toByteArray()) }
        binding.keyRight.setOnClickListener { sendSequence("\u001b[C".toByteArray()) }
        binding.keyEnd.setOnClickListener { sendSequence("\u001b[F".toByteArray()) }
        binding.keyEnter.setOnClickListener { sendSequence(byteArrayOf(0x0d)) }
        binding.keyCopy.setOnClickListener { binding.terminalView.copySelection() }
        binding.keyPaste.setOnClickListener { pasteClipboard() }
        listOf(binding.keyCtrl, binding.keyAlt).forEach { key ->
            key.setOnClickListener { binding.composer.composerInput.requestFocus() }
        }
    }

    private fun applyModifiers(text: String): ByteArray {
        var bytes = text.toByteArray(Charsets.UTF_8)
        if (binding.keyCtrl.isChecked && text.length == 1) {
            ctrlByte(text[0])?.let { bytes = byteArrayOf(it) }
        }
        if (binding.keyAlt.isChecked) bytes = byteArrayOf(0x1b) + bytes
        clearModifiers()
        return bytes
    }

    private fun ctrlByte(char: Char): Byte? = when (val upper = char.uppercaseChar()) {
        in '@'..'_' -> (upper.code - '@'.code).toByte()
        ' ' -> 0.toByte()
        '?' -> 0x7f.toByte()
        else -> null
    }

    private fun clearModifiers() {
        binding.keyCtrl.isChecked = false
        binding.keyAlt.isChecked = false
    }

    private fun sendSequence(bytes: ByteArray) {
        val output = if (binding.keyAlt.isChecked && bytes.firstOrNull() != 0x1b.toByte()) {
            byteArrayOf(0x1b) + bytes
        } else {
            bytes
        }
        sendInput(output)
        clearModifiers()
        binding.composer.composerInput.requestFocus()
    }

    private fun sendInput(bytes: ByteArray): Boolean {
        val activeSid = sid ?: return false
        return client?.sendPtyInput(activeSid, bytes) == true
    }

    private fun pasteClipboard() {
        clearModifiers()
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip ?: return
        var handledImage = false
        if (clip.description.hasMimeType("image/*")) {
            for (index in 0 until clip.itemCount) {
                clip.getItemAt(index).uri?.let { uri ->
                    handledImage = true
                    attachments.queue(uri)
                }
            }
        }
        if (!handledImage) {
            val text = clip.getItemAt(0).coerceToText(this)?.toString().orEmpty()
            insertComposerText(text)
        }
    }

    private fun showKeyboard() {
        binding.composer.composerInput.requestFocus()
        val input = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        input.showSoftInput(binding.composer.composerInput, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun bindComposer() {
        binding.composer.composerLayout.hint = getString(R.string.composer_hint)
        attachments = ComposerAttachments(
            context = this, handler = handler,
            store = attachmentsModel.storeFor(
                "${pin?.endpointKey.orEmpty()}\u0000${sessionId.orEmpty()}",
            ),
            status = binding.composer.composerAttachmentStatus, attach = binding.composer.composerAttach,
            input = binding.composer.composerInput, owner = composerOwner,
        )
        attachments.bind { imagePicker.launch("image/*") }
        binding.composer.composerSend.isFocusable = false
        binding.composer.composerSend.setOnClickListener { submitComposer() }
        binding.composer.composerInput.doAfterTextChanged { updateComposerState() }
        val editorActionHandler = ComposerEditorActionHandler(::submitComposer)
        binding.composer.composerInput.setOnEditorActionListener { _, actionId, _ ->
            editorActionHandler.onEditorAction(actionId, EditorInfo.IME_ACTION_SEND)
        }
        updateComposerState()
    }

    private fun submitComposer() {
        if (!attachments.isIdle) return
        val message = attachments.payload(binding.composer.composerInput.text?.toString().orEmpty())
        if (message.isBlank()) return
        val bracketed = binding.terminalView.bracketedPasteMode && !binding.keyCtrl.isChecked && !binding.keyAlt.isChecked
        val sent = sendInput(ComposerPayload.submitBytes(applyModifiers(message), bracketed))
        if (!sent) {
            Toast.makeText(this, R.string.terminal_not_ready, Toast.LENGTH_SHORT).show()
            return
        }
        sessionId?.let { target ->
            client?.sendControl(
                "t" to "session_message",
                "sessionId" to target,
                "text" to message,
                "clientPlatform" to "android",
            )
        }
        binding.composer.composerInput.text?.clear()
        attachments.consumed()
        showKeyboard()
    }

    private fun insertComposerText(text: String) {
        if (text.isEmpty()) return
        val editable = binding.composer.composerInput.text ?: return
        val selection = binding.composer.composerInput.selectionStart.coerceIn(0, editable.length)
        editable.insert(selection, text)
        showKeyboard()
    }

    private fun handleUploadResult(message: ControlMessage) {
        val target = sessionId ?: return
        if (message.string("sessionId") != target) return
        val requestId = message.string("id") ?: return
        attachments.acknowledge(requestId, target, message.string("path"), message.string("error"))
    }

    private fun interruptUploads() {
        if (::attachments.isInitialized) attachments.interrupt()
    }

    private fun flushImageUploads() {
        if (::attachments.isInitialized) attachments.flush()
    }

    private fun updateComposerState() {
        if (::attachments.isInitialized) attachments.render() else renderSendButton()
    }

    private fun renderSendButton() {
        val ready = if (::attachments.isInitialized) attachments.readyCount else 0
        val idle = !::attachments.isInitialized || attachments.isIdle
        binding.composer.composerSend.isEnabled =
            sid != null && idle && (!binding.composer.composerInput.text.isNullOrBlank() || ready > 0)
    }

    private fun rejectToolRequest(message: ControlMessage) {
        val id = message.string("id") ?: return
        client?.sendControl(
            "t" to "tool_response",
            "id" to id,
            "ok" to false,
            "error" to "The Android viewer does not expose peer tools",
        )
    }

    companion object {
        private const val EXTRA_SESSION_ID = "session_id"
        private const val EXTRA_HOST_ID = "host_id"
        private const val EXTRA_AGENT = "agent"
        private const val EXTRA_DISPLAY_NAME = "display_name"
        private const val EXTRA_IS_HERDR = "is_herdr"
        private const val EXTRA_RESOLVE_UI = "resolve_ui"
        const val EXTRA_ENDPOINT_KEY = "endpoint_key"
        private const val STATE_SESSION_ID = "state_session_id"
        private const val STATE_HOST_ID = "state_host_id"
        private const val STATE_ENDPOINT_KEY = "state_endpoint_key"
        private const val STATE_IS_HERDR = "state_is_herdr"
        private const val RECONNECT_DELAY_MS = 3_000L
        private const val STATUS_HIDE_DELAY_MS = 1_200L
        private const val DELETE_FINISH_DELAY_MS = 250L

        fun attachIntent(
            context: Context,
            sessionId: String,
            displayName: String,
            isHerdr: Boolean,
            hostId: String? = null,
            forceTerminal: Boolean = false,
            endpointKey: String? = null,
        ): Intent =
            Intent(context, if (!forceTerminal && SessionUiSettings.startsInChat(context, sessionId, isHerdr))
                AgentChatActivity::class.java else TerminalActivity::class.java)
                // Present only when the caller holds a pin: presence is what tells
                // the receiving screen to adopt it rather than derive a new one.
                .apply { if (endpointKey != null) putExtra(EXTRA_ENDPOINT_KEY, endpointKey) }
                .putExtra(EXTRA_SESSION_ID, sessionId)
                .putExtra(EXTRA_DISPLAY_NAME, displayName)
                .putExtra(EXTRA_IS_HERDR, isHerdr)
                .putExtra(EXTRA_HOST_ID, hostId)
                .apply {
                    if (!hostId.isNullOrBlank()) {
                        data = Uri.Builder()
                            .scheme("termbridge")
                            .authority("conversation")
                            .appendPath(hostId)
                            .appendPath(sessionId)
                            .build()
                    }
                }

        /**
         * For notifications, whose PendingIntent is built long before it is
         * clicked. It always names this Activity and defers the view choice to
         * `resolveSessionInterface`, so changing the setting afterwards is
         * honoured instead of reopening whatever was current at creation time.
         */
        fun notificationIntent(
            context: Context,
            sessionId: String,
            displayName: String,
            isHerdr: Boolean,
            hostId: String? = null,
        ): Intent = attachIntent(context, sessionId, displayName, isHerdr, hostId, forceTerminal = true)
            .putExtra(EXTRA_RESOLVE_UI, true)

        fun createIntent(context: Context, agent: String): Intent =
            Intent(context, TerminalActivity::class.java)
                .putExtra(EXTRA_AGENT, agent)
                .putExtra(EXTRA_DISPLAY_NAME, if (agent == "shell") "Shell" else agent)
    }
}
