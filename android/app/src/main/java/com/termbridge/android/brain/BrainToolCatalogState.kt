package com.termbridge.android.brain

import com.termbridge.android.protocol.BrainToolDescriptorInfo

/** Process-local projection of the latest Host-authoritative tool registry. */
object BrainToolCatalogState {
    @Volatile private var tools: List<BrainToolDescriptorInfo> = emptyList()

    fun update(next: List<BrainToolDescriptorInfo>) {
        tools = next.toList()
    }

    fun snapshot(): List<BrainToolDescriptorInfo> = tools.toList()
}
