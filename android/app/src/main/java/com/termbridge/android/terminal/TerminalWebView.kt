package com.termbridge.android.terminal

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.util.AttributeSet
import android.util.Base64
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayOutputStream

class TerminalWebView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : WebView(context, attrs, defStyleAttr) {

    interface Listener {
        fun onTerminalReady(cols: Int, rows: Int)
        fun onTerminalResize(cols: Int, rows: Int)
        fun onTerminalTitle(title: String)
        fun onSelectionCopied()
        fun onTerminalTouched()
        fun onTranscriptResync(revision: Int)
        fun onOpenFile(path: String) = Unit
    }

    var listener: Listener? = null
    @Volatile var bracketedPasteMode = false
        private set
    private val mainHandler = Handler(Looper.getMainLooper())
    private val pendingOutput = ByteArrayOutputStream()
    private var terminalReady = false
    private var flushPosted = false

    private val flushOutput = Runnable {
        val bytes = synchronized(pendingOutput) {
            flushPosted = false
            if (!terminalReady || pendingOutput.size() == 0) return@synchronized null
            pendingOutput.toByteArray().also { pendingOutput.reset() }
        } ?: return@Runnable
        var offset = 0
        while (offset < bytes.size) {
            val end = (offset + OUTPUT_CHUNK_SIZE).coerceAtMost(bytes.size)
            val base64 = Base64.encodeToString(bytes, offset, end - offset, Base64.NO_WRAP)
            evaluateJavascript("window.Termbridge?.writeBase64('$base64')", null)
            offset = end
        }
    }

    init {
        configure()
    }

    @SuppressLint("SetJavaScriptEnabled", "AddJavascriptInterface")
    private fun configure() {
        setBackgroundColor(0xff0d100e.toInt())
        isFocusable = false
        isFocusableInTouchMode = false
        overScrollMode = OVER_SCROLL_NEVER
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowContentAccess = false
            allowFileAccess = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            cacheMode = WebSettings.LOAD_NO_CACHE
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            textZoom = 100
        }
        addJavascriptInterface(NativeBridge(), "TermbridgeNative")
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return true
                if (url.startsWith("file:///android_asset/")) return false
                openExternalLink(url)
                return true
            }
        }
        loadUrl("file:///android_asset/terminal.html")
    }

    fun write(data: ByteArray) {
        if (data.isEmpty()) return
        synchronized(pendingOutput) {
            pendingOutput.write(data)
            if (!flushPosted) {
                flushPosted = true
                mainHandler.postDelayed(flushOutput, OUTPUT_BATCH_MS)
            }
        }
    }

    fun applyMobileSnapshot(revision: Int, payload: ByteArray) = post {
        val base64 = Base64.encodeToString(payload, Base64.NO_WRAP)
        evaluateJavascript("window.Termbridge?.applyMobileSnapshot($revision,'$base64')", null)
    }

    fun applyMobilePatch(baseRevision: Int, revision: Int, payload: ByteArray) = post {
        val base64 = Base64.encodeToString(payload, Base64.NO_WRAP)
        evaluateJavascript("window.Termbridge?.applyMobilePatch($baseRevision,$revision,'$base64')", null)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val handled = super.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            post { listener?.onTerminalTouched() }
        }
        return handled
    }

    fun resetTerminal(onReset: (() -> Unit)? = null) = post {
        bracketedPasteMode = false
        evaluateJavascript("window.Termbridge?.reset()") { onReset?.invoke() }
    }

    fun fitTerminal() = post {
        evaluateJavascript("window.Termbridge?.fit()", null)
    }

    fun copySelection() = post {
        evaluateJavascript("window.Termbridge?.copySelection()", null)
    }

    fun release() {
        listener = null
        mainHandler.removeCallbacksAndMessages(null)
        removeJavascriptInterface("TermbridgeNative")
        stopLoading()
        loadUrl("about:blank")
        destroy()
    }

    private inner class NativeBridge {
        @JavascriptInterface
        fun onInputMode(bracketedPaste: Boolean) {
            bracketedPasteMode = bracketedPaste
        }

        @JavascriptInterface
        fun onReady(cols: Int, rows: Int) {
            post {
                terminalReady = true
                listener?.onTerminalReady(cols, rows)
                scheduleFlush()
            }
        }

        @JavascriptInterface
        fun onResize(cols: Int, rows: Int) {
            post { listener?.onTerminalResize(cols, rows) }
        }

        @JavascriptInterface
        fun onTitle(title: String) {
            post { listener?.onTerminalTitle(title) }
        }

        @JavascriptInterface
        fun onCopy(text: String) {
            post {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                clipboard.setPrimaryClip(ClipData.newPlainText("Terminal selection", text))
                performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                listener?.onSelectionCopied()
            }
        }

        @JavascriptInterface
        fun onBell() {
            post { performHapticFeedback(HapticFeedbackConstants.LONG_PRESS) }
        }

        @JavascriptInterface
        fun onTranscriptResync(revision: Int) {
            post { listener?.onTranscriptResync(revision) }
        }

        @JavascriptInterface
        fun onOpenLink(url: String) {
            post { openExternalLink(url) }
        }

        @JavascriptInterface
        fun onOpenFile(path: String) {
            post { listener?.onOpenFile(path) }
        }

    }

    private fun openExternalLink(value: String) {
        val url = ExternalLinkPolicy.allow(value) ?: return
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (_: ActivityNotFoundException) {
            android.widget.Toast.makeText(context, com.termbridge.android.R.string.link_open_failed, android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    private fun scheduleFlush() {
        synchronized(pendingOutput) {
            if (pendingOutput.size() > 0 && !flushPosted) {
                flushPosted = true
                mainHandler.post(flushOutput)
            }
        }
    }

    private companion object {
        const val OUTPUT_BATCH_MS = 12L
        const val OUTPUT_CHUNK_SIZE = 24 * 1024
    }
}
