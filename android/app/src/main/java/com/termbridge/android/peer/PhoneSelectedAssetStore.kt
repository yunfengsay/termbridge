package com.termbridge.android.peer

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

data class PhoneSelectedAsset(
    val assetId: String,
    val name: String,
    val mime: String,
    val size: Long,
    val sha256: String,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "assetId" to assetId,
        "name" to name,
        "mime" to mime,
        "size" to size,
        "sha256" to sha256,
    )

    fun toJson(): JSONObject = JSONObject(toMap())

    /** Epochs and byte counts cross the JS protocol boundary as numbers, not MessagePack int64/bigint. */
    fun toWireMap(): Map<String, Any?> = toMap() + ("size" to size.toDouble())

    companion object {
        fun fromJson(json: JSONObject) = PhoneSelectedAsset(
            assetId = json.getString("assetId"),
            name = json.getString("name"),
            mime = json.getString("mime"),
            size = json.getLong("size"),
            sha256 = json.getString("sha256"),
        )
    }
}

class PhoneSelectedAssetStore(private val context: Context) {
    private val root = File(context.filesDir, "phone-selected-assets")

    fun import(
        actionId: String,
        uris: List<Uri>,
        maxItems: Int,
        isCancelled: () -> Boolean = { false },
    ): List<PhoneSelectedAsset> {
        require(safeId(actionId)) { "invalid phone action id" }
        val selected = uris.distinct().take(maxItems.coerceIn(1, PhoneActionRequest.MAX_PHOTO_SELECTION))
        require(selected.isNotEmpty()) { "no photos were selected" }
        cleanupExpired()
        val actionDirectory = File(root, actionId)
        actionDirectory.mkdirs()
        var total = 0L
        return try {
            selected.map { uri ->
                if (isCancelled()) throw android.os.OperationCanceledException()
                val assetId = UUID.randomUUID().toString()
                val display = metadata(uri)
                val target = File(actionDirectory, "$assetId.data")
                val digest = MessageDigest.getInstance("SHA-256")
                var written = 0L
                context.contentResolver.openInputStream(uri)?.use { input ->
                    target.outputStream().buffered().use { output ->
                        val buffer = ByteArray(COPY_BUFFER_BYTES)
                        while (true) {
                            if (isCancelled()) throw android.os.OperationCanceledException()
                            val count = input.read(buffer)
                            if (count < 0) break
                            written += count
                            total += count
                            require(written <= MAX_ASSET_BYTES) { "one selected photo is too large" }
                            require(total <= MAX_ACTION_BYTES) { "selected photos are too large" }
                            digest.update(buffer, 0, count)
                            output.write(buffer, 0, count)
                        }
                    }
                } ?: error("the selected photo is unavailable")
                require(written > 0) { "the selected photo is empty" }
                val asset = PhoneSelectedAsset(
                    assetId = assetId,
                    name = display.first,
                    mime = context.contentResolver.getType(uri)?.take(128) ?: "image/*",
                    size = written,
                    sha256 = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) },
                )
                File(actionDirectory, "$assetId.json").writeText(asset.toJson().toString())
                asset
            }
        } catch (error: Throwable) {
            actionDirectory.deleteRecursively()
            throw error
        }
    }

    /** Imports app-produced image bytes into the same opaque, encrypted-pull asset boundary as Photo Picker. */
    fun importBytes(actionId: String, name: String, mime: String, bytes: ByteArray): PhoneSelectedAsset {
        require(safeId(actionId)) { "invalid phone action id" }
        require(bytes.isNotEmpty()) { "captured image is empty" }
        require(bytes.size.toLong() <= MAX_ASSET_BYTES) { "captured image is too large" }
        cleanupExpired()
        val actionDirectory = File(root, actionId).apply { mkdirs() }
        val assetId = UUID.randomUUID().toString()
        val safeName = name
            .replace(Regex("[\\p{Cc}/\\\\]+"), "_")
            .trim()
            .take(160)
            .ifBlank { "screen-capture.png" }
        val asset = PhoneSelectedAsset(
            assetId = assetId,
            name = safeName,
            mime = mime.take(128).ifBlank { "image/png" },
            size = bytes.size.toLong(),
            sha256 = MessageDigest.getInstance("SHA-256").digest(bytes)
                .joinToString("") { "%02x".format(it.toInt() and 0xff) },
        )
        return try {
            File(actionDirectory, "$assetId.data").writeBytes(bytes)
            File(actionDirectory, "$assetId.json").writeText(asset.toJson().toString())
            asset
        } catch (error: Throwable) {
            actionDirectory.deleteRecursively()
            throw error
        }
    }

    fun read(args: Map<String, Any?>): Map<String, Any?> {
        val actionId = args.requiredSafeId("actionId")
        val assetId = args.requiredSafeId("assetId")
        val offset = (args["offset"] as? Number)?.toLong()?.coerceAtLeast(0L) ?: 0L
        val length = ((args["length"] as? Number)?.toInt() ?: DEFAULT_READ_BYTES).coerceIn(1, MAX_READ_BYTES)
        val directory = File(root, actionId)
        val metadataFile = File(directory, "$assetId.json")
        val dataFile = File(directory, "$assetId.data")
        require(metadataFile.isFile && dataFile.isFile) { "selected photo asset was not found" }
        val asset = PhoneSelectedAsset.fromJson(JSONObject(metadataFile.readText()))
        require(offset <= dataFile.length()) { "asset offset is out of range" }
        val bytes = ByteArray(minOf(length.toLong(), dataFile.length() - offset).toInt())
        RandomAccessFile(dataFile, "r").use { file ->
            file.seek(offset)
            if (bytes.isNotEmpty()) file.readFully(bytes)
        }
        require(bytes.isNotEmpty()) { "selected photo is already at EOF" }
        val crypto = PeerArtifactCrypto.receiver(
            args.requiredString("clientPublicKey"),
            args.requiredString("salt"),
        )
        val nextOffset = offset + bytes.size
        return asset.toMap() + mapOf(
            "actionId" to actionId,
            "offset" to offset,
            "nextOffset" to nextOffset,
            "eof" to (nextOffset == dataFile.length()),
            "encrypted" to true,
            "phonePublicKey" to crypto.publicKey,
        ) + PeerArtifactCrypto.encrypt(crypto.key, assetId, offset, bytes)
    }

    fun delete(args: Map<String, Any?>): Map<String, Any?> {
        val actionId = args.requiredSafeId("actionId")
        val deleted = File(root, actionId).takeIf(File::exists)?.deleteRecursively() ?: false
        return mapOf("actionId" to actionId, "deleted" to deleted)
    }

    private fun metadata(uri: Uri): Pair<String, Long?> {
        var name: String? = null
        var size: Long? = null
        context.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (nameIndex >= 0) name = cursor.getString(nameIndex)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
            }
        }
        val safeName = name
            ?.replace(Regex("[\\p{Cc}/\\\\]+"), "_")
            ?.trim()
            ?.take(160)
            ?.takeIf(String::isNotBlank)
            ?: "selected-photo"
        return safeName to size
    }

    private fun cleanupExpired() {
        val cutoff = System.currentTimeMillis() - RETENTION_MS
        root.listFiles()?.filter { it.lastModified() < cutoff }?.forEach(File::deleteRecursively)
    }

    private fun Map<String, Any?>.requiredSafeId(name: String): String {
        val value = (this[name] as? String)?.trim().orEmpty()
        require(safeId(value)) { "invalid $name" }
        return value
    }

    private fun Map<String, Any?>.requiredString(name: String): String =
        (this[name] as? String)?.takeIf(String::isNotBlank) ?: error("missing $name")

    private fun safeId(value: String): Boolean = value.length in 1..128 && SAFE_ID.matches(value)

    companion object {
        val SAFE_ID = Regex("^[a-zA-Z0-9._-]+$")
        const val COPY_BUFFER_BYTES = 64 * 1024
        const val DEFAULT_READ_BYTES = 64 * 1024
        const val MAX_READ_BYTES = 96 * 1024
        const val MAX_ASSET_BYTES = 40L * 1024 * 1024
        const val MAX_ACTION_BYTES = 200L * 1024 * 1024
        const val RETENTION_MS = 24L * 60 * 60 * 1_000
        const val RETENTION_SECONDS = RETENTION_MS / 1_000
    }
}
