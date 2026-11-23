package com.termbridge.android.chat

/**
 * What a letter typed while Ctrl or Alt is armed should become.
 *
 * Separated from the screen because the order matters and is easy to get wrong:
 * the character may only leave the draft once the key has actually been handed
 * to the socket. Deciding first, sending second and editing the text last is
 * what stops a lost connection from eating what the user typed.
 */
object ComposerModifier {
    /**
     * @param armed "ctrl", "alt", or null when neither button is held
     * @param usable whether a key can be delivered on this subscription now
     * @return the key to send, or null when the character is just text
     */
    fun keyFor(armed: String?, before: String, after: String, usable: Boolean): String? {
        if (armed == null) return null
        // Exactly one character appended. A paste, a deletion or an IME
        // replacing a candidate word is ordinary editing, not a chord.
        if (after.length != before.length + 1 || !after.startsWith(before)) return null
        val typed = after.last().lowercaseChar()
        if (typed !in 'a'..'z') return null
        // The modifier may have been armed while connected and pressed after the
        // connection went. The letter stays; the caller disarms.
        if (!usable) return null
        return "$armed-$typed"
    }
}
