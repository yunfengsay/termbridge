package com.termbridge.android.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.BaseInputConnection
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import androidx.core.net.toUri
import com.termbridge.android.ComposerAttachments
import com.termbridge.android.ComposerAttachmentsViewModel
import com.termbridge.android.ComposerEditorActionHandler
import com.termbridge.android.EncodedImage
import com.termbridge.android.R
import com.termbridge.android.TerminalActivity
import com.termbridge.android.databinding.ActivityAgentChatBinding
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.ui.applyWindowInsets
import org.json.JSONObject
import java.util.UUID

/** An additional view of the existing session. Its socket never attaches a terminal. */
class AgentChatActivity : AppCompatActivity() {
    private val handler = Handler(Looper.getMainLooper())
    private val epoch = AgentChatEpoch()
    private var client: TermbridgeClient? = null
    private var started = false
    private var connected = false
    private var subscribed = false
    private var canSend = false
    private var unavailable: String? = null
    private lateinit var settings: ConnectionSettings
    /** The Host identity this window keeps, independent of the app's current profile. */
    private var pin: SessionPin? = null
    private val gate = AgentChatSurfaceGate()
    /** Uploads and keys wait for the Host's answer, not for the request going out. */
    private val uploadGate = SessionUploadGate()
    /** Key requests this view is still waiting on, so old results are ignored. */
    private val pendingKeys = mutableSetOf<String>()
    private lateinit var binding: ActivityAgentChatBinding
    private lateinit var conversationId: String
    private lateinit var displayName: String
    private lateinit var draft: AgentChatDraft
    private lateinit var surface: AgentChatWebView
    private lateinit var attachments: ComposerAttachments
    private var updatingComposer = false
    /**
     * Whether this Host offers attachments for this conversation. Sticky across
     * a reconnect on purpose: a picker result arriving while the socket is down
     * still belongs to this session, and forgetting the capability would throw
     * the user's image away. Only the Host saying so turns it on, and only the
     * Host saying otherwise turns it off.
     */
    private var attachmentsSupported = false
    /**
     * Set when the picker is launched and kept until its result is handled.
     *
     * Choosing an image takes this Activity through onStop, and on a low-memory
     * device through a full recreate, which resets everything the Host told us.
     * The target is therefore fixed at the moment the user asked to attach, and
     * restored with the rest of the instance state, so the returning result is
     * still queued against this conversation rather than dropped for looking
     * unsupported.
     */
    private var attachArmed = false
    /** Survives rotation, so an upload mid-encode or mid-flight is not lost. */
    private val attachmentsModel: ComposerAttachmentsViewModel by viewModels()
    private val imagePicker = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        uris.forEach { uri: Uri -> attachments.queue(uri) }
        attachArmed = false
        if (::attachments.isInitialized) attachments.render()
    }
    /**
     * The chat view earns the right to upload by holding a live subscription to
     * this conversation, which is what the Host checks. It never uploads against
     * a session it is not currently subscribed to.
     */
    private val composerOwner = object : ComposerAttachments.Owner {
        override fun attachmentSessionId(): String? =
            conversationId.takeIf { attachmentsSupported || attachArmed }
        // `subscribed` only means the request was sent; the Host is still
        // awaiting describe/locate and would refuse — and a refusal is
        // acknowledged, which would throw the image away.
        override fun uploadReady(): Boolean =
            started && connected && client != null && uploadGate.allows(epoch.generation)
        override fun sendUpload(requestId: String, sessionId: String, image: EncodedImage): Boolean =
            client?.sendControl(
                "t" to "session_upload", "id" to requestId, "sessionId" to sessionId,
                "mime" to image.mime, "data" to image.data,
            ) == true
        override fun onAttachmentsChanged() = renderActions()
        override fun attachmentsAllowed(): Boolean = attachmentsSupported
        override fun notReadyMessage(): Int =
            if (attachmentsSupported) R.string.terminal_not_ready else R.string.agent_chat_attachments_unsupported
    }
    private var initialSnapshot: JSONObject? = null
    private val queuedEvents = ArrayDeque<JSONObject>()
    private var earlierRequest: String? = null
    private val reconnect = Runnable { if (started) connect() }
    private val unsupportedTimeout = Runnable {
        if (started && subscribed && initialSnapshot == null) degrade(getString(R.string.agent_chat_host_update))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        conversationId = intent.getStringExtra("session_id").orEmpty()
        displayName = intent.getStringExtra("display_name").orEmpty()
        val active = SettingsStore.load(this)
        val profiles = SettingsStore.profiles(this)
        // Restored rather than recomputed after a rotation: recomputing would
        // re-pin to whichever profile is current by then.
        pin = savedInstanceState
            ?.let { SessionHostPin.restore(it.getString("pinned_host"), it.getString("pinned_endpoint")) }
            ?: SessionPinHandoff.receive(
                forwarded = intent.hasExtra(TerminalActivity.EXTRA_ENDPOINT_KEY),
                hostId = intent.getStringExtra("host_id"),
                endpointKey = intent.getStringExtra(TerminalActivity.EXTRA_ENDPOINT_KEY),
                current = active,
                profiles = profiles,
            )
        attachArmed = savedInstanceState?.getBoolean("attach_armed") == true
        attachmentsSupported = savedInstanceState?.getBoolean("attachments_supported") == true
        val pinned = SessionHostPin.resolve(pin, active, profiles)
        if (conversationId.isBlank() || pinned == null) {
            // Without the Host this session was opened against there is nothing
            // safe to connect to: another profile may reuse the same pane ID.
            if (conversationId.isNotBlank()) {
                Toast.makeText(this, R.string.session_host_missing, Toast.LENGTH_LONG).show()
            }
            finish(); return
        }
        settings = pinned
        // Pin connection configuration now: a different Activity selecting a Host
        // must never redirect this composer's next reconnect to another machine.
        draft = AgentChatDrafts.get(settings.profileKey, conversationId)
        if (savedInstanceState != null && draft.requestId == null) {
            val submitted = savedInstanceState.getString("pending_text")
            if (submitted != null) {
                draft.text = submitted
                draft.begin(UUID.randomUUID().toString(), -1)
                draft.disconnected(getString(R.string.agent_chat_uncertain))
            }
            draft.text = savedInstanceState.getString("draft").orEmpty()
        }
        buildUi()
        renderComposer()
    }

    private fun buildUi() {
        binding = ActivityAgentChatBinding.inflate(layoutInflater)
        setContentView(binding.root)
        // The composer paints the gesture area, so the bar's colour is
        // continuous to the bottom edge instead of sitting on a pale strip.
        applyWindowInsets(binding.root, includeKeyboard = true, bottomInsetTarget = binding.composer.root)
        binding.toolbar.apply {
            title = this@AgentChatActivity.displayName
            setNavigationOnClickListener { finish() }
            menu.add(R.string.agent_chat_terminal).setIcon(R.drawable.ic_terminal).setOnMenuItemClickListener {
                // A deliberate switch is remembered for this session, so a
                // notification opened later reopens what the user chose.
                SessionUiSettings.setOverride(this@AgentChatActivity, conversationId, SessionUi.TERMINAL)
                openTerminal(); true
            }
            // The only always-available way back through history. The inline
            // control appears once the reader scrolls up, which a page too
            // short to scroll never can.
            menu.add(R.string.agent_chat_load_earlier).setIcon(R.drawable.ic_history).setOnMenuItemClickListener {
                if (surface.ready) surface.receive(JSONObject().put("op", "load-earlier"))
                true
            }
            menu.add(R.string.reconnect).setIcon(R.drawable.ic_refresh).setOnMenuItemClickListener { connect(); true }
        }
        com.termbridge.android.ui.MenuAppearance.apply(this, binding.toolbar.menu)
        surface = AgentChatWebView(this, ::onSurfaceMessage)
        binding.surfaceContainer.addView(surface, FrameLayout.LayoutParams(-1, -1))

        // The same composer the terminal uses, wired to this view's send path.
        attachments = ComposerAttachments(
            context = this, handler = handler,
            // Keyed by Host profile and conversation: a different session never
            // inherits images that were picked for this one.
            store = attachmentsModel.storeFor("${settings.profileKey}\u0000$conversationId"),
            status = binding.composer.composerAttachmentStatus, attach = binding.composer.composerAttach,
            input = binding.composer.composerInput, owner = composerOwner,
        )
        attachments.bind {
            // Armed before launching: the result may come back to a different
            // instance of this Activity than the one that asked.
            attachArmed = true
            imagePicker.launch("image/*")
        }
        binding.composer.composerInput.setHint(R.string.agent_chat_composer_hint)
        binding.composer.composerSend.isFocusable = false
        binding.composer.composerSend.setOnClickListener { sendPrompt() }
        binding.composer.composerInput.doAfterTextChanged {
            if (updatingComposer) return@doAfterTextChanged
            val typed = it?.toString().orEmpty()
            if (consumeModifiedCharacter(draft.text, typed)) return@doAfterTextChanged
            draft.text = typed
            renderActions()
        }
        val editorActionHandler = ComposerEditorActionHandler(::sendPrompt)
        binding.composer.composerInput.setOnEditorActionListener { _, action, event ->
            // Candidate-word confirmation/normal multiline Enter belongs to the IME.
            if (event == null && !composing()) {
                editorActionHandler.onEditorAction(action, EditorInfo.IME_ACTION_SEND)
            } else false
        }
        binding.retry.setOnClickListener {
            if (!draft.retryable) return@setOnClickListener
            if (draft.text.isNotEmpty() && draft.text != draft.submittedText()) {
                Toast.makeText(this@AgentChatActivity, R.string.agent_chat_retry_draft, Toast.LENGTH_LONG).show()
            } else {
                draft.text = draft.submittedText(); renderComposer(); sendPrompt()
            }
        }
        binding.copyPending.setOnClickListener { copy(draft.submittedText()) }
        bindKeys()
        binding.composer.composerInput.requestFocus()
    }

    override fun onStart() { super.onStart(); if (::surface.isInitialized) { started = true; connect() } }
    override fun onStop() {
        started = false
        if (::draft.isInitialized) disconnect()
        super.onStop()
    }
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        // Detaches this screen from the retained queue; the ViewModel ends it
        // when the screen is really finishing rather than rotating.
        if (::attachments.isInitialized) attachments.dispose()
        if (::surface.isInitialized) surface.release()
        super.onDestroy()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("pinned_host", pin?.hostId)
        outState.putString("pinned_endpoint", pin?.endpointKey)
        outState.putBoolean("attach_armed", attachArmed)
        outState.putBoolean("attachments_supported", attachmentsSupported)

        if (::draft.isInitialized) {
            outState.putString("draft", draft.text)
            if (draft.pending || draft.state == "uncertain") outState.putString("pending_text", draft.submittedText())
        }
        super.onSaveInstanceState(outState)
    }

    private fun disconnect() {
        handler.removeCallbacks(reconnect); handler.removeCallbacks(unsupportedTimeout)
        if (subscribed) client?.sendControl("t" to "agent_chat_unsubscribe", "conversationId" to conversationId)
        epoch.nextConnection()
        subscribed = false; connected = false; canSend = false; earlierRequest = null
        uploadGate.revoked()
        pendingKeys.clear()
        // The results of uploads already on the wire can never be matched now.
        if (::attachments.isInitialized) attachments.interrupt()
        draft.disconnected(getString(R.string.agent_chat_uncertain))
        client?.disconnect(); client = null
        renderComposer()
    }

    private fun connect() {
        disconnect()
        if (!started) return
        // Re-resolve the pinned Host: another Activity may have changed the
        // current profile, and a removed profile must stop this view, not
        // silently move it to whichever machine is selected now.
        val pinned = SessionHostPin.resolve(pin, SettingsStore.load(this), SettingsStore.profiles(this))
        if (pinned == null) { showStatus(getString(R.string.session_host_missing)); return }
        settings = pinned
        pin = SessionHostPin.negotiated(pin, pinned)
        if (!settings.connectionEnabled) { showStatus(getString(R.string.connection_paused)); return }
        settings.validationError()?.let { showStatus(it); return }
        unavailable = null; initialSnapshot = null; queuedEvents.clear()
        surface.receive(JSONObject().put("op", "clear"))
        val connection = epoch.connection
        val listener = object : TermbridgeClient.Listener {
            private fun current(block: () -> Unit) = runOnUiThread {
                if (started && epoch.connection == connection) block()
            }
            override fun onConnectionState(state: ConnectionState) = current {
                when (state) {
                    ConnectionState.Connecting -> showStatus(getString(R.string.connecting))
                    ConnectionState.Authenticating -> showStatus(getString(R.string.authenticating))
                    ConnectionState.Connected -> Unit
                    ConnectionState.Disconnected -> lost(getString(R.string.disconnected))
                    is ConnectionState.Failed -> lost(state.message)
                }
            }
            override fun onReady(client: TermbridgeClient) = current {
                connected = true
                subscribe(client)
            }
            override fun onControl(message: ControlMessage) = current { handle(message, connection) }
            override fun onPtyOutput(sid: Int, data: ByteArray) = Unit
        }
        client = TermbridgeClient(settings, listener, context = applicationContext).also(TermbridgeClient::connect)
    }

    /**
     * Starts a new subscription generation. Used both for the first read and
     * after the surface reloads, where the Host's fresh bounded snapshot is the
     * only honest way to rebuild what the page lost.
     */
    private fun subscribe(target: TermbridgeClient? = client) {
        if (!started || !connected) return
        val client = target ?: return
        handler.removeCallbacks(unsupportedTimeout)
        initialSnapshot = null; queuedEvents.clear(); earlierRequest = null
        val generation = epoch.nextSubscription()
        uploadGate.requested()
        pendingKeys.clear()
        subscribed = true
        if (!client.sendControl("t" to "agent_chat_subscribe", "requestId" to UUID.randomUUID().toString(),
                "conversationId" to conversationId, "generation" to generation)) {
            subscribed = false
            lost(getString(R.string.disconnected))
            return
        }
        handler.postDelayed(unsupportedTimeout, 8_000)
        renderComposer()
    }

    private fun lost(reason: String) {
        connected = false; canSend = false; subscribed = false
        uploadGate.revoked()
        if (::attachments.isInitialized) attachments.interrupt()
        handler.removeCallbacks(unsupportedTimeout)
        draft.disconnected(getString(R.string.agent_chat_uncertain))
        renderComposer(); showStatus(reason)
        handler.removeCallbacks(reconnect)
        val fatal = listOf("password", "fingerprint", "authentication", "host not found", "multiple hosts", "invalid")
            .any { reason.contains(it, ignoreCase = true) }
        if (started && !fatal) handler.postDelayed(reconnect, 3_000)
    }

    private fun handle(message: ControlMessage, connection: Int) {
        // Upload results are not part of the chat generation: they are answers to
        // this socket's own request IDs, and the queue itself checks ownership.
        if (message.type == "session_upload_result") {
            if (connection != epoch.connection) return
            val requestId = message.string("id") ?: return
            if (message.string("sessionId") != conversationId) return
            attachments.acknowledge(requestId, conversationId, message.string("path"), message.string("error"))
            return
        }
        if (!message.type.startsWith("agent_chat_")) return
        if (!epoch.accepts(connection, message.string("conversationId"), conversationId, message.int("generation"))) return
        when (message.type) {
            "agent_chat_snapshot", "agent_chat_append" -> {
                @Suppress("UNCHECKED_CAST")
                val capabilities = message.fields["capabilities"] as? Map<String, Any?> ?: emptyMap()
                canSend = capabilities["send"] == true
                // A Host that predates attachment support says false, or says
                // nothing at all; both keep the attach control switched off
                // rather than offering something that cannot be delivered.
                attachmentsSupported = capabilities["attachments"] == true
                // Reaching here means the Host answered for the generation this
                // view is on, which is exactly what authorizes an upload.
                if (attachmentsSupported) uploadGate.confirmed(epoch.generation) else uploadGate.revoked()
                unavailable = message.string("error") ?: capabilities["degraded"] as? String
                val payload = JSONObject(message.fields).put("op", if (message.type == "agent_chat_snapshot") "snapshot" else "append")
                // This shell has a history entry in its own menu, so the inline
                // control can wait until the reader scrolls up. A shell without
                // one keeps the inline entry, or a page too short to scroll
                // could never reach history at all.
                if (message.type == "agent_chat_snapshot") payload.put("historyMenu", true)
                if (message.type == "agent_chat_snapshot") {
                    handler.removeCallbacks(unsupportedTimeout)
                    initialSnapshot = payload; queuedEvents.clear()
                    if (capabilities["history"] != true) {
                        degrade(unavailable ?: getString(R.string.agent_chat_unsupported))
                        return
                    }
                }
                deliverToSurface(payload)
                // Anything the picker produced before the Host confirmed the
                // capability goes out now, not silently never.
                if (::attachments.isInitialized) attachments.flush()
                renderComposer()
            }
            "agent_chat_earlier_result" -> {
                if (message.string("requestId") != earlierRequest) return
                earlierRequest = null
                if (message.string("error") != null) { showStatus(message.string("error")); return }
                deliverToSurface(JSONObject(message.fields).put("op", "earlier"))
            }
            "agent_chat_key_result" -> {
                // Only a result for a key this view actually pressed, on the
                // subscription it pressed it under. An error from an old socket
                // or an abandoned generation never reaches the current window.
                val requestId = message.string("requestId").orEmpty()
                if (!pendingKeys.remove(requestId)) return
                if (message.fields["ok"] != true) {
                    Toast.makeText(this, message.string("error") ?: getString(R.string.key_send_failed), Toast.LENGTH_SHORT).show()
                }
            }
            "agent_chat_delivery" -> {
                if (draft.receipt(message.string("requestId").orEmpty(), message.int("generation") ?: -1,
                        message.string("state").orEmpty(), message.string("error"),
                        message.string("messageId"))) renderComposer()
            }
        }
    }

    private fun degrade(reason: String) {
        // A degraded conversation cannot take attachments either.
        unavailable = reason; canSend = false; attachmentsSupported = false
        uploadGate.revoked()
        if (subscribed) client?.sendControl("t" to "agent_chat_unsubscribe", "conversationId" to conversationId)
        subscribed = false; epoch.nextSubscription()
        showStatus(reason); renderActions()
        val chosenByHand = intent.getBooleanExtra("explicit_chat", false) ||
            SessionUiSettings.overrideFor(this, conversationId) == SessionUi.CHAT
        if (SessionUiSettings.load(this) == SessionUi.AUTO && !chosenByHand) {
            Toast.makeText(this, reason, Toast.LENGTH_LONG).show()
            openTerminal()
        }
    }

    /**
     * The single guard every submit path shares.
     *
     * Disabling the button is not a guard: IME_ACTION_SEND and a hardware Enter
     * reach here without touching it, and an unfinished upload would then send
     * the text alone, leaving the image to arrive with nothing referring to it.
     */
    private fun canSubmit(): Boolean =
        started && connected && subscribed && canSend && !draft.pending &&
            attachments.isIdle && !composing()

    private fun sendPrompt() {
        if (!::attachments.isInitialized || !canSubmit()) return
        // Attachments are named in the text, exactly as the terminal composer
        // names them, so the Agent consumes them through the same path.
        val outgoing = attachments.verbatimPayload(draft.text)
        if (outgoing.isBlank() || outgoing.length > MAX_PROMPT) return
        val request = UUID.randomUUID().toString()
        val generation = epoch.generation
        // The draft carries what actually goes on the wire, so a retry resends
        // the same message rather than one missing its images.
        draft.text = outgoing
        val text = draft.begin(request, generation)
        attachments.consumed()
        val sent = runCatching { client?.sendControl("t" to "agent_chat_send", "requestId" to request,
            "conversationId" to conversationId, "text" to text) == true }
        if (sent.getOrNull() == false) draft.receipt(request, generation, "failed", getString(R.string.agent_chat_not_sent))
        if (sent.isFailure) draft.receipt(request, generation, "uncertain", getString(R.string.agent_chat_uncertain))
        renderComposer()
        handler.postDelayed({
            if (draft.requestId == request && draft.generation == generation && draft.pending) {
                draft.disconnected(getString(R.string.agent_chat_uncertain))
                if (started) renderComposer()
            }
        }, 45_000)
    }

    private fun renderComposer() {
        if (!::binding.isInitialized) return
        if (binding.composer.composerInput.text.toString() != draft.text) {
            updatingComposer = true
            binding.composer.composerInput.setText(draft.text)
            binding.composer.composerInput.setSelection(binding.composer.composerInput.length())
            updatingComposer = false
        }
        // A send's receipt belongs to the message it is about, so it goes to the
        // transcript next to those words. The status row keeps only what is
        // about this connection, which is the one thing a message cannot say.
        pushPendingSend()
        showStatus(if (connected) unavailable else unavailable ?: getString(R.string.connecting))
        if (::attachments.isInitialized) attachments.render() else renderActions()
    }

    /**
     * Mirrors the outstanding send into the transcript.
     *
     * Cleared once the Agent's own record carries the message: the receipt has
     * done its job and leaving it would show the same words twice.
     */
    private fun pushPendingSend() {
        if (!::surface.isInitialized || !surface.ready) return
        val request = draft.requestId
        val state = draft.state
        val payload = JSONObject().put("op", "pending").put("id", request.orEmpty())
        if (request == null || state == null) {
            surface.receive(payload.put("text", ""))
            return
        }
        // `observed` is not the moment to drop this row: the Host has seen the
        // send, but its record may not have reached the transcript yet, and
        // clearing here would make the message vanish in between. The surface
        // retires it by messageId once both are present.
        payload.put("text", draft.submittedText()).put("state", state)
        draft.error?.let { payload.put("error", it) }
        draft.messageId?.let { payload.put("messageId", it) }
        surface.receive(payload)
    }

    /**
     * The Terminal's key row, wired to this conversation's own pane.
     *
     * Each button names a key; the Host owns the bytes. It is refused unless
     * this connection holds a live subscription on the generation it names, so
     * a key cannot reach a session this window has moved away from — and it is
     * never turned into a chat message.
     */
    private fun bindKeys() {
        val keys = listOf(
            binding.chatKeys.chatKeyEsc to "escape",
            binding.chatKeys.chatKeyTab to "tab",
            binding.chatKeys.chatKeyCtrlC to "ctrl-c",
            binding.chatKeys.chatKeyUp to "up",
            binding.chatKeys.chatKeyDown to "down",
            binding.chatKeys.chatKeyLeft to "left",
            binding.chatKeys.chatKeyRight to "right",
            binding.chatKeys.chatKeyHome to "home",
            binding.chatKeys.chatKeyEnd to "end",
            binding.chatKeys.chatKeyEnter to "enter",
        )
        for ((button, key) in keys) button.setOnClickListener { sendKey(key) }
        // Ctrl and Alt arm; they do not send anything by themselves.
        for (modifier in listOf(binding.chatKeys.chatKeyCtrl, binding.chatKeys.chatKeyAlt)) {
            modifier.setOnClickListener {
                val other = if (modifier === binding.chatKeys.chatKeyCtrl) binding.chatKeys.chatKeyAlt else binding.chatKeys.chatKeyCtrl
                if (modifier.isChecked) other.isChecked = false
            }
        }
    }

    /** The armed modifier, if any, as the prefix the Host understands. */
    private fun armedModifier(): String? = when {
        binding.chatKeys.chatKeyCtrl.isChecked -> "ctrl"
        binding.chatKeys.chatKeyAlt.isChecked -> "alt"
        else -> null
    }

    private fun clearModifiers() {
        for (modifier in listOf(binding.chatKeys.chatKeyCtrl, binding.chatKeys.chatKeyAlt)) {
            modifier.isChecked = false
        }
    }

    /**
     * A letter typed while Ctrl or Alt is armed is that combination, not text.
     *
     * It is taken back out of the draft before it can be sent as a message: the
     * whole point of the modifier is that the character never was one.
     * @return true when the character was consumed as a key.
     */
    private fun consumeModifiedCharacter(before: String, after: String): Boolean {
        val armed = armedModifier()
        val key = ComposerModifier.keyFor(armed, before, after, keysUsable())
        if (key == null) {
            // Armed but undeliverable: disarm so the next letter is plain text
            // rather than silently disappearing too.
            if (armed != null && !keysUsable()) clearModifiers()
            return false
        }
        // Sent first, removed second. If the socket refuses it synchronously the
        // character simply stays in the draft where the user put it.
        if (!sendKey(key)) {
            clearModifiers()
            return false
        }
        updatingComposer = true
        binding.composer.composerInput.setText(before)
        binding.composer.composerInput.setSelection(before.length)
        updatingComposer = false
        draft.text = before
        clearModifiers()
        return true
    }

    /** @return true when the frame was handed to the socket. */
    private fun sendKey(key: String): Boolean {
        // The same bar as sending: the Host must have answered this generation.
        if (!keysUsable()) return false
        val requestId = UUID.randomUUID().toString()
        pendingKeys += requestId
        val sent = client?.sendControl(
            "t" to "agent_chat_key", "requestId" to requestId,
            "conversationId" to conversationId, "generation" to epoch.generation, "key" to key,
        ) == true
        // A key is never resent on its own; the user presses it again if they
        // decide it did not land.
        if (!sent) {
            pendingKeys.remove(requestId)
            Toast.makeText(this, R.string.key_send_failed, Toast.LENGTH_SHORT).show()
        }
        return sent
    }

    /**
     * Whether the key row can act.
     *
     * The subscription request going out is not enough: the Host only binds the
     * conversation after it answers, and a key sent before that is refused.
     */
    private fun keysUsable(): Boolean =
        started && connected && subscribed && client != null && uploadGate.allows(epoch.generation)

    /** Whether the key row can act right now. */
    private fun renderKeys() {
        if (!::binding.isInitialized) return
        val live = keysUsable()
        binding.chatKeys.chatExtraKeys.alpha = if (live) 1f else 0.4f
        for (index in 0 until binding.chatKeys.chatExtraKeys.childCount) {
            binding.chatKeys.chatExtraKeys.getChildAt(index).isEnabled = live
        }
    }

    /** True while the IME still owns an unconfirmed candidate word. */
    private fun composing(): Boolean {
        val text = binding.composer.composerInput.text ?: return false
        return BaseInputConnection.getComposingSpanStart(text) >= 0
    }

    /** A blank reason hides the row entirely instead of leaving an empty band. */
    private fun showStatus(text: String?) {
        binding.chatStatus.text = text.orEmpty()
        binding.chatStatus.visibility = if (text.isNullOrBlank()) View.GONE else View.VISIBLE
    }

    private fun renderActions() {
        if (!::binding.isInitialized) return
        val attached = if (::attachments.isInitialized) attachments.readyCount else 0
        val settled = !::attachments.isInitialized || attachments.isIdle
        val tooLong = draft.text.length > MAX_PROMPT
        if (tooLong) showStatus(getString(R.string.agent_chat_too_long))
        val live = started && connected && subscribed && canSend
        binding.composer.composerSend.isEnabled = live && !draft.pending && settled && !tooLong &&
            (draft.text.isNotBlank() || attached > 0)
        binding.retry.visibility = if (draft.retryable) View.VISIBLE else View.GONE
        binding.retry.isEnabled = live && draft.retryable
        binding.copyPending.visibility = if (draft.state == "uncertain") View.VISIBLE else View.GONE
        renderKeys()
    }

    private fun deliverToSurface(payload: JSONObject) {
        if (surface.ready) surface.receive(payload)
        else if (payload.optString("op") != "snapshot") {
            // No unbounded queue if the WebView is suspended or fails to load.
            if (queuedEvents.size < 32) queuedEvents.addLast(payload)
            else { queuedEvents.clear(); handler.post { if (started) connect() } }
        }
    }

    private fun onSurfaceMessage(message: JSONObject) {
        when (message.optString("op")) {
            "ready" -> {
                val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
                surface.receive(JSONObject().put("op", "theme").put("theme", if (dark) "dark" else "light"))
                when (gate.becameReady(connected, subscribed)) {
                    // The cached snapshot predates everything the Host has sent
                    // since, and the increments went to a page that no longer
                    // exists. Ask for a fresh bounded snapshot instead.
                    SurfaceReadyAction.SUBSCRIBE -> subscribe()
                    SurfaceReadyAction.WAIT -> { initialSnapshot = null; queuedEvents.clear() }
                    SurfaceReadyAction.REPLAY -> {
                        initialSnapshot?.let(surface::receive)
                        queuedEvents.forEach(surface::receive); queuedEvents.clear()
                    }
                }
                // The page is new: whatever it replays, it has never been told
                // about the send this composer is still waiting on. Without
                // this an uncertain message — the one the user most needs to
                // see — is invisible after a reload or a restored draft.
                pushPendingSend()
            }
            AgentChatWebView.SURFACE_RESET -> surfaceLost(replace = false)
            AgentChatWebView.SURFACE_GONE -> surfaceLost(replace = true)
            "earlier" -> {
                if (!started || !subscribed || message.optInt("generation", -1) != epoch.generation || earlierRequest != null) return
                val cursor = message.optLong("cursor", -1).takeIf { it >= 0 } ?: return
                val request = UUID.randomUUID().toString(); earlierRequest = request
                if (client?.sendControl("t" to "agent_chat_earlier", "requestId" to request, "conversationId" to conversationId,
                        "generation" to epoch.generation, "cursor" to cursor) != true) earlierRequest = null
                handler.postDelayed({ if (earlierRequest == request) { earlierRequest = null; showStatus(getString(R.string.agent_chat_history_retry)) } }, 10_000)
            }
            "copy" -> copy(message.optString("data"))
            "open" -> {
                com.termbridge.android.content.ArtifactPreviewActivity.open(this, message.optString("url"), conversationId, pin?.hostId)
            }
        }
    }

    /**
     * The page that held the conversation is gone. The old subscription is
     * dropped so its late events cannot be applied to the next page, and an
     * unconfirmed send stays unconfirmed: nothing is retransmitted.
     */
    private fun surfaceLost(replace: Boolean) {
        if (!gate.reset() && !replace) return
        initialSnapshot = null; queuedEvents.clear(); earlierRequest = null
        canSend = false
        uploadGate.revoked()
        handler.removeCallbacks(unsupportedTimeout)
        if (subscribed) {
            client?.sendControl("t" to "agent_chat_unsubscribe", "conversationId" to conversationId)
            subscribed = false
            epoch.nextSubscription()
        }
        draft.disconnected(getString(R.string.agent_chat_uncertain))
        renderComposer()
        if (replace) replaceSurface()
    }

    private fun replaceSurface() {
        if (isFinishing || isDestroyed || !::binding.isInitialized) return
        val old = surface
        binding.surfaceContainer.removeAllViews()
        old.release()
        surface = AgentChatWebView(this, ::onSurfaceMessage)
        binding.surfaceContainer.addView(surface, FrameLayout.LayoutParams(-1, -1))
    }

    private fun openTerminal() {
        if (isFinishing) return
        // A view switch opened above the existing terminal returns to that exact
        // Activity, preserving its native draft instead of recreating the screen.
        if (intent.getBooleanExtra("return_to_terminal", false)) { finish(); return }
        // The terminal inherits this window's whole pin. Forwarding only the Host
        // ID loses a profile that was pinned by endpoint before it had one, and
        // the terminal would then re-pin to whatever profile is current.
        startActivity(TerminalActivity.attachIntent(this, conversationId, displayName, intent.getBooleanExtra("is_herdr", true),
            pin?.hostId?.takeIf { it.isNotEmpty() } ?: settings.hostId,
            forceTerminal = true, endpointKey = pin?.endpointKey))
        finish()
    }
    private fun copy(text: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(getString(R.string.agent_chat_title), text))
        Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
    }


    private companion object {
        const val MAX_PROMPT = 16_000
    }
}
