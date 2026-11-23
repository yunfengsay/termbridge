package com.termbridge.android.brain

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Activity
import android.app.Application
import android.content.Intent
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.MainActivity
import com.termbridge.android.R
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** Presentation-only device tests: never construct AudioRecord or start a Voice Call. */
@RunWith(AndroidJUnit4::class)
class VoiceCallPresentationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test fun floatingCallShowsOnlyOrbAndTapReturnsWithoutOpeningMicrophone() {
        val context = instrumentation.targetContext
        val owner = Any()
        val stops = AtomicInteger()
        val ui = instrumentation.uiAutomation
        ui.serviceInfo = ui.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
        val monitor = instrumentation.addMonitor(BrainActivity::class.java.name, null, false)
        var returnedPage: Activity? = null
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            try {
                scenario.onActivity { activity ->
                    VoiceCallOwnership.shared.acquire(owner) {
                        stops.incrementAndGet()
                        VoiceCallOwnership.shared.release(owner)
                        VoiceCallUiState.setActive(false)
                    }
                    VoiceCallUiState.setMode(VoiceLevelView.Mode.LISTENING)
                    VoiceCallUiState.setActive(true)
                    VoiceCallOverlayService.start(activity)
                }
                await { VoiceCallUiState.current().overlayVisible }
                val returnLabel = context.getString(R.string.voice_call_return)
                var overlay: AccessibilityNodeInfo? = null
                await {
                    overlay = ui.windows.mapNotNull { it.root }.firstOrNull { hasLabel(it, returnLabel) }
                    overlay != null
                }
                val root = requireNotNull(overlay)
                assertFalse("Collapsed orb must not expose a hangup button",
                    hasLabel(root, context.getString(R.string.voice_call_end)))
                assertFalse("Collapsed orb must not show status text",
                    hasLabel(root, context.getString(R.string.voice_orb_listening)))
                assertTrue(clickLabel(root, returnLabel))
                returnedPage = instrumentation.waitForMonitorWithTimeout(monitor, 5_000)
                assertTrue("Tapping the orb must return to the call page", returnedPage is BrainActivity)
                assertEquals("Returning must not hang up the call", 0, stops.get())
            } finally {
                instrumentation.removeMonitor(monitor)
                instrumentation.runOnMainSync {
                    VoiceCallOwnership.shared.stopActive("test_cleanup")
                    VoiceCallOverlayService.stop()
                    returnedPage?.finish()
                }
            }
        }
    }

    @Test fun globalEntryReusesExistingPageUnderAnotherActivity() {
        val context = instrumentation.targetContext
        val app = context.applicationContext as Application
        val creations = AtomicInteger()
        val mainPage = AtomicReference<MainActivity>()
        val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(activity: Activity, state: Bundle?) {
                if (activity is BrainActivity) creations.incrementAndGet()
            }
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityResumed(activity: Activity) {
                if (activity is MainActivity) mainPage.set(activity)
            }
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        }
        app.registerActivityLifecycleCallbacks(callbacks)
        try {
            ActivityScenario.launch<BrainActivity>(BrainActivity.globalIntent(context)).use { scenario ->
                scenario.onActivity { it.startActivity(Intent(it, MainActivity::class.java)) }
                await { mainPage.get() != null }
                instrumentation.runOnMainSync {
                    val main = requireNotNull(mainPage.get())
                    main.startActivity(BrainActivity.globalIntent(main))
                }
                instrumentation.waitForIdleSync()
                scenario.onActivity { assertFalse(VoiceCallUiState.current().active) }
                assertEquals("Re-entry must not create another call owner screen", 1, creations.get())
            }
        } finally {
            app.unregisterActivityLifecycleCallbacks(callbacks)
        }
    }

    @Test fun revokingOverlayPermissionEndsBackgroundCallWithoutMicrophone() {
        val context = instrumentation.targetContext
        val owner = Any()
        val stops = AtomicInteger()
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            try {
                scenario.onActivity {
                    VoiceCallOwnership.shared.acquire(owner) {
                        stops.incrementAndGet()
                        VoiceCallOwnership.shared.release(owner)
                        VoiceCallUiState.setActive(false)
                    }
                    VoiceCallUiState.setActive(true)
                    VoiceCallOverlayService.start(it)
                }
                await { VoiceCallUiState.current().overlayVisible }
                shell("appops set com.termbridge.android SYSTEM_ALERT_WINDOW ignore")
                await { !VoiceCallUiState.current().active && !VoiceCallUiState.current().overlayVisible }
                assertEquals(1, stops.get())
            } finally {
                shell("appops set com.termbridge.android SYSTEM_ALERT_WINDOW allow")
                instrumentation.runOnMainSync {
                    VoiceCallOwnership.shared.stopActive("test_cleanup")
                    VoiceCallOverlayService.stop()
                }
            }
        }
    }

    private fun shell(command: String) {
        instrumentation.uiAutomation.executeShellCommand(command).use {
            java.io.FileInputStream(it.fileDescriptor).use { stream -> stream.readBytes() }
        }
    }

    private fun clickLabel(node: AccessibilityNodeInfo, label: String): Boolean {
        if (node.contentDescription?.toString() == label && node.isClickable) {
            return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }
        return (0 until node.childCount).any { node.getChild(it)?.let { child -> clickLabel(child, label) } == true }
    }

    private fun hasLabel(node: AccessibilityNodeInfo, label: String): Boolean {
        if (node.isVisibleToUser && (node.contentDescription?.toString() == label || node.text?.toString() == label)) return true
        return (0 until node.childCount).any { node.getChild(it)?.let { child -> hasLabel(child, label) } == true }
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.nanoTime() + 5_000_000_000L
        while (System.nanoTime() < deadline) {
            if (condition()) return
            Thread.sleep(50)
        }
        assertTrue("Condition did not become true within five seconds", condition())
    }
}
