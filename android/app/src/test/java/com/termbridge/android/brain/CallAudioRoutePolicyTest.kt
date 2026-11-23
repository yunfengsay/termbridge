package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Test

class CallAudioRoutePolicyTest {
    @Test
    fun `automatic call routing preserves the current external device`() {
        assertEquals(
            CallAudioRouteKind.BLUETOOTH_SCO,
            CallAudioRoutePolicy.select(
                available = listOf(
                    CallAudioRouteKind.BUILTIN_SPEAKER,
                    CallAudioRouteKind.BLUETOOTH_SCO,
                    CallAudioRouteKind.BUILTIN_EARPIECE,
                ),
                current = CallAudioRouteKind.BLUETOOTH_SCO,
                forceSpeaker = false,
                speakerFallback = true,
            ),
        )
    }

    @Test
    fun `automatic call routing prefers a bluetooth communication device over speaker fallback`() {
        assertEquals(
            CallAudioRouteKind.BLE_HEADSET,
            CallAudioRoutePolicy.select(
                available = listOf(
                    CallAudioRouteKind.BUILTIN_SPEAKER,
                    CallAudioRouteKind.BLE_HEADSET,
                    CallAudioRouteKind.BUILTIN_EARPIECE,
                ),
                current = CallAudioRouteKind.BUILTIN_SPEAKER,
                forceSpeaker = false,
                speakerFallback = true,
            ),
        )
    }

    @Test
    fun `speaker button forces speaker only for the active call`() {
        assertEquals(
            CallAudioRouteKind.BUILTIN_SPEAKER,
            CallAudioRoutePolicy.select(
                available = listOf(
                    CallAudioRouteKind.BUILTIN_SPEAKER,
                    CallAudioRouteKind.BLUETOOTH_SCO,
                ),
                current = CallAudioRouteKind.BLUETOOTH_SCO,
                forceSpeaker = true,
                speakerFallback = false,
            ),
        )
    }

    @Test
    fun `automatic call routing falls back to the persisted local route`() {
        val available = listOf(
            CallAudioRouteKind.BUILTIN_EARPIECE,
            CallAudioRouteKind.BUILTIN_SPEAKER,
        )
        assertEquals(
            CallAudioRouteKind.BUILTIN_SPEAKER,
            CallAudioRoutePolicy.select(available, null, forceSpeaker = false, speakerFallback = true),
        )
        assertEquals(
            CallAudioRouteKind.BUILTIN_EARPIECE,
            CallAudioRoutePolicy.select(available, null, forceSpeaker = false, speakerFallback = false),
        )
    }
}
