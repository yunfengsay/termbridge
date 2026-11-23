package com.termbridge.android.brain

import kotlin.math.PI
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRingDynamicsTest {
    @Test
    fun `closed ring has matching deformation at zero and two pi`() {
        val zero = VoiceRingDynamics.radialOffset(0f, 3, 2.4f, 0.7f, 0.6f)
        val fullTurn = VoiceRingDynamics.radialOffset((PI * 2).toFloat(), 3, 2.4f, 0.7f, 0.6f)

        assertEquals(zero, fullTurn, 0.0001f)
    }

    @Test
    fun `deformation stays bounded and grows with voice energy`() {
        assertTrue(VoiceRingDynamics.deformationAmplitude(1f) < 0.21f)
        assertTrue(
            VoiceRingDynamics.deformationAmplitude(0.9f) >
                VoiceRingDynamics.deformationAmplitude(0.1f),
        )
        repeat(7) { ring ->
            repeat(96) { sample ->
                val offset = VoiceRingDynamics.radialOffset(
                    angle = (PI * 2 * sample / 96).toFloat(),
                    ringIndex = ring,
                    seconds = 3.2f,
                    energy = 1f,
                    speed = 1f,
                )
                assertTrue(abs(offset) <= VoiceRingDynamics.deformationAmplitude(1f) + 0.0001f)
            }
        }
    }
}
