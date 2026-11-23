package com.termbridge.android.terminal

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ExternalLinkPolicyTest {
    @Test
    fun `allows only credential-free web links`() {
        assertEquals("https://example.com/docs", ExternalLinkPolicy.allow("https://example.com/docs"))
        assertNull(ExternalLinkPolicy.allow("file:///data/local/private"))
        assertNull(ExternalLinkPolicy.allow("javascript:alert(1)"))
        assertNull(ExternalLinkPolicy.allow("https://user:secret@example.com/private"))
    }
}
