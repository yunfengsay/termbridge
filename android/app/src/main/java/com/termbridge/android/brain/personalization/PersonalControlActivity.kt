package com.termbridge.android.brain.personalization

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.termbridge.android.R
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.peer.AndroidPeerIdentity
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.VoiceLearningProtocol
import com.termbridge.android.ui.applyWindowInsets
import java.text.DateFormat
import java.util.Date
import java.util.UUID
import java.util.concurrent.Executors

/** A settings page, not a microphone service. Connecting never starts a voice session. */
class PersonalControlActivity : AppCompatActivity(), TermbridgeClient.Listener {
    private lateinit var store: PersonalControlStore
    private lateinit var content: LinearLayout
    private lateinit var status: TextView
    private val executor = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private var client: TermbridgeClient? = null
    private var pending: String? = null
    private var syncSent = false
    private var resyncNeeded = false
    private var active = false
    private var page = 0
    private val timeout = Runnable { finishSync(R.string.voice_learning_timeout) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = PersonalControlStore(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(MaterialToolbar(this).apply {
            setTitle(R.string.voice_learning_title)
            setNavigationIcon(androidx.appcompat.R.drawable.abc_ic_ab_back_material)
            setNavigationOnClickListener { finish() }
        })
        status = TextView(this).apply { setPadding(24, 8, 24, 8); setText(R.string.voice_learning_shadow) }
        root.addView(status)
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 0, 24, 24) }
        root.addView(ScrollView(this).apply { addView(content) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root); applyWindowInsets(root)
    }
    override fun onStart() { super.onStart(); active = true; render() }
    override fun onStop() {
        active = false; pending = null; handler.removeCallbacks(timeout); client?.disconnect(); client = null
        super.onStop()
    }
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
    private fun work(action: () -> Unit) {
        executor.execute {
            val result = runCatching(action)
            runOnUiThread { if (active) {
                if (result.isFailure) status.setText(R.string.voice_learning_failed)
                render()
                if (result.isSuccess) { if (pending != null) resyncNeeded = true else sync() }
            } }
        }
    }
    private fun render() {
        executor.execute {
            val result = runCatching { store.snapshot() to store.model() }
            runOnUiThread {
                if (!active) return@runOnUiThread
                val (snapshot, model) = result.getOrElse { status.setText(R.string.voice_learning_failed); return@runOnUiThread }
                content.removeAllViews()
                content.addView(TextView(this).apply { setText(R.string.voice_learning_detail) })
                content.addView(MaterialSwitch(this).apply {
                    val settings = com.termbridge.android.brain.VoiceSettingsStore(this@PersonalControlActivity)
                    setText(R.string.voice_learning_adaptive); isChecked = settings.load().adaptiveTurnControl
                    setOnCheckedChangeListener { _, enabled -> settings.setAdaptiveTurnControl(enabled) }
                })
                content.addView(MaterialSwitch(this).apply {
                    setText(R.string.voice_boundary_learning); isChecked = snapshot.getBoolean("enabled")
                    setOnCheckedChangeListener { _, enabled -> work { store.consent(enabled) } }
                })
                content.addView(MaterialSwitch(this).apply {
                    setText(R.string.voice_learning_context_consent); isChecked = snapshot.optBoolean("contextConsent")
                    setOnCheckedChangeListener { _, enabled -> work { store.contextConsent(enabled) } }
                })
                snapshot.optJSONObject("assist")?.let { assist ->
                    content.addView(TextView(this).apply { text = getString(R.string.voice_learning_assist_status,
                        assist.optInt("examples"), assist.optLong("trainingMs"), snapshot.optString("assistHost"), assist.optInt("rules")) })
                }
                content.addView(TextView(this).apply { text = getString(R.string.voice_learning_version, model.version.take(22), model.samples) })
                button(content, R.string.voice_learning_sync) { sync() }
                button(content, R.string.voice_learning_revoke) { work { store.consent(false) }; status.setText(R.string.voice_learning_revoke_pending) }
                val feedback = PersonalControlStore.objects(snapshot.getJSONArray("feedback"))
                val observations = PersonalControlStore.objects(snapshot.getJSONArray("observations")).asReversed()
                if (observations.isEmpty()) content.addView(TextView(this).apply { setText(R.string.voice_boundary_samples_empty) })
                page = page.coerceIn(0, ((observations.size - 1) / 20).coerceAtLeast(0))
                if (page > 0) button(content, R.string.voice_learning_previous) { page--; render() }
                if ((page + 1) * 20 < observations.size) button(content, R.string.voice_learning_next) { page++; render() }
                observations.drop(page * 20).take(20).forEach { row ->
                    val id = row.getString("id")
                    val features = PersonalControlStore.numbers(row.getJSONArray("features"))
                    if (row.has("text")) content.addView(TextView(this).apply {
                        setPadding(0, 16, 0, 0); text = listOf(row.optString("context"), row.getString("text")).filter { it.isNotBlank() }.joinToString("\n→ ")
                    })
                    content.addView(TextView(this).apply {
                        setPadding(0, 24, 0, 4)
                        text = getString(R.string.voice_learning_observation, DateFormat.getDateTimeInstance().format(Date(row.getLong("at"))),
                            (model.probability("addressed", features) * 100).toInt(), (model.probability("finished", features) * 100).toInt())
                    })
                    for ((head, title) in listOf("addressed" to R.string.voice_learning_addressed, "finished" to R.string.voice_learning_finished)) {
                        content.addView(TextView(this).apply { setText(title) })
                        val selected = feedback.firstOrNull { it.getString("observation") == id && it.getString("head") == head }?.getInt("label")
                        val buttons = LinearLayout(this)
                        listOf(1 to R.string.voice_learning_yes, 0 to R.string.voice_learning_no, null to R.string.voice_learning_skip).forEach { (label, name) ->
                            buttons.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                                setText(name); isCheckable = true; isChecked = selected == label
                                setOnClickListener { work { store.label(id, head, label) } }
                            }, LinearLayout.LayoutParams(0, -2, 1f))
                        }
                        content.addView(buttons)
                    }
                    button(content, R.string.voice_boundary_delete) { work { store.delete(id) }; status.setText(R.string.voice_learning_revoke_pending) }
                }
            }
        }
    }
    private fun button(parent: LinearLayout, title: Int, action: () -> Unit) {
        parent.addView(MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
            setText(title); setOnClickListener { action() }
        })
    }
    private fun sync() {
        if (pending != null) return
        val settings = SettingsStore.load(this)
        if (settings.validationError() != null) { status.setText(R.string.voice_learning_failed); return }
        pending = UUID.randomUUID().toString(); syncSent = false; status.setText(R.string.voice_learning_syncing)
        handler.postDelayed(timeout, 15_000)
        client = TermbridgeClient(settings, this).also { it.connect() }
    }
    override fun onReady(client: TermbridgeClient) {
        client.sendControl("t" to "peer_register", "deviceId" to AndroidPeerIdentity.deviceId(this),
            "platform" to "android", "name" to AndroidPeerIdentity.displayName(), "role" to "manager",
            "capabilities" to listOf("voice.personalization", "peer.control-only"))
        client.sendControl("t" to "brain_snapshot")
    }
    override fun onControl(message: ControlMessage) = runOnUiThread {
        if (!active || pending == null) return@runOnUiThread
        if (message.type == "brain_snapshot_result") {
            if (syncSent) return@runOnUiThread
            if ((message.int(VoiceLearningProtocol.CAPABILITY) ?: 0) < 2) { finishSync(R.string.voice_learning_host_old); return@runOnUiThread }
            val id = pending ?: return@runOnUiThread
            syncSent = true
            executor.execute {
                val wire = runCatching { store.request(id) }
                runOnUiThread {
                    if (pending == id && active && (wire.isFailure || client?.sendControl(*wire.getOrThrow().map { it.key to it.value }.toTypedArray()) != true)) finishSync(R.string.voice_learning_failed)
                }
            }
        }
        if (message.type == VoiceLearningProtocol.RESULT && message.string("requestId") == pending) {
            val id = pending
            executor.execute {
                val accepted = runCatching {
                    val ok = when (message.string("status")) {
                        "completed" -> store.applyHost(ControlModel.wireRevision(message.fields["revision"]), message.fields["model"] as Map<*, *>)
                        "revoked" -> ControlModel.wireRevision(message.fields["revision"]) == store.snapshot().getLong("revision")
                        else -> false
                    }
                    ok && store.acknowledge(SettingsStore.load(this).hostId, ControlModel.wireRevision(message.fields["revision"]), message.fields["assist"] as? Map<*, *>)
                }.getOrDefault(false)
                runOnUiThread { if (active && pending == id) { finishSync(if (accepted) R.string.voice_learning_synced else R.string.voice_learning_failed); render() } }
            }
        }
    }
    private fun finishSync(message: Int) {
        handler.removeCallbacks(timeout); pending = null; client?.disconnect(); client = null
        if (active) status.setText(message)
        if (active && resyncNeeded) { resyncNeeded = false; handler.postDelayed({ if (active) sync() }, 200) }
    }
    override fun onConnectionState(state: ConnectionState) {
        if (state is ConnectionState.Failed) runOnUiThread { if (pending != null) finishSync(R.string.voice_learning_failed) }
    }
    override fun onPtyOutput(sid: Int, data: ByteArray) = Unit
}
