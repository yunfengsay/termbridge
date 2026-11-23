package com.termbridge.android.brain

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/** Visible Android entry point for Bixby, Samsung side-key actions, deep links, and shortcuts. */
class GlobalCallEntryActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        launchGlobalCall()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        launchGlobalCall()
    }

    private fun launchGlobalCall() {
        startActivity(BrainActivity.globalCallIntent(this))
        finish()
    }
}
