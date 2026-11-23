package com.termbridge.android.chat

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.os.Build
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.annotation.RequiresApi
import org.json.JSONObject

/** Packaged, inert transcript renderer. The bridge never sends prompts or executes tools. */
@SuppressLint("SetJavaScriptEnabled", "ViewConstructor") // Created programmatically with a required native callback.
class AgentChatWebView(context: Context, private val message: (JSONObject) -> Unit) : WebView(context) {
    var ready = false; private set
    private var released = false
    init {
        settings.javaScriptEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.domStorageEnabled = false
        settings.setSupportMultipleWindows(false)
        addJavascriptInterface(object {
            @JavascriptInterface fun postMessage(raw: String) {
                if (raw.length > 131_072) return
                val value = runCatching { JSONObject(raw) }.getOrNull() ?: return
                post {
                    if (released) return@post
                    if (value.optString("op") == "ready") ready = true
                    message(value)
                }
            }
        }, "TermBridgeChat")
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                // The page republishes the bridge on every load. Anything already
                // delivered to the previous one is gone, so the shell stops
                // treating the surface as holding the conversation.
                if (!ready || released) return
                ready = false
                message(JSONObject().put("op", SURFACE_RESET))
            }
            @RequiresApi(Build.VERSION_CODES.O)
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                // Returning true keeps this process alive; the shell replaces the
                // dead view rather than leaving a stale transcript on screen.
                released = true; ready = false
                message(JSONObject().put("op", SURFACE_GONE))
                return true
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                val path = uri.path.orEmpty().removePrefix("/")
                if (uri.scheme == "https" && uri.host == "chat.termbridge.local" &&
                    path in setOf("index.html", "chat.js", "chat.css")) {
                    val mime = when (path) { "index.html" -> "text/html"; "chat.js" -> "application/javascript"; else -> "text/css" }
                    val stream = runCatching { context.assets.open("agent-chat/$path") }.getOrNull()
                    if (stream != null) return WebResourceResponse(mime, "utf-8", stream)
                }
                // Remote transcript images/links must not make ambient authenticated requests.
                return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), null)
            }
        }
        loadUrl("https://chat.termbridge.local/index.html")
    }

    fun receive(value: JSONObject) {
        if (ready && !released) evaluateJavascript("window.termbridgeChat.receive($value)", null)
    }

    fun release() { released = true; ready = false; removeJavascriptInterface("TermBridgeChat"); stopLoading(); destroy() }

    companion object {
        /** The page reloaded: the shell must resubscribe instead of replaying. */
        const val SURFACE_RESET = "surface_reset"
        /** The renderer died: this view is unusable and has to be replaced. */
        const val SURFACE_GONE = "surface_gone"
    }
}
