package com.termbridge.android.peer

import android.content.Context
import org.json.JSONObject
import java.util.UUID

enum class PhoneActionApprovalPolicy(val wireName: String) {
    ALWAYS("always"),
    ONCE_PER_CONVERSATION("conversation"),
    ALLOW("allow"),
    DENY("deny");

    companion object {
        fun fromWire(value: String?): PhoneActionApprovalPolicy =
            entries.firstOrNull { it.wireName == value } ?: ALWAYS
    }
}

data class PhoneActionConversationGrant(
    val conversationId: String,
    val action: String,
    val nonce: String,
    val issuedAt: Long,
)

enum class PhoneActionAuthorizationDecision { REQUIRE_APPROVAL, ALLOW, DENY }

object PhoneActionAuthorization {
    fun decide(
        policy: PhoneActionApprovalPolicy,
        conversationId: String,
        action: String,
        grant: PhoneActionConversationGrant?,
    ): PhoneActionAuthorizationDecision = when (policy) {
        PhoneActionApprovalPolicy.ALWAYS -> PhoneActionAuthorizationDecision.REQUIRE_APPROVAL
        PhoneActionApprovalPolicy.ALLOW -> PhoneActionAuthorizationDecision.ALLOW
        PhoneActionApprovalPolicy.DENY -> PhoneActionAuthorizationDecision.DENY
        PhoneActionApprovalPolicy.ONCE_PER_CONVERSATION -> if (
            grant?.conversationId == conversationId && grant.action == action && grant.nonce.isNotBlank()
        ) {
            PhoneActionAuthorizationDecision.ALLOW
        } else {
            PhoneActionAuthorizationDecision.REQUIRE_APPROVAL
        }
    }
}

/** App-private approval policy and opaque grants; neither is sent through Relay. */
class PhoneActionPolicyStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences(STORE, Context.MODE_PRIVATE)

    fun policy(action: String): PhoneActionApprovalPolicy {
        val stored = preferences.getString(policyKey(action), null)
        return if (stored == null) defaultPolicy(action) else PhoneActionApprovalPolicy.fromWire(stored)
    }

    @Synchronized
    fun setPolicy(action: String, policy: PhoneActionApprovalPolicy) {
        require(action in PhoneActionRequest.actions) { "unsupported phone action" }
        preferences.edit().putString(policyKey(action), policy.wireName).apply()
        revokeGrants(action)
    }

    fun decision(request: PhoneActionRequest): PhoneActionAuthorizationDecision = PhoneActionAuthorization.decide(
        policy(request.action),
        request.conversationId,
        request.action,
        grant(request.conversationId, request.action),
    )

    @Synchronized
    fun grantConversation(request: PhoneActionRequest): PhoneActionConversationGrant {
        require(policy(request.action) == PhoneActionApprovalPolicy.ONCE_PER_CONVERSATION)
        val grant = PhoneActionConversationGrant(
            request.conversationId,
            request.action,
            UUID.randomUUID().toString(),
            System.currentTimeMillis(),
        )
        preferences.edit().putString(
            grantKey(request.conversationId, request.action),
            JSONObject().apply {
                put("conversationId", grant.conversationId)
                put("action", grant.action)
                put("nonce", grant.nonce)
                put("issuedAt", grant.issuedAt)
            }.toString(),
        ).apply()
        pruneGrants()
        return grant
    }

    @Synchronized
    fun revokeGrants(action: String? = null) {
        preferences.edit().also { editor ->
            preferences.all.keys.filter { key ->
                key.startsWith(GRANT_PREFIX) && (action == null || key.endsWith(":$action"))
            }.forEach(editor::remove)
        }.apply()
    }

    private fun grant(conversationId: String, action: String): PhoneActionConversationGrant? {
        val raw = preferences.getString(grantKey(conversationId, action), null) ?: return null
        return runCatching {
            val json = JSONObject(raw)
            PhoneActionConversationGrant(
                json.getString("conversationId"),
                json.getString("action"),
                json.getString("nonce"),
                json.getLong("issuedAt"),
            )
        }.getOrNull()?.takeIf { System.currentTimeMillis() - it.issuedAt <= GRANT_RETENTION_MS }
    }

    private fun pruneGrants() {
        val cutoff = System.currentTimeMillis() - GRANT_RETENTION_MS
        preferences.edit().also { editor ->
            preferences.all.filterKeys { it.startsWith(GRANT_PREFIX) }.forEach { (key, raw) ->
                val issuedAt = runCatching { JSONObject(raw as String).getLong("issuedAt") }.getOrDefault(0L)
                if (issuedAt < cutoff) editor.remove(key)
            }
        }.apply()
    }

    private fun policyKey(action: String) = "$POLICY_PREFIX$action"
    private fun grantKey(conversationId: String, action: String) = "$GRANT_PREFIX$conversationId:$action"

    companion object {
        const val STORE = "phone_action_policies"
        const val POLICY_PREFIX = "policy:"
        const val GRANT_PREFIX = "grant:"
        const val GRANT_RETENTION_MS = 7L * 24 * 60 * 60 * 1_000
        internal fun defaultPolicy(action: String): PhoneActionApprovalPolicy =
            if (action == "call.speaker.set" || action == "photo.count") {
                PhoneActionApprovalPolicy.ALLOW
            } else {
                PhoneActionApprovalPolicy.ALWAYS
            }
    }
}
