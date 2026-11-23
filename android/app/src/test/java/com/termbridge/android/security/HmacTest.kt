package com.termbridge.android.security

import org.junit.Assert.assertEquals
import org.junit.Test

class HmacTest {
    @Test
    fun matchesRfc4231Sha256Vector() {
        assertEquals(
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
            Hmac.sha256Hex("Jefe", "what do ya want for nothing?"),
        )
    }

    @Test
    fun emptySecretMatchesTermbridgePasswordlessHandshake() {
        assertEquals("", Hmac.sha256Hex("", "nonce"))
    }
}
