package com.termbridge.android.update

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.pm.PackageInfoCompat
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

internal class UpdateRepository(private val context: Context) {
    private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(5, TimeUnit.MINUTES).build()
    @Volatile private var active: Call? = null
    private val directory = File(context.cacheDir, "app-updates")

    fun check(): UpdateArtifact {
        val call = http.newCall(Request.Builder().url("$RELEASE_ORIGIN/downloads/manifest.json")
            .header("Cache-Control", "no-cache").build())
        active = call
        try {
            call.execute().use { response ->
                check(response.isSuccessful) { "Release server HTTP ${response.code}" }
                val body = response.body
                val bytes = body.byteStream().use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        require(output.size() + count <= 256 * 1024) { "Release manifest is too large" }
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
                val manifest = JSONObject(bytes.toString(Charsets.UTF_8))
                require(manifest.getInt("schema") == 1) { "Unsupported release manifest" }
                val apk = manifest.getJSONObject("android")
                val url = java.net.URI(RELEASE_ORIGIN).resolve(apk.getString("url")).toString()
                return UpdateArtifact(apk.getString("version"), apk.getLong("versionCode"), apk.getInt("minSdk"),
                    url, apk.getLong("size"), apk.getString("sha256"))
            }
        } finally { active = null }
    }

    fun download(artifact: UpdateArtifact, progress: (Int) -> Unit): File {
        check(directory.isDirectory || directory.mkdirs()) { "Cannot create update cache" }
        // Only files owned by this downloader are removed, never user files or app data.
        directory.listFiles()?.filter { it.name.matches(Regex("[a-f0-9]{64}\\.(apk|part)")) }?.forEach { it.delete() }
        val temporary = File(directory, "${artifact.sha256}.part")
        val destination = File(directory, "${artifact.sha256}.apk")
        val call = http.newCall(Request.Builder().url(artifact.url).build())
        active = call
        try {
            call.execute().use { response ->
                check(response.isSuccessful) { "Download HTTP ${response.code}" }
                response.body.byteStream().use { copyVerifiedApk(it, temporary, artifact, progress) }
            }
            validatePackage(temporary, artifact)
            check(temporary.renameTo(destination)) { "Cannot finalize verified update" }
            return destination
        } finally { active = null; temporary.delete() }
    }

    @Suppress("DEPRECATION")
    fun validatePackage(file: File, artifact: UpdateArtifact) {
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val installed = pm.getPackageInfo(context.packageName, flags)
        val candidate = pm.getPackageArchiveInfo(file.path, flags) ?: error("Invalid APK")
        fun identity(info: PackageInfo) = UpdatePackageIdentity(info.packageName, info.versionName,
            PackageInfoCompat.getLongVersionCode(info), signers(info))
        verifyUpdateIdentity(artifact, identity(installed), identity(candidate))
    }

    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return signatures.orEmpty().map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
        }.toSet()
    }

    fun cancel() { active?.cancel() }
}
