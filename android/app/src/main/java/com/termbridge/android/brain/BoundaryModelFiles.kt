package com.termbridge.android.brain

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Version-pinned public weights. Download only after an explicit settings/preparation tap. */
class BoundaryModelFiles(context: Context) {
    val directory = File(context.noBackupFilesDir, "boundary-sensevoice-2024")
    private val marker get() = File(directory, "verified-$REVISION")

    fun isReady(): Boolean = marker.isFile && files.all { File(directory, it.name).length() == it.bytes }

    fun verify(): Boolean = files.all {
        val file = File(directory, it.name)
        file.isFile && file.length() == it.bytes && digest(file) == it.sha256
    }

    fun install(progress: (Int) -> Unit) = synchronized(lock) {
        directory.mkdirs()
        if (verify()) { marker.writeText(REVISION); progress(100); return@synchronized }
        val total = files.sumOf { it.bytes }
        var completed = 0L
        for (entry in files) {
            val target = File(directory, entry.name)
            if (target.isFile && target.length() == entry.bytes && digest(target) == entry.sha256) {
                completed += entry.bytes
                continue
            }
            val temporary = File(directory, "${entry.name}.download")
            val connection = URL("$BASE/${entry.name}").openConnection() as HttpURLConnection
            connection.connectTimeout = 15_000
            connection.readTimeout = 30_000
            try {
                check(connection.responseCode == 200) { "Model download HTTP ${connection.responseCode}" }
                var received = 0L
                connection.inputStream.use { input -> temporary.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        check(!Thread.currentThread().isInterrupted) { "Model download cancelled" }
                        val count = input.read(buffer)
                        if (count < 0) break
                        received += count
                        check(received <= entry.bytes) { "Model download exceeds expected size" }
                        output.write(buffer, 0, count)
                        progress(((completed + received) * 100 / total).toInt())
                    }
                } }
                check(temporary.length() == entry.bytes && digest(temporary) == entry.sha256) { "Model checksum mismatch" }
                check(temporary.renameTo(target)) { "Could not activate verified model" }
                completed += entry.bytes
            } finally {
                connection.disconnect()
                temporary.delete()
            }
        }
        check(verify()) { "Model verification failed" }
        marker.writeText(REVISION)
        progress(100)
    }

    companion object {
        const val REVISION = "2365baeacb507f821a0c8120fcee3d484dba7a07"
        private const val BASE = "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/$REVISION"
        private val lock = Any()
        private data class Artifact(val name: String, val bytes: Long, val sha256: String)
        private val files = listOf(
            Artifact("model.int8.onnx", 239233841, "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51"),
            Artifact("tokens.txt", 315894, "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc"),
        )
        private fun digest(file: File): String {
            val hash = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) { val count = input.read(buffer); if (count < 0) break; hash.update(buffer, 0, count) }
            }
            return hash.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
