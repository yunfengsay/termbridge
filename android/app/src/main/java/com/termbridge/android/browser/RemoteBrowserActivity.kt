package com.termbridge.android.browser

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.graphics.ColorUtils
import androidx.core.view.WindowCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import com.termbridge.android.R
import com.termbridge.android.chat.SessionHostPin
import com.termbridge.android.chat.SessionPin
import com.termbridge.android.data.ConnectionMode
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.HostNetworkPolicy
import com.termbridge.android.protocol.ProxyTunnelProtocol
import com.termbridge.android.ui.applyWindowInsets
import java.util.concurrent.Executor

/**
 * Built-in browser running in the isolated `:browser` process.
 *
 * Every HTTP, HTTPS, WebSocket, and loopback request made by this WebView is forced through
 * a local loopback proxy multiplexed over the target Host's TermBridge Relay connection.
 */
class RemoteBrowserActivity : AppCompatActivity(), TermbridgeClient.Listener, ProxyTunnelTransport {
    private lateinit var profile: ConnectionSettings
    private lateinit var urlInput: EditText
    private lateinit var statusView: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var backButton: ImageButton
    private lateinit var forwardButton: ImageButton
    private lateinit var reloadButton: ImageButton
    private lateinit var webView: WebView

    private var proxyServer: LocalProxyServer? = null
    private var client: TermbridgeClient? = null
    @Volatile private var relayReady = false
    @Volatile private var proxyApplied = false
    private var pendingUrl: String? = null
    private var loadingPage = false
    private var destroyed = false

    private val mainExecutor = Executor { command -> runOnUiThread(command) }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        profile = resolveProfile() ?: run {
            Toast.makeText(this, R.string.session_host_missing, Toast.LENGTH_SHORT).show()
            finish()
            return
        }
        pendingUrl = intent.getStringExtra(EXTRA_URL)?.let(RemoteBrowserPolicy::normalizeEntryUrl)

        buildUi()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else finish()
            }
        })

        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            setStatus(getString(R.string.remote_browser_unsupported), error = true)
            return
        }

        val server = runCatching { LocalProxyServer(this) }.getOrNull() ?: run {
            setStatus(getString(R.string.remote_browser_proxy_failed), error = true)
            return
        }
        proxyServer = server

        val proxyConfigBuilder = ProxyConfig.Builder()
            .addProxyRule("http://127.0.0.1:${server.port}")
        if (WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS)) {
            proxyConfigBuilder.removeImplicitRules()
        } else {
            proxyConfigBuilder.removeImplicitRules()
        }
        setStatus(getString(R.string.remote_browser_connecting, profile.displayName), error = false)
        ProxyController.getInstance().setProxyOverride(proxyConfigBuilder.build(), mainExecutor) {
            if (destroyed) return@setProxyOverride
            proxyApplied = true
            maybeLoadPending()
        }
        connectRelay()
    }

    private fun buildUi() {
        val dp = resources.displayMetrics.density
        val paper = getColor(R.color.paper)
        val ink = getColor(R.color.ink)
        val muted = getColor(R.color.ink_muted)
        val surface = getColor(R.color.surface)
        val accent = getColor(R.color.green)

        @Suppress("DEPRECATION")
        window.statusBarColor = ColorUtils.setAlphaComponent(paper, 220)
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = resources.getBoolean(R.bool.light_system_bars)
            isAppearanceLightNavigationBars = resources.getBoolean(R.bool.light_system_bars)
        }
        if (Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(paper)
        }

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setBackgroundColor(paper)
            setPadding((6 * dp).toInt(), (6 * dp).toInt(), (6 * dp).toInt(), (6 * dp).toInt())
        }

        fun iconButton(resId: Int, description: String, onClick: () -> Unit): ImageButton =
            ImageButton(this).apply {
                setImageResource(resId)
                contentDescription = description
                imageTintList = android.content.res.ColorStateList.valueOf(ink)
                val outValue = TypedValue()
                theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, outValue, true)
                setBackgroundResource(outValue.resourceId)
                val size = (38 * dp).toInt()
                layoutParams = LinearLayout.LayoutParams(size, size)
                setOnClickListener { onClick() }
            }

        val closeBtn = iconButton(R.drawable.ic_close, getString(R.string.remote_browser_close)) { finish() }
        backButton = iconButton(R.drawable.ic_arrow_back, getString(R.string.remote_browser_back)) {
            if (webView.canGoBack()) webView.goBack()
        }.apply { alpha = 0.35f; isEnabled = false }
        forwardButton = iconButton(R.drawable.ic_chevron_right, getString(R.string.remote_browser_forward)) {
            if (webView.canGoForward()) webView.goForward()
        }.apply { alpha = 0.35f; isEnabled = false }
        reloadButton = iconButton(R.drawable.ic_refresh, getString(R.string.remote_browser_reload)) {
            if (loadingPage) webView.stopLoading()
            else if (!relayReady) connectRelay()
            else if (webView.url.isNullOrBlank()) navigateFromInput()
            else webView.reload()
        }

        urlInput = EditText(this).apply {
            setText(pendingUrl ?: "http://127.0.0.1:")
            hint = getString(R.string.remote_browser_url_hint)
            setTextColor(ink)
            setHintTextColor(muted)
            textSize = 14f
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_GO
            setPadding((10 * dp).toInt(), (6 * dp).toInt(), (10 * dp).toInt(), (6 * dp).toInt())
            background = GradientDrawable().apply {
                setColor(surface)
                cornerRadius = 8 * dp
                setStroke((1 * dp).toInt(), ColorUtils.setAlphaComponent(muted, 80))
            }
            setOnEditorActionListener { _, actionId, event ->
                val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
                if (actionId == EditorInfo.IME_ACTION_GO || enter) {
                    navigateFromInput()
                    true
                } else false
            }
        }

        val copyBtn = iconButton(R.drawable.ic_copy, getString(R.string.content_copy_link)) {
            val current = webView.url?.takeIf { it.isNotBlank() } ?: urlInput.text?.toString().orEmpty()
            if (current.isNotBlank()) {
                (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText("URL", current))
                Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
            }
        }

        topBar.addView(closeBtn)
        topBar.addView(backButton)
        topBar.addView(forwardButton)
        topBar.addView(urlInput, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
            marginStart = (4 * dp).toInt()
            marginEnd = (4 * dp).toInt()
        })
        topBar.addView(reloadButton)
        topBar.addView(copyBtn)

        statusView = TextView(this).apply {
            textSize = 12f
            setTextColor(muted)
            setBackgroundColor(surface)
            setPadding((12 * dp).toInt(), (4 * dp).toInt(), (12 * dp).toInt(), (4 * dp).toInt())
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setOnClickListener {
                if (!relayReady) connectRelay()
            }
        }

        progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 100
            visibility = View.GONE
            progressTintList = android.content.res.ColorStateList.valueOf(accent)
        }

        webView = WebView(this).apply {
            setBackgroundColor(Color.WHITE)
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                useWideViewPort = true
                loadWithOverviewMode = true
                builtInZoomControls = true
                displayZoomControls = false
                setSupportZoom(true)
                allowFileAccess = false
                allowContentAccess = false
                mediaPlaybackRequiresUserGesture = false
                mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            }
            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    progressBar.progress = newProgress
                    progressBar.visibility = if (newProgress in 1..99) View.VISIBLE else View.GONE
                }
            }
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val scheme = request?.url?.scheme?.lowercase()
                    return scheme != "http" && scheme != "https"
                }

                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    loadingPage = true
                    if (!url.isNullOrBlank() && !urlInput.hasFocus()) urlInput.setText(url)
                    updateNavButtons()
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    loadingPage = false
                    if (!url.isNullOrBlank() && !urlInput.hasFocus()) urlInput.setText(url)
                    updateNavButtons()
                    if (relayReady) {
                        setStatus(getString(R.string.remote_browser_proxying, profile.displayName), error = false)
                    }
                }

                override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
                    if (request?.isForMainFrame == true) {
                        val desc = error?.description?.toString().orEmpty()
                        setStatus(getString(R.string.remote_browser_load_error, desc), error = true)
                    }
                }
            }
        }

        root.addView(topBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(statusView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(progressBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (2 * dp).toInt()))
        root.addView(webView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        applyWindowInsets(root, includeKeyboard = true)
    }

    private fun navigateFromInput() {
        val normalized = RemoteBrowserPolicy.normalizeEntryUrl(urlInput.text?.toString().orEmpty())
        if (normalized == null) {
            Toast.makeText(this, R.string.remote_browser_invalid_url, Toast.LENGTH_SHORT).show()
            return
        }
        urlInput.setText(normalized)
        urlInput.clearFocus()
        (getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager)?.hideSoftInputFromWindow(urlInput.windowToken, 0)
        pendingUrl = normalized
        maybeLoadPending()
    }

    private fun maybeLoadPending() {
        if (!proxyApplied || !relayReady || destroyed) return
        val target = pendingUrl ?: return
        pendingUrl = null
        webView.loadUrl(target)
    }

    private fun updateNavButtons() {
        val canBack = webView.canGoBack()
        val canForward = webView.canGoForward()
        backButton.isEnabled = canBack
        backButton.alpha = if (canBack) 1f else 0.35f
        forwardButton.isEnabled = canForward
        forwardButton.alpha = if (canForward) 1f else 0.35f
    }

    private fun setStatus(text: String, error: Boolean) {
        statusView.text = text
        statusView.setTextColor(getColor(if (error) R.color.red else R.color.ink_muted))
    }

    private fun connectRelay() {
        relayReady = false
        proxyServer?.resetAllTunnels("Reconnecting")
        client?.disconnect()
        val next = TermbridgeClient(profile, this, backgroundMonitor = false, context = this)
        client = next
        setStatus(getString(R.string.remote_browser_connecting, profile.displayName), error = false)
        next.connect()
    }

    override fun onConnectionState(state: ConnectionState) = runOnUiThread {
        if (destroyed) return@runOnUiThread
        when (state) {
            ConnectionState.Connecting, ConnectionState.Authenticating -> {
                relayReady = false
                setStatus(getString(R.string.remote_browser_connecting, profile.displayName), error = false)
            }
            ConnectionState.Connected -> Unit
            ConnectionState.Disconnected -> {
                relayReady = false
                proxyServer?.resetAllTunnels("Relay disconnected")
                setStatus(getString(R.string.remote_browser_disconnected), error = true)
            }
            is ConnectionState.Failed -> {
                relayReady = false
                proxyServer?.resetAllTunnels(state.message)
                setStatus(getString(R.string.remote_browser_error, state.message), error = true)
            }
        }
    }

    override fun onReady(client: TermbridgeClient) = runOnUiThread {
        if (destroyed || this.client !== client) return@runOnUiThread
        relayReady = true
        setStatus(getString(R.string.remote_browser_proxying, profile.displayName), error = false)
        maybeLoadPending()
    }

    override fun onControl(message: ControlMessage) {
        if (message.type != ProxyTunnelProtocol.TYPE) return
        val id = message.string("id") ?: return
        when (message.string("kind")) {
            ProxyTunnelProtocol.KIND_OPENED -> proxyServer?.onTunnelOpened(id)
            ProxyTunnelProtocol.KIND_DATA -> message.string("data")?.let { proxyServer?.onTunnelData(id, it) }
            ProxyTunnelProtocol.KIND_CLOSE -> proxyServer?.onTunnelClosed(id, message.string("reason"))
        }
    }

    override fun onPtyOutput(sid: Int, data: ByteArray) = Unit

    override fun sendTunnelOpen(id: String, host: String, port: Int): Boolean {
        if (!relayReady) return false
        return client?.sendControl(
            "t" to ProxyTunnelProtocol.TYPE,
            "id" to id,
            "kind" to ProxyTunnelProtocol.KIND_OPEN,
            "host" to host,
            "port" to port,
        ) == true
    }

    override fun sendTunnelData(id: String, base64Data: String): Boolean {
        if (!relayReady) return false
        return client?.sendControl(
            "t" to ProxyTunnelProtocol.TYPE,
            "id" to id,
            "kind" to ProxyTunnelProtocol.KIND_DATA,
            "data" to base64Data,
        ) == true
    }

    override fun sendTunnelAck(id: String, bytes: Int): Boolean {
        if (!relayReady) return false
        return client?.sendControl(
            "t" to ProxyTunnelProtocol.TYPE,
            "id" to id,
            "kind" to ProxyTunnelProtocol.KIND_ACK,
            "bytes" to bytes,
        ) == true
    }

    override fun sendTunnelClose(id: String, reason: String?): Boolean {
        val pairs = mutableListOf<Pair<String, Any>>(
            "t" to ProxyTunnelProtocol.TYPE,
            "id" to id,
            "kind" to ProxyTunnelProtocol.KIND_CLOSE,
        )
        if (!reason.isNullOrBlank()) pairs += "reason" to reason.take(512)
        return client?.sendControl(*pairs.toTypedArray()) == true
    }

    override fun onDestroy() {
        destroyed = true
        relayReady = false
        proxyServer?.close()
        proxyServer = null
        client?.disconnect()
        client = null
        if (proxyApplied && WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            runCatching { ProxyController.getInstance().clearProxyOverride(mainExecutor) {} }
        }
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.loadUrl("about:blank")
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun resolveProfile(): ConnectionSettings? {
        val relayUrl = intent.getStringExtra(EXTRA_RELAY_URL)
        if (!relayUrl.isNullOrBlank()) {
            val modeValue = intent.getStringExtra(EXTRA_CONNECTION_MODE)
            val mode = ConnectionMode.entries.firstOrNull { it.value == modeValue }
            val policyValue = intent.getStringExtra(EXTRA_NETWORK_POLICY)
            val policy = HostNetworkPolicy.fromWire(policyValue)
            return ConnectionSettings(
                relayUrl = relayUrl,
                hostId = intent.getStringExtra(EXTRA_HOST_ID).orEmpty(),
                secret = intent.getStringExtra(EXTRA_SECRET).orEmpty(),
                tlsFingerprint = intent.getStringExtra(EXTRA_TLS_FINGERPRINT).orEmpty(),
                hostName = intent.getStringExtra(EXTRA_HOST_NAME).orEmpty(),
                profileAlias = intent.getStringExtra(EXTRA_PROFILE_ALIAS).orEmpty(),
                networkPolicy = policy,
                connectionMode = mode,
            ).normalized()
        }
        val active = SettingsStore.load(this)
        val profiles = SettingsStore.profiles(this)
        val pin = SessionPin(intent.getStringExtra(EXTRA_HOST_ID).orEmpty(), intent.getStringExtra(EXTRA_ENDPOINT_KEY).orEmpty())
        return SessionHostPin.resolve(pin, active, profiles)
    }

    companion object {
        private const val EXTRA_URL = "browser_url"
        private const val EXTRA_HOST_ID = "browser_host_id"
        private const val EXTRA_ENDPOINT_KEY = "browser_endpoint_key"
        private const val EXTRA_RELAY_URL = "browser_relay_url"
        private const val EXTRA_SECRET = "browser_secret"
        private const val EXTRA_TLS_FINGERPRINT = "browser_tls_fingerprint"
        private const val EXTRA_HOST_NAME = "browser_host_name"
        private const val EXTRA_PROFILE_ALIAS = "browser_profile_alias"
        private const val EXTRA_NETWORK_POLICY = "browser_network_policy"
        private const val EXTRA_CONNECTION_MODE = "browser_connection_mode"

        fun intent(context: Context, profile: ConnectionSettings, url: String? = null): Intent =
            Intent(context, RemoteBrowserActivity::class.java).apply {
                if (!url.isNullOrBlank()) putExtra(EXTRA_URL, url)
                putExtra(EXTRA_HOST_ID, profile.hostId)
                putExtra(EXTRA_ENDPOINT_KEY, profile.endpointKey)
                putExtra(EXTRA_RELAY_URL, profile.relayUrl)
                putExtra(EXTRA_SECRET, profile.secret)
                putExtra(EXTRA_TLS_FINGERPRINT, profile.tlsFingerprint)
                putExtra(EXTRA_HOST_NAME, profile.hostName)
                putExtra(EXTRA_PROFILE_ALIAS, profile.profileAlias)
                putExtra(EXTRA_NETWORK_POLICY, profile.networkPolicy.wireName)
                profile.connectionMode?.let { putExtra(EXTRA_CONNECTION_MODE, it.value) }
            }

        fun open(context: Context, profile: ConnectionSettings, url: String? = null) {
            context.startActivity(intent(context, profile, url))
        }
    }
}
