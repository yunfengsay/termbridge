package com.termbridge.android.brain

import android.content.Intent
import android.view.View
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.button.MaterialButton
import com.termbridge.android.R
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BoundaryPreparationTest {
    @Test fun missingModelOffersInlineChoicesWithoutStartingCaptureOrDownload() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<BrainActivity>(Intent(context, BrainActivity::class.java)).use { scenario ->
            scenario.onActivity { activity ->
                assertFalse(VoiceCallUiState.current().active)
                BrainActivity::class.java.getDeclaredMethod("showWakeBoundaryPreparation").apply {
                    isAccessible = true
                }.invoke(activity)
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.boundaryPreparation).visibility)
                assertTrue(activity.findViewById<MaterialButton>(R.id.boundaryPrepareButton).isEnabled)
                assertTrue(activity.findViewById<MaterialButton>(R.id.boundaryContinuousButton).isEnabled)
                assertFalse(VoiceCallUiState.current().active)
                val downloading = BrainActivity::class.java.getDeclaredField("boundaryDownloadRunning").apply {
                    isAccessible = true
                }
                assertFalse(downloading.getBoolean(activity))
                assertFalse(activity.isFinishing)
            }
        }
    }
}
