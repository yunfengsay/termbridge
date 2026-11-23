package com.termbridge.android.brain

import android.os.Bundle
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.snackbar.Snackbar
import com.termbridge.android.R
import com.termbridge.android.peer.PhoneActionPolicyRows
import com.termbridge.android.peer.PhoneActionPolicyStore
import com.termbridge.android.ui.applyWindowInsets

class BrainToolsActivity : AppCompatActivity() {
    private lateinit var policyStore: PhoneActionPolicyStore

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_brain_tools)
        applyWindowInsets(findViewById(R.id.brainToolsRoot))
        findViewById<MaterialToolbar>(R.id.brainToolsToolbar).setNavigationOnClickListener { finish() }
        policyStore = PhoneActionPolicyStore(this)
        renderCatalog()
    }

    private fun renderCatalog() {
        val container = findViewById<LinearLayout>(R.id.brainToolList)
        val empty = findViewById<TextView>(R.id.brainToolsEmpty)
        val tools = BrainToolCatalogState.snapshot().sortedByDescending { it.name == "phone_action" }
        empty.visibility = if (tools.isEmpty()) View.VISIBLE else View.GONE
        tools.forEach { tool ->
            val row = layoutInflater.inflate(R.layout.item_brain_tool, container, false)
            row.findViewById<TextView>(R.id.brainToolName).text = tool.label
            row.findViewById<TextView>(R.id.brainToolMeta).text = listOfNotNull(
                getString(if (tool.execution == "worker") R.string.brain_tool_worker else R.string.brain_tool_direct),
                getString(R.string.brain_tool_category, tool.category),
                getString(R.string.brain_tool_name, tool.name),
            ).joinToString(" · ")
            row.findViewById<TextView>(R.id.brainToolDescription).text = tool.description
            row.findViewById<TextView>(R.id.brainToolApproval).apply {
                visibility = if (tool.approval == "device") View.VISIBLE else View.GONE
                setText(R.string.brain_tool_device_approval)
            }
            row.findViewById<View>(R.id.brainToolPolicySection).visibility =
                if (tool.name == "phone_action") View.VISIBLE else View.GONE
            if (tool.name == "phone_action") {
                val policyList = row.findViewById<LinearLayout>(R.id.phoneActionPolicyList)
                PhoneActionPolicyRows.render(this, layoutInflater, policyList, policyStore)
                row.findViewById<MaterialButton>(R.id.revokeConversationApprovalsButton).setOnClickListener {
                    policyStore.revokeGrants()
                    Snackbar.make(policyList, R.string.phone_action_revoke_done, Snackbar.LENGTH_SHORT).show()
                }
            }
            container.addView(row)
        }
    }
}
