package com.termbridge.android

import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.widget.EditText
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class LanConnectionSettingsTest {
    @Test fun addingConnectionKeepsExistingProfileWithoutCertificateConfirmation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("lanFixture") == "true")
        val context = instrumentation.targetContext
        val old = SettingsStore.load(context)
        val fixture = ConnectionSettings("wss://relay.example/lan-ui-test", "existing-mac", "existing-password-123", "", "Existing Mac")
        instrumentation.runOnMainSync {
            AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags("zh-CN"))
            SettingsStore.save(context, fixture)
        }
        fun shot(name: String) {
            SystemClock.sleep(250)
            val bitmap = instrumentation.uiAutomation.takeScreenshot()
            File(context.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
        try {
            ActivityScenario.launch<GlobalSettingsActivity>(Intent(context, GlobalSettingsActivity::class.java)).use { scenario ->
                scenario.onActivity { activity -> assertNotNull(activity.findViewById<View>(R.id.addConnection)); assertTrue(activity.findViewById<View>(R.id.connectionProfiles).isShown) }
                shot("lan-global-settings.png")
            }
            ActivityScenario.launch<ConnectionSettingsActivity>(Intent(context, ConnectionSettingsActivity::class.java).putExtra(ConnectionSettingsActivity.EXTRA_NEW, true)).use { scenario ->
                scenario.onActivity { activity ->
                    assertEquals("", activity.findViewById<EditText>(R.id.relayUrl).text.toString())
                    assertEquals("", activity.findViewById<EditText>(R.id.sharedSecret).text.toString())
                    assertEquals(View.GONE, activity.findViewById<View>(R.id.deleteConnection).visibility)
                    activity.findViewById<EditText>(R.id.connectionName).setText("Mac mini 内网")
                    activity.findViewById<EditText>(R.id.relayUrl).setText("10.0.2.2")
                    activity.findViewById<EditText>(R.id.port).setText("38742")
                    activity.findViewById<EditText>(R.id.sharedSecret).setText("lan-ui-fixture-password")
                }
                shot("lan-add-connection.png")
                scenario.onActivity { it.findViewById<View>(R.id.save).performClick() }
                val saved = SettingsStore.load(context)
                assertEquals("ws://10.0.2.2:38742", saved.relayUrl)
                assertEquals("", saved.normalizedFingerprint)
                assertTrue(SettingsStore.profiles(context).any { it.profileKey == fixture.profileKey })
            }
        } finally {
            instrumentation.runOnMainSync {
                SettingsStore.profiles(context).filter { it.relayUrl == "ws://10.0.2.2:38742" || it.profileKey == fixture.profileKey }.forEach { SettingsStore.remove(context, it.profileKey) }
                SettingsStore.select(context, old.profileKey)
            }
        }
    }

    @Test fun directClientAuthenticatesRunsPTYAndRejectsWrongPassword() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("lanFixture") == "true")
        val settings = ConnectionSettings("ws://10.0.2.2:38742", "", "lan-ui-fixture-password", "", connectionMode = com.termbridge.android.data.ConnectionMode.DIRECT)
        fun attempt(candidate: ConnectionSettings, success: Boolean) {
            val done = java.util.concurrent.CountDownLatch(1)
            val output = StringBuilder()
            var requested = false
            lateinit var client: com.termbridge.android.network.TermbridgeClient
            client = com.termbridge.android.network.TermbridgeClient(candidate, object : com.termbridge.android.network.TermbridgeClient.Listener {
                override fun onConnectionState(state: com.termbridge.android.network.ConnectionState) {
                    if (state is com.termbridge.android.network.ConnectionState.Failed || state is com.termbridge.android.network.ConnectionState.Disconnected) done.countDown()
                }
                override fun onReady(client: com.termbridge.android.network.TermbridgeClient) = Unit
                override fun onControl(message: com.termbridge.android.protocol.ControlMessage) {
                    if (message.type == "host_list_result" && !requested) {
                        requested = true
                        client.sendControl("t" to "session_create", "command" to "/bin/sh", "args" to listOf("-c", "printf LAN_NATIVE_PTY_OK"), "cols" to 80, "rows" to 24)
                    }
                    if (message.type == "error") done.countDown()
                }
                override fun onPtyOutput(sid: Int, data: ByteArray) {
                    synchronized(output) { output.append(String(data)); if (output.contains("LAN_NATIVE_PTY_OK")) done.countDown() }
                }
            })
            try {
                client.connect()
                assertTrue("Direct connection must complete or reject promptly", done.await(15, java.util.concurrent.TimeUnit.SECONDS))
                assertEquals(success, synchronized(output) { output.contains("LAN_NATIVE_PTY_OK") })
                if (!success) assertFalse("Unauthenticated connection must never reach Host discovery", requested)
            } finally { client.disconnect() }
        }
        attempt(settings, true)
        attempt(settings.copy(secret = "wrong-lan-password"), false)
    }

    @Test fun routeProbeRequiresTheServerToAnswer() {
        fun server(reply: String?) = java.net.ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).also { socket ->
            kotlin.concurrent.thread(isDaemon = true) {
                runCatching { socket.accept().use { peer -> reply?.let { peer.getOutputStream().write(it.toByteArray()) }; Thread.sleep(3_000) } }
            }
        }
        val route = com.termbridge.android.network.LanRoute("test", null)
        server(null).use { silent ->
            val result = com.termbridge.android.network.LanRoutes.probe(route, "127.0.0.1", silent.localPort, secure = false, timeoutMs = 1_000)
            assertFalse("Accepting TCP without answering is how a proxy VPN fakes a connection", result.connected)
            assertTrue(result.accepted)
        }
        server("HTTP/1.1 101 Switching Protocols\r\n\r\n").use { relay ->
            val result = com.termbridge.android.network.LanRoutes.probe(route, "127.0.0.1", relay.localPort, secure = false, timeoutMs = 2_000)
            assertTrue(result.error ?: "", result.connected)
            assertEquals("HTTP 101", result.reply)
        }
    }

    @Test fun connectionCheckReportsRouteHttpAndLogin() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("lanFixture") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = ConnectionSettings("ws://10.0.2.2:38742", "", "lan-ui-fixture-password", "", connectionMode = com.termbridge.android.data.ConnectionMode.DIRECT)
        val report = com.termbridge.android.network.ConnectionCheck.run(context, settings).joinToString("\n")
        val accepted = context.getString(R.string.connection_test_ws_ok, "\u0000", 0).substringBefore("\u0000")
        assertTrue(report, report.contains(context.getString(R.string.connection_test_http_ok, 200)))
        assertTrue(report, report.contains(accepted))
        val rejected = com.termbridge.android.network.ConnectionCheck.run(context, settings.copy(secret = "wrong-lan-password")).joinToString("\n")
        assertFalse(rejected, rejected.contains(accepted))
        assertTrue(rejected, rejected.contains(context.getString(R.string.connection_test_ws_failed, "\u0000").substringBefore("\u0000")))
    }
}
