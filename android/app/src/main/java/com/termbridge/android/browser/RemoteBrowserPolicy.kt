package com.termbridge.android.browser

import java.net.URI

/** Decides which links clicked inside a remote Host session should open via the Host's proxy browser. */
object RemoteBrowserPolicy {
    fun shouldIntercept(rawUrl: String): Boolean {
        val uri = parseHttpUri(rawUrl) ?: return false
        val host = uri.host?.trim()?.lowercase()?.removePrefix("[")?.removeSuffix("]") ?: return false
        if (host.isEmpty()) return false
        if (isLoopbackHost(host)) return true
        if (host == "0.0.0.0" || host == "::" || host == "0:0:0:0:0:0:0:0") return true
        if (isPrivateIPv4(host)) return true
        if (host.endsWith(".local") || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".lan")) {
            return true
        }
        // Single-label internal hostnames (e.g. http://mac-mini:8765) have no dot and are not IPv6 literals.
        if (!host.contains('.') && !host.contains(':')) return true
        return false
    }

    /** Normalizes user-typed or terminal-clicked URLs (e.g. 0.0.0.0 -> 127.0.0.1, bare host:port -> http://...). */
    fun normalizeEntryUrl(raw: String): String? {
        val trimmed = raw.trim()
        if (trimmed.isEmpty() || trimmed.length > 4_096) return null
        val candidate = if (trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true)) {
            trimmed
        } else if (!trimmed.contains("://")) {
            "http://$trimmed"
        } else {
            return null
        }
        val uri = parseHttpUri(candidate) ?: return null
        val host = uri.host?.trim()?.lowercase() ?: return null
        val normalizedHost = if (host == "0.0.0.0" || host == "[::]" || host == "::") "127.0.0.1" else uri.host
        return if (normalizedHost == uri.host) {
            candidate
        } else {
            runCatching {
                URI(uri.scheme, uri.userInfo, normalizedHost, uri.port, uri.rawPath, uri.rawQuery, uri.rawFragment).toASCIIString()
            }.getOrDefault(candidate)
        }
    }

    fun isLoopbackHost(host: String): Boolean {
        val lower = host.lowercase().removePrefix("[").removeSuffix("]")
        if (lower == "localhost" || lower == "::1" || lower == "0:0:0:0:0:0:0:1" || lower.endsWith(".localhost")) {
            return true
        }
        val parts = lower.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { it.toIntOrNull() ?: return false }
        return octets.all { it in 0..255 } && octets[0] == 127
    }

    fun isPrivateIPv4(host: String): Boolean {
        val parts = host.split('.')
        if (parts.size != 4) return false
        val octets = parts.map { it.toIntOrNull() ?: return false }
        if (octets.any { it !in 0..255 }) return false
        val (a, b) = octets[0] to octets[1]
        return a == 10 ||
            (a == 172 && b in 16..31) ||
            (a == 192 && b == 168) ||
            (a == 169 && b == 254) ||
            (a == 100 && b in 64..127)
    }

    private fun parseHttpUri(value: String): URI? = runCatching {
        val uri = URI(value.trim())
        val scheme = uri.scheme?.lowercase()
        if ((scheme == "http" || scheme == "https") && !uri.host.isNullOrBlank() && uri.userInfo == null) uri else null
    }.getOrNull()
}
