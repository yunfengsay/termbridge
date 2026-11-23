package com.termbridge.android.content

import android.content.res.Configuration
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.URLSpan
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.noties.markwon.core.spans.StrongEmphasisSpan
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Tests the renderer used by Global messages, not a second Markdown parser. */
@RunWith(AndroidJUnit4::class)
class ArtifactMarkdownTest {
    @Test fun globalReplyRendersEmphasisListsQuotesAndLinks() = render(false) { renderer, view ->
        renderer.bind(view, "记录里：\n\n- 发给 **termbridge-voice**\n- 第二条\n\n> 引用\n\n[查看结果](https://example.com/report.md)")
        val text = view.text as Spanned
        assertFalse(text.toString().contains("**"))
        assertTrue(text.getSpans(0, text.length, StrongEmphasisSpan::class.java).isNotEmpty())
        assertTrue(text.getSpans(0, text.length, URLSpan::class.java).any { it.url == "https://example.com/report.md" })
        assertTrue(text.getSpans(0, text.length, Any::class.java).any { it.javaClass.simpleName.contains("Bullet") })
        assertTrue(text.getSpans(0, text.length, Any::class.java).any { it.javaClass.simpleName.contains("BlockQuote") })
    }

    @Test fun fencedCodeUsesSyntaxColorsInBothThemes() {
        for (dark in listOf(false, true)) render(dark) { renderer, view ->
            renderer.bind(view, "```javascript\nconst answer = 42; // comment\n```\n\nInline `answer`.")
            val text = view.text as Spanned
            assertFalse(text.toString().contains("```"))
            assertTrue(text.toString().contains("const answer = 42;"))
            assertTrue("Code tokens must have colors", text.getSpans(0, text.length, ForegroundColorSpan::class.java).isNotEmpty())
        }
    }

    @Test fun unknownCodeLanguageKeepsTextAndRebindingDropsOldFormatting() = render(false) { renderer, view ->
        renderer.bind(view, "```unsupported-fixture\nvalue <tag> & 42\n```")
        assertTrue(view.text.toString().contains("value <tag> & 42"))
        renderer.bind(view, "**旧回复**")
        renderer.bind(view, "新回复")
        assertEquals("新回复", view.text.toString())
        val text = view.text as Spanned
        assertTrue(text.getSpans(0, text.length, StrongEmphasisSpan::class.java).isEmpty())
    }

    private fun render(dark: Boolean, block: (ArtifactMarkdown, TextView) -> Unit) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val original = instrumentation.targetContext
            val config = Configuration(original.resources.configuration).apply {
                uiMode = (uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
                    (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
            }
            val context = original.createConfigurationContext(config)
            ArtifactMarkdown(context, { error("No external image loading in this test") }, {}).use { renderer ->
                block(renderer, TextView(context))
            }
        }
    }
}
