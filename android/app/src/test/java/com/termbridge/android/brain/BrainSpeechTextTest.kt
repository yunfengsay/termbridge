package com.termbridge.android.brain

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Test

class BrainSpeechTextTest {
    @Test
    fun removesMarkdownAndUrlsBeforeSpeaking() {
        assertEquals(
            "Result details code block done.",
            BrainSpeechText.normalize("## Result [details](https://example.com)\n```sh\necho nope\n``` done."),
        )
    }

    @Test
    fun choosesChineseVoiceWhenTextContainsHanCharacters() {
        assertEquals(Locale.SIMPLIFIED_CHINESE, BrainSpeechText.localeFor("任务完成了"))
        assertEquals(Locale.US, BrainSpeechText.localeFor("Task completed"))
    }
}
