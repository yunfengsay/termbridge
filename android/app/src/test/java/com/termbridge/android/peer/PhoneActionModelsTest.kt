package com.termbridge.android.peer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class PhoneActionModelsTest {
    @Test
    fun `photo edit accepts several selected items without any library read operation`() {
        val request = PhoneActionRequest.fromArgs(
            mapOf(
                "actionId" to "phone-1",
                "requestId" to "request-1",
                "callId" to "call-1",
                "toolResultId" to "tool-1",
                "action" to "photo.edit",
                "instructions" to "统一调色",
                "maxItems" to 12,
            ),
        )

        assertEquals(3, request.maxItems)
        assertEquals("统一调色", request.instructions)
        assertThrows(IllegalArgumentException::class.java) {
            PhoneActionRequest.fromArgs(
                mapOf(
                    "actionId" to "phone-2",
                    "requestId" to "request-2",
                    "callId" to "call-2",
                    "toolResultId" to "tool-2",
                    "action" to "photo.read_all",
                ),
            )
        }
    }

    @Test
    fun `photo selection maximum is capped at three`() {
        val request = PhoneActionRequest.fromArgs(
            mapOf(
                "actionId" to "phone-1",
                "requestId" to "request-1",
                "callId" to "call-1",
                "toolResultId" to "tool-1",
                "action" to "photo.edit",
                "instructions" to "批量调整亮度",
                "maxItems" to 200,
            ),
        )
        assertEquals(3, request.maxItems)
    }

    @Test
    fun `photo library queries require a bounded time window`() {
        val base = mapOf(
            "actionId" to "phone-photo",
            "requestId" to "request-photo",
            "callId" to "call-photo",
            "toolResultId" to "tool-photo",
            "startsAt" to "2026-09-01T00:00:00+08:00",
            "endsAt" to "2026-09-05T00:00:00+08:00",
        )
        val count = PhoneActionRequest.fromArgs(base + ("action" to "photo.count"))
        assertEquals("camera", count.collection)
        val fetch = PhoneActionRequest.fromArgs(base + mapOf(
            "action" to "photo.fetch",
            "collection" to "all",
            "instructions" to "整理新加坡旅行照片",
            "maxItems" to 99,
        ))
        assertEquals("all", fetch.collection)
        assertEquals(3, fetch.maxItems)
        assertThrows(IllegalArgumentException::class.java) {
            PhoneActionRequest.fromArgs(base + mapOf(
                "action" to "photo.fetch",
                "collection" to "private",
                "instructions" to "整理",
            ))
        }
    }

    @Test
    fun `speaker route action requires an explicit boolean`() {
        val base = mapOf(
            "actionId" to "phone-speaker",
            "requestId" to "request-speaker",
            "callId" to "call-speaker",
            "toolResultId" to "tool-speaker",
            "action" to "call.speaker.set",
        )
        assertEquals(true, PhoneActionRequest.fromArgs(base + ("enabled" to true)).enabled)
        assertThrows(IllegalArgumentException::class.java) { PhoneActionRequest.fromArgs(base) }
        assertEquals("screen.capture", PhoneActionRequest.fromArgs(base + ("action" to "screen.capture")).action)
    }

    @Test
    fun `phone action times require an explicit offset`() {
        assertEquals(0L, parsePhoneIsoTime("1970-01-01T08:00:00+08:00"))
        assertThrows(IllegalArgumentException::class.java) {
            parsePhoneIsoTime("2026-09-03T14:00:00")
        }
    }

    @Test
    fun `phone action event omits a missing optional error from the wire`() {
        val event = PhoneActionEvent(
            eventId = "event-1",
            actionId = "action-1",
            requestId = "request-1",
            callId = "call-1",
            toolResultId = "tool-1",
            deviceId = "device-123456789",
            action = "calendar.create",
            state = "completed",
            summary = "created",
            createdAt = 1L,
        )

        assertFalse(event.toControlFields().containsKey("error"))
        assertTrue(event.copy(error = "failed").toControlFields().containsKey("error"))
        assertEquals(1.0, event.toControlFields()["createdAt"])
    }

    @Test
    fun `phone action event makes nested long values safe for the JavaScript host`() {
        val event = PhoneActionEvent(
            eventId = "event-1",
            actionId = "action-1",
            requestId = "request-1",
            callId = "call-1",
            toolResultId = "tool-1",
            deviceId = "device-123456789",
            action = "calendar.list",
            state = "completed",
            summary = "listed",
            createdAt = 1_725_399_944_000L,
            data = mapOf(
                "startsAt" to 1_725_399_944_000L,
                "events" to listOf(mapOf("endsAt" to 1_725_403_544_000L)),
            ),
        )

        assertEquals(1_725_399_944_000.0, event.toControlFields()["createdAt"])
        assertEquals(1_725_399_944_000.0, (event.toControlFields()["data"] as Map<*, *>)["startsAt"])
    }

    @Test
    fun `calendar list immediate result makes ids and timestamps JSON safe`() {
        val result = PhoneActionResult(
            actionId = "action-1",
            action = "calendar.list",
            state = "completed",
            summary = "listed",
            data = mapOf(
                "events" to listOf(mapOf(
                    "eventId" to "9007199254740993",
                    "startsAt" to 1_725_399_944_000L,
                    "endsAt" to 1_725_403_544_000L,
                )),
            ),
        )

        val event = ((result.toMap()["events"] as List<*>).single() as Map<*, *>)
        assertEquals("9007199254740993", event["eventId"])
        assertEquals(1_725_399_944_000.0, event["startsAt"])
        assertEquals(1_725_403_544_000.0, event["endsAt"])
    }

    @Test
    fun `selected image byte count crosses the JavaScript boundary as a number`() {
        val asset = PhoneSelectedAsset("asset-1", "photo.jpg", "image/jpeg", 123L, "a".repeat(64))

        assertEquals(123.0, asset.toWireMap()["size"])
    }
}
