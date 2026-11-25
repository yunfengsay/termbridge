package com.termbridge.android.content

import java.net.URI

/** Navigation data, never commands. Local paths always require a Host session. */
data class ArtifactTarget(
    val location: String,
    val remote: Boolean,
    val line: Int? = null,
    val endLine: Int? = null,
) {
    val extension: String get() = location.substringBefore('?').substringBefore('#').substringAfterLast('.', "").lowercase()
    val image: Boolean get() = extension in setOf("png", "jpg", "jpeg", "webp", "gif", "bmp", "ico", "heic", "heif", "avif")
    val svg: Boolean get() = extension == "svg"
    val html: Boolean get() = extension in setOf("html", "htm")
    val pdf: Boolean get() = extension == "pdf"
    val video: Boolean get() = extension in setOf("mp4", "webm", "mov", "m4v", "mkv", "3gp")
    val audio: Boolean get() = extension in setOf("mp3", "wav", "m4a", "ogg", "aac", "flac", "opus")
    val markdown: Boolean get() = extension in setOf("md", "markdown", "mdown")

    companion object {
        private val COLON_LINE_SUFFIX = Regex(":(\\d+)(?::\\d+)?(?:-(\\d+)(?::\\d+)?)?$")
        private val HASH_LINE_SUFFIX = Regex("#L(\\d+)(?:C\\d+)?(?:-L?(\\d+)(?:C\\d+)?)?$", RegexOption.IGNORE_CASE)

        fun parse(value: String, base: String? = null): ArtifactTarget? = runCatching {
            val raw = value.trim()
            if (raw.isEmpty() || raw.length > 4096 || raw.any { it.code < 32 || it.code == 127 } || '\\' in raw) return null
            if (raw.startsWith("http://", ignoreCase = true) || raw.startsWith("https://", ignoreCase = true)) {
                val uri = URI(raw.replace(" ", "%20"))
                if (uri.scheme?.lowercase() !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.userInfo != null) return null
                return ArtifactTarget(uri.toASCIIString(), true)
            }
            if (raw.startsWith("//") || raw.startsWith('#')) return null

            var stripped = raw
            var line: Int? = null
            var endLine: Int? = null
            val hashMatch = HASH_LINE_SUFFIX.find(stripped)
            if (hashMatch != null) {
                line = hashMatch.groupValues[1].toIntOrNull()?.takeIf { it > 0 }
                endLine = hashMatch.groupValues[2].toIntOrNull()?.takeIf { it >= (line ?: 0) }
                stripped = stripped.removeRange(hashMatch.range)
            } else {
                val colonMatch = COLON_LINE_SUFFIX.find(stripped)
                if (colonMatch != null) {
                    line = colonMatch.groupValues[1].toIntOrNull()?.takeIf { it > 0 }
                    endLine = colonMatch.groupValues[2].toIntOrNull()?.takeIf { it >= (line ?: 0) }
                    stripped = stripped.removeRange(colonMatch.range)
                }
            }
            if (stripped.isEmpty()) return null

            val uri = URI(stripped.replace(" ", "%20"))
            if (uri.scheme != null) return null
            if (base != null && base.startsWith("https://")) return parse(URI(base).resolve(uri).toASCIIString())
            val local = uri.path ?: return null
            if (local.any { it.code < 32 || it.code == 127 } || '\\' in local || local.startsWith("//")) return null
            val resolved = if (base != null && !local.startsWith('/') && !local.startsWith("~/")) {
                base.substringBeforeLast('/', "").let { if (it.isEmpty()) local else "$it/$local" }
            } else local
            ArtifactTarget(resolved, false, line, endLine)
        }.getOrNull()
    }
}
