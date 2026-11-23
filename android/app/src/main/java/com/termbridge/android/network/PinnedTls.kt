package com.termbridge.android.network

import android.annotation.SuppressLint
import okhttp3.OkHttpClient
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

object PinnedTls {
    /**
     * Termbridge pins the SHA-256 digest of the whole self-signed certificate, not
     * an SPKI pin. Trust is relaxed only for this client and the exact digest is
     * then checked in the hostname verifier.
     */
    @SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
    fun apply(builder: OkHttpClient.Builder, normalizedFingerprint: String) {
        if (normalizedFingerprint.isBlank()) return
        val trustManager = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        }
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trustManager), SecureRandom())
        builder.sslSocketFactory(context.socketFactory, trustManager)
        builder.hostnameVerifier { _, session ->
            val certificate = runCatching { session.peerCertificates.firstOrNull() as? X509Certificate }.getOrNull()
                ?: return@hostnameVerifier false
            val actual = MessageDigest.getInstance("SHA-256")
                .digest(certificate.encoded)
                .joinToString("") { "%02x".format(it) }
            MessageDigest.isEqual(actual.toByteArray(), normalizedFingerprint.toByteArray())
        }
    }
}
