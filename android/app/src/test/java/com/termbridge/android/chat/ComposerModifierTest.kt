package com.termbridge.android.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComposerModifierTest {
    @Test
    fun anArmedModifierTurnsTheNextLetterIntoAChord() {
        assertEquals("ctrl-a", ComposerModifier.keyFor("ctrl", "", "a", usable = true))
        assertEquals("alt-b", ComposerModifier.keyFor("alt", "hello", "hellob", usable = true))
        // Case is normalised; the Host names keys in lower case.
        assertEquals("ctrl-c", ComposerModifier.keyFor("ctrl", "", "C", usable = true))
    }

    /**
     * The chain that lost a character: armed while connected, connection drops,
     * the user types. Taking the letter out of the draft and then failing to
     * send it would leave them with neither.
     */
    @Test
    fun aLetterTypedAfterTheGrantWentStaysAsText() {
        assertNull(ComposerModifier.keyFor("ctrl", "", "a", usable = false))
        assertNull(ComposerModifier.keyFor("alt", "hello", "hellob", usable = false))
    }

    @Test
    fun ordinaryEditingIsNeverAChord() {
        // Nothing armed.
        assertNull(ComposerModifier.keyFor(null, "", "a", usable = true))
        // A paste, not a keystroke.
        assertNull(ComposerModifier.keyFor("ctrl", "", "hello", usable = true))
        // A deletion.
        assertNull(ComposerModifier.keyFor("ctrl", "ab", "a", usable = true))
        // An IME replacing a candidate word rather than appending.
        assertNull(ComposerModifier.keyFor("ctrl", "ni", "你", usable = true))
        // Punctuation and digits are not in the Host's key set.
        assertNull(ComposerModifier.keyFor("ctrl", "", "1", usable = true))
        assertNull(ComposerModifier.keyFor("alt", "", "，", usable = true))
    }
}
