package com.termbridge.android.security

import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object Hmac {
    fun sha256Hex(secret: String, message: String): String {
        if (secret.isEmpty()) return ""
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(message.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }
}
