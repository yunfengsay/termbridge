package com.termbridge.android.ui

import android.content.Context
import android.content.MutableContextWrapper
import android.os.Looper
import android.view.ViewGroup
import com.termbridge.android.chat.AgentChatWebView
import com.termbridge.android.terminal.TerminalWebView
import org.json.JSONObject

/**
 * Keeps 1 pre-loaded TerminalWebView and 1 AgentChatWebView warm while MainActivity is idle,
 * eliminating the 150-350ms WebView + JS bundle cold-start delay when opening a session.
 */
object WebViewPrewarmer {
    private var warmTerminal: TerminalWebView? = null
    private var warmTerminalReady = false
    private var terminalScheduled = false

    fun schedulePrewarm(context: Context) {
        val appContext = context.applicationContext
        if (warmTerminal != null || terminalScheduled) return
        terminalScheduled = true
        Looper.myQueue().addIdleHandler {
            terminalScheduled = false
            if (warmTerminal == null) {
                runCatching {
                    val wrapper = MutableContextWrapper(appContext)
                    val view = TerminalWebView(wrapper)
                    view.listener = object : TerminalWebView.Listener {
                        override fun onTerminalReady(cols: Int, rows: Int) { warmTerminalReady = true }
                        override fun onTerminalResize(cols: Int, rows: Int) = Unit
                        override fun onTerminalTitle(title: String) = Unit
                        override fun onSelectionCopied() = Unit
                        override fun onTerminalTouched() = Unit
                        override fun onTranscriptResync(revision: Int) = Unit
                    }
                    warmTerminal = view
                }
            }
            false
        }
    }

    /**
     * Claims a pre-warmed TerminalWebView if available and rebinds its MutableContextWrapper
     * to the hosting Activity context. Returns Pair(view, alreadyReady).
     */
    fun claimTerminal(activityContext: Context): Pair<TerminalWebView, Boolean>? {
        val view = warmTerminal ?: return null
        val ready = warmTerminalReady
        warmTerminal = null
        warmTerminalReady = false
        (view.context as? MutableContextWrapper)?.baseContext = activityContext
        (view.parent as? ViewGroup)?.removeView(view)
        view.listener = null
        return view to ready
    }

    fun releaseAll() {
        warmTerminal?.release()
        warmTerminal = null
        warmTerminalReady = false
    }
}
