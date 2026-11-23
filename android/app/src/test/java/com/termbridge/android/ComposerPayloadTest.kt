package com.termbridge.android

import org.junit.Assert.assertEquals
import org.junit.Test

class ComposerPayloadTest {
    @Test fun submitKeepsReturnOutsideThePasteAndRetainsLegacyTerminalInput() {
        val text = "你好 [Image: /tmp/a.png]"
        assertEquals("\u001b[200~${text}\u001b[201~\r",
            ComposerPayload.submitBytes(text.toByteArray(), true).toString(Charsets.UTF_8))
        assertEquals("${text}\r", ComposerPayload.submitBytes(text.toByteArray(), false).toString(Charsets.UTF_8))
    }

    @Test
    fun combinesNativeDraftAndUploadedImagesIntoOneTerminalPrompt() {
        assertEquals(
            "修一下 这个 bug [Image: /Users/alice/.termbridge/uploads/a.jpg] [Image: /Users/alice/.termbridge/uploads/b.jpg]",
            ComposerPayload.build(
                draft = "  修一下\n这个   bug  ",
                attachmentPaths = listOf(
                    "/Users/alice/.termbridge/uploads/a.jpg",
                    "/Users/alice/.termbridge/uploads/b.jpg",
                ),
            ),
        )
    }

    @Test
    fun supportsAnImageOnlyPrompt() {
        assertEquals(
            "[Image: /tmp/image.jpg]",
            ComposerPayload.build("", listOf("/tmp/image.jpg")),
        )
    }

    // R3 counter-example: the chat view delivers through bracketed paste, where
    // the block arrives whole. Collapsing whitespace there — which the terminal
    // build deliberately does — turns pasted Python into one broken line.
    @Test
    fun theChatBuildKeepsNewlinesIndentationAndRuns() {
        val python = "def main():\n    if x:\n        return  1\n\n    return 2"
        assertEquals(python, ComposerPayload.buildVerbatim(python, emptyList()))
        // The terminal build is the one that must not carry newlines: there a
        // newline is Enter, and the prompt would submit itself line by line.
        assertEquals("def main(): if x: return 1 return 2", ComposerPayload.build(python, emptyList()))
    }

    @Test
    fun theChatBuildAppendsImagesWithoutTouchingTheText() {
        val yaml = "steps:\n  - run: |\n      echo  hi"
        assertEquals(
            "$yaml [Image: /tmp/a.png]",
            ComposerPayload.buildVerbatim(yaml, listOf("/tmp/a.png")),
        )
    }

    // The chat draft is not edited at either end. Trailing whitespace can be
    // content — inside a fence, in Markdown, in a here-doc — and an IME leaving
    // a space behind is not permission to rewrite what the user typed.
    @Test
    fun aChatDraftKeepsBothEndsExactly() {
        assertEquals("    indented   \n", ComposerPayload.buildVerbatim("    indented   \n", emptyList()))
        assertEquals("行尾两个空格  ", ComposerPayload.buildVerbatim("行尾两个空格  ", emptyList()))
        assertEquals("尾部换行\n\n", ComposerPayload.buildVerbatim("尾部换行\n\n", emptyList()))
        // Whitespace alone is an empty message, not content.
        assertEquals("[Image: /tmp/a.png]", ComposerPayload.buildVerbatim("   \n  ", listOf("/tmp/a.png")))
        // The terminal build keeps its own semantics: there a newline is Enter.
        assertEquals("indented", ComposerPayload.build("    indented   \n", emptyList()))
    }
}
