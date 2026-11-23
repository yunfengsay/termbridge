package com.termbridge.android.peer

import android.content.Context
import android.view.LayoutInflater
import android.widget.LinearLayout
import android.widget.RadioGroup
import android.widget.TextView
import com.termbridge.android.R

/** Shared renderer for the four-state approval control shown in Global Settings. */
object PhoneActionPolicyRows {
    fun render(
        context: Context,
        inflater: LayoutInflater,
        container: LinearLayout,
        store: PhoneActionPolicyStore,
    ) {
        container.removeAllViews()
        PhoneActionRequest.actions.forEach { action ->
            val row = inflater.inflate(R.layout.item_phone_action_policy, container, false)
            row.findViewById<TextView>(R.id.phoneActionPolicyName).text = phoneActionLabel(context, action)
            row.findViewById<RadioGroup>(R.id.phoneActionPolicyChoices).apply {
                check(buttonId(store.policy(action)))
                setOnCheckedChangeListener { _, checkedId ->
                    policyForButton(checkedId)?.let { store.setPolicy(action, it) }
                }
            }
            container.addView(row)
        }
    }

    private fun buttonId(policy: PhoneActionApprovalPolicy): Int = when (policy) {
        PhoneActionApprovalPolicy.ALWAYS -> R.id.phoneActionPolicyAlways
        PhoneActionApprovalPolicy.ONCE_PER_CONVERSATION -> R.id.phoneActionPolicyConversation
        PhoneActionApprovalPolicy.ALLOW -> R.id.phoneActionPolicyAllow
        PhoneActionApprovalPolicy.DENY -> R.id.phoneActionPolicyDeny
    }

    private fun policyForButton(id: Int): PhoneActionApprovalPolicy? = when (id) {
        R.id.phoneActionPolicyAlways -> PhoneActionApprovalPolicy.ALWAYS
        R.id.phoneActionPolicyConversation -> PhoneActionApprovalPolicy.ONCE_PER_CONVERSATION
        R.id.phoneActionPolicyAllow -> PhoneActionApprovalPolicy.ALLOW
        R.id.phoneActionPolicyDeny -> PhoneActionApprovalPolicy.DENY
        else -> null
    }
}
