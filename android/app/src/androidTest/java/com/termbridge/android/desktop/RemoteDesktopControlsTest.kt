package com.termbridge.android.desktop

import android.graphics.Bitmap
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.EditText
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.R
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Fixture rendering plus optional local Mac authentication handshake; never enters credentials or unlocks. */
@RunWith(AndroidJUnit4::class)
class RemoteDesktopControlsTest {
    @org.junit.Before fun requireExplicitFixtureRun() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("desktopFixture") == "true")
    }
    @Test fun nativeMenuKeyboardAndEmptyStateUseTheSameSurface() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val old = SettingsStore.load(context)
        val fixture = ConnectionSettings("ws://10.0.2.2:38642", "desktop-fixture", "desktop-fixture-pairing-key", "", "Desktop QA")
        fun children(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { children(view.getChildAt(it)) } else emptyList()
        fun shot(name: String) { SystemClock.sleep(400); instrumentation.uiAutomation.takeScreenshot().useBitmap { bitmap -> File(context.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } } }
        instrumentation.runOnMainSync { AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags("zh-CN")); SettingsStore.save(context, fixture) }
        try {
            ActivityScenario.launch<RemoteDesktopActivity>(RemoteDesktopActivity.intent(context, fixture.hostId)).use { scenario ->
                var ready = false
                val deadline = SystemClock.uptimeMillis() + 15000
                while (!ready && SystemClock.uptimeMillis() < deadline) {
                    scenario.onActivity { activity -> ready = children(activity.window.decorView).any { it.contentDescription == activity.getString(R.string.desktop_keyboard) && it.isEnabled } }
                    if (!ready) SystemClock.sleep(100)
                }
                shot("desktop-native-ready-check.png")
                assertTrue("Encrypted viewer must connect before native actions are enabled", ready)
                instrumentation.waitForIdleSync(); shot("desktop-native-connected.png")
                scenario.onActivity { activity -> children(activity.window.decorView).first { it.contentDescription == activity.getString(R.string.desktop_display) }.performClick() }
                instrumentation.waitForIdleSync(); shot("desktop-native-displays.png")
                instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
                scenario.onActivity { activity -> children(activity.window.decorView).first { it.contentDescription == activity.getString(R.string.desktop_keyboard) }.performClick() }
                instrumentation.waitForIdleSync()
                scenario.onActivity { activity ->
                    children(activity.window.decorView).filterIsInstance<EditText>().first().setText("原生键盘 ✓")
                    children(activity.window.decorView).first { it.contentDescription == activity.getString(R.string.desktop_send) }.performClick()
                }
                instrumentation.waitForIdleSync(); shot("desktop-native-keyboard.png")
                scenario.onActivity { activity ->
                    val web = children(activity.window.decorView).filterIsInstance<WebView>().first()
                    web.evaluateJavascript("window.Desktop.disconnected()", null)
                }
                SystemClock.sleep(400); instrumentation.waitForIdleSync(); shot("desktop-native-disconnected.png")
            }
        } finally { instrumentation.runOnMainSync { SettingsStore.remove(context, fixture.profileKey); SettingsStore.select(context, old.profileKey) } }
    }
    @Test fun systemSharingRequestsCredentialsInNativeDialog() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("desktopSystemSharing") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val old = SettingsStore.load(context)
        val fixture = ConnectionSettings("ws://10.0.2.2:38643", "desktop-system-fixture", "desktop-fixture-pairing-key", "", "Mac Screen Sharing")
        SettingsStore.save(context, fixture)
        try {
            ActivityScenario.launch<RemoteDesktopActivity>(RemoteDesktopActivity.intent(context, fixture.hostId)).use {
                val deadline = SystemClock.uptimeMillis() + 15000
                var shown = false
                while (!shown && SystemClock.uptimeMillis() < deadline) {
                    val root = instrumentation.uiAutomation.rootInActiveWindow
                    shown = root?.findAccessibilityNodeInfosByText(context.getString(R.string.desktop_login))?.isNotEmpty() == true
                    if (!shown) SystemClock.sleep(100)
                }
                assertTrue("Real Mac RFB authentication must use a native credential dialog", shown)
                SystemClock.sleep(400)
                instrumentation.uiAutomation.takeScreenshot().useBitmap { bitmap -> File(context.getExternalFilesDir(null), "desktop-system-login.png").outputStream().use { output -> bitmap.compress(Bitmap.CompressFormat.PNG, 100, output) } }
                instrumentation.sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            }
        } finally { SettingsStore.remove(context, fixture.profileKey); SettingsStore.select(context, old.profileKey) }
    }
    private inline fun Bitmap.useBitmap(block: (Bitmap) -> Unit) { try { block(this) } finally { recycle() } }
}
