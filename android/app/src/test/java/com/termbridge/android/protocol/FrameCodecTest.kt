package com.termbridge.android.protocol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class FrameCodecTest {
    @Test
    fun decodesMsgpackrAuthChallenge() {
        val frame = FrameCodec.decode(hex(AUTH_CHALLENGE_FIXTURE)) as IncomingFrame.Control

        assertEquals("auth_challenge", frame.message.type)
        assertEquals("abc123", frame.message.string("nonce"))
        assertEquals(true, frame.message.boolean("required"))
    }

    @Test
    fun decodesMsgpackrSessionListAndFloatingPointTimestamp() {
        val frame = FrameCodec.decode(hex(SESSION_LIST_FIXTURE)) as IncomingFrame.Control
        val sessions = frame.message.sessions()

        assertEquals(1, sessions.size)
        assertEquals(
            SessionInfo(
                sessionId = "sess-7",
                command = "shell",
                cols = 92,
                rows = 31,
                createdAt = 1_712_345_678_901,
                viewers = 2,
            ),
            sessions.single(),
        )
        assertTrue(sessions.single().isActive)
    }

    @Test
    fun parsesHerdrReplyPreview() {
        val session = SessionInfo.fromMap(
            mapOf(
                "sessionId" to "herdr:w3:p1",
                "command" to "canvas-three-gpu · claude",
                "cols" to 120,
                "rows" to 40,
                "createdAt" to 0L,
                "viewers" to 0,
                "source" to "herdr",
                "name" to "Canvas",
                "paneId" to "w3:p1",
                "preview" to "最后一句回复。",
            ),
        )

        assertEquals("最后一句回复。", session?.preview)
        assertEquals("Canvas", session?.displayName)
        assertTrue(session?.isHerdr == true)
    }

    @Test
    fun encodesPtyInputAndResizeInNetworkByteOrder() {
        assertArrayEquals(
            hex("03123400500018"),
            FrameCodec.resize(sid = 0x1234, cols = 80, rows = 24),
        )
        assertArrayEquals(
            hex("021234e4b8ad"),
            FrameCodec.ptyInput(0x1234, "中".toByteArray()),
        )
    }

    @Test
    fun controlRoundTripsNestedValues() {
        val encoded = FrameCodec.control(
            "t" to "session_create",
            "agent" to "shell",
            "cols" to 80,
            "rows" to 24,
            "args" to listOf("-l", "-i"),
        )
        val message = (FrameCodec.decode(encoded) as IncomingFrame.Control).message

        assertEquals("session_create", message.type)
        assertEquals("shell", message.string("agent"))
        assertEquals(80, message.int("cols"))
        assertEquals(listOf("-l", "-i"), message.stringList("args"))
    }

    @Test
    fun decodesConfirmedHostNetworkPolicy() {
        val message = (
            FrameCodec.decode(
                FrameCodec.control(
                    "t" to "network_policy_result",
                    "requestId" to "route-1",
                    "policy" to "direct",
                    "changed" to true,
                    "proxyDetected" to true,
                ),
            ) as IncomingFrame.Control
        ).message

        assertEquals(
            HostNetworkPolicyInfo(HostNetworkPolicy.DIRECT, changed = true, proxyDetected = true),
            message.hostNetworkPolicy(),
        )
    }

    @Test
    fun controlRoundTripsNativeImageBytes() {
        val image = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xd9.toByte())
        val message = (
            FrameCodec.decode(
                FrameCodec.control(
                    "t" to "session_upload",
                    "id" to "upload-1",
                    "sessionId" to "herdr:w3:p1",
                    "mime" to "image/jpeg",
                    "data" to image,
                ),
            ) as IncomingFrame.Control
        ).message

        assertArrayEquals(image, message.bytes("data"))
    }

    private fun hex(value: String): ByteArray =
        value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    private companion object {
        const val AUTH_CHALLENGE_FIXTURE =
            "00de0003a174ae617574685f6368616c6c656e6765a56e6f6e6365a6616263313233a87265717569726564c3"
        const val SESSION_LIST_FIXTURE =
            "00de0002a174b373657373696f6e5f6c6973745f726573756c74a873657373696f6e7391de0006a973657373696f6e4964a6736573732d37a7636f6d6d616e64a57368656c6ca4636f6c735ca4726f77731fa9637265617465644174cb4278eafc18435000a77669657765727302"
    }
}
