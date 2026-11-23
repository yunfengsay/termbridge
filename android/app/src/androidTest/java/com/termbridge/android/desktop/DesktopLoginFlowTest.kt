package com.termbridge.android.desktop

import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.R
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Fixed credentials against the local ARD fixture; never authenticates to a real Mac. */
@RunWith(AndroidJUnit4::class)
class DesktopLoginFlowTest {
    private fun children(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { children(view.getChildAt(it)) } else emptyList()
    private fun nodes(node: AccessibilityNodeInfo): List<AccessibilityNodeInfo> = listOf(node) + (0 until node.childCount).flatMap { node.getChild(it)?.let(::nodes).orEmpty() }
    private fun awaitCondition(message: String, predicate: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 15000
        while (SystemClock.uptimeMillis() < deadline) { if (predicate()) return; SystemClock.sleep(100) }
        fail(message)
    }
    @Test fun rejectedPasswordIsNotSavedAndSuccessfulLoginIsReused() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("desktopCredentialsFixture") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val old = SettingsStore.load(context)
        val fixture = ConnectionSettings("ws://10.0.2.2:38644", "desktop-auth-fixture", "desktop-fixture-pairing-key", "", "Authentication fixture")
        val store = DesktopCredentialStore(context, fixture)
        fun loginForm(): List<AccessibilityNodeInfo> = instrumentation.uiAutomation.rootInActiveWindow?.let(::nodes)?.filter { it.className == "android.widget.EditText" }.orEmpty()
        fun submit(password: String) {
            awaitCondition("Native credential form must appear") { loginForm().size == 2 }
            loginForm().zip(listOf("fixture-user", password)).forEach { (field, text) ->
                assertTrue(field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }))
            }
            val button = nodes(instrumentation.uiAutomation.rootInActiveWindow).first { it.text?.toString() == context.getString(R.string.desktop_login) && it.isClickable }
            assertTrue(button.performAction(AccessibilityNodeInfo.ACTION_CLICK))
        }
        fun ready(scenario: ActivityScenario<RemoteDesktopActivity>): Boolean {
            var value = false
            scenario.onActivity { activity -> value = children(activity.window.decorView).any { it.contentDescription == context.getString(R.string.desktop_keyboard) && it.isEnabled } }
            return value
        }
        store.clear(); SettingsStore.save(context, fixture)
        try {
            ActivityScenario.launch<RemoteDesktopActivity>(RemoteDesktopActivity.intent(context, fixture.hostId)).use { scenario ->
                awaitCondition("Native credential form must appear") { loginForm().size == 2 }
                scenario.onActivity { activity ->
                    children(activity.window.decorView).filterIsInstance<WebView>().first().evaluateJavascript("window.dispatchEvent(new Event('blur'))", null)
                }
                instrumentation.uiAutomation.takeScreenshot().also { bitmap ->
                    java.io.File(context.getExternalFilesDir(null), "desktop-remember-login.png").outputStream().use {
                        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                    }
                    bitmap.recycle()
                }
                submit("incorrect-fixture-password")
                awaitCondition("Rejected login must expose reconnect") {
                    var value = false
                    scenario.onActivity { activity -> value = children(activity.window.decorView).any { it.contentDescription == context.getString(R.string.desktop_reconnect) && it.visibility == View.VISIBLE } }
                    value
                }
                assertNull("Never remember a rejected password", store.load())
                scenario.onActivity { activity -> children(activity.window.decorView).first { it.contentDescription == context.getString(R.string.desktop_reconnect) }.performClick() }
                submit("fixture-password")
                awaitCondition("ARD login must reach a usable desktop") { ready(scenario) }
                awaitCondition("Remember only after verified authentication") { store.load()?.password == "fixture-password" }
            }
            ActivityScenario.launch<RemoteDesktopActivity>(RemoteDesktopActivity.intent(context, fixture.hostId)).use { scenario ->
                awaitCondition("Next visit must authenticate using remembered credentials") { ready(scenario) }
                assertTrue("Remembered login must not leave a credential dialog", loginForm().isEmpty())
            }
            store.save(DesktopCredentialStore.Credentials("fixture-user", "expired-fixture-password"))
            ActivityScenario.launch<RemoteDesktopActivity>(RemoteDesktopActivity.intent(context, fixture.hostId)).use { scenario ->
                awaitCondition("A rejected saved password must be removed, without retrying it forever") { store.load() == null }
                assertFalse(ready(scenario))
            }
        } finally { store.clear(); SettingsStore.remove(context, fixture.profileKey); SettingsStore.select(context, old.profileKey) }
    }
}
