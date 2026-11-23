package com.termbridge.android.brain

import org.junit.Assert.*
import org.junit.Test

class DictationDraftTest {
    @Test fun `partial revisions replace rather than duplicate and pauses do not send`() {
        val draft = DictationDraft("已写的前文", "发送")
        assertFalse(draft.accept("最近", false))
        assertFalse(draft.accept("最近的 Agent", false))
        assertEquals("已写的前文 最近的 Agent", draft.text)
        assertFalse(draft.accept("最近的 Agent", true))
        assertFalse(draft.accept("在做什么", true))
        assertEquals("已写的前文 最近的 Agent 在做什么", draft.text)
    }
    @Test fun `keyword only submits on final transcript and is removed from the draft`() {
        val draft = DictationDraft("", "提交任务")
        assertFalse(draft.accept("查看项目，提交任务", false))
        assertTrue(draft.accept("查看项目，提交任务。", true))
        assertEquals("查看项目", draft.text)
    }
    @Test fun `empty command and keyword in the middle do not submit`() {
        val draft = DictationDraft("", "发送")
        assertFalse(draft.accept("发送", true))
        assertFalse(draft.accept("发送请求的逻辑有问题", true))
        assertTrue(draft.accept("发送", true))
        assertEquals("发送请求的逻辑有问题", draft.text)
    }
}
