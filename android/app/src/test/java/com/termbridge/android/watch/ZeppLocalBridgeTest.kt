package com.termbridge.android.watch

import com.termbridge.android.protocol.SessionInfo
import io.github.jaredmdobson.concentus.OpusApplication
import io.github.jaredmdobson.concentus.OpusEncoder
import java.net.InetAddress
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ZeppLocalBridgeTest {
    @Test
    fun tokenIsLongAndPasteFriendly() {
        val token = ZeppBridgeTokenStore.generateToken()

        assertTrue(ZeppBridgeTokenStore.isValid(token))
        assertEquals(48, token.length)
        assertEquals(token, ZeppBridgeTokenStore.normalize(ZeppBridgeTokenStore.display(token)))
        assertFalse(ZeppBridgeTokenStore.isValid("123456"))
    }

    @Test
    fun snapshotPrioritizesAttentionAndEscapesJson() {
        val snapshot = ZeppBridgeSnapshot.fromSessions(
            connected = true,
            host = "Mac \"Studio\"",
            sessions = listOf(
                session("done", "done", "finished"),
                session("run", "working", "line 1\nline 2"),
                session("approve", "approval", "confirm"),
            ),
            now = 123L,
        )

        assertEquals(listOf("approve", "run", "done"), snapshot.agents.map { it.sessionId })
        val json = snapshot.toJson()
        assertTrue(json.contains("\"connected\":true"))
        assertTrue(json.contains("Mac \\\"Studio\\\""))
        assertTrue(json.contains("line 1\\nline 2"))
        assertTrue(json.contains("\"attention\":1"))
        assertTrue(json.contains("\"alerts\":[]"))
    }

    @Test
    fun snapshotSerializesBoundedAlertHistory() {
        val session = session("approve", "approval", "confirm deployment")
        val alerts = (1L..20L).map { time -> ZeppBridgeAlert.fromSession(session, "approval", time) }
        val snapshot = ZeppBridgeSnapshot.fromSessions(true, "Phone", listOf(session), 21L, alerts)

        assertEquals(16, snapshot.alerts.size)
        val json = snapshot.toJson()
        assertTrue(json.contains("\"alerts\":16"))
        assertTrue(json.contains("confirm deployment"))
    }

    @Test
    fun alertHistoryIsNewestFirstDeduplicatedAndBounded() {
        val session = session("approve", "approval", "confirm deployment")
        val alerts = (1L..20L).fold(emptyList<ZeppBridgeAlert>()) { current, time ->
            ZeppBridgeAlertStore.merge(current, ZeppBridgeAlert.fromSession(session, "approval", time))
        }
        val duplicate = alerts.first().copy(title = "updated")
        val merged = ZeppBridgeAlertStore.merge(alerts, duplicate)

        assertEquals(16, merged.size)
        assertEquals((20L downTo 5L).toList(), merged.map(ZeppBridgeAlert::occurredAt))
        assertEquals("updated", merged.first().title)
    }

    @Test
    fun loopbackEndpointRejectsWrongTokenAndReturnsBoundedStatus() {
        val token = "a".repeat(48)
        val bridge = ZeppLocalBridge(
            expectedToken = { token },
            currentSnapshot = { ZeppBridgeSnapshot(true, "Phone", 7L, emptyList()) },
            requestedPort = 0,
        )
        assertTrue(bridge.start())
        try {
            val rejected = get(bridge.boundPort, "wrong")
            assertTrue(rejected.startsWith("HTTP/1.1 401"))
            assertFalse(rejected.contains("Phone"))

            val accepted = get(bridge.boundPort, token)
            assertTrue(accepted.startsWith("HTTP/1.1 200"))
            assertTrue(accepted.contains("\"host\":\"Phone\""))
            assertTrue(accepted.contains("Cache-Control: no-store"))
        } finally {
            bridge.close()
        }
    }

    @Test
    fun loopbackVoiceEndpointAuthenticatesUploadsAndReturnsProgress() {
        val token = "b".repeat(48)
        val expectedAudio = ByteArray(96) { it.toByte() }
        var received = ByteArray(0)
        var receivedSource: String? = null
        val snapshot = ZeppVoiceSnapshot("12345678-1234-1234-1234-123456789abc", "thinking", "你好", "", "", 9L)
        val bridge = ZeppLocalBridge(
            expectedToken = { token },
            currentSnapshot = { ZeppBridgeSnapshot(true, "Phone", 7L, emptyList()) },
            submitVoice = { audio, sourceSessionId ->
                received = audio
                receivedSource = sourceSessionId
                snapshot
            },
            currentVoice = { id -> snapshot.takeIf { it.id == id } },
            requestedPort = 0,
        )
        assertTrue(bridge.start())
        try {
            val body = Base64.getEncoder().encodeToString(expectedAudio)
            val uploaded = request(
                bridge.boundPort,
                token,
                "POST",
                ZeppLocalBridge.VOICE_PATH,
                body,
                sourceSessionId = "herdr:w1:p1",
            )
            assertTrue(uploaded.startsWith("HTTP/1.1 202"))
            assertTrue(expectedAudio.contentEquals(received))
            assertEquals("herdr:w1:p1", receivedSource)
            assertTrue(uploaded.contains("\"state\":\"thinking\""))

            val progress = request(
                bridge.boundPort,
                token,
                "GET",
                "${ZeppLocalBridge.VOICE_PATH}/${snapshot.id}",
                "",
            )
            assertTrue(progress.startsWith("HTTP/1.1 200"))
            assertTrue(progress.contains("你好"))
        } finally {
            bridge.close()
        }
    }

    @Test
    fun loopbackVoiceDecisionEndpointSupportsConfirmRewriteAndDiscard() {
        val token = "e".repeat(48)
        val voiceId = "12345678-1234-1234-1234-123456789abc"
        var received: Pair<String, ZeppVoiceDecision>? = null
        val snapshot = ZeppVoiceSnapshot(
            voiceId,
            ZeppGlobalVoiceController.STATE_THINKING,
            "发送这句话",
            "",
            "",
            12L,
        )
        val bridge = ZeppLocalBridge(
            expectedToken = { token },
            currentSnapshot = { ZeppBridgeSnapshot(true, "Phone", 7L, emptyList()) },
            decideVoice = { id, decision ->
                received = id to decision
                snapshot
            },
            requestedPort = 0,
        )
        assertTrue(bridge.start())
        try {
            val accepted = request(
                bridge.boundPort,
                token,
                "POST",
                ZeppLocalBridge.VOICE_DECISION_PATH,
                "",
                voiceId = voiceId,
                voiceDecision = "confirm",
            )
            assertTrue(accepted.startsWith("HTTP/1.1 202"))
            assertEquals(voiceId to ZeppVoiceDecision.CONFIRM, received)
            assertTrue(accepted.contains("\"state\":\"thinking\""))

            val rejected = request(
                bridge.boundPort,
                token,
                "POST",
                ZeppLocalBridge.VOICE_DECISION_PATH,
                "",
                voiceId = voiceId,
                voiceDecision = "send-anyway",
            )
            assertTrue(rejected.startsWith("HTTP/1.1 400"))
        } finally {
            bridge.close()
        }
    }

    @Test
    fun rewriteAndDiscardFinishTheCurrentVoiceTurnButConfirmationDoesNot() {
        fun snapshot(state: String) = ZeppVoiceSnapshot("id", state, "text", "", "", 1L)

        assertFalse(snapshot(ZeppGlobalVoiceController.STATE_AWAITING_CONFIRMATION).terminal)
        assertTrue(snapshot(ZeppGlobalVoiceController.STATE_REWRITE).terminal)
        assertTrue(snapshot(ZeppGlobalVoiceController.STATE_DISCARDED).terminal)
    }

    @Test
    fun loopbackHandoffRequiresAnExactSessionAndInvokesPhoneCallback() {
        val token = "c".repeat(48)
        var openedSession = ""
        val bridge = ZeppLocalBridge(
            expectedToken = { token },
            currentSnapshot = { ZeppBridgeSnapshot(true, "Phone", 7L, emptyList()) },
            openSession = { sessionId ->
                openedSession = sessionId
                true
            },
            requestedPort = 0,
        )
        assertTrue(bridge.start())
        try {
            val opened = request(
                bridge.boundPort,
                token,
                "POST",
                ZeppLocalBridge.OPEN_SESSION_PATH,
                "",
                sourceSessionId = "herdr:w1:p7",
            )
            assertTrue(opened.startsWith("HTTP/1.1 202"))
            assertEquals("herdr:w1:p7", openedSession)

            val rejected = request(bridge.boundPort, token, "POST", ZeppLocalBridge.OPEN_SESSION_PATH, "")
            assertTrue(rejected.startsWith("HTTP/1.1 400"))
        } finally {
            bridge.close()
        }
    }

    @Test
    fun loopbackActionEndpointAcceptsOnlyFixedContextualActions() {
        val token = "d".repeat(48)
        var received: Pair<ZeppWatchAction, String>? = null
        val snapshot = ZeppWatchActionSnapshot(
            id = "87654321-4321-4321-4321-cba987654321",
            action = ZeppWatchAction.SUMMARIZE,
            sessionId = "herdr:w4:p2",
            state = ZeppWatchActionSnapshot.STATE_THINKING,
            summary = "正在获取摘要",
            error = "",
            updatedAt = 9L,
        )
        val bridge = ZeppLocalBridge(
            expectedToken = { token },
            currentSnapshot = { ZeppBridgeSnapshot(true, "Phone", 7L, emptyList()) },
            submitAction = { action, sessionId -> received = action to sessionId; snapshot },
            currentAction = { id -> snapshot.takeIf { it.id == id } },
            requestedPort = 0,
        )
        assertTrue(bridge.start())
        try {
            val accepted = request(
                bridge.boundPort,
                token,
                "POST",
                ZeppLocalBridge.ACTION_PATH,
                "",
                sourceSessionId = "herdr:w4:p2",
                action = "summarize",
            )
            assertTrue(accepted.startsWith("HTTP/1.1 202"))
            assertEquals(ZeppWatchAction.SUMMARIZE to "herdr:w4:p2", received)

            val status = request(
                bridge.boundPort,
                token,
                "GET",
                "${ZeppLocalBridge.ACTION_PATH}/${snapshot.id}",
                "",
            )
            assertTrue(status.startsWith("HTTP/1.1 200"))
            assertTrue(status.contains("\"action\":\"summarize\""))

            val rejected = request(
                bridge.boundPort,
                token,
                "POST",
                ZeppLocalBridge.ACTION_PATH,
                "",
                sourceSessionId = "herdr:w4:p2",
                action = "deploy",
            )
            assertTrue(rejected.startsWith("HTTP/1.1 400"))
        } finally {
            bridge.close()
        }
    }

    @Test
    fun pcmNormalizerDownmixesAndResamples() {
        val stereo48k = java.nio.ByteBuffer.allocate(48 * 2 * 2)
            .order(java.nio.ByteOrder.LITTLE_ENDIAN)
        repeat(48) {
            stereo48k.putShort(1_000)
            stereo48k.putShort(3_000)
        }

        val mono16k = ZeppOpusDecoder.normalizePcm16(stereo48k.array(), 48_000, 2)

        assertEquals(16 * 2, mono16k.size)
        val samples = java.nio.ByteBuffer.wrap(mono16k).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        repeat(16) { assertEquals(2_000, samples.short.toInt()) }
    }

    @Test
    fun zeppOpusFramesUseEightByteBigEndianEnvelopes() {
        val encoded = byteArrayOf(
            0, 0, 0, 3, 1, 2, 3, 4, 10, 20, 30,
            0, 0, 0, 2, 5, 6, 7, 8, 40, 50,
        )

        val ranges = ZeppOpusDecoder.frameRanges(encoded)

        assertEquals(listOf(8..10, 19..20), ranges)
        assertEquals(listOf(10, 20, 30), ranges.first().map { encoded[it].toInt() })
        assertEquals(listOf(40, 50), ranges.last().map { encoded[it].toInt() })
    }

    @Test
    fun zeppOpusFramesRejectTruncatedPayloads() {
        val truncated = byteArrayOf(0, 0, 0, 4, 0, 0, 0, 0, 1, 2, 3)

        assertThrows(IllegalArgumentException::class.java) {
            ZeppOpusDecoder.frameRanges(truncated)
        }
    }

    @Test
    fun zeppOpusFramesCanIgnoreStaleRecorderTail() {
        val encoded = byteArrayOf(
            0, 0, 0, 3, 1, 2, 3, 4, 10, 20, 30,
            0x7f, 0x22, 0x33, 0x44, 9, 8, 7, 6,
        )

        val ranges = ZeppOpusDecoder.frameRanges(encoded, allowTrailingGarbage = true)

        assertEquals(listOf(8..10), ranges)
    }

    @Test
    fun zeppOpusDecoderDecodesARealFramedPacket() {
        val samples = ShortArray(320) { index ->
            (12_000 * kotlin.math.sin(index * 2.0 * Math.PI * 440.0 / 16_000.0)).toInt().toShort()
        }
        val packetBuffer = ByteArray(1_500)
        val encoder = OpusEncoder(16_000, 1, OpusApplication.OPUS_APPLICATION_VOIP)
        val packetLength = encoder.encode(samples, 0, samples.size, packetBuffer, 0, packetBuffer.size)
        val framed = java.nio.ByteBuffer.allocate(8 + packetLength)
            .order(java.nio.ByteOrder.BIG_ENDIAN)
            .putInt(packetLength)
            .putInt(0)
            .put(packetBuffer, 0, packetLength)
            .array()

        val decoded = ZeppOpusDecoder.decodeFrames(framed + byteArrayOf(0x7f, 1, 2, 3, 4, 5, 6, 7))

        assertEquals(samples.size * 2, decoded.size)
        assertTrue(decoded.any { it.toInt() != 0 })
    }

    private fun get(port: Int, token: String): String =
        request(port, token, "GET", ZeppLocalBridge.STATUS_PATH, "")

    private fun request(
        port: Int,
        token: String,
        method: String,
        path: String,
        body: String,
        sourceSessionId: String? = null,
        action: String? = null,
        voiceId: String? = null,
        voiceDecision: String? = null,
    ): String =
        Socket(InetAddress.getByName(ZeppLocalBridge.LOOPBACK_IPV4), port).use { socket ->
            val bodyBytes = body.toByteArray(StandardCharsets.US_ASCII)
            val headers = buildString {
                append("$method $path HTTP/1.1\r\n")
                append("Host: 127.0.0.1\r\n")
                append("Authorization: Bearer $token\r\n")
                sourceSessionId?.let { append("X-TermBridge-Source-Session: $it\r\n") }
                action?.let { append("X-TermBridge-Action: $it\r\n") }
                voiceId?.let { append("X-TermBridge-Voice-Id: $it\r\n") }
                voiceDecision?.let { append("X-TermBridge-Voice-Decision: $it\r\n") }
                if (bodyBytes.isNotEmpty()) append("Content-Length: ${bodyBytes.size}\r\n")
                append("\r\n")
            }.toByteArray(StandardCharsets.US_ASCII)
            socket.getOutputStream().apply {
                write(headers)
                write(bodyBytes)
                flush()
            }
            socket.getInputStream().readBytes().toString(StandardCharsets.UTF_8)
        }

    private fun session(id: String, status: String, preview: String) = SessionInfo(
        sessionId = id,
        command = id,
        cols = 80,
        rows = 24,
        createdAt = 1L,
        viewers = 0,
        name = id,
        status = status,
        preview = preview,
    )
}
