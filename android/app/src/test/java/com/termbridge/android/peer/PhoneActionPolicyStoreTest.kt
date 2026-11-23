package com.termbridge.android.peer

import org.junit.Assert.assertEquals
import org.junit.Test

class PhoneActionPolicyStoreTest {
    private val grant = PhoneActionConversationGrant("conversation-1", "calendar.create", "nonce", 1L)

    @Test
    fun `each policy has one unambiguous decision`() {
        assertEquals(PhoneActionAuthorizationDecision.REQUIRE_APPROVAL,
            PhoneActionAuthorization.decide(PhoneActionApprovalPolicy.ALWAYS, "conversation-1", "calendar.create", grant))
        assertEquals(PhoneActionAuthorizationDecision.ALLOW,
            PhoneActionAuthorization.decide(PhoneActionApprovalPolicy.ALLOW, "conversation-1", "calendar.create", null))
        assertEquals(PhoneActionAuthorizationDecision.DENY,
            PhoneActionAuthorization.decide(PhoneActionApprovalPolicy.DENY, "conversation-1", "calendar.create", grant))
    }

    @Test
    fun `conversation approval only matches the exact conversation and tool`() {
        assertEquals(PhoneActionAuthorizationDecision.ALLOW,
            PhoneActionAuthorization.decide(PhoneActionApprovalPolicy.ONCE_PER_CONVERSATION,
                "conversation-1", "calendar.create", grant))
        assertEquals(PhoneActionAuthorizationDecision.REQUIRE_APPROVAL,
            PhoneActionAuthorization.decide(PhoneActionApprovalPolicy.ONCE_PER_CONVERSATION,
                "conversation-2", "calendar.create", grant))
        assertEquals(PhoneActionAuthorizationDecision.REQUIRE_APPROVAL,
            PhoneActionAuthorization.decide(PhoneActionApprovalPolicy.ONCE_PER_CONVERSATION,
                "conversation-1", "calendar.list", grant))
    }

    @Test
    fun `low risk count and speaker actions default to automatic approval`() {
        assertEquals(PhoneActionApprovalPolicy.ALLOW, PhoneActionPolicyStore.defaultPolicy("call.speaker.set"))
        assertEquals(PhoneActionApprovalPolicy.ALLOW, PhoneActionPolicyStore.defaultPolicy("photo.count"))
        assertEquals(PhoneActionApprovalPolicy.ALWAYS, PhoneActionPolicyStore.defaultPolicy("photo.fetch"))
        assertEquals(PhoneActionApprovalPolicy.ALWAYS, PhoneActionPolicyStore.defaultPolicy("calendar.create"))
    }
}
