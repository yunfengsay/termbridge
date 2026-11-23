package com.termbridge.android.review

import android.content.Context
import android.content.res.Configuration
import android.util.LruCache

internal class ReviewSyntaxHighlighter(context: Context) {
    private val highlighter = ReviewPrismFactory.create(
        context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES,
    )
    private val cache = LruCache<String, CharSequence>(CACHE_SIZE)

    fun highlight(path: String, code: String): CharSequence {
        val language = ReviewLanguage.forPath(path) ?: return code
        val key = "$language\u0000$code"
        return cache.get(key) ?: runCatching { highlighter.highlight(language, code) }
            .getOrDefault(code)
            .also { cache.put(key, it) }
    }

    private companion object {
        const val CACHE_SIZE = 768
    }
}

internal object ReviewLanguage {
    fun forPath(path: String): String? {
        val name = path.substringAfterLast('/').lowercase()
        return when {
            name == "dockerfile" -> "makefile"
            name == "makefile" || name.endsWith(".mk") -> "makefile"
            name == ".gitignore" || name == ".gitattributes" || name == ".gitmodules" -> "git"
            name.endsWith(".gradle") || name.endsWith(".gradle.kts") -> "groovy"
            else -> when (name.substringAfterLast('.', missingDelimiterValue = "")) {
                "c", "h" -> "c"
                "cc", "cpp", "cxx", "hpp" -> "cpp"
                "cs" -> "csharp"
                "css", "scss" -> "css"
                "dart" -> "dart"
                "go" -> "go"
                "groovy" -> "groovy"
                "java" -> "java"
                "js", "jsx", "mjs", "cjs", "ts", "tsx" -> "javascript"
                "json", "jsonc" -> "json"
                "kt", "kts" -> "kotlin"
                "md", "mdx" -> "markdown"
                "html", "htm", "xml", "svg" -> "markup"
                "py" -> "python"
                "scala" -> "scala"
                "sql" -> "sql"
                "swift" -> "swift"
                "yaml", "yml" -> "yaml"
                else -> null
            }
        }
    }
}
