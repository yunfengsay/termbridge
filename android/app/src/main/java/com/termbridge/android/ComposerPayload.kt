package com.termbridge.android

/**
 * The message a composer actually sends: the draft plus one reference per
 * uploaded image.
 *
 * The two views differ in exactly one way, and it is not cosmetic. The terminal
 * writes raw bytes into a pty, where an embedded newline *is* Enter, so a
 * multi-line draft would submit itself line by line; it collapses whitespace
 * for that reason. The chat view delivers through Herdr's bracketed paste,
 * which carries the text as one block, so it must keep the draft byte for byte
 * — collapsing it there turns pasted Python or YAML into a single broken line.
 */
object ComposerPayload {
    /** Keep Return outside paste framing so fast input cannot absorb it as text. */
    fun submitBytes(text: ByteArray, bracketedPaste: Boolean): ByteArray =
        if (bracketedPaste) "\u001b[200~".toByteArray() + text + "\u001b[201~\r".toByteArray()
        else text + byteArrayOf(0x0d)

    private val whitespace = Regex("\\s+")

    /** For the terminal: one line, because the destination submits on newline. */
    fun build(draft: String, attachmentPaths: List<String>): String =
        join(draft.trim().replace(whitespace, " "), attachmentPaths)

    /**
     * For the chat view: the draft exactly as typed or pasted, to the byte.
     *
     * Nothing is trimmed. Leading spaces are the first line's indentation and
     * trailing ones can be significant too — inside a fence, in Markdown, in a
     * here-doc. An IME sometimes leaves a space behind, which is not a licence
     * to edit what the user wrote. A draft that is only whitespace is still
     * dropped, because that is an empty message rather than content.
     */
    fun buildVerbatim(draft: String, attachmentPaths: List<String>): String =
        join(draft, attachmentPaths)

    private fun join(draft: String, attachmentPaths: List<String>): String =
        buildList {
            draft.takeIf(String::isNotBlank)?.let(::add)
            attachmentPaths.forEach { path ->
                path.trim().takeIf(String::isNotBlank)?.let { add("[Image: $it]") }
            }
        }.joinToString(" ")
}
