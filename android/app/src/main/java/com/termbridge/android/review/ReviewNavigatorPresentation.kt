package com.termbridge.android.review

import com.termbridge.android.protocol.ReviewFileInfo

internal enum class ReviewNavigatorMode { TREE, FLAT }

internal sealed interface ReviewNavigatorRow {
    val key: String
    val depth: Int

    data class Directory(
        val path: String,
        val name: String,
        override val depth: Int,
        val expanded: Boolean,
        val fileCount: Int,
    ) : ReviewNavigatorRow {
        override val key: String = "directory:$path"
    }

    data class File(
        val file: ReviewFileInfo,
        val title: String,
        override val depth: Int,
        val selected: Boolean,
    ) : ReviewNavigatorRow {
        override val key: String = "file:${file.path}"
    }
}

internal object ReviewNavigatorPresentation {
    fun rows(
        files: List<ReviewFileInfo>,
        mode: ReviewNavigatorMode,
        collapsedDirectories: Set<String> = emptySet(),
        selectedPath: String? = null,
    ): List<ReviewNavigatorRow> = when (mode) {
        ReviewNavigatorMode.FLAT -> files.sortedBy { it.path }.map { file ->
            ReviewNavigatorRow.File(file, file.path, depth = 0, selected = file.path == selectedPath)
        }
        ReviewNavigatorMode.TREE -> treeRows(files, collapsedDirectories, selectedPath)
    }

    private fun treeRows(
        files: List<ReviewFileInfo>,
        collapsedDirectories: Set<String>,
        selectedPath: String?,
    ): List<ReviewNavigatorRow> {
        val directories = sortedSetOf<String>()
        val directoryCounts = mutableMapOf<String, Int>()
        files.forEach { file ->
            val parts = file.path.split('/').filter(String::isNotBlank)
            (1 until parts.size).forEach { index ->
                val path = parts.take(index).joinToString("/")
                directories += path
                directoryCounts[path] = (directoryCounts[path] ?: 0) + 1
            }
        }
        val directoryChildren = directories.groupBy(::directoryParent)
        val fileChildren = files.groupBy { directoryParent(it.path) }
        val rows = mutableListOf<ReviewNavigatorRow>()

        fun append(parent: String, depth: Int) {
            directoryChildren[parent].orEmpty().forEach { firstPath ->
                    var path = firstPath
                    val compactNames = mutableListOf(path.substringAfterLast('/'))
                    while (fileChildren[path].isNullOrEmpty()) {
                        val children = directoryChildren[path].orEmpty()
                        if (children.size != 1) break
                        path = children.single()
                        compactNames += path.substringAfterLast('/')
                    }
                    val expanded = path !in collapsedDirectories
                    rows += ReviewNavigatorRow.Directory(
                        path = path,
                        name = compactNames.joinToString("/"),
                        depth = depth,
                        expanded = expanded,
                        fileCount = directoryCounts[path] ?: 0,
                    )
                    if (expanded) append(path, depth + 1)
                }
            fileChildren[parent].orEmpty()
                .sortedBy(ReviewFileInfo::path)
                .forEach { file ->
                    rows += ReviewNavigatorRow.File(
                        file = file,
                        title = file.path.substringAfterLast('/'),
                        depth = depth,
                        selected = file.path == selectedPath,
                    )
                }
        }

        append(parent = "", depth = 0)
        return rows
    }

    private fun directoryParent(path: String): String = path.substringBeforeLast('/', missingDelimiterValue = "")
}
