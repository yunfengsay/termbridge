package com.termbridge.android.peer

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

class PeerApkInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val artifactId = intent.getStringExtra(PeerApkInstaller.EXTRA_ARTIFACT_ID) ?: return
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
        val packageName = intent.getStringExtra(PackageInstaller.EXTRA_PACKAGE_NAME)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                PeerInstallState.save(context, artifactId, "awaiting_confirmation", packageName, message)
                val confirmation = confirmationIntent(intent)
                if (confirmation != null) {
                    PeerApkInstaller.requestConfirmation(context, artifactId, confirmation)
                }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                PeerInstallState.save(context, artifactId, "installed", packageName, message)
                PeerArtifactStore(context.applicationContext).removeCommitted(artifactId)
                PeerApkInstaller.showResultNotification(context, artifactId, true, packageName)
            }
            else -> {
                val detail = message ?: "PackageInstaller status $status"
                PeerInstallState.save(context, artifactId, "failed", packageName, detail)
                PeerApkInstaller.showResultNotification(context, artifactId, false, detail)
                Log.w("TermbridgePeer", "APK install failed: $detail")
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun confirmationIntent(intent: Intent): Intent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
        } else {
            intent.getParcelableExtra(Intent.EXTRA_INTENT)
        }
}
