package com.termbridge.android.brain

import android.content.Intent
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.material.materialswitch.MaterialSwitch
import com.termbridge.android.R
import com.termbridge.android.data.TrafficSettings
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Settings only: never start microphone, change routes, or perform phone actions. */
@RunWith(AndroidJUnit4::class)
class TrafficSettingsTest {
    @Test fun globalSwitchPersistsBothModesAcrossRecreation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val original = TrafficSettings.enabled(context)
        try {
            TrafficSettings.setEnabled(context, false)
            ActivityScenario.launch<VoiceProfileActivity>(Intent(context, VoiceProfileActivity::class.java)).use { scenario ->
                scenario.onActivity { activity ->
                    val toggle = activity.findViewById<MaterialSwitch>(R.id.backgroundTrafficSaver)
                    assertFalse(toggle.isChecked)
                    toggle.performClick()
                    assertTrue(TrafficSettings.enabled(context))
                }
                scenario.recreate()
                scenario.onActivity { activity ->
                    val toggle = activity.findViewById<MaterialSwitch>(R.id.backgroundTrafficSaver)
                    assertTrue(toggle.isChecked)
                    toggle.performClick()
                    assertFalse(TrafficSettings.enabled(context))
                }
            }
        } finally {
            TrafficSettings.setEnabled(context, original)
        }
    }
}
