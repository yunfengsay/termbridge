package com.termbridge.android.brain

import android.content.Intent
import android.graphics.Rect
import android.os.SystemClock
import android.provider.AlarmClock
import android.view.ContextThemeWrapper
import android.view.MotionEvent
import android.view.View
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.termbridge.android.R
import com.termbridge.android.MainActivity
import com.termbridge.android.content.ArtifactMarkdown
import com.termbridge.android.peer.PhoneActionNavigation
import com.termbridge.android.peer.PhoneActionResult
import com.termbridge.android.peer.PhoneActionStore
import com.termbridge.android.protocol.VoiceToolViewInfo
import com.termbridge.android.protocol.VoiceToolViewItemInfo
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PhoneActionCardTest {
    @Test fun titleAndSummaryTouchesOpenClockWithoutCreatingAnotherAlarm() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val intents = mutableListOf<Intent>()
        val context = object : ContextThemeWrapper(instrumentation.targetContext, R.style.Theme_Termbridge) {
            override fun startActivity(intent: Intent) { intents += intent }
        }
        val actionId = "test-alarm-card-${SystemClock.uptimeMillis()}"
        val store = PhoneActionStore(context)
        store.complete(PhoneActionResult(actionId, "alarm.create", "completed", "已打开系统时钟"))
        var markdown: ArtifactMarkdown? = null
        try {
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            for (target in listOf(R.id.title, R.id.summary)) {
                lateinit var view: VoiceToolResultView
                scenario.onActivity { activity ->
                    if (markdown == null) markdown = ArtifactMarkdown(context, { error("No asset reads") }, { error("No links") })
                    view = VoiceToolResultView(context)
                    view.bind(VoiceToolViewInfo("receipt", "Phone action", listOf(
                        VoiceToolViewItemInfo(actionId, "Create alarm", detail = "已打开系统时钟", status = "completed"),
                    )), { PhoneActionNavigation.open(context, it.id) }, markdown)
                    activity.setContentView(view)
                }
                instrumentation.waitForIdleSync()
                instrumentation.runOnMainSync {
                    val row = view.findViewById<android.view.ViewGroup>(R.id.rows).getChildAt(0)
                    val child = row.findViewById<View>(target)
                    val bounds = Rect(0, 0, child.width, child.height)
                    view.offsetDescendantRectToMyCoords(child, bounds)
                    val time = SystemClock.uptimeMillis()
                    for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                        val motion = MotionEvent.obtain(time, time + action * 40L, action,
                            bounds.exactCenterX(), bounds.exactCenterY(), 0)
                        view.dispatchTouchEvent(motion)
                        motion.recycle()
                    }
                }
                instrumentation.waitForIdleSync()
            }
            assertEquals(listOf(AlarmClock.ACTION_SHOW_ALARMS, AlarmClock.ACTION_SHOW_ALARMS), intents.map { it.action })
            }
        } finally {
            instrumentation.runOnMainSync { markdown?.close() }
            store.discard(actionId)
        }
    }
}
