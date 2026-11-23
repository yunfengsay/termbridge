package com.termbridge.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.PopupMenu
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.SimpleItemAnimator
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.chip.Chip
import com.google.android.material.snackbar.Snackbar
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.brain.BrainActivity
import com.termbridge.android.databinding.ActivityMainBinding
import com.termbridge.android.databinding.DialogRenameHostBinding
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.notifications.AgentMonitorService
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.HostNetworkPolicy
import com.termbridge.android.protocol.SessionInfo
import com.termbridge.android.ui.SessionAdapter
import com.termbridge.android.ui.applyWindowInsets
import com.termbridge.android.watch.WatchGatewayService
import java.util.UUID

class MainActivity : AppCompatActivity(), TermbridgeClient.Listener {
    private lateinit var binding: ActivityMainBinding
    private lateinit var adapter: SessionAdapter
    private val handler = Handler(Looper.getMainLooper())
    private var client: TermbridgeClient? = null
    private var started = false
    private var connected = false
    private var loaded = false
    private var sessions: List<SessionInfo> = emptyList()
    private var agentNames: List<String> = emptyList()
    private val hostChipViews = linkedMapOf<String, Chip>()
    private val networkPolicyRequests = mutableMapOf<String, NetworkPolicyRequest>()
    private var pendingNetworkPolicy: PendingNetworkPolicy? = null
    private val reconnect = Runnable {
        if (started && SettingsStore.load(this).connectionEnabled) connectNow()
    }
    private val sessionRefresh = object : Runnable {
        override fun run() {
            if (!started || !connected) return
            client?.sendControl("t" to "session_list")
            handler.postDelayed(this, SESSION_REFRESH_MS)
        }
    }
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && SettingsStore.load(this).connectionEnabled) AgentMonitorService.start(this)
    }
    private val connectionSettings = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            applyConnectionSettings(SettingsStore.load(this), R.string.settings_saved)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val hadSettings = SettingsStore.isConfigured(this)
        val debugConfigured = SettingsStore.applyDebugIntent(this, intent)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyWindowInsets(binding.root)

        adapter = SessionAdapter(::openSession, ::confirmKill)
        binding.sessionList.layoutManager = LinearLayoutManager(this)
        binding.sessionList.adapter = adapter
        (binding.sessionList.itemAnimator as? SimpleItemAnimator)?.supportsChangeAnimations = false
        binding.retryButton.setOnClickListener { connectNow() }
        binding.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_global -> {
                    val settings = SettingsStore.load(this)
                    if (settings.connectionEnabled) {
                        startActivity(BrainActivity.globalIntent(this))
                    } else {
                        Snackbar.make(
                            binding.root,
                            getString(R.string.connection_paused_detail, settings.displayName),
                            Snackbar.LENGTH_LONG,
                        ).show()
                    }
                    true
                }
                R.id.action_more -> {
                    showMainMenu()
                    true
                }
                else -> false
            }
        }

        if (!hadSettings && !debugConfigured) {
            binding.root.post { showConnectionSettings() }
        }
        val configured = SettingsStore.load(this)
        renderHosts(configured.profileKey)
        enableCompletionNotifications()
    }

    override fun onStart() {
        super.onStart()
        started = true
        connectNow()
    }

    override fun onResume() {
        super.onResume()
    }

    override fun onStop() {
        started = false
        handler.removeCallbacks(reconnect)
        handler.removeCallbacks(sessionRefresh)
        client?.disconnect()
        client = null
        connected = false
        super.onStop()
    }

    override fun onConnectionState(state: ConnectionState) = runOnUiThread {
        when (state) {
            ConnectionState.Connecting -> showConnectionState(R.string.connecting, R.drawable.status_dot_idle)
            ConnectionState.Authenticating -> showConnectionState(R.string.authenticating, R.drawable.status_dot_idle)
            ConnectionState.Connected -> {
                connected = true
                showConnectionState(R.string.connected, R.drawable.status_dot_active)
            }
            ConnectionState.Disconnected -> {
                connected = false
                showFailure(getString(R.string.disconnected), retry = true)
            }
            is ConnectionState.Failed -> {
                connected = false
                showFailure(state.message, retry = shouldRetry(state.message))
            }
        }
    }

    override fun onReady(client: TermbridgeClient) {
        client.sendControl("t" to "desktop_subscribe", "deviceId" to com.termbridge.android.peer.AndroidPeerIdentity.deviceId(this), "foreground" to true)
        client.sendControl("t" to "session_list")
        client.sendControl("t" to "agents")
        val active = SettingsStore.load(this)
        val pending = pendingNetworkPolicy?.takeIf { it.profileKey == active.profileKey }
        if (pending != null) sendNetworkPolicySet(client, pending)
        else requestNetworkPolicy(client, active.profileKey)
        handler.removeCallbacks(sessionRefresh)
        handler.postDelayed(sessionRefresh, SESSION_REFRESH_MS)
    }

    override fun onControl(message: ControlMessage) = runOnUiThread {
        if (message.type == "desktop_attention") {
            startActivity(com.termbridge.android.desktop.RemoteDesktopActivity.intent(this, SettingsStore.load(this).hostId))
            return@runOnUiThread
        }
        when (message.type) {
            "session_list_result" -> {
                loaded = true
                sessions = message.sessions().sortedWith(
                    compareByDescending<SessionInfo> { it.isActive }.thenByDescending { it.createdAt },
                )
                adapter.submitList(sessions)
                renderSessions()
            }
            "host_list_result" -> {
                val before = SettingsStore.load(this)
                val roster = message.hosts()
                val selectedHost = message.string("selectedHostId") ?: before.hostId
                SettingsStore.mergeDiscoveredHosts(
                    this,
                    before,
                    roster.map { it.hostId to it.name },
                    selectedHost,
                )
                val selected = SettingsStore.load(this)
                WatchGatewayService.sync(this)
                if (selected.hostId.isNotBlank() && selected.hostId != before.hostId) {
                    if (notificationsAllowed()) AgentMonitorService.switchHost(this)
                }
                renderHosts(selected.profileKey)
            }
            "agents_result" -> agentNames = message.stringList("names").distinct().sorted()
            "network_policy_result" -> handleNetworkPolicyResult(message)
            "error" -> showFailure(message.string("message") ?: "Host rejected the request", retry = false)
            "tool_request" -> rejectToolRequest(message)
        }
    }

    override fun onPtyOutput(sid: Int, data: ByteArray) = Unit

    private fun connectNow() {
        handler.removeCallbacks(reconnect)
        handler.removeCallbacks(sessionRefresh)
        networkPolicyRequests.clear()
        client?.disconnect()
        client = null
        connected = false
        val settings = SettingsStore.load(this)
        if (!settings.connectionEnabled) {
            showPausedConnection(settings)
            return
        }
        if (!loaded) binding.progress.visibility = View.VISIBLE
        settings.validationError()?.let {
            showFailure(it, retry = false)
            return
        }
        client = TermbridgeClient(settings, this).also(TermbridgeClient::connect)
    }

    private fun renderSessions() {
        binding.progress.visibility = View.GONE
        val active = sessions.count(SessionInfo::isActive)
        binding.sessionCount.text = resources.getQuantityString(
            R.plurals.session_count,
            sessions.size,
            sessions.size,
            active,
        )
        binding.emptyState.visibility = if (sessions.isEmpty()) View.VISIBLE else View.GONE
        binding.sessionList.visibility = if (sessions.isEmpty()) View.GONE else View.VISIBLE
        if (sessions.isEmpty()) {
            binding.emptyTitle.setText(R.string.no_sessions)
            binding.emptyDetail.setText(R.string.no_sessions_detail)
            binding.retryButton.visibility = View.GONE
        }
    }

    private fun renderHosts(selectedProfileKey: String) {
        val profiles = SettingsStore.profiles(this)
        binding.hostScroller.visibility = if (profiles.isEmpty()) View.GONE else View.VISIBLE

        val profileKeys = profiles.mapTo(linkedSetOf(), ConnectionSettings::profileKey)
        hostChipViews.keys.filterNot(profileKeys::contains).forEach { profileKey ->
            binding.hostChips.removeView(hostChipViews.remove(profileKey))
        }

        profiles.forEachIndexed { index, profile ->
            val chip = hostChipViews.getOrPut(profile.profileKey) { createHostChip() }
            bindHostChip(chip, profile)
            val currentIndex = binding.hostChips.indexOfChild(chip)
            if (currentIndex != index) {
                if (currentIndex >= 0) binding.hostChips.removeView(chip)
                binding.hostChips.addView(chip, index)
            }
        }

        val selectedProfile = profiles.firstOrNull { it.profileKey == selectedProfileKey }
        val selected = hostChipViews[selectedProfileKey]
        if (selectedProfile?.connectionEnabled == true && selected != null) {
            if (binding.hostChips.checkedChipId != selected.id) binding.hostChips.check(selected.id)
        } else {
            binding.hostChips.clearCheck()
        }
    }

    private fun createHostChip(): Chip {
        val checkedStates = arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf())
        val backgroundColors = intArrayOf(
            ContextCompat.getColor(this, R.color.surface_variant),
            ContextCompat.getColor(this, R.color.paper),
        )
        val textColors = intArrayOf(
            ContextCompat.getColor(this, R.color.ink),
            ContextCompat.getColor(this, R.color.ink_muted),
        )
        return Chip(this).apply {
            id = View.generateViewId()
            isCheckable = true
            isCheckedIconVisible = false
            chipMinHeight = dp(28).toFloat()
            minHeight = dp(28)
            setEnsureMinTouchTargetSize(false)
            textSize = 11f
            chipStrokeWidth = resources.displayMetrics.density
            chipStrokeColor = ColorStateList(checkedStates, textColors)
            chipBackgroundColor = ColorStateList(checkedStates, backgroundColors)
            setTextColor(ColorStateList(checkedStates, textColors))
            rippleColor = ColorStateList.valueOf(Color.TRANSPARENT)
        }
    }

    private fun bindHostChip(chip: Chip, profile: ConnectionSettings) {
        chip.apply {
            text = profile.displayName
            alpha = if (profile.connectionEnabled) 1f else DISCONNECTED_TAB_ALPHA
            isCheckable = profile.connectionEnabled
            if (!profile.connectionEnabled) isChecked = false
            contentDescription = buildString {
                append(profile.displayName)
                append(" (${profile.hostId.ifBlank { profile.relayUrl }})")
                if (!profile.connectionEnabled) append(", ${getString(R.string.connection_paused)}")
                append(", ${getString(networkPolicyLabel(profile.networkPolicy))}")
            }
            setOnClickListener {
                if (profile.connectionEnabled && profile.profileKey != SettingsStore.load(this@MainActivity).profileKey) {
                    switchHost(profile)
                }
            }
            setOnLongClickListener {
                showHostActions(profile)
                true
            }
        }
    }

    private fun switchHost(profile: ConnectionSettings, forceReconnect: Boolean = false) {
        if (!profile.connectionEnabled) return
        val current = SettingsStore.load(this)
        if (profile.profileKey != current.profileKey) SettingsStore.select(this, profile.profileKey)
        sessions = emptyList()
        loaded = false
        adapter.submitList(emptyList())
        renderSessions()
        renderHosts(profile.profileKey)
        WatchGatewayService.sync(this)
        if (notificationsAllowed()) AgentMonitorService.switchHost(this)
        if (forceReconnect || profile.profileKey != current.profileKey) connectNow()
    }

    private fun showHostActions(profile: ConnectionSettings) {
        val actions = buildList {
            add(HostAction.EDIT)
            add(HostAction.RENAME)
            add(HostAction.NETWORK)
            if (profile.connectionEnabled) add(HostAction.DISCONNECT)
            add(HostAction.RECONNECT)
            add(HostAction.UNPAIR)
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(profile.displayName)
            .setItems(actions.map { getString(it.label) }.toTypedArray()) { _, which ->
                when (actions[which]) {
                    HostAction.EDIT -> connectionSettings.launch(
                        Intent(this, ConnectionSettingsActivity::class.java)
                            .putExtra(ConnectionSettingsActivity.EXTRA_PROFILE_KEY, profile.profileKey),
                    )
                    HostAction.RENAME -> showRenameHost(profile)
                    HostAction.NETWORK -> showNetworkPolicy(profile)
                    HostAction.DISCONNECT -> disconnectHost(profile)
                    HostAction.RECONNECT -> reconnectHost(profile)
                    HostAction.UNPAIR -> confirmUnpair(profile)
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showNetworkPolicy(profile: ConnectionSettings) {
        val policies = HostNetworkPolicy.entries
        val labels = policies.map { policy ->
            when (policy) {
                HostNetworkPolicy.SYSTEM -> getString(R.string.network_policy_system_detail)
                HostNetworkPolicy.DIRECT -> getString(R.string.network_policy_direct_detail)
            }
        }.toTypedArray()
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.network_policy_title, profile.displayName))
            .setSingleChoiceItems(labels, policies.indexOf(profile.networkPolicy)) { dialog, which ->
                dialog.dismiss()
                applyNetworkPolicy(profile, policies[which])
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun applyNetworkPolicy(profile: ConnectionSettings, policy: HostNetworkPolicy) {
        val enabled = if (profile.connectionEnabled) profile else {
            SettingsStore.setConnectionEnabled(this, profile.profileKey, true) ?: profile
        }
        val updated = SettingsStore.setNetworkPolicy(this, enabled.profileKey, policy) ?: return
        val pending = PendingNetworkPolicy(updated.profileKey, policy)
        pendingNetworkPolicy = pending
        renderHosts(SettingsStore.load(this).profileKey)

        val active = SettingsStore.load(this)
        if (active.profileKey != updated.profileKey || !connected) {
            switchHost(updated, forceReconnect = true)
        } else {
            client?.let { sendNetworkPolicySet(it, pending) }
        }
    }

    private fun requestNetworkPolicy(client: TermbridgeClient, profileKey: String) {
        val requestId = UUID.randomUUID().toString()
        networkPolicyRequests[requestId] = NetworkPolicyRequest(profileKey, isUpdate = false)
        if (!client.sendControl("t" to "network_policy_get", "requestId" to requestId)) {
            networkPolicyRequests.remove(requestId)
        }
    }

    private fun sendNetworkPolicySet(client: TermbridgeClient, pending: PendingNetworkPolicy) {
        val requestId = UUID.randomUUID().toString()
        networkPolicyRequests[requestId] = NetworkPolicyRequest(pending.profileKey, isUpdate = true)
        val sent = client.sendControl(
            "t" to "network_policy_set",
            "requestId" to requestId,
            "policy" to pending.policy.wireName,
        )
        if (!sent) networkPolicyRequests.remove(requestId)
    }

    private fun handleNetworkPolicyResult(message: ControlMessage) {
        val requestId = message.string("requestId") ?: return
        val request = networkPolicyRequests.remove(requestId) ?: return
        val result = message.hostNetworkPolicy() ?: return
        val before = SettingsStore.profiles(this).firstOrNull { it.profileKey == request.profileKey }
        SettingsStore.setNetworkPolicy(this, request.profileKey, result.policy)
        renderHosts(SettingsStore.load(this).profileKey)

        if (request.isUpdate) {
            pendingNetworkPolicy = null
            val status = when {
                result.policy == HostNetworkPolicy.DIRECT -> R.string.network_policy_direct_confirmed
                result.proxyDetected -> R.string.network_policy_proxy_confirmed
                else -> R.string.network_policy_system_confirmed
            }
            Snackbar.make(
                binding.root,
                getString(status),
                Snackbar.LENGTH_LONG,
            ).show()
        }

        // The Host is authoritative. If it reports a different value, or it
        // just changed routes, re-dial after its own 3-second reconnect so the
        // phone also constructs its next socket under the confirmed policy.
        if ((before?.networkPolicy != result.policy || result.changed) &&
            SettingsStore.load(this).profileKey == request.profileKey
        ) {
            handler.postDelayed({ if (started) connectNow() }, NETWORK_POLICY_RECONNECT_DELAY_MS)
        }
    }

    private fun networkPolicyLabel(policy: HostNetworkPolicy): Int = when (policy) {
        HostNetworkPolicy.SYSTEM -> R.string.network_policy_system
        HostNetworkPolicy.DIRECT -> R.string.network_policy_direct
    }

    private fun showRenameHost(profile: ConnectionSettings) {
        val form = DialogRenameHostBinding.inflate(layoutInflater)
        form.hostAlias.setText(profile.displayName)
        form.hostAlias.selectAll()
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.rename_host)
            .setView(form.root)
            .setNegativeButton(R.string.cancel, null)
            .setNeutralButton(R.string.use_reported_name) { _, _ -> renameHost(profile, "") }
            .setPositiveButton(R.string.save) { _, _ ->
                renameHost(profile, form.hostAlias.text?.toString().orEmpty())
            }
            .show()
    }

    private fun renameHost(profile: ConnectionSettings, alias: String) {
        val renamed = SettingsStore.rename(this, profile.profileKey, alias) ?: return
        renderHosts(SettingsStore.load(this).profileKey)
        Snackbar.make(
            binding.root,
            getString(R.string.host_renamed, renamed.displayName),
            Snackbar.LENGTH_SHORT,
        ).show()
    }

    private fun disconnectHost(profile: ConnectionSettings) {
        val wasActive = profile.profileKey == SettingsStore.load(this).profileKey
        val disconnected = SettingsStore.setConnectionEnabled(this, profile.profileKey, false) ?: return
        renderHosts(SettingsStore.load(this).profileKey)
        WatchGatewayService.sync(this)
        if (!wasActive) return

        handler.removeCallbacks(reconnect)
        handler.removeCallbacks(sessionRefresh)
        client?.disconnect()
        client = null
        connected = false
        loaded = false
        sessions = emptyList()
        agentNames = emptyList()
        adapter.submitList(emptyList())
        AgentMonitorService.stop(this)
        showPausedConnection(disconnected)
        Snackbar.make(
            binding.root,
            getString(R.string.host_disconnected, disconnected.displayName),
            Snackbar.LENGTH_LONG,
        ).show()
    }

    private fun reconnectHost(profile: ConnectionSettings) {
        val enabled = SettingsStore.setConnectionEnabled(this, profile.profileKey, true) ?: return
        SettingsStore.select(this, enabled.profileKey)
        renderHosts(enabled.profileKey)
        WatchGatewayService.sync(this)
        loaded = false
        sessions = emptyList()
        adapter.submitList(emptyList())
        if (notificationsAllowed()) AgentMonitorService.switchHost(this)
        if (started) connectNow()
    }

    private fun confirmUnpair(profile: ConnectionSettings) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.unpair_host)
            .setMessage(getString(R.string.unpair_host_message, profile.displayName))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.unpair) { _, _ ->
                val removedActive = profile.profileKey == SettingsStore.load(this).profileKey
                val next = SettingsStore.remove(this, profile.profileKey)
                renderHosts(next?.profileKey.orEmpty())
                WatchGatewayService.sync(this)
                if (removedActive) {
                    sessions = emptyList()
                    loaded = false
                    adapter.submitList(emptyList())
                    renderSessions()
                    client?.disconnect()
                    client = null
                    connected = false
                    if (next != null) {
                        AgentMonitorService.switchHost(this)
                        connectNow()
                    } else {
                        AgentMonitorService.stop(this)
                        showConnectionSettings()
                    }
                }
            }
            .show()
    }

    private fun enableCompletionNotifications() {
        AgentMonitorService.createChannels(this)
        if (!SettingsStore.load(this).connectionEnabled) return
        if (notificationsAllowed()) {
            AgentMonitorService.start(this)
        } else {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun notificationsAllowed(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun showConnectionState(label: Int, dot: Int) {
        binding.connectionStatus.setText(label)
        binding.connectionStatus.setTextColor(ContextCompat.getColor(this, R.color.ink_muted))
        binding.connectionDot.setBackgroundResource(dot)
    }

    private fun showPausedConnection(profile: ConnectionSettings) {
        binding.progress.visibility = View.GONE
        binding.connectionStatus.setText(R.string.connection_paused)
        binding.connectionStatus.setTextColor(ContextCompat.getColor(this, R.color.ink_muted))
        binding.connectionDot.setBackgroundResource(R.drawable.status_dot_idle)
        binding.emptyState.visibility = View.VISIBLE
        binding.sessionList.visibility = View.GONE
        binding.emptyTitle.setText(R.string.connection_paused)
        binding.emptyDetail.text = getString(R.string.connection_paused_detail, profile.displayName)
        binding.retryButton.visibility = View.GONE
    }

    private fun showFailure(message: String, retry: Boolean) {
        handler.removeCallbacks(sessionRefresh)
        binding.progress.visibility = View.GONE
        binding.connectionStatus.text = message
        binding.connectionStatus.setTextColor(ContextCompat.getColor(this, R.color.red))
        binding.connectionDot.setBackgroundResource(R.drawable.status_dot_error)
        if (!loaded || sessions.isEmpty()) {
            binding.emptyState.visibility = View.VISIBLE
            binding.sessionList.visibility = View.GONE
            binding.emptyTitle.setText(R.string.disconnected)
            binding.emptyDetail.text = message
            binding.retryButton.visibility = View.VISIBLE
        }
        if (retry && started) {
            binding.connectionStatus.setText(R.string.reconnecting)
            handler.removeCallbacks(reconnect)
            handler.postDelayed(reconnect, RECONNECT_DELAY_MS)
        }
    }

    private fun shouldRetry(message: String): Boolean {
        val fatalWords = listOf("password", "fingerprint", "authentication", "host not found", "multiple hosts", "invalid")
        return fatalWords.none { message.contains(it, ignoreCase = true) }
    }

    private fun showMainMenu() {
        val agents = listOf("shell") + agentNames.filterNot { it == "shell" }
        PopupMenu(this, binding.toolbar.findViewById<View>(R.id.action_more)).apply {
            inflate(R.menu.main_overflow)
            setForceShowIcon(true)
            val newSession = menu.findItem(R.id.action_new_session)
            newSession.isEnabled = connected
            val agentMenu = requireNotNull(newSession.subMenu)
            agents.forEachIndexed { index, agent ->
                val key = agent.lowercase()
                val label = when (key) {
                    "shell" -> getString(R.string.shell)
                    "cc", "claude", "claude-code" -> "Claude Code"
                    "codex" -> "Codex"
                    else -> agent
                }
                val icon = when {
                    key == "cc" || "claude" in key -> R.drawable.ic_agent_claude
                    "codex" in key -> R.drawable.ic_agent_codex
                    else -> R.drawable.ic_agent_shell
                }
                agentMenu.add(0, View.generateViewId(), index, label).setIcon(icon)
                    .setOnMenuItemClickListener {
                        if (connected) openNewSession(agent)
                        else Snackbar.make(binding.root, R.string.disconnected, Snackbar.LENGTH_LONG).show()
                        true
                    }
            }
            setOnMenuItemClickListener { item ->
                if (item.itemId == R.id.action_desktop) {
                    startActivity(com.termbridge.android.desktop.RemoteDesktopActivity.intent(this@MainActivity))
                    true
                } else if (item.itemId == R.id.action_settings) {
                    connectionSettings.launch(Intent(this@MainActivity, GlobalSettingsActivity::class.java))
                    true
                } else false
            }
            com.termbridge.android.ui.MenuAppearance.apply(this@MainActivity, menu)
            show()
        }
    }

    private fun openSession(session: SessionInfo) {
        startActivity(
            TerminalActivity.attachIntent(
                this,
                session.sessionId,
                session.displayName,
                session.isHerdr,
                SettingsStore.load(this).hostId,
            ),
        )
    }

    private fun openNewSession(agent: String) {
        startActivity(TerminalActivity.createIntent(this, agent))
    }

    private fun confirmKill(session: SessionInfo) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.kill_session)
            .setMessage(getString(R.string.kill_session_message, session.command))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.kill) { _, _ ->
                client?.sendControl("t" to "kill", "sessionId" to session.sessionId)
                sessions = sessions.filterNot { it.sessionId == session.sessionId }
                adapter.submitList(sessions)
                renderSessions()
                handler.postDelayed({ if (connected) client?.sendControl("t" to "session_list") }, 500)
            }
            .show()
    }

    private fun showConnectionSettings() {
        connectionSettings.launch(Intent(this, ConnectionSettingsActivity::class.java))
    }

    private fun applyConnectionSettings(candidate: ConnectionSettings, message: Int) {
        SettingsStore.save(this, candidate)
        WatchGatewayService.sync(this)
        loaded = false
        sessions = emptyList()
        adapter.submitList(emptyList())
        renderHosts(SettingsStore.load(this).profileKey)
        if (notificationsAllowed()) AgentMonitorService.switchHost(this)
        Snackbar.make(binding.root, message, Snackbar.LENGTH_SHORT).show()
        if (started) connectNow()
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

    private companion object {
        const val RECONNECT_DELAY_MS = 3_000L
        const val SESSION_REFRESH_MS = 2_500L
        const val DISCONNECTED_TAB_ALPHA = 0.38f
        const val NETWORK_POLICY_RECONNECT_DELAY_MS = 4_500L
    }

    private enum class HostAction(val label: Int) {
        EDIT(R.string.connection_edit),
        RENAME(R.string.rename_host),
        NETWORK(R.string.network_policy_action),
        DISCONNECT(R.string.disconnect),
        RECONNECT(R.string.reconnect),
        UNPAIR(R.string.unpair_host),
    }

    private data class PendingNetworkPolicy(
        val profileKey: String,
        val policy: HostNetworkPolicy,
    )

    private data class NetworkPolicyRequest(
        val profileKey: String,
        val isUpdate: Boolean,
    )
}
