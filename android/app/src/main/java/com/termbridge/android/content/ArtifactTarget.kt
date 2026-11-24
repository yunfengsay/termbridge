package com.termbridge.android.content

import java.net.URI

/** Navigation data, never commands. Local paths always require a Host session. */
data class ArtifactTarget(val location: String, val remote: Boolean) {
    val extension: String get() = location.substringBefore('?').substringBefore('#').substringAfterLast('.', "").lowercase()
    val image: Boolean get() = extension in setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "heic", "heif", "avif")
    val svg: Boolean get() = extension == "svg"
    val html: Boolean get() = extension in setOf("html", "htm")
    val pdf: Boolean get() = extension == "pdf"
    val video: Boolean get() = extension in setOf("mp4", "webm", "mov", "m4v", "mkv", "3gp")
    val audio: Boolean get() = extension in setOf("mp3", "wav", "m4a", "ogg", "aac", "flac", "opus")
    val markdown: Boolean get() = extension in setOf("md", "markdown", "mdown")

    companion object {
        fun parse(value: String, base: String? = null): ArtifactTarget? = runCatching {
            val raw = value.trim()
            if (raw.isEmpty() || raw.length > 4096 || raw.any { it.code < 32 || it.code == 127 } || '\\' in raw) return null
            val uri = URI(raw.replace(" ", "%20"))
            if (uri.scheme != null) {
                if (uri.scheme.lowercase() !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.userInfo != null) return null
                return ArtifactTarget(uri.toASCIIString(), true)
            }
            if (raw.startsWith("//") || raw.startsWith('#')) return null
            if (base != null && base.startsWith("https://")) return parse(URI(base).resolve(uri).toASCIIString())
            val local = uri.path?.replace(Regex(":\\d+(?::\\d+)?$"), "") ?: return null
            if (local.any { it.code < 32 || it.code == 127 } || '\\' in local || local.startsWith("//")) return null
            val resolved = if (base != null && !local.startsWith('/') && !local.startsWith("~/")) {
                base.substringBeforeLast('/', "").let { if (it.isEmpty()) local else "$it/$local" }
            } else local
            ArtifactTarget(resolved, false)
        }.getOrNull()
    }
}
