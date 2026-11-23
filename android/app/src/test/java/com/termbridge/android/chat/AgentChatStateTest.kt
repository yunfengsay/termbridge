package com.termbridge.android.chat

import org.junit.Assert.*
import org.junit.Test

class AgentChatStateTest {
    @Test fun defaultAndUnknownPreferencesStayAutomatic() {
        assertEquals(SessionUi.AUTO, SessionUi.from(null))
        assertEquals(SessionUi.AUTO, SessionUi.from("unknown"))
        assertEquals(SessionUi.CHAT, SessionUi.from("chat"))
        assertEquals(SessionUi.TERMINAL, SessionUi.from("terminal"))
    }

    @Test fun receiptsRequireRequestAndGeneration() {
        val draft = AgentChatDraft().apply { text = "hello"; begin("one", 2) }
        assertFalse(draft.receipt("one", 1, "observed", null))
        assertFalse(draft.receipt("another", 2, "observed", null))
        assertTrue(draft.pending)
        assertTrue(draft.receipt("one", 2, "delivered", null))
        assertFalse(draft.receipt("one", 2, "accepted", null))
        assertEquals("delivered", draft.state)
        assertTrue(draft.receipt("one", 2, "observed", null))
        assertFalse(draft.pending)
    }

    @Test fun aReceiptDoesNotEraseTheNextDraft() {
        val draft = AgentChatDraft().apply { text = "first"; begin("one", 1); text = "next" }
        draft.receipt("one", 1, "observed", null)
        assertEquals("next", draft.text)
        assertFalse(draft.receipt("one", 1, "failed", "late failure"))
    }

    @Test fun interruptedSendIsUncertainAndCannotBeRetriedAutomatically() {
        val draft = AgentChatDraft().apply { text = "work"; begin("one", 1) }
        draft.disconnected("unknown")
        assertEquals("uncertain", draft.state)
        assertFalse(draft.pending)
        assertFalse(draft.retryable)
        assertEquals("", draft.text)
        assertEquals("work", draft.submittedText())
        assertFalse(draft.receipt("one", 1, "delivered", null))
    }

    @Test fun rejectedSendRestoresOnlyAnEmptyComposer() {
        val draft = AgentChatDraft().apply { text = "work"; begin("one", 1) }
        draft.receipt("one", 1, "failed", "not written")
        assertTrue(draft.retryable)
        assertEquals("work", draft.text)
        draft.begin("two", 1); draft.text = "next"
        draft.receipt("two", 1, "failed", null)
        assertEquals("next", draft.text)
    }

    @Test fun identicalTextHasDifferentReceiptOwnership() {
        val draft = AgentChatDraft().apply { text = "same"; begin("one", 1) }
        draft.receipt("one", 1, "observed", null)
        draft.text = "same"; draft.begin("two", 1)
        assertFalse(draft.receipt("one", 1, "observed", null))
        assertTrue(draft.pending)
    }

    @Test fun hostAndSessionDraftsAreSeparate() {
        val a = AgentChatDrafts.get("a", "test-session")
        val b = AgentChatDrafts.get("b", "test-session")
        val c = AgentChatDrafts.get("a", "test-other")
        a.text = "a"; b.text = "b"; c.text = "c"
        assertEquals("a", AgentChatDrafts.get("a", "test-session").text)
        assertEquals("b", b.text)
        assertEquals("c", c.text)
    }

    @Test fun oldConnectionAndOldPaginationCannotChangeCurrentView() {
        val epoch = AgentChatEpoch()
        val first = epoch.nextConnection()
        val generation = epoch.nextSubscription()
        assertTrue(epoch.accepts(first, "a", "a", generation))
        assertFalse(epoch.accepts(first, "b", "a", generation))
        epoch.nextSubscription()
        assertFalse(epoch.accepts(first, "a", "a", generation))
        epoch.nextConnection()
        assertFalse(epoch.accepts(first, "a", "a", epoch.generation))
    }
}
