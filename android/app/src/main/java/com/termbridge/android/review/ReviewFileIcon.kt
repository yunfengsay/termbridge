package com.termbridge.android.review

import androidx.annotation.DrawableRes
import com.termbridge.android.R

internal object ReviewFileIcon {
    @DrawableRes
    fun directory(path: String, expanded: Boolean): Int = when {
        path.substringAfterLast('/').lowercase() in SOURCE_DIRECTORIES -> R.drawable.ic_folder_source
        expanded -> R.drawable.ic_folder_open
        else -> R.drawable.ic_folder
    }

    @DrawableRes
    fun file(path: String): Int {
        val name = path.substringAfterLast('/').lowercase()
        return when {
            name == ".gitignore" || name == ".gitattributes" || name == ".gitmodules" -> R.drawable.ic_file_git
            name == "build.gradle" || name == "build.gradle.kts" || name == "settings.gradle" || name == "settings.gradle.kts" -> R.drawable.ic_file_gradle
            else -> when (name.substringAfterLast('.', missingDelimiterValue = "")) {
                "kt", "kts" -> R.drawable.ic_file_kotlin
                "ts", "tsx" -> R.drawable.ic_file_typescript
                "java" -> R.drawable.ic_file_java
                "xml", "html", "htm", "svg" -> R.drawable.ic_file_xml
                "json", "jsonc" -> R.drawable.ic_file_json
                "md", "mdx" -> R.drawable.ic_file_markdown
                "sh", "bash", "zsh", "fish" -> R.drawable.ic_file_shell
                else -> R.drawable.ic_file_default
            }
        }
    }

    private val SOURCE_DIRECTORIES = setOf("src", "source", "sources")
}
