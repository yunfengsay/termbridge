package com.termbridge.android.brain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceSendCommandTest {
    @Test
    fun `only treats trailing keyword as send command`() {
        val result = VoiceSendCommand.parse("汇总所有 Agent 的状态，发送。")
        assertTrue(result.shouldSend)
        assertEquals("汇总所有 Agent 的状态", result.text)
    }

    @Test
    fun `does not send when keyword is part of the dictated request`() {
        val result = VoiceSendCommand.parse("先不要发送这封邮件")
        assertFalse(result.shouldSend)
        assertEquals("先不要发送这封邮件", result.text)
    }

    @Test
    fun `keyword alone sends accumulated text`() {
        val result = VoiceSendCommand.parse("发送")
        assertTrue(result.shouldSend)
        assertEquals("", result.text)
        assertEquals("上一句", VoiceSendCommand.append("上一句", result.text))
    }

    @Test
    fun `custom keyword replaces default keyword`() {
        val result = VoiceSendCommand.parse("查看所有任务，完成", "完成")
        assertTrue(result.shouldSend)
        assertEquals("查看所有任务", result.text)
        assertFalse(VoiceSendCommand.parse("查看所有任务，发送", "完成").shouldSend)
    }
}
