package com.termbridge.android.brain

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class VoiceProfileStore(context: Context) {
    private val file = AtomicFile(context.noBackupFilesDir.resolve(FILE_NAME))

    fun exists(): Boolean = file.baseFile.isFile

    fun load(): FloatArray? = runCatching {
        val stored = file.readFully()
        require(stored.size > 3 && stored[0] == VERSION)
        val ivSize = stored[1].toInt() and 0xff
        require(ivSize in 12..32 && stored.size > 2 + ivSize)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, stored.copyOfRange(2, 2 + ivSize)),
        )
        VoiceProfileCodec.decode(cipher.doFinal(stored.copyOfRange(2 + ivSize, stored.size)))
    }.getOrNull()

    fun save(embedding: FloatArray) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(VoiceProfileCodec.encode(VoiceEmbedding.normalize(embedding)))
        val stored = byteArrayOf(VERSION, cipher.iv.size.toByte()) + cipher.iv + encrypted
        val output = file.startWrite()
        try {
            output.write(stored)
            file.finishWrite(output)
        } catch (error: Throwable) {
            file.failWrite(output)
            throw error
        }
    }

    fun clear() {
        file.delete()
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    private companion object {
        const val FILE_NAME = "voice-profile.bin"
        const val KEY_ALIAS = "termbridge.voice-profile.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val VERSION: Byte = 1
    }
}

internal object VoiceProfileCodec {
    fun encode(embedding: FloatArray): ByteArray {
        require(embedding.isNotEmpty() && embedding.size <= MAX_DIMENSION)
        return ByteBuffer.allocate(4 + embedding.size * 4)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putInt(embedding.size)
            .also { buffer -> embedding.forEach(buffer::putFloat) }
            .array()
    }

    fun decode(data: ByteArray): FloatArray {
        require(data.size >= 8)
        val buffer = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
        val size = buffer.int
        require(size in 1..MAX_DIMENSION && buffer.remaining() == size * 4)
        return FloatArray(size) { buffer.float }
    }

    private const val MAX_DIMENSION = 2_048
}
