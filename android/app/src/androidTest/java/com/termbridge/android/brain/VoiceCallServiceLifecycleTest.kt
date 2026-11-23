package com.termbridge.android.brain

import android.app.ActivityManager
import android.content.Intent
import android.os.SystemClock
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.MainActivity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Reproduces cancellation before the framework can deliver Service.onCreate; no mic/cloud. */
@RunWith(AndroidJUnit4::class)
class VoiceCallServiceLifecycleTest {
    @Test fun normalStartPublishesForegroundAndStopReleasesService() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val surface = Any()
        @Suppress("DEPRECATION")
        fun service() = context.getSystemService(ActivityManager::class.java).getRunningServices(100)
            .firstOrNull { it.service.className == VoiceCallOverlayService::class.java.name }
        fun await(condition: () -> Boolean) {
            val deadline = SystemClock.elapsedRealtime() + 5_000
            while (!condition() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(50)
            assertTrue("Service lifecycle did not settle", condition())
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            try {
                scenario.onActivity {
                    VoiceCallUiState.setSurfaceVisible(surface, true)
                    VoiceCallUiState.setActive(true)
                    VoiceCallOverlayService.start(it)
                }
                await { service()?.foreground == true }
                scenario.onActivity {
                    // A repeated start must not lose its foreground acknowledgement.
                    VoiceCallOverlayService.start(it)
                }
                instrumentation.waitForIdleSync()
                assertTrue(service()?.foreground == true)
                scenario.onActivity { VoiceCallOverlayService.stop() }
                await { service() == null }
                assertFalse(VoiceCallUiState.current().active)
                assertFalse(VoiceCallUiState.current().overlayVisible)
            } finally {
                instrumentation.runOnMainSync {
                    VoiceCallOverlayService.stop()
                    VoiceCallUiState.setSurfaceVisible(surface, false)
                }
            }
        }
    }

    @Test fun immediateCancellationBeforeServiceCreationDoesNotCrash() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val surface = Any()
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            try {
                repeat(3) {
                    scenario.onActivity { activity ->
                        VoiceCallUiState.setSurfaceVisible(surface, true)
                        VoiceCallUiState.setActive(true)
                        VoiceCallOverlayService.start(activity)
                        // Same main-thread turn: the service's onCreate cannot yet have run.
                        VoiceCallUiState.setActive(false)
                        VoiceCallOverlayService.stop()
                    }
                    instrumentation.waitForIdleSync()
                    SystemClock.sleep(2_000)
                    assertFalse(VoiceCallUiState.current().active)
                    assertFalse(VoiceCallUiState.current().overlayVisible)
                }
            } finally {
                instrumentation.runOnMainSync {
                    VoiceCallUiState.setActive(false)
                    VoiceCallUiState.setSurfaceVisible(surface, false)
                    VoiceCallOverlayService.stop()
                }
            }
        }
    }
}
