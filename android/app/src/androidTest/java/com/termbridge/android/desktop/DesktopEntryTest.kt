package com.termbridge.android.desktop

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import com.google.android.material.appbar.MaterialToolbar
import com.termbridge.android.R
import com.termbridge.android.TerminalActivity
import com.termbridge.android.data.ConnectionSettings
import com.termbridge.android.data.SettingsStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DesktopEntryTest {
    @Test fun detailMenuOpensRemoteDesktopOnTheSessionsExactEndpoint() {
        org.junit.Assume.assumeTrue(InstrumentationRegistry.getArguments().getString("desktopNavigationFixture") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val old = SettingsStore.load(context)
        val public = ConnectionSettings("wss://desktop-entry.invalid", "desktop-entry-fixture", "fixture-password", "", connectionEnabled = false, profileAlias = "Fixture public")
        val lan = public.copy(relayUrl = "wss://127.0.0.1:39178", profileAlias = "Fixture LAN")
        instrumentation.runOnMainSync { SettingsStore.save(context, public); SettingsStore.save(context, lan) }
        var desktop: RemoteDesktopActivity? = null
        fun children(v: View): List<View> = listOf(v) + if (v is ViewGroup) (0 until v.childCount).flatMap { children(v.getChildAt(it)) } else emptyList()
        try {
            ActivityScenario.launch<TerminalActivity>(TerminalActivity.attachIntent(context, "herdr:desktop-entry-fixture", "Fixture session", true,
                lan.hostId, forceTerminal = true, endpointKey = lan.endpointKey)).use { scenario ->
                scenario.onActivity { activity ->
                    assertEquals(lan.profileKey, SettingsStore.load(context).profileKey)
                    // Switching the global target cannot redirect an already-open detail page.
                    SettingsStore.select(context, public.profileKey)
                    val toolbar = activity.findViewById<MaterialToolbar>(R.id.toolbar)
                    assertEquals(context.getString(R.string.remote_desktop), toolbar.menu.findItem(R.id.action_desktop).title)
                    assertTrue(toolbar.menu.performIdentifierAction(R.id.action_desktop, 0))
                }
                val deadline = SystemClock.uptimeMillis() + 5000
                while (desktop == null && SystemClock.uptimeMillis() < deadline) {
                    instrumentation.runOnMainSync {
                        desktop = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED)
                            .filterIsInstance<RemoteDesktopActivity>().singleOrNull()
                    }
                    if (desktop == null) SystemClock.sleep(50)
                }
                assertNotNull("The menu must launch the native remote desktop activity", desktop)
                instrumentation.runOnMainSync {
                    assertEquals(lan.endpointKey, desktop!!.intent.getStringExtra("desktopEndpointKey"))
                    assertEquals(lan.profileAlias, children(desktop!!.window.decorView).filterIsInstance<MaterialToolbar>().first().subtitle)
                    desktop!!.finish()
                }
            }
        } finally {
            instrumentation.runOnMainSync {
                desktop?.finish()
                SettingsStore.remove(context, lan.profileKey); SettingsStore.remove(context, public.profileKey)
                SettingsStore.select(context, old.profileKey)
            }
        }
    }
}
