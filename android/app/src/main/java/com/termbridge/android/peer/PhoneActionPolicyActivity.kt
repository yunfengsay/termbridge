package com.termbridge.android.peer

import android.os.Bundle
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.appbar.MaterialToolbar
import com.google.android.material.button.MaterialButton
import com.google.android.material.snackbar.Snackbar
import com.termbridge.android.R
import com.termbridge.android.ui.applyWindowInsets

/** One explicit, phone-owned policy surface for every native action. */
class PhoneActionPolicyActivity : AppCompatActivity() {
    private lateinit var store: PhoneActionPolicyStore
    private lateinit var container: LinearLayout

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_phone_action_policies)
        applyWindowInsets(findViewById(R.id.phoneActionPolicyRoot))
        store = PhoneActionPolicyStore(this)
        container = findViewById(R.id.phoneActionPolicyList)
        findViewById<MaterialToolbar>(R.id.phoneActionPolicyToolbar).setNavigationOnClickListener { finish() }
        findViewById<MaterialButton>(R.id.revokeConversationApprovalsButton).setOnClickListener {
            store.revokeGrants()
            Snackbar.make(container, R.string.phone_action_revoke_done, Snackbar.LENGTH_SHORT).show()
        }
        render()
    }

    private fun render() {
        PhoneActionPolicyRows.render(this, layoutInflater, container, store)
    }
}
