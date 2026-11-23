package com.termbridge.android.update

import java.io.File
import java.io.InputStream
import java.net.URI
import java.security.MessageDigest

internal const val RELEASE_ORIGIN = "https://termbridge-a0k.pages.dev"
internal const val MAX_APK_BYTES = 200L * 1024 * 1024

internal data class UpdateArtifact(
    val version: String, val versionCode: Long, val minSdk: Int,
    val url: String, val size: Long, val sha256: String,
) {
    init {
        require(version.matches(Regex("[0-9A-Za-z.+_-]{1,64}"))) { "Invalid release version" }
        require(versionCode in 1..Int.MAX_VALUE.toLong() && minSdk in 24..100) { "Invalid Android version metadata" }
        require(size in 1..MAX_APK_BYTES && sha256.matches(Regex("[a-f0-9]{64}"))) { "Invalid release checksum or size" }
        val uri = URI(url)
        require(uri.scheme == "https" && uri.host == URI(RELEASE_ORIGIN).host && uri.port == -1 &&
            uri.userInfo == null && uri.fragment == null &&
            uri.rawPath.matches(Regex("/download/[A-Za-z0-9._-]+\\.apk"))) { "Untrusted APK URL" }
    }

    fun newerThan(installed: Long, sdk: Int): Boolean = versionCode > installed && sdk >= minSdk
}

internal data class UpdatePackageIdentity(val name: String, val version: String?, val code: Long, val signers: Set<String>)

internal fun verifyUpdateIdentity(release: UpdateArtifact, installed: UpdatePackageIdentity, candidate: UpdatePackageIdentity) {
    require(candidate.name == installed.name) { "APK belongs to another app" }
    require(candidate.code == release.versionCode && candidate.version == release.version) { "APK version does not match release" }
    require(candidate.code > installed.code) { "Update is not newer than installed app" }
    require(installed.signers.isNotEmpty() && installed.signers == candidate.signers) { "APK signing certificate differs; refusing update" }
}

/** Bounded streaming verification; never buffer the full APK or accept a partial download. */
internal fun copyVerifiedApk(input: InputStream, output: File, artifact: UpdateArtifact, progress: (Int) -> Unit) {
    val hash = MessageDigest.getInstance("SHA-256")
    var total = 0L
    var previous = -1
    try {
        output.outputStream().use { sink ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                if (Thread.currentThread().isInterrupted) throw InterruptedException("Download cancelled")
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                require(total <= artifact.size) { "APK exceeds declared size" }
                sink.write(buffer, 0, count)
                hash.update(buffer, 0, count)
                val percent = (total * 100 / artifact.size).toInt()
                if (percent != previous) { previous = percent; progress(percent) }
            }
        }
        require(total == artifact.size) { "Incomplete APK download" }
        require(hash.digest().joinToString("") { "%02x".format(it) } == artifact.sha256) { "APK checksum mismatch" }
    } catch (error: Exception) {
        output.delete()
        throw error
    }
}
