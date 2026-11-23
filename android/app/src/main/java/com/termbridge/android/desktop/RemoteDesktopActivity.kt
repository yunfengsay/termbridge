package com.termbridge.android.desktop

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.termbridge.android.R
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.chat.SessionHostPin
import com.termbridge.android.chat.SessionPinHandoff
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.network.ConnectionState
import com.termbridge.android.network.TermbridgeClient
import com.termbridge.android.protocol.ControlMessage
import com.termbridge.android.protocol.RemoteDesktopProtocol
import com.termbridge.android.ui.applyWindowInsets
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** A dedicated foreground connection owns the desktop; leaving this screen closes it. */
class RemoteDesktopActivity : AppCompatActivity() {
    private lateinit var controls: DesktopControls
    private lateinit var web: WebView
    private lateinit var profile: ConnectionSettings
    private var client: TermbridgeClient? = null
    private var epoch = 0
    private var loaded = false
    private var ready = false
    private var started = false
    private var visible = false
    private var loginRequestId: String? = null
    private var pendingCredentials: DesktopCredentialStore.Credentials? = null
    private var rememberLogin = false
    private var usedSavedLogin = false
    private fun credentialsStore() = DesktopCredentialStore(this, profile)
    private fun clearLoginAttempt() {
        loginRequestId = null; pendingCredentials = null; rememberLogin = false; usedSavedLogin = false
        loginDialog?.dismiss(); loginDialog = null
    }
    private var loginDialog: androidx.appcompat.app.AlertDialog? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val hostId = intent.getStringExtra("desktopHostId")
        val active = SettingsStore.load(this)
        val profiles = SettingsStore.profiles(this)
        val pin = SessionPinHandoff.receive(intent.hasExtra("desktopEndpointKey"), hostId,
            intent.getStringExtra("desktopEndpointKey"), active, profiles)
        profile = SessionHostPin.resolve(pin, active, profiles) ?: run { finish(); return }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(getColor(R.color.paper)) }
        @Suppress("DEPRECATION")
        window.statusBarColor = androidx.core.graphics.ColorUtils.setAlphaComponent(getColor(R.color.paper), 190)
        @Suppress("DEPRECATION")
        window.navigationBarColor = android.graphics.Color.TRANSPARENT
        androidx.core.view.WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = resources.getBoolean(R.bool.light_system_bars)
            isAppearanceLightNavigationBars = resources.getBoolean(R.bool.light_system_bars)
        }
        if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = false
        controls = DesktopControls(this) { action, value ->
            if (action == "forgetCredentials") {
                credentialsStore().clear(); pendingCredentials = null; rememberLogin = false
                android.widget.Toast.makeText(this, R.string.desktop_password_forgotten, android.widget.Toast.LENGTH_SHORT).show()
                return@DesktopControls
            }
            if (action == "fps" && value is Int && value in listOf(10, 20, 30)) {
                getSharedPreferences("desktop", MODE_PRIVATE).edit().putInt("fps", value).apply()
            }
            val message = JSONObject().put("action", action)
            if (value != null) message.put("value", value)
            web.evaluateJavascript("window.Desktop?.ui($message)", null)
        }
        val toolbar = MaterialToolbar(this).apply {
            title = getString(R.string.remote_desktop)
            subtitle = profile.displayName
            setTitleTextAppearance(this@RemoteDesktopActivity, R.style.TextAppearance_Termbridge_Toolbar)
            setSubtitleTextAppearance(this@RemoteDesktopActivity, com.google.android.material.R.style.TextAppearance_Material3_BodySmall)
            setBackgroundColor(getColor(R.color.paper))
            setNavigationIcon(androidx.appcompat.R.drawable.abc_ic_ab_back_material)
            setNavigationOnClickListener { finish() }
        }
        web = WebView(this).apply {
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            settings.javaScriptEnabled = true
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            settings.domStorageEnabled = false
            settings.setSupportMultipleWindows(false)
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            addJavascriptInterface(Bridge(), "DesktopNative")
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                    val uri = request.url
                    if (uri.scheme == "https" && uri.host == "desktop.termbridge.local" && uri.path?.startsWith("/desktop/") == true) {
                        val path = uri.path!!.removePrefix("/")
                        if (!path.contains("..")) {
                            val mime = when { path.endsWith(".js") -> "text/javascript"; path.endsWith(".css") -> "text/css"; path.endsWith(".html") -> "text/html"; else -> "text/plain" }
                            runCatching { assets.open(path) }.getOrNull()?.let { return WebResourceResponse(mime, "UTF-8", it) }
                        }
                    }
                    return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
                }
            }
            loadUrl("https://desktop.termbridge.local/desktop/index.html")
        }
        root.addView(toolbar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(controls.top)
        root.addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(controls.bottom)
        setContentView(root); applyWindowInsets(root, includeKeyboard = true, bottomInsetTarget = controls.bottom)
    }

    override fun onStart() { super.onStart(); if (!::web.isInitialized) return; visible = true; web.onResume(); connect() }
    override fun onStop() {
        clearLoginAttempt()
        visible = false; epoch++; ready = false; started = false
        client?.disconnect(); client = null
        if (::web.isInitialized) { web.evaluateJavascript("window.Desktop?.disconnected()", null); web.onPause() }
        super.onStop()
    }
    override fun onDestroy() { if (::web.isInitialized) { web.removeJavascriptInterface("DesktopNative"); web.destroy() }; super.onDestroy() }

    private fun connect() {
        if (!visible || !profile.connectionEnabled) return
        clearLoginAttempt()
        epoch++; val expected = epoch
        client?.disconnect(); ready = false; started = false
        val listener = object : TermbridgeClient.Listener {
            override fun onConnectionState(state: ConnectionState) = runOnUiThread {
                if (expected != epoch) return@runOnUiThread
                if (state is ConnectionState.Failed || state == ConnectionState.Disconnected) {
                    ready = false; started = false; web.evaluateJavascript("window.Desktop?.disconnected()", null)
                }
            }
            override fun onReady(client: TermbridgeClient) = runOnUiThread {
                if (expected == epoch && visible) { ready = true; startViewer() }
            }
            override fun onControl(message: ControlMessage) = runOnUiThread {
                if (expected != epoch || !visible) return@runOnUiThread
                if (message.type == "host_list_result" && profile.hostId.isBlank()) {
                    message.string("selectedHostId")?.let { profile = profile.copy(hostId = it); startViewer() }
                }
                if (message.type in setOf(RemoteDesktopProtocol.READY, RemoteDesktopProtocol.DATA, RemoteDesktopProtocol.CLOSED)) {
                    val json = JSONObject(message.fields).toString()
                    web.evaluateJavascript("window.Desktop?.receive($json)", null)
                }
            }
            override fun onPtyOutput(sid: Int, data: ByteArray) = Unit
        }
        client = TermbridgeClient(profile, listener, context = this).also { it.connect() }
    }

    private fun startViewer() {
        if (!visible || !ready || !loaded || started || profile.hostId.isBlank()) return
        started = true
        val settings = JSONObject().put("hostId", profile.hostId).put("secret", profile.secret)
            .put("deviceId", com.termbridge.android.peer.AndroidPeerIdentity.deviceId(this))
        web.evaluateJavascript("window.Desktop.start($settings)", null)
    }

    private fun submitDesktopLogin(value: DesktopCredentialStore.Credentials, remember: Boolean) {
        val requestId = loginRequestId ?: return
        pendingCredentials = value; rememberLogin = remember
        if (!remember) credentialsStore().clear()
        val credentials = JSONObject().put("username", value.username).put("password", value.password)
        val message = JSONObject().put("action", "credentials").put("requestId", requestId).put("value", credentials)
        web.evaluateJavascript("window.Desktop?.ui($message)", null)
    }

    private fun onDesktopAuth(message: JSONObject) {
        if (message.optString("requestId") != loginRequestId) return
        when (message.optString("state")) {
            "authenticated" -> {
                pendingCredentials?.takeIf { rememberLogin }?.let { value ->
                    runCatching { credentialsStore().save(value) }.onFailure {
                        android.widget.Toast.makeText(this, R.string.desktop_password_save_failed, android.widget.Toast.LENGTH_LONG).show()
                    }
                }
                clearLoginAttempt()
            }
            "rejected" -> { if (usedSavedLogin) credentialsStore().clear(); clearLoginAttempt() }
            "closed" -> clearLoginAttempt()
        }
    }

    private fun showDesktopLogin(needsUsername: Boolean, requestId: String) {
        if (requestId.isBlank() || loginRequestId == requestId) return
        clearLoginAttempt(); loginRequestId = requestId
        val saved = credentialsStore().load()
        if (saved != null) { usedSavedLogin = true; submitDesktopLogin(saved, true); return }
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 16, 48, 0) }
        val username = android.widget.EditText(this).apply {
            hint = getString(R.string.desktop_username); isSingleLine = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
            if (android.os.Build.VERSION.SDK_INT >= 26) importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val password = android.widget.EditText(this).apply {
            hint = getString(R.string.desktop_password); isSingleLine = true
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            if (android.os.Build.VERSION.SDK_INT >= 26) importantForAutofill = android.view.View.IMPORTANT_FOR_AUTOFILL_NO
        }
        if (needsUsername) form.addView(username)
        form.addView(password)
        val remember = com.google.android.material.checkbox.MaterialCheckBox(this).apply {
            text = getString(R.string.desktop_remember_password); isChecked = true
        }
        form.addView(remember)
        fun cancel() { web.evaluateJavascript("window.Desktop?.ui({action:'cancelLogin'})", null) }
        loginDialog = com.google.android.material.dialog.MaterialAlertDialogBuilder(this)
            .setBackground(android.graphics.drawable.GradientDrawable().apply {
                setColor(getColor(R.color.paper)); cornerRadius = 18 * resources.displayMetrics.density
            })
            .setTitle(R.string.desktop_login).setMessage(R.string.desktop_login_hint).setView(form)
            .setPositiveButton(R.string.desktop_login) { _, _ ->
                submitDesktopLogin(DesktopCredentialStore.Credentials(username.text.toString().trim(), password.text.toString()), remember.isChecked)
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> cancel() }
            .setOnCancelListener { cancel() }.create().also { dialog ->
                dialog.setOnDismissListener { username.text.clear(); password.text.clear(); loginDialog = null }
                dialog.show()
            }
    }

    private inner class Bridge {
        @JavascriptInterface fun postMessage(raw: String) {
            if (raw.length > 90_000) return
            val message = runCatching { JSONObject(raw) }.getOrNull() ?: return
            runOnUiThread {
                when (message.optString("t")) {
                    "desktop_loaded" -> {
                        val options = JSONObject().put("nativeControls", true).put("fps", getSharedPreferences("desktop", MODE_PRIVATE).getInt("fps", 10))
                        for ((key, color) in listOf("background" to R.color.paper, "foreground" to R.color.ink, "muted" to R.color.ink_muted, "accent" to R.color.green_dark)) {
                            options.put(key, String.format(java.util.Locale.ROOT, "#%06X", getColor(color) and 0xffffff))
                        }
                        options.put("appearance", if (resources.getBoolean(R.bool.light_system_bars)) "light" else "dark")
                        web.evaluateJavascript("window.Desktop.configure($options)", null)
                        loaded = true; startViewer()
                    }
                    "desktop_state" -> controls.update(message)
                    "desktop_credentials" -> if (visible) showDesktopLogin(message.optBoolean("username"), message.optString("requestId"))
                    "desktop_auth" -> onDesktopAuth(message)
                    "desktop_reconnect" -> connect()
                    RemoteDesktopProtocol.OPEN, RemoteDesktopProtocol.DATA -> {
                        if (!visible || !ready) return@runOnUiThread
                        val fields = message.keys().asSequence().map { it to message.get(it) }.toList().toTypedArray()
                        if (client?.sendControl(*fields) != true) web.evaluateJavascript("window.Desktop?.disconnected()", null)
                    }
                }
            }
        }
    }

    companion object {
        fun intent(context: Context, hostId: String? = null, endpointKey: String? = null) =
            Intent(context, RemoteDesktopActivity::class.java).putExtra("desktopHostId", hostId)
                .apply { if (endpointKey != null) putExtra("desktopEndpointKey", endpointKey) }
    }
}
