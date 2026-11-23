package com.termbridge.android.terminal

import java.net.URI

object ExternalLinkPolicy {
    fun allow(value: String): String? {
        if (value.isBlank() || value.length > 4_096) return null
        return runCatching {
            val uri = URI(value)
            val scheme = uri.scheme?.lowercase()
            value.takeIf {
                (scheme == "http" || scheme == "https") &&
                    !uri.host.isNullOrBlank() &&
                    uri.userInfo == null
            }
        }.getOrNull()
    }
}
