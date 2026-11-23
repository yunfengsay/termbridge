package com.termbridge.android.desktop

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.termbridge.android.data.ConnectionSettings
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Local-only credentials: Keystore encryption, excluded from backup, bound to the paired endpoint and Host. */
internal class DesktopCredentialStore(context: Context, profile: ConnectionSettings) {
    private val scope = "${profile.endpointKey}\u0000${profile.hostId}".toByteArray()
    private val name = MessageDigest.getInstance("SHA-256").digest(scope).joinToString("") { "%02x".format(it) }
    private val file = AtomicFile(context.noBackupFilesDir.resolve("desktop-login-$name"))
    class Credentials(val username: String, val password: String)

    fun load(): Credentials? = runCatching {
        val bytes = file.readFully()
        require(bytes.size > 29 && bytes[0] == 1.toByte())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 13)))
        cipher.updateAAD(scope)
        val value = JSONObject(String(cipher.doFinal(bytes.copyOfRange(13, bytes.size)), Charsets.UTF_8))
        Credentials(value.getString("username"), value.getString("password"))
    }.getOrNull()

    fun save(value: Credentials) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(scope)
        val payload = JSONObject().put("username", value.username).put("password", value.password).toString().toByteArray()
        val output = file.startWrite()
        try {
            output.write(byteArrayOf(1) + cipher.iv + cipher.doFinal(payload))
            file.finishWrite(output)
        } catch (error: Throwable) { file.failWrite(output); throw error }
        finally { payload.fill(0) }
    }
    fun clear() = file.delete()
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }
    private companion object { const val KEY_ALIAS = "termbridge.desktop-login.v1" }
}
