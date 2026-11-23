package com.termbridge.android.data

import android.content.Context
import java.util.concurrent.CopyOnWriteArraySet

/** Global opt-in, independent of host selection or voice settings. */
object TrafficSettings {
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    fun enabled(context: Context): Boolean = context.getSharedPreferences("traffic", Context.MODE_PRIVATE)
        .getBoolean("background_saver", false)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences("traffic", Context.MODE_PRIVATE).edit()
            .putBoolean("background_saver", enabled).apply()
        listeners.forEach { it() }
    }

    fun addListener(listener: () -> Unit) { listeners += listener }
    fun removeListener(listener: () -> Unit) { listeners -= listener }
}
