package com.termbridge.android

import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.google.android.material.chip.Chip
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostConnectionEditingTest {
    @Test fun longPressEditsExactServerCancelPreservesSelectionAndSaveReconnects() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("connectionSettingsFixture") == "true")
        val context = instrumentation.targetContext
        val original = SettingsStore.load(context)
        val first = ConnectionSettings("ws://127.0.0.1:39151", "edit-first", "first-test-password", "", "First fixture", connectionEnabled = false)
        val target = ConnectionSettings("wss://192.168.240.2:39152", "edit-target", "second-test-password", "a".repeat(64), "Second fixture", connectionEnabled = false)
        fun children(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { children(view.getChildAt(it)) } else emptyList()
        fun resumedEditor(): ConnectionSettingsActivity? {
            var editor: ConnectionSettingsActivity? = null
            instrumentation.runOnMainSync { editor = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<ConnectionSettingsActivity>().firstOrNull() }
            return editor
        }
        fun openEditor(scenario: ActivityScenario<MainActivity>): ConnectionSettingsActivity {
            scenario.onActivity { activity -> children(activity.window.decorView).filterIsInstance<Chip>().first { it.text == target.displayName }.performLongClick() }
            instrumentation.waitForIdleSync()
            val menuDeadline = SystemClock.uptimeMillis() + 5000
            var edit: android.view.accessibility.AccessibilityNodeInfo? = null
            while (edit == null && SystemClock.uptimeMillis() < menuDeadline) {
                edit = instrumentation.uiAutomation.rootInActiveWindow?.findAccessibilityNodeInfosByText(context.getString(R.string.connection_edit))?.firstOrNull()
                if (edit == null) SystemClock.sleep(50)
            }
            assertNotNull("Server menu must offer Edit connection", edit)
            val bitmap = instrumentation.uiAutomation.takeScreenshot()
            if (bitmap != null) {
                java.io.File(context.getExternalFilesDir(null), "server-edit-menu.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            val bounds = android.graphics.Rect()
            edit!!.getBoundsInScreen(bounds)
            assertFalse("Edit row must have a visible hit target", bounds.isEmpty)
            val time = SystemClock.uptimeMillis()
            instrumentation.sendPointerSync(android.view.MotionEvent.obtain(time, time, android.view.MotionEvent.ACTION_DOWN, bounds.exactCenterX(), bounds.exactCenterY(), 0))
            instrumentation.sendPointerSync(android.view.MotionEvent.obtain(time, time + 50, android.view.MotionEvent.ACTION_UP, bounds.exactCenterX(), bounds.exactCenterY(), 0))
            val deadline = SystemClock.uptimeMillis() + 5000
            while (SystemClock.uptimeMillis() < deadline) { resumedEditor()?.let { return it }; SystemClock.sleep(50) }
            throw AssertionError("Exact connection editor did not open")
        }
        instrumentation.runOnMainSync { SettingsStore.save(context, target); SettingsStore.save(context, first) }
        try {
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                val cancelled = openEditor(scenario)
                instrumentation.runOnMainSync {
                    assertEquals("192.168.240.2", cancelled.findViewById<EditText>(R.id.relayUrl).text.toString())
                    assertEquals(target.hostId, cancelled.findViewById<EditText>(R.id.hostId).text.toString())
                    assertTrue(cancelled.findViewById<View>(R.id.hostLayout).isShown)
                    cancelled.findViewById<EditText>(R.id.sharedSecret).setText("discard-this-password")
                    cancelled.finish()
                }
                instrumentation.waitForIdleSync()
                assertEquals(first.profileKey, SettingsStore.load(context).profileKey)
                assertEquals(target.secret, SettingsStore.profiles(context).first { it.profileKey == target.profileKey }.secret)
                val editor = openEditor(scenario)
                instrumentation.runOnMainSync {
                    editor.findViewById<EditText>(R.id.relayUrl).setText("127.0.0.1")
                    editor.findViewById<EditText>(R.id.hostId).setText("edit-target-updated")
                    editor.findViewById<EditText>(R.id.sharedSecret).setText("replacement-test-password")
                    editor.findViewById<View>(R.id.save).performClick()
                }
                instrumentation.waitForIdleSync()
                val saved = SettingsStore.load(context)
                assertEquals("edit-target-updated", saved.hostId)
                assertEquals("wss://127.0.0.1:39152", saved.relayUrl)
                assertEquals("replacement-test-password", saved.secret)
                assertTrue(saved.connectionEnabled)
                assertFalse(SettingsStore.profiles(context).any { it.profileKey == target.profileKey })
                assertEquals(first, SettingsStore.profiles(context).first { it.profileKey == first.profileKey })
            }
        } finally {
            instrumentation.runOnMainSync {
                SettingsStore.profiles(context).filter { it.hostId in setOf("edit-first", "edit-target", "edit-target-updated") }.forEach { SettingsStore.remove(context, it.profileKey) }
                SettingsStore.select(context, original.profileKey)
            }
        }
    }
}
