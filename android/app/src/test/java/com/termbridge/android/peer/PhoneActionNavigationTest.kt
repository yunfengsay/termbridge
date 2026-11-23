package com.termbridge.android.peer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PhoneActionNavigationTest {
    private val request = PhoneActionRequest.fromArgs(mapOf(
        "actionId" to "phone-test", "requestId" to "request", "callId" to "call",
        "toolResultId" to "tool", "action" to "alarm.create", "scheduledAt" to "2026-09-25T10:30:00+08:00",
    ))

    @Test fun `pending approval opens approval but completed alarm only opens clock list`() {
        assertEquals(PhoneActionDestination.APPROVAL, phoneActionDestination(request, null))
        val completed = PhoneActionResult("phone-test", "alarm.create", "completed", "已打开系统时钟")
        assertEquals(PhoneActionDestination.ALARMS, phoneActionDestination(null, completed))
        assertEquals(PhoneActionDestination.ALARMS, phoneActionDestination(request, completed))
    }

    @Test fun `unknown foreign and failed receipts never execute a phone action`() {
        assertNull(phoneActionDestination(null, null))
        for (state in listOf("failed", "denied", "cancelled", "expired", "running")) {
            assertEquals(PhoneActionDestination.DETAILS,
                phoneActionDestination(request, PhoneActionResult("phone-test", "alarm.create", state, state)))
        }
        assertEquals(PhoneActionDestination.DETAILS,
            phoneActionDestination(null, PhoneActionResult("phone-test", "alarm.create", "awaiting_user", "stale")))
    }
}
