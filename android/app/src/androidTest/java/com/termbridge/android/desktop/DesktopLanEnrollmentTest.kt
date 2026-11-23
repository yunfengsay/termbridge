package com.termbridge.android.desktop

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.R
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import com.termbridge.android.network.LanConnection
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket

/** Explicit device setup, not a regular regression test. Success preserves the verified LAN profile.
 * Run only after backing up app data. Pairing credentials enter through an ADB-forwarded loopback socket.
 */
@RunWith(AndroidJUnit4::class)
class DesktopLanEnrollmentTest {
    @Test fun enrollKnownMacAndRenderOverPinnedLAN() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("installLanProfile") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val old = SettingsStore.load(context)
        val request = ServerSocket(38646, 1, InetAddress.getByName("127.0.0.1")).use { server ->
            server.soTimeout = 60000
            server.accept().use { socket -> socket.soTimeout = 5000; JSONObject(socket.getInputStream().bufferedReader().readLine()) }
        }
        val address = request.getString("address")
        val port = request.getInt("port")
        require(request.getString("hostId") == old.hostId) { "Enrollment must target the already paired Mac" }
        val pin = LanConnection.probe(address, port)
        require(pin == request.getString("tlsPin")) { "Certificate differs from the one read on the Mac" }
        val profile = ConnectionSettings("wss://$address:$port", old.hostId, request.getString("secret"), pin,
            old.hostName, profileAlias = "Mac mini 内网直连")
        require(SettingsStore.profiles(context).none { it.profileKey == profile.profileKey }) { "Never overwrite an existing LAN profile in this setup probe" }
        val savedLogin = DesktopCredentialStore(context, old).load()
        if (savedLogin != null) DesktopCredentialStore(context, profile).save(savedLogin)
        var verified = false
        try {
            instrumentation.runOnMainSync { SettingsStore.save(context, profile) }
            ActivityScenario.launch<RemoteDesktopActivity>(RemoteDesktopActivity.intent(context)).use { scenario ->
                fun children(v: View): List<View> = listOf(v) + if (v is ViewGroup) (0 until v.childCount).flatMap { children(v.getChildAt(it)) } else emptyList()
                var ready = false
                val start = SystemClock.uptimeMillis()
                while (!ready && SystemClock.uptimeMillis() - start < 30000) {
                    scenario.onActivity { activity ->
                        ready = children(activity.window.decorView).any { it.contentDescription == context.getString(R.string.desktop_keyboard) && it.isEnabled }
                    }
                    if (!ready) SystemClock.sleep(100)
                }
                assertTrue("The saved account must authenticate and paint a real LAN frame", ready)
                SystemClock.sleep(300)
                val bitmap = instrumentation.uiAutomation.takeScreenshot()
                java.io.File(context.getExternalFilesDir(null), "desktop-lan-enrolled.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
                java.io.File(context.getExternalFilesDir(null), "desktop-lan-enrolled.json").writeText(JSONObject()
                    .put("address", profile.relayUrl).put("hostId", profile.hostId).put("readyMs", SystemClock.uptimeMillis() - start)
                    .put("reusedSavedAccount", savedLogin != null).toString())
                verified = true
            }
        } finally {
            if (!verified) {
                instrumentation.runOnMainSync { SettingsStore.remove(context, profile.profileKey); SettingsStore.select(context, old.profileKey) }
                DesktopCredentialStore(context, profile).clear()
            }
        }
    }
}
