package com.termbridge.android.peer

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

class PeerArtifactCryptoTest {
    @Test
    fun `decrypts an authenticated P-256 artifact chunk`() {
        val sender = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
        val salt = ByteArray(32) { (it + 1).toByte() }
        val receiver = PeerArtifactCrypto.receiver(sender.public.encoded, salt)
        val receiverPublic = KeyFactory.getInstance("EC").generatePublic(
            X509EncodedKeySpec(receiver.publicKeyBytes),
        )
        val agreement = KeyAgreement.getInstance("ECDH")
        agreement.init(sender.private)
        agreement.doPhase(receiverPublic, true)
        val key = hkdf(agreement.generateSecret(), salt)
        val id = "artifact-test"
        val offset = 98_304L
        val plaintext = "verified apk bytes".toByteArray()
        val iv = ByteArray(12) { (it + 11).toByte() }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        cipher.updateAAD("termbridge-artifact-v1:$id:$offset:${plaintext.size}".toByteArray())
        val encrypted = cipher.doFinal(plaintext)

        assertArrayEquals(
            plaintext,
            PeerArtifactCrypto.decrypt(receiver.key, id, offset, plaintext.size, iv, encrypted),
        )
        assertThrows(AEADBadTagException::class.java) {
            PeerArtifactCrypto.decrypt(receiver.key, id, 0, plaintext.size, iv, encrypted)
        }
    }

    @Test
    fun `encrypts a selected photo chunk with authenticated offsets`() {
        val sender = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"))
        }.generateKeyPair()
        val salt = ByteArray(32) { (it + 1).toByte() }
        val receiver = PeerArtifactCrypto.receiver(sender.public.encoded, salt)
        val plaintext = "selected photo bytes".toByteArray()
        val iv = ByteArray(12) { (it + 7).toByte() }
        val encrypted = PeerArtifactCrypto.encrypt(receiver.key, "asset-1", 512, plaintext, iv)

        assertArrayEquals(
            plaintext,
            PeerArtifactCrypto.decrypt(
                receiver.key,
                "asset-1",
                512,
                plaintext.size,
                iv,
                encrypted,
            ),
        )
    }

    private fun hkdf(input: ByteArray, salt: ByteArray): ByteArray {
        val extract = Mac.getInstance("HmacSHA256")
        extract.init(SecretKeySpec(salt, "HmacSHA256"))
        val pseudorandomKey = extract.doFinal(input)
        val expand = Mac.getInstance("HmacSHA256")
        expand.init(SecretKeySpec(pseudorandomKey, "HmacSHA256"))
        expand.update("termbridge-artifact-v1".toByteArray())
        expand.update(1.toByte())
        return expand.doFinal()
    }
}
