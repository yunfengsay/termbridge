package com.termbridge.android.peer

import android.util.Base64
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal object PeerArtifactCrypto {
    private val info = "termbridge-artifact-v1".toByteArray(StandardCharsets.UTF_8)

    data class Receiver(
        val publicKeyBytes: ByteArray,
        val key: ByteArray,
    ) {
        val publicKey: String get() = Base64.encodeToString(publicKeyBytes, Base64.NO_WRAP)
    }

    fun receiver(senderPublicKey: String, salt: String): Receiver {
        require(senderPublicKey.length in 80..512) { "invalid artifact sender key" }
        require(salt.length in 40..48) { "invalid artifact salt" }
        return receiver(
            Base64.decode(senderPublicKey, Base64.NO_WRAP),
            Base64.decode(salt, Base64.NO_WRAP),
        )
    }

    internal fun receiver(senderPublicKey: ByteArray, salt: ByteArray): Receiver {
        require(senderPublicKey.size in 80..256) { "invalid artifact sender key" }
        require(salt.size == 32) { "artifact salt must be 32 bytes" }
        val sender = KeyFactory.getInstance("EC").generatePublic(
            X509EncodedKeySpec(senderPublicKey),
        )
        val pair = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(pair.private)
        agreement.doPhase(sender, true)
        val shared = agreement.generateSecret()
        val key = hkdf(shared, salt, info, 32)
        return Receiver(
            publicKeyBytes = pair.public.encoded,
            key = key,
        )
    }

    fun decrypt(
        key: ByteArray,
        artifactId: String,
        offset: Long,
        plainBytes: Int,
        iv: String,
        ciphertext: String,
    ): ByteArray {
        require(iv.length in 16..32) { "invalid artifact chunk IV" }
        require(ciphertext.length <= ((plainBytes + 16) * 4 / 3) + 12) { "encrypted artifact chunk is too large" }
        return decrypt(
            key,
            artifactId,
            offset,
            plainBytes,
            Base64.decode(iv, Base64.NO_WRAP),
            Base64.decode(ciphertext, Base64.NO_WRAP),
        )
    }

    internal fun decrypt(
        key: ByteArray,
        artifactId: String,
        offset: Long,
        plainBytes: Int,
        ivBytes: ByteArray,
        ciphertext: ByteArray,
    ): ByteArray {
        require(ivBytes.size == 12) { "artifact chunk IV must be 12 bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, ivBytes),
        )
        cipher.updateAAD(aad(artifactId, offset, plainBytes))
        return cipher.doFinal(ciphertext).also {
            require(it.size == plainBytes) { "artifact chunk length mismatch" }
        }
    }

    fun encrypt(
        key: ByteArray,
        artifactId: String,
        offset: Long,
        plaintext: ByteArray,
    ): Map<String, Any?> {
        require(plaintext.isNotEmpty()) { "artifact chunk is empty" }
        val iv = ByteArray(12).also(SecureRandom()::nextBytes)
        val ciphertext = encrypt(key, artifactId, offset, plaintext, iv)
        return mapOf(
            "iv" to Base64.encodeToString(iv, Base64.NO_WRAP),
            "ciphertext" to Base64.encodeToString(ciphertext, Base64.NO_WRAP),
            "plainBytes" to plaintext.size,
        )
    }

    internal fun encrypt(
        key: ByteArray,
        artifactId: String,
        offset: Long,
        plaintext: ByteArray,
        iv: ByteArray,
    ): ByteArray {
        require(iv.size == 12) { "artifact chunk IV must be 12 bytes" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            GCMParameterSpec(128, iv),
        )
        cipher.updateAAD(aad(artifactId, offset, plaintext.size))
        return cipher.doFinal(plaintext)
    }

    private fun aad(artifactId: String, offset: Long, plainBytes: Int): ByteArray =
        "termbridge-artifact-v1:$artifactId:$offset:$plainBytes".toByteArray(StandardCharsets.UTF_8)

    private fun hkdf(input: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(salt, "HmacSHA256"))
        val pseudorandomKey = extract.doFinal(input)
        val output = ByteArray(length)
        var previous = ByteArray(0)
        var written = 0
        var counter = 1
        while (written < length) {
            val expand = Mac.getInstance("HmacSHA256")
            expand.init(SecretKeySpec(pseudorandomKey, "HmacSHA256"))
            expand.update(previous)
            expand.update(info)
            expand.update(counter.toByte())
            previous = expand.doFinal()
            val take = minOf(previous.size, length - written)
            previous.copyInto(output, written, 0, take)
            written += take
            counter += 1
        }
        return output
    }
}
