package com.termbridge.android.watch

import com.termbridge.android.data.ConnectionSettings
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WatchLinkCodecTest {
    @Test
    fun gattUuidsMatchTheFirmwareContractInAllSixteenBytes() {
        assertEquals("7f510001-5a7d-4b79-9c2e-7b4e54420001", WatchBleContract.SERVICE_UUID.toString())
        assertEquals("7f510002-5a7d-4b79-9c2e-7b4e54420002", WatchBleContract.WATCH_TO_PHONE_UUID.toString())
        assertEquals("7f510003-5a7d-4b79-9c2e-7b4e54420003", WatchBleContract.PHONE_TO_WATCH_UUID.toString())
    }

    @Test
    fun fragmentsAndReassemblesLosslessPcmAtSmallAndLargeMtu() {
        val pcm = ByteArray(3_840) { index -> (index * 31).toByte() }

        for (mtuPayload in listOf(20, 185, 514)) {
            val fragments = WatchLinkCodec.fragment(
                WatchMessageType.VOICE_INPUT_PCM,
                sequence = 0x1234,
                payload = pcm,
                mtuPayload = mtuPayload,
            )
            val reassembler = WatchLinkCodec.Reassembler()
            fragments.dropLast(1).forEach { assertNull(reassembler.accept(it)) }
            val message = reassembler.accept(fragments.last())!!
            assertEquals(WatchMessageType.VOICE_INPUT_PCM, message.type)
            assertEquals(0x1234, message.sequence)
            assertArrayEquals(pcm, message.payload)
        }
    }

    @Test
    fun emptyControlMessageStillProducesOneCompleteFragment() {
        val fragment = WatchLinkCodec.fragment(WatchMessageType.VOICE_COMMIT, 7, byteArrayOf(), 20).single()
        val message = WatchLinkCodec.Reassembler().accept(fragment)!!

        assertEquals(WatchMessageType.VOICE_COMMIT, message.type)
        assertArrayEquals(byteArrayOf(), message.payload)
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsAContinuationFromAnotherSequence() {
        val fragments = WatchLinkCodec.fragment(WatchMessageType.VOICE_INPUT_PCM, 1, ByteArray(40), 20)
        val reassembler = WatchLinkCodec.Reassembler()
        reassembler.accept(fragments.first())
        val other = WatchLinkCodec.fragment(WatchMessageType.VOICE_INPUT_PCM, 2, ByteArray(40), 20)[1]
        reassembler.accept(other)
    }

    @Test
    fun provisioningCopiesTheExactActiveLinkAndFullQualityPcmContract() {
        val current = ConnectionSettings(
            relayUrl = "wss://relay.internal.example:9443/custom/path",
            hostId = "mac-office",
            secret = "test-secret-not-production",
            tlsFingerprint = "ab".repeat(32),
        )
        val decoded = WatchProvisioning.decode(
            WatchProvisioning.current(current, WatchTransport.AUTO, negotiatedAttMtu = 515).encode(),
        )

        assertEquals(current.relayUrl, decoded.relayUrl)
        assertEquals(current.hostId, decoded.hostId)
        assertEquals(current.secret, decoded.secret)
        assertEquals(current.normalizedFingerprint, decoded.tlsFingerprint)
        assertEquals(WatchTransport.AUTO, decoded.transport)
        assertEquals(16_000, decoded.inputSampleRate)
        assertEquals(24_000, decoded.outputSampleRate)
        assertEquals(515, decoded.negotiatedAttMtu)
    }

    @Test
    fun provisioningDoesNotRequireCloudflareOrAuthenticationFields() {
        val current = ConnectionSettings(
            relayUrl = "ws://192.168.50.12:8787/termbridge",
            hostId = "",
            secret = "",
            tlsFingerprint = "",
        )

        val decoded = WatchProvisioning.decode(
            WatchProvisioning.current(current, WatchTransport.WIFI).encode(),
        )

        assertEquals(current.relayUrl, decoded.relayUrl)
        assertEquals("", decoded.hostId)
        assertEquals("", decoded.secret)
        assertEquals(WatchTransport.WIFI, decoded.transport)
    }
}
