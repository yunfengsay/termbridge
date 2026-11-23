package com.termbridge.android.peer

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

internal class PeerArtifactStore(private val context: Context) {
    private data class Upload(
        val id: String,
        val name: String,
        val size: Long,
        val sha256: String,
        val file: File,
        val key: ByteArray,
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256"),
        var nextOffset: Long = 0,
    )

    private val uploads = ConcurrentHashMap<String, Upload>()
    private val root = File(context.cacheDir, "peer-artifacts")

    fun begin(args: Map<String, Any?>): Map<String, Any?> {
        cleanupExpired()
        val id = args.string("id")
        require(ID.matches(id)) { "invalid artifact id" }
        val name = args.string("name").take(120)
        require(name.endsWith(".apk", ignoreCase = true)) { "only APK artifacts are accepted" }
        val size = args.long("size")
        require(size in 1..MAX_ARTIFACT_BYTES) { "APK size is outside the accepted range" }
        root.mkdirs()
        require(root.isDirectory) { "could not create the private APK cache" }
        require(root.usableSpace > size + MIN_FREE_BYTES) { "not enough phone storage for APK" }
        val sha256 = args.string("sha256").lowercase()
        require(SHA256.matches(sha256)) { "invalid artifact SHA-256" }
        require(args.string("mime") == APK_MIME) { "unsupported artifact type" }
        val receiver = PeerArtifactCrypto.receiver(args.string("senderPublicKey"), args.string("salt"))
        val part = partFile(id)
        part.delete()
        apkFile(id).delete()
        part.createNewFile()
        uploads.remove(id)
        uploads[id] = Upload(id, name, size, sha256, part, receiver.key)
        return mapOf(
            "artifactId" to id,
            "receiverPublicKey" to receiver.publicKey,
            "chunkBytes" to MAX_CHUNK_BYTES,
            "encrypted" to true,
        )
    }

    fun append(args: Map<String, Any?>): Map<String, Any?> {
        val id = args.string("id")
        val upload = uploads[id] ?: error("artifact upload is not active; restart the upload")
        val offset = args.long("offset")
        require(offset == upload.nextOffset) { "artifact chunk offset mismatch" }
        val plainBytes = args.int("plainBytes")
        require(plainBytes in 1..MAX_CHUNK_BYTES) { "artifact chunk is too large" }
        require(offset + plainBytes <= upload.size) { "artifact chunk exceeds declared size" }
        val plaintext = PeerArtifactCrypto.decrypt(
            upload.key,
            upload.id,
            offset,
            plainBytes,
            args.string("iv"),
            args.string("ciphertext"),
        )
        FileOutputStream(upload.file, true).use { it.write(plaintext) }
        upload.digest.update(plaintext)
        upload.nextOffset += plaintext.size
        upload.file.setLastModified(System.currentTimeMillis())
        return mapOf("artifactId" to id, "received" to upload.nextOffset, "size" to upload.size)
    }

    fun commit(args: Map<String, Any?>): Map<String, Any?> {
        val id = args.string("id")
        val upload = uploads.remove(id) ?: error("artifact upload is not active")
        require(upload.nextOffset == upload.size) { "APK upload is incomplete" }
        val actual = upload.digest.digest().joinToString("") { "%02x".format(it) }
        if (actual != upload.sha256) {
            upload.file.delete()
            error("APK SHA-256 verification failed")
        }
        val apk = apkFile(id)
        apk.delete()
        require(upload.file.renameTo(apk)) { "could not finalize APK artifact" }
        return mapOf(
            "artifactId" to id,
            "name" to upload.name,
            "size" to upload.size,
            "sha256" to actual,
            "verified" to true,
        )
    }

    fun delete(args: Map<String, Any?>): Map<String, Any?> {
        val id = args.string("id")
        require(ID.matches(id)) { "invalid artifact id" }
        val activeDeleted = uploads.remove(id)?.file?.delete() == true
        val partDeleted = partFile(id).delete()
        val apkDeleted = apkFile(id).delete()
        val deleted = activeDeleted || partDeleted || apkDeleted
        return mapOf("artifactId" to id, "deleted" to deleted)
    }

    fun committedApk(id: String): File {
        require(ID.matches(id)) { "invalid artifact id" }
        return apkFile(id).also { require(it.isFile && it.length() > 0) { "verified APK artifact not found" } }
    }

    fun removeCommitted(id: String) {
        if (ID.matches(id)) apkFile(id).delete()
    }

    private fun partFile(id: String) = File(root, "$id.part")
    private fun apkFile(id: String) = File(root, "$id.apk")

    private fun cleanupExpired() {
        if (!root.isDirectory) return
        val cutoff = System.currentTimeMillis() - ARTIFACT_TTL_MS
        root.listFiles()?.filter { it.lastModified() < cutoff }?.forEach(File::delete)
    }

    private fun Map<String, Any?>.string(name: String): String =
        (this[name] as? String)?.takeIf(String::isNotBlank) ?: error("missing artifact field $name")

    private fun Map<String, Any?>.long(name: String): Long =
        (this[name] as? Number)?.toLong() ?: error("missing artifact field $name")

    private fun Map<String, Any?>.int(name: String): Int =
        (this[name] as? Number)?.toInt() ?: error("missing artifact field $name")

    companion object {
        const val APK_MIME = "application/vnd.android.package-archive"
        const val MAX_CHUNK_BYTES = 128 * 1024
        const val MAX_ARTIFACT_BYTES = 256L * 1024 * 1024
        private const val MIN_FREE_BYTES = 32L * 1024 * 1024
        private const val ARTIFACT_TTL_MS = 24L * 60 * 60 * 1000
        private val ID = Regex("[a-zA-Z0-9-]{8,80}")
        private val SHA256 = Regex("[a-f0-9]{64}")
    }
}
