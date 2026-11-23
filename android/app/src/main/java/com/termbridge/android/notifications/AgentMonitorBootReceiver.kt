package com.termbridge.android.notifications

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.watch.WatchGatewayService
import com.termbridge.android.watch.WatchSettingsStore

/** Restores completion monitoring after reboot or a data-preserving app update. */
class AgentMonitorBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        if (intent?.action !in SUPPORTED_ACTIONS || !SettingsStore.load(context).connectionEnabled) return
        val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (allowed) {
            AgentMonitorService.start(context)
            if (WatchSettingsStore.load(context).paired) WatchGatewayService.sync(context)
        }
    }

    private companion object {
        val SUPPORTED_ACTIONS = setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)
    }
}
