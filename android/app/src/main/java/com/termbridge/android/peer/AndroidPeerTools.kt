package com.termbridge.android.peer

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import android.util.Log
import com.termbridge.android.protocol.ControlMessage
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.Executors

data class PeerToolResult(
    val ok: Boolean,
    val exit: Int? = null,
    val stdout: String? = null,
    val stderr: String? = null,
    val data: Map<String, Any?>? = null,
    val error: String? = null,
)

object AndroidPeerTools {
    @Volatile private var artifactStore: PeerArtifactStore? = null
    @Volatile private var selectedAssetStore: PhoneSelectedAssetStore? = null
    @Volatile private var photoPublishStore: PhonePhotoPublishStore? = null
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "termbridge-peer-tools").apply { isDaemon = true }
    }

    fun execute(context: Context, message: ControlMessage, callback: (PeerToolResult) -> Unit) {
        val id = message.string("id")
        val op = message.string("op")
        if (id.isNullOrBlank() || op.isNullOrBlank()) {
            callback(PeerToolResult(false, error = "invalid Android peer tool request"))
            return
        }
        @Suppress("UNCHECKED_CAST")
        val args = message.fields["args"] as? Map<String, Any?> ?: emptyMap()
        worker.execute {
            val result = runCatching { dispatch(context.applicationContext, op, args) }
                .getOrElse { PeerToolResult(false, error = it.message ?: it.javaClass.simpleName) }
            Log.i("TermbridgePeer", "$op -> ${if (result.ok) "ok" else "denied: ${result.error}"}")
            callback(result)
        }
    }

    private fun dispatch(context: Context, op: String, args: Map<String, Any?>): PeerToolResult {
        val artifacts = artifactStore(context)
        return when (op) {
            "info" -> PeerToolResult(
                true,
                data = mapOf(
                    "platform" to "android",
                    "manufacturer" to Build.MANUFACTURER,
                    "model" to Build.MODEL,
                    "sdk" to Build.VERSION.SDK_INT,
                    "exposed" to true,
                    "exec" to false,
                    "fs" to "off",
                    "capabilities" to listOf(
                        "android.logcat.app",
                        "android.logcat.system.optional",
                        "artifact.apk.e2ee",
                        "android.packageInstaller.userConfirmed",
                        "phone.actions.alarm",
                        "phone.actions.calendar",
                        "phone.actions.todo",
                        "phone.actions.status",
                        "phone.actions.audio",
                        "phone.actions.screen.capture.consented",
                        "phone.photos.count.metadata-only",
                        "phone.photos.fetch.bounded",
                        "phone.photos.selected.multiple",
                        "phone.asset.read.e2ee",
                        "phone.photos.edited.publish.e2ee",
                    ),
                ),
            )
            "android.logcat" -> logcat(context, args)
            "artifact.begin" -> PeerToolResult(true, data = artifacts.begin(args))
            "artifact.chunk" -> PeerToolResult(true, data = artifacts.append(args))
            "artifact.commit" -> PeerToolResult(true, data = artifacts.commit(args))
            "artifact.delete" -> PeerToolResult(true, data = artifacts.delete(args))
            "android.install_apk" -> {
                val artifactId = args.string("artifactId")
                PeerToolResult(true, data = PeerApkInstaller.install(context, artifactId, artifacts.committedApk(artifactId)))
            }
            "android.install_status" -> {
                val artifactId = args.string("artifactId")
                PeerToolResult(true, data = PeerInstallState.read(context, artifactId))
            }
            "phone.action" -> PeerToolResult(true, data = PhoneActionCoordinator.submit(context, args).toMap())
            "phone.action.status" -> PeerToolResult(true, data = PhoneActionCoordinator.status(context, args).toMap())
            "phone.action.cancel" -> PeerToolResult(true, data = PhoneActionCoordinator.cancel(context, args).toMap())
            "phone.asset.read" -> PeerToolResult(true, data = selectedAssets(context).read(args))
            "phone.asset.delete" -> PeerToolResult(true, data = selectedAssets(context).delete(args))
            "phone.photo.publish.begin" -> PeerToolResult(true, data = photoPublisher(context).begin(args))
            "phone.photo.publish.chunk" -> PeerToolResult(true, data = photoPublisher(context).append(args))
            "phone.photo.publish.commit" -> PeerToolResult(true, data = photoPublisher(context).commit(args))
            "phone.photo.publish.abort" -> PeerToolResult(true, data = photoPublisher(context).abort(args))
            "exec", "fs.read", "fs.write", "fs.ls", "fs.stat" -> PeerToolResult(
                false,
                error = "Android exposes only allowlisted native tools; arbitrary shell and filesystem access are disabled",
            )
            else -> PeerToolResult(false, error = "unsupported Android peer tool: $op")
        }
    }

    private fun artifactStore(context: Context): PeerArtifactStore =
        artifactStore ?: synchronized(this) {
            artifactStore ?: PeerArtifactStore(context.applicationContext).also { artifactStore = it }
        }

    private fun selectedAssets(context: Context): PhoneSelectedAssetStore =
        selectedAssetStore ?: synchronized(this) {
            selectedAssetStore ?: PhoneSelectedAssetStore(context.applicationContext).also { selectedAssetStore = it }
        }

    private fun photoPublisher(context: Context): PhonePhotoPublishStore =
        photoPublishStore ?: synchronized(this) {
            photoPublishStore ?: PhonePhotoPublishStore(context.applicationContext).also { photoPublishStore = it }
        }

    private fun logcat(context: Context, args: Map<String, Any?>): PeerToolResult {
        val lines = ((args["lines"] as? Number)?.toInt() ?: 200).coerceIn(1, 2_000)
        val level = (args["level"] as? String)?.uppercase()?.takeIf { it in LOG_LEVELS } ?: "V"
        val system = args["scope"] == "system"
        if (system && context.checkSelfPermission(Manifest.permission.READ_LOGS) != PackageManager.PERMISSION_GRANTED) {
            return PeerToolResult(
                false,
                error = "system logcat needs one local bootstrap: adb shell pm grant ${context.packageName} android.permission.READ_LOGS",
            )
        }
        val command = mutableListOf("/system/bin/logcat", "-d", "-v", "threadtime", "-t", lines.toString())
        if (!system) command += "--pid=${Process.myPid()}"
        command += "*:$level"
        val process = ProcessBuilder(command).redirectErrorStream(true).start()
        val captured = process.inputStream.use(::readLogOutput)
        val exit = process.waitFor()
        return PeerToolResult(
            ok = exit == 0,
            exit = exit,
            data = mapOf(
                "scope" to if (system) "system" else "app",
                "text" to captured.first.toString(Charsets.UTF_8),
                "bytes" to captured.second,
                "truncated" to (captured.second > captured.first.size),
            ),
            error = if (exit == 0) null else "logcat exited with $exit",
        )
    }

    private fun readLogOutput(input: InputStream): Pair<ByteArray, Int> {
        val kept = ByteArrayOutputStream(MAX_LOG_BYTES)
        val buffer = ByteArray(8 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            val remaining = MAX_LOG_BYTES - kept.size()
            if (remaining > 0) kept.write(buffer, 0, minOf(read, remaining))
            total += read
        }
        return kept.toByteArray() to total
    }

    private fun Map<String, Any?>.string(name: String): String =
        (this[name] as? String)?.takeIf(String::isNotBlank) ?: error("missing $name")

    private val LOG_LEVELS = setOf("V", "D", "I", "W", "E", "F")
    private const val MAX_LOG_BYTES = 1024 * 1024
}
