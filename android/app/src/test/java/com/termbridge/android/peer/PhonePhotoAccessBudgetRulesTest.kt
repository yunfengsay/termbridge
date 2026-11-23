package com.termbridge.android.peer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PhonePhotoAccessBudgetRulesTest {
    @Test
    fun `automatic content grants enforce cooldown and hourly item budget`() {
        val now = 10_000_000L
        assertTrue(PhonePhotoAccessBudgetRules.decide(emptyList(), now, 3).allowed)

        val coolingDown = PhonePhotoAccessBudgetRules.decide(
            listOf(PhonePhotoAccessGrant(now - 15_000, 3)),
            now,
            1,
        )
        assertFalse(coolingDown.allowed)
        assertEquals(45, coolingDown.retryAfterSeconds)

        val hourlyLimit = PhonePhotoAccessBudgetRules.decide(
            listOf(
                PhonePhotoAccessGrant(now - 50 * 60_000, 3),
                PhonePhotoAccessGrant(now - 40 * 60_000, 3),
                PhonePhotoAccessGrant(now - 30 * 60_000, 3),
                PhonePhotoAccessGrant(now - 20 * 60_000, 3),
            ),
            now,
            1,
        )
        assertFalse(hourlyLimit.allowed)
        assertEquals(10 * 60, hourlyLimit.retryAfterSeconds)
    }

    @Test
    fun `expired grants do not consume the next hourly budget`() {
        val now = 20_000_000L
        val result = PhonePhotoAccessBudgetRules.decide(
            listOf(PhonePhotoAccessGrant(now - PhonePhotoAccessBudgetRules.WINDOW_MS, 3)),
            now,
            3,
        )
        assertTrue(result.allowed)
    }
}
