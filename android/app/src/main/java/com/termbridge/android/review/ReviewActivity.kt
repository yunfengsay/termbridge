package com.termbridge.android.review

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.activity.addCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.isVisible
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.termbridge.android.R
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.databinding.ActivityReviewBinding
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.chat.SessionConnectionGate
import com.termbridge.android.chat.SessionHostPin
import com.termbridge.android.chat.SessionPinHandoff
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.ReviewSnapshotInfo
import com.termbridge.android.ui.applyWindowInsets
import com.termbridge.android.watch.WatchGatewayService
import java.util.UUID

class ReviewActivity : AppCompatActivity(), TermbridgeClient.Listener {
    private lateinit var binding: ActivityReviewBinding
    private val adapter by lazy { ReviewAdapter(ReviewSyntaxHighlighter(applicationContext)) }
    private val navigatorAdapter = ReviewNavigatorAdapter(::onNavigatorRowClicked)
    /** Every connection this screen opens goes through the pin, or does not open. */
    private val gate = SessionConnectionGate<TermbridgeClient>(
        openClient = { TermbridgeClient(it, this).also(TermbridgeClient::connect) },
        closeClient = TermbridgeClient::disconnect,
    )
    private var clientGeneration = 0
    private val client: TermbridgeClient? get() = gate.client
    private var connected = false
    private lateinit var sessionId: String
    private var hostId: String? = null
    private var mode = MODE_WORKING
    private var baseBranch: String? = null
    private var snapshot: ReviewSnapshotInfo? = null
    private var pendingRequestId: String? = null
    private var navigatorMode = ReviewNavigatorMode.TREE
    private val collapsedDirectories = linkedSetOf<String>()
    private var navigatorOpen = true
    private var selectedPath: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityReviewBinding.inflate(layoutInflater)
        setContentView(binding.root)
        applyWindowInsets(binding.root)

        sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: run {
            finish()
            return
        }
        hostId = intent.getStringExtra(EXTRA_HOST_ID)
        val current = SettingsStore.load(this)
        val profiles = SettingsStore.profiles(this)
        gate.pin = savedInstanceState
            ?.let { SessionHostPin.restore(it.getString(STATE_PIN_HOST), it.getString(STATE_PIN_ENDPOINT)) }
            ?: SessionPinHandoff.receive(
                forwarded = intent.hasExtra(EXTRA_ENDPOINT_KEY),
                hostId = hostId,
                endpointKey = intent.getStringExtra(EXTRA_ENDPOINT_KEY),
                current = current,
                profiles = profiles,
            )
        routeToRequestedHost()
        mode = intent.getStringExtra(EXTRA_MODE)?.takeIf { it in MODES } ?: MODE_FILES
        binding.toolbar.title = getString(R.string.review_title)
        binding.toolbar.subtitle = intent.getStringExtra(EXTRA_DISPLAY_NAME)
        binding.toolbar.setNavigationOnClickListener { navigateBack() }
        com.termbridge.android.ui.MenuAppearance.apply(this, binding.toolbar.menu)
        binding.toolbar.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                R.id.action_review_files -> {
                    navigatorOpen = !navigatorOpen
                    renderSnapshot()
                    if (!navigatorOpen && connected) requestSnapshot(selectedPath)
                    true
                }
                R.id.action_review_layout -> {
                    navigatorMode = if (navigatorMode == ReviewNavigatorMode.TREE) {
                        ReviewNavigatorMode.FLAT
                    } else {
                        ReviewNavigatorMode.TREE
                    }
                    navigatorOpen = true
                    renderSnapshot()
                    true
                }
                R.id.action_review_refresh -> {
                    requestSnapshot()
                    true
                }
                R.id.action_review_switch_branch -> {
                    showBranchSwitcher()
                    true
                }
                else -> false
            }
        }

        binding.reviewList.layoutManager = LinearLayoutManager(this)
        binding.reviewList.adapter = adapter
        binding.navigatorList.layoutManager = LinearLayoutManager(this)
        binding.navigatorList.adapter = navigatorAdapter
        binding.reviewMode.check(
            when (mode) {
                MODE_BRANCH -> R.id.reviewModeBranch
                MODE_FILES -> R.id.reviewModeFiles
                else -> R.id.reviewModeWorking
            },
        )
        binding.compareBranchLayout.isVisible = mode == MODE_BRANCH
        binding.reviewMode.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            mode = when (checkedId) {
                R.id.reviewModeBranch -> MODE_BRANCH
                R.id.reviewModeFiles -> MODE_FILES
                else -> MODE_WORKING
            }
            binding.compareBranchLayout.isVisible = mode == MODE_BRANCH
            if (connected) {
                selectedPath = null
                navigatorOpen = true
                requestSnapshot()
            }
        }
        binding.compareBranch.setOnItemClickListener { parent, _, position, _ ->
            baseBranch = parent.getItemAtPosition(position) as? String
            selectedPath = null
            navigatorOpen = true
            requestSnapshot()
        }
        onBackPressedDispatcher.addCallback(this) { navigateBack() }
    }

    override fun onStart() {
        super.onStart()
        connect()
    }

    override fun onStop() {
        connected = false
        gate.disconnect()
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_PIN_HOST, gate.pin?.hostId)
        outState.putString(STATE_PIN_ENDPOINT, gate.pin?.endpointKey)
        super.onSaveInstanceState(outState)
    }

    override fun onConnectionState(state: ConnectionState) = runOnUiThread {
        if (!gate.accepts(clientGeneration)) return@runOnUiThread
        when (state) {
            ConnectionState.Connecting -> showLoading(getString(R.string.connecting))
            ConnectionState.Authenticating -> showLoading(getString(R.string.authenticating))
            ConnectionState.Connected -> connected = true
            ConnectionState.Disconnected -> showError(getString(R.string.disconnected))
            is ConnectionState.Failed -> showError(state.message)
        }
    }

    override fun onReady(client: TermbridgeClient) = runOnUiThread {
        if (!gate.accepts(clientGeneration)) return@runOnUiThread
        connected = true
        requestSnapshot()
    }

    override fun onControl(message: ControlMessage) = runOnUiThread {
        when (message.type) {
            "review_snapshot_result" -> handleSnapshot(message)
            "review_switch_branch_result" -> handleBranchSwitch(message)
            "error" -> showError(message.string("message") ?: getString(R.string.review_load_failed))
        }
    }

    override fun onPtyOutput(sid: Int, data: ByteArray) = Unit

    private fun connect() {
        // Resolving through the gate is what stops this screen from opening a
        // client on the current Host and sending the original Host's session ID
        // to it. Returning from routeToRequestedHost alone never did that.
        if (gate.connect(SettingsStore.load(this), SettingsStore.profiles(this)) == null) {
            showError(getString(R.string.session_host_missing))
            return
        }
        clientGeneration = gate.generation
        gate.settings?.validationError()?.let {
            gate.disconnect()
            showError(it)
        }
    }

    private fun requestSnapshot(priorityPath: String? = selectedPath.takeIf { !navigatorOpen }) {
        val activeClient = client ?: return
        val requestId = UUID.randomUUID().toString()
        pendingRequestId = requestId
        showLoading(getString(if (mode == MODE_FILES) R.string.review_project_loading else R.string.review_loading))
        val sent = activeClient.sendControl(
            "t" to "review_snapshot",
            "requestId" to requestId,
            "sessionId" to sessionId,
            "mode" to mode,
            "baseBranch" to baseBranch.takeIf { mode == MODE_BRANCH },
            "path" to priorityPath,
        )
        if (!sent) showError(getString(R.string.review_load_failed))
    }

    private fun handleSnapshot(message: ControlMessage) {
        if (message.string("requestId") != pendingRequestId) return
        pendingRequestId = null
        message.string("error")?.let {
            showError(it)
            return
        }
        val next = message.reviewSnapshot() ?: run {
            showError(getString(R.string.review_load_failed))
            return
        }
        snapshot = next
        baseBranch = next.baseBranch
        selectedPath = selectedPath?.takeIf { path -> next.files.any { it.path == path } }
            ?: next.files.firstOrNull()?.path
        bindBranches(next)
        binding.progress.visibility = View.GONE
        binding.reviewStatus.visibility = View.GONE
        binding.toolbar.menu.findItem(R.id.action_review_switch_branch)?.isEnabled = next.branches.size > 1
        renderSnapshot()
    }

    private fun bindBranches(next: ReviewSnapshotInfo) {
        val compareBranches = next.branches
        binding.compareBranch.setAdapter(
            ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, compareBranches),
        )
        binding.compareBranch.setText(next.baseBranch.orEmpty(), false)
        binding.compareBranchLayout.isVisible = mode == MODE_BRANCH && compareBranches.isNotEmpty()
    }

    private fun showBranchSwitcher() {
        val current = snapshot ?: return
        if (!current.canSwitchBranch) {
            MaterialAlertDialogBuilder(this)
                .setTitle(R.string.review_switch_branch)
                .setMessage(R.string.review_switch_dirty)
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }
        val branches = current.branches.filter { it != current.branch }
        if (branches.isEmpty()) return
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.review_switch_branch)
            .setItems(branches.toTypedArray()) { _, index -> confirmBranchSwitch(branches[index]) }
            .show()
    }

    private fun confirmBranchSwitch(branch: String) {
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.review_switch_branch)
            .setMessage(getString(R.string.review_switch_branch_message, branch))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.review_switch) { _, _ -> switchBranch(branch) }
            .show()
    }

    private fun switchBranch(branch: String) {
        val requestId = UUID.randomUUID().toString()
        pendingRequestId = requestId
        showLoading(getString(R.string.review_switching_branch, branch))
        val sent = client?.sendControl(
            "t" to "review_switch_branch",
            "requestId" to requestId,
            "sessionId" to sessionId,
            "branch" to branch,
        ) == true
        if (!sent) showError(getString(R.string.review_switch_failed))
    }

    private fun handleBranchSwitch(message: ControlMessage) {
        if (message.string("requestId") != pendingRequestId) return
        pendingRequestId = null
        if (message.boolean("ok") != true) {
            showError(message.string("error") ?: getString(R.string.review_switch_failed))
            return
        }
        val branch = message.string("branch").orEmpty()
        Toast.makeText(this, getString(R.string.review_switched_branch, branch), Toast.LENGTH_SHORT).show()
        baseBranch = null
        requestSnapshot()
    }

    private fun showLoading(message: String) {
        binding.progress.visibility = View.VISIBLE
        binding.reviewStatus.text = message
        binding.reviewStatus.visibility = if (adapter.itemCount == 0 && navigatorAdapter.itemCount == 0) View.VISIBLE else View.GONE
    }

    private fun showError(message: String) {
        binding.progress.visibility = View.GONE
        binding.reviewStatus.text = message
        binding.reviewStatus.visibility = View.VISIBLE
        if (adapter.itemCount == 0) {
            binding.reviewList.visibility = View.GONE
            binding.fileNavigator.visibility = View.GONE
        }
    }

    private fun onNavigatorRowClicked(row: ReviewNavigatorRow) {
        when (row) {
            is ReviewNavigatorRow.Directory -> {
                if (row.expanded) collapsedDirectories += row.path else collapsedDirectories -= row.path
            }
            is ReviewNavigatorRow.File -> {
                selectedPath = row.file.path
                navigatorOpen = false
                renderSnapshot()
                if (connected) requestSnapshot(row.file.path)
                return
            }
        }
        renderSnapshot()
    }

    private fun renderSnapshot() {
        val current = snapshot ?: return
        val files = current.files
        navigatorAdapter.submitList(
            ReviewNavigatorPresentation.rows(files, navigatorMode, collapsedDirectories, selectedPath),
        )
        adapter.submitList(ReviewPresentation.rows(current, selectedPath))
        val showNavigator = navigatorOpen && files.isNotEmpty()
        binding.fileNavigator.isVisible = showNavigator
        binding.reviewList.isVisible = !showNavigator
        if (showNavigator) {
            binding.toolbar.title = current.repository
            binding.toolbar.subtitle = if (mode == MODE_FILES) {
                getString(R.string.review_project_summary, current.branch, current.changedFileCount)
            } else {
                getString(
                    R.string.review_summary,
                    current.branch,
                    current.changedFileCount,
                    current.additions,
                    current.deletions,
                )
            }
        } else {
            val path = selectedPath
            binding.toolbar.title = path?.substringAfterLast('/') ?: current.repository
            binding.toolbar.subtitle = path?.substringBeforeLast('/', missingDelimiterValue = current.branch)
                ?: current.branch
        }
        binding.navigatorTitle.setText(when {
            mode == MODE_FILES && navigatorMode == ReviewNavigatorMode.TREE -> R.string.review_project_tree
            mode == MODE_FILES -> R.string.review_project_flat
            navigatorMode == ReviewNavigatorMode.TREE -> R.string.review_tree_view
            else -> R.string.review_flat_view
        })
        binding.navigatorSummary.text = resources.getQuantityString(
            R.plurals.review_file_count,
            files.size,
            files.size,
        )
        binding.toolbar.menu.findItem(R.id.action_review_files)?.apply {
            isEnabled = files.isNotEmpty()
            setTitle(if (showNavigator) R.string.review_hide_files else R.string.review_show_files)
        }
        binding.toolbar.menu.findItem(R.id.action_review_layout)?.apply {
            isEnabled = files.isNotEmpty()
            setTitle(if (navigatorMode == ReviewNavigatorMode.TREE) R.string.review_switch_to_flat else R.string.review_switch_to_tree)
            setIcon(if (navigatorMode == ReviewNavigatorMode.TREE) R.drawable.ic_view_list else R.drawable.ic_account_tree)
        }
    }

    private fun navigateBack() {
        if (!navigatorOpen && selectedPath != null) {
            navigatorOpen = true
            renderSnapshot()
        } else {
            finish()
        }
    }

    /**
     * Session navigation may only select a profile the user has saved. Applying
     * the wanted Host to whatever profile is current and saving the result would
     * rebuild a deleted Host out of an unrelated relay and credentials.
     */
    private fun routeToRequestedHost() {
        val current = SettingsStore.load(this)
        val key = SessionHostPin.navigate(gate.pin, current, SettingsStore.profiles(this)).selectProfileKey ?: return
        if (!SettingsStore.select(this, key)) return
        WatchGatewayService.sync(this)
    }

    companion object {
        private const val EXTRA_SESSION_ID = "session_id"
        private const val EXTRA_HOST_ID = "host_id"
        private const val EXTRA_ENDPOINT_KEY = "endpoint_key"
        private const val STATE_PIN_HOST = "state_pin_host"
        private const val STATE_PIN_ENDPOINT = "state_pin_endpoint"
        private const val EXTRA_DISPLAY_NAME = "display_name"
        private const val EXTRA_MODE = "mode"
        private const val MODE_WORKING = "working"
        private const val MODE_BRANCH = "branch"
        private const val MODE_FILES = "files"
        private val MODES = setOf(MODE_WORKING, MODE_BRANCH, MODE_FILES)

        fun intent(
            context: Context,
            sessionId: String,
            displayName: String,
            hostId: String?,
            mode: String = MODE_WORKING,
            endpointKey: String? = null,
        ): Intent = Intent(context, ReviewActivity::class.java)
            .putExtra(EXTRA_SESSION_ID, sessionId)
            .putExtra(EXTRA_HOST_ID, hostId)
            .putExtra(EXTRA_DISPLAY_NAME, displayName)
            .putExtra(EXTRA_MODE, mode)
            // Only set when the caller really has a pin: its presence is what
            // tells this screen to adopt it instead of deriving a new one.
            .apply { if (endpointKey != null) putExtra(EXTRA_ENDPOINT_KEY, endpointKey) }
    }
}
