package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class BrainEntryContextTest {
    @Test
    fun `session origin survives retries and is consumed only after the first durable request`() {
        val context = BrainEntryContext()
        context.accept("herdr:wA:p1", clear = false)

        repeat(2) {
            val fields = mutableListOf<Pair<String, Any?>>()
            context.appendTo(fields)
            assertEquals("herdr:wA:p1", fields.toMap()["sourceSessionId"])
        }

        context.consume()
        val laterFields = mutableListOf<Pair<String, Any?>>()
        context.appendTo(laterFields)
        assertFalse(laterFields.toMap().containsKey("sourceSessionId"))
    }

    @Test
    fun `regular Global entry clears an unused Terminal origin`() {
        val context = BrainEntryContext()
        context.accept("session-1", clear = false)
        context.accept(null, clear = true)
        assertEquals(null, context.sourceSessionId)
    }
}
