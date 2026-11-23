package com.termbridge.android

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ComposerEditorActionHandlerTest {
    @Test
    fun `send action invokes composer submission`() {
        var submissions = 0
        val handler = ComposerEditorActionHandler { submissions += 1 }

        assertTrue(handler.onEditorAction(actionId = 4, sendActionId = 4))
        assertTrue(submissions == 1)
    }

    @Test
    fun `non-send action remains available to the editor`() {
        var submissions = 0
        val handler = ComposerEditorActionHandler { submissions += 1 }

        assertFalse(handler.onEditorAction(actionId = 0, sendActionId = 4))
        assertTrue(submissions == 0)
    }
}
