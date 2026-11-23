package com.termbridge.android.peer

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.provider.MediaStore
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap

/** Receives Agent-edited images and publishes new, app-owned copies to the system gallery. */
class PhonePhotoPublishStore(private val context: Context) {
    private data class Upload(
        val id: String,
        val actionId: String,
        val name: String,
        val mime: String,
        val size: Long,
        val sha256: String,
        val index: Int,
        val total: Int,
        val file: File,
        val key: ByteArray,
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256"),
        var nextOffset: Long = 0,
    )

    private val root = File(context.cacheDir, "phone-edited-assets")
    private val uploads = ConcurrentHashMap<String, Upload>()
    private val results = context.getSharedPreferences(RESULT_STORE, Context.MODE_PRIVATE)

    fun begin(args: Map<String, Any?>): Map<String, Any?> {
        require(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            "publishing edited photos requires Android 10 or newer"
        }
        val actionId = args.safeId("actionId")
        val request = PhoneActionStore(context).load(actionId) ?: error("photo action is no longer active")
        val selection = PhoneActionStore(context).result(actionId)
        require(request.action in setOf("photo.edit", "photo.fetch") && selection?.state == "running") {
            "photo action is not waiting for edited output"
        }
        val id = args.safeId("id")
        val mime = args.string("mime").lowercase()
        require(mime in MIME_TYPES) { "unsupported edited photo type" }
        val size = args.long("size")
        require(size in 1..MAX_ASSET_BYTES) { "edited photo size is outside the accepted range" }
        val sha256 = args.string("sha256").lowercase()
        require(SHA256.matches(sha256)) { "invalid edited photo SHA-256" }
        val index = args.int("index")
        val total = args.int("total")
        require(total in 1..PhoneActionRequest.MAX_PHOTO_SELECTION && index in 0 until total) {
            "invalid edited photo batch position"
        }
        if (index == 0) clearOutputResults(actionId)
        root.mkdirs()
        require(root.isDirectory && root.usableSpace > size + MIN_FREE_BYTES) {
            "not enough phone storage for edited photo"
        }
        val receiver = PeerArtifactCrypto.receiver(args.string("senderPublicKey"), args.string("salt"))
        val file = File(root, "$id.part")
        file.delete()
        file.createNewFile()
        uploads.remove(id)?.file?.delete()
        uploads[id] = Upload(
            id = id,
            actionId = actionId,
            name = safeName(args.string("name"), mime),
            mime = mime,
            size = size,
            sha256 = sha256,
            index = index,
            total = total,
            file = file,
            key = receiver.key,
        )
        return mapOf(
            "id" to id,
            "actionId" to actionId,
            "receiverPublicKey" to receiver.publicKey,
            "chunkBytes" to MAX_CHUNK_BYTES,
            "encrypted" to true,
        )
    }

    fun append(args: Map<String, Any?>): Map<String, Any?> {
        val id = args.safeId("id")
        val upload = uploads[id] ?: error("edited photo upload is not active; restart the upload")
        val offset = args.long("offset")
        require(offset == upload.nextOffset) { "edited photo chunk offset mismatch" }
        val plainBytes = args.int("plainBytes")
        require(plainBytes in 1..MAX_CHUNK_BYTES && offset + plainBytes <= upload.size) {
            "edited photo chunk is outside the accepted range"
        }
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
        return mapOf("id" to id, "received" to upload.nextOffset, "size" to upload.size)
    }

    fun commit(args: Map<String, Any?>): Map<String, Any?> {
        val id = args.safeId("id")
        val upload = uploads.remove(id) ?: error("edited photo upload is not active")
        try {
            require(upload.nextOffset == upload.size) { "edited photo upload is incomplete" }
            val actual = upload.digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
            require(actual == upload.sha256) { "edited photo SHA-256 verification failed" }
            val output = publish(upload)
            val completed = rememberOutput(upload, output)
            if (completed != null) finishAction(upload.actionId, completed)
            return output + mapOf(
                "actionId" to upload.actionId,
                "index" to upload.index,
                "total" to upload.total,
                "batchComplete" to (completed != null),
            )
        } finally {
            upload.file.delete()
        }
    }

    fun abort(args: Map<String, Any?>): Map<String, Any?> {
        val id = args.safeId("id")
        val deleted = uploads.remove(id)?.file?.delete() ?: File(root, "$id.part").delete()
        return mapOf("id" to id, "deleted" to deleted)
    }

    private fun publish(upload: Upload): Map<String, Any?> {
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, uniqueName(upload.name))
            put(MediaStore.Images.Media.MIME_TYPE, upload.mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/TermBridge")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val resolver = context.contentResolver
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
            ?: error("could not create an edited photo in the gallery")
        return try {
            resolver.openOutputStream(uri, "w")?.use { output -> upload.file.inputStream().use { it.copyTo(output) } }
                ?: error("could not open the edited gallery photo")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
            mapOf(
                "name" to values.getAsString(MediaStore.Images.Media.DISPLAY_NAME),
                "mime" to upload.mime,
                "size" to upload.size,
                "sha256" to upload.sha256,
                "uri" to uri.toString(),
            )
        } catch (error: Throwable) {
            resolver.delete(uri, null, null)
            throw error
        }
    }

    @Synchronized
    private fun rememberOutput(upload: Upload, output: Map<String, Any?>): List<Map<String, Any?>>? {
        results.edit().putString(resultKey(upload.actionId, upload.index), JSONObject(output).toString()).apply()
        val outputs = (0 until upload.total).mapNotNull { index ->
            results.getString(resultKey(upload.actionId, index), null)?.let { JSONObject(it).toMap() }
        }
        return outputs.takeIf { it.size == upload.total }
    }

    private fun finishAction(actionId: String, outputs: List<Map<String, Any?>>) {
        val store = PhoneActionStore(context)
        val request = store.load(actionId) ?: return
        val selection = store.result(actionId)
        val result = PhoneActionResult(
            actionId,
            request.action,
            "completed",
            "已保存 ${outputs.size} 张编辑后的照片到相册",
            mapOf(
                "selectedCount" to ((selection?.data?.get("selectedCount") as? Number)?.toInt() ?: outputs.size),
                "outputCount" to outputs.size,
                "outputs" to outputs,
            ),
        )
        store.complete(result)
        PhoneSelectedAssetStore(context).delete(mapOf("actionId" to actionId))
        clearOutputResults(actionId)
        PhoneActionOutbox.enqueue(
            context,
            PhoneActionEvent.create(
                request,
                AndroidPeerIdentity.deviceId(context),
                result.state,
                result.summary,
                result.data,
            ),
        )
    }

    private fun uniqueName(name: String): String {
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        return "${base.take(100)}-TermBridge-${System.currentTimeMillis()}$extension"
    }

    private fun safeName(value: String, mime: String): String {
        val extension = when (mime) {
            "image/png" -> ".png"
            "image/webp" -> ".webp"
            else -> ".jpg"
        }
        val cleaned = value.replace(Regex("[\\p{Cc}/\\\\]+"), "_").trim().take(120)
        return cleaned.takeIf { it.endsWith(extension, ignoreCase = true) } ?: "${cleaned.ifBlank { "edited-photo" }}$extension"
    }

    private fun resultKey(actionId: String, index: Int) = "output:$actionId:$index"

    private fun clearOutputResults(actionId: String) {
        val prefix = "output:$actionId:"
        results.edit().also { editor ->
            results.all.keys.filter { it.startsWith(prefix) }.forEach(editor::remove)
        }.apply()
    }

    private fun Map<String, Any?>.string(name: String): String =
        (this[name] as? String)?.trim()?.takeIf(String::isNotBlank) ?: error("missing $name")

    private fun Map<String, Any?>.safeId(name: String): String = string(name).also {
        require(SAFE_ID.matches(it)) { "invalid $name" }
    }

    private fun Map<String, Any?>.long(name: String): Long =
        (this[name] as? Number)?.toLong() ?: error("missing $name")

    private fun Map<String, Any?>.int(name: String): Int =
        (this[name] as? Number)?.toInt() ?: error("missing $name")

    private companion object {
        val SAFE_ID = Regex("^[a-zA-Z0-9._-]{1,128}$")
        val SHA256 = Regex("^[a-f0-9]{64}$")
        val MIME_TYPES = setOf("image/jpeg", "image/png", "image/webp")
        const val MAX_CHUNK_BYTES = 128 * 1024
        const val MAX_ASSET_BYTES = 40L * 1024 * 1024
        const val MIN_FREE_BYTES = 32L * 1024 * 1024
        const val RESULT_STORE = "phone_photo_publish"
    }
}
