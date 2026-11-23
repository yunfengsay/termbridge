package com.termbridge.android.peer

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import com.termbridge.android.R
import java.io.File

internal object PeerApkInstaller {
    const val EXTRA_ARTIFACT_ID = "termbridge_artifact_id"
    private const val CHANNEL_ID = "peer_installs"

    fun install(context: Context, artifactId: String, apk: File): Map<String, Any?> {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            PeerInstallState.save(context, artifactId, "permission_required", message = "Allow TermBridge to install unknown apps")
            requestInstallPermission(context, artifactId)
            return mapOf(
                "status" to "permission_required",
                "requiresUserAction" to true,
                "message" to "Open the TermBridge notification and allow installs from this app, then rerun the command",
            )
        }

        val packageInfo = archiveInfo(context.packageManager, apk)
            ?: error("Android rejected the uploaded file as an APK")
        val packageName = packageInfo.packageName ?: error("APK has no package name")
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
        }
        val installer = context.packageManager.packageInstaller
        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
            apk.inputStream().use { input ->
                session.openWrite("termbridge.apk", 0, apk.length()).use { output ->
                    input.copyTo(output)
                    session.fsync(output)
                }
            }
            val callback = Intent(context, PeerApkInstallReceiver::class.java)
                .putExtra(EXTRA_ARTIFACT_ID, artifactId)
            val pending = PendingIntent.getBroadcast(
                context,
                artifactId.hashCode(),
                callback,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            PeerInstallState.save(context, artifactId, "submitted", packageName, sessionId = sessionId)
            session.commit(pending.intentSender)
        }
        return mapOf(
            "status" to "submitted",
            "artifactId" to artifactId,
            "packageName" to packageName,
            "sessionId" to sessionId,
            "requiresUserAction" to true,
            "message" to "Approve the Android package installer prompt on the phone",
        )
    }

    fun showConfirmationNotification(context: Context, artifactId: String, intent: Intent) {
        ensureChannel(context)
        val pending = PendingIntent.getActivity(
            context,
            artifactId.hashCode(),
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Approve APK installation")
            .setContentText("TermBridge received a verified APK. Tap to review the system installer.")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(artifactId.hashCode(), notification)
    }

    fun requestConfirmation(context: Context, artifactId: String, intent: Intent) {
        showConfirmationNotification(context, artifactId, intent)
        runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    fun showResultNotification(context: Context, artifactId: String, success: Boolean, message: String?) {
        ensureChannel(context)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (success) "APK installed" else "APK installation failed")
            .setContentText(message ?: if (success) "Installation completed" else "Open TermBridge for details")
            .setAutoCancel(true)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(artifactId.hashCode(), notification)
    }

    private fun requestInstallPermission(context: Context, artifactId: String) {
        ensureChannel(context)
        val intent = Intent(
            Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
            Uri.parse("package:${context.packageName}"),
        )
        val pending = PendingIntent.getActivity(
            context,
            artifactId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Allow TermBridge APK installs")
            .setContentText("Tap to allow installs from TermBridge, then retry the command")
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(artifactId.hashCode(), notification)
        runCatching { context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Remote APK installs", NotificationManager.IMPORTANCE_HIGH),
        )
    }

    @Suppress("DEPRECATION")
    private fun archiveInfo(packageManager: PackageManager, apk: File): PackageInfo? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            packageManager.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(0))
        } else {
            packageManager.getPackageArchiveInfo(apk.path, 0)
        }
}
