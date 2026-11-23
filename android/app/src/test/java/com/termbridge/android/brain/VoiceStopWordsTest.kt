package com.termbridge.android.brain

import org.junit.Assert.*
import org.junit.Test

class VoiceStopWordsTest {
    @Test fun `explicit English and Chinese trailing commands close input`() {
        assertEquals("查一下运行的进程", VoiceStopWords.match("查一下运行的进程，OVER。", VoiceStopWords.DEFAULT)?.precedingText)
        assertNotNull(VoiceStopWords.match("说完了！", VoiceStopWords.DEFAULT))
        assertNotNull(VoiceStopWords.match("ｏｖｅｒ", VoiceStopWords.DEFAULT))
    }

    @Test fun `English substrings and quoted discussion are not trailing commands`() {
        for (text in listOf("overflow", "leftover", "takeover", "Over 是什么意思", "把 over 作为停止词", "‘over’")) {
            assertNull(text, VoiceStopWords.match(text, VoiceStopWords.DEFAULT))
        }
    }

    @Test fun `changing configuration removes old stop words`() {
        val words = VoiceStopWords.parse("结束交流, 结束交流, Finish now")
        assertEquals(2, words.size)
        assertNull(VoiceStopWords.match("Over", words))
        assertNotNull(VoiceStopWords.match("查询任务，结束交流", words))
        assertNotNull(VoiceStopWords.match("finish now", words))
    }
}
