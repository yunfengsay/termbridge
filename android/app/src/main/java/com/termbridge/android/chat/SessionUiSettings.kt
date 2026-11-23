package com.termbridge.android.chat

import android.content.Context
import androidx.core.content.edit

object SessionUiSettings {
    private const val PREFERENCES = "session_ui"
    private const val DEFAULT_KEY = "default_ui"
    private const val OVERRIDE_KEY = "session_overrides"

    fun load(context: Context): SessionUi = SessionUi.from(preferences(context).getString(DEFAULT_KEY, null))

    fun save(context: Context, mode: SessionUi) {
        preferences(context).edit { putString(DEFAULT_KEY, mode.wireValue) }
    }

    /** The view this session was last switched to by hand, if any. */
    fun overrideFor(context: Context, sessionId: String): SessionUi? =
        SessionUiRouting.of(preferences(context).getString(OVERRIDE_KEY, null), sessionId)

    /** Records a deliberate switch. `AUTO` restores the device default. */
    fun setOverride(context: Context, sessionId: String, mode: SessionUi) {
        val preferences = preferences(context)
        val next = SessionUiRouting.with(preferences.getString(OVERRIDE_KEY, null), sessionId, mode)
        preferences.edit { putString(OVERRIDE_KEY, next) }
    }

    /**
     * Resolved when a notification or list entry is activated, so changing the
     * default does not leave older notifications opening the previous view.
     */
    fun startsInChat(context: Context, sessionId: String, isHerdr: Boolean): Boolean =
        SessionUiRouting.startsInChat(load(context), overrideFor(context, sessionId), isHerdr)

    private fun preferences(context: Context) =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
}
