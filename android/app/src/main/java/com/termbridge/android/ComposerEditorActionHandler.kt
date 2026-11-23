package com.termbridge.android

class ComposerEditorActionHandler(
    private val submit: () -> Unit,
) {
    fun onEditorAction(actionId: Int, sendActionId: Int): Boolean {
        if (actionId != sendActionId) return false
        submit()
        return true
    }
}
