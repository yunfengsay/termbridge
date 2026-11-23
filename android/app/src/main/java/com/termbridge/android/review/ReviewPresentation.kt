package com.termbridge.android.review

import com.termbridge.android.protocol.ReviewLineInfo
import com.termbridge.android.protocol.ReviewSnapshotInfo

internal sealed interface ReviewRow {
    data class FileHeader(
        val path: String,
        val oldPath: String?,
        val status: String,
        val additions: Int,
        val deletions: Int,
    ) : ReviewRow

    data class HunkHeader(val text: String) : ReviewRow
    data class Line(val path: String, val line: ReviewLineInfo) : ReviewRow
    data class Notice(val kind: Kind) : ReviewRow {
        enum class Kind { EMPTY, PROJECT_EMPTY, BINARY, PRIVATE, FILE_TRUNCATED, SNAPSHOT_TRUNCATED }
    }
}

internal object ReviewPresentation {
    fun lineNumber(line: ReviewLineInfo): String =
        (line.newLine ?: line.oldLine)?.toString().orEmpty()

    fun rows(snapshot: ReviewSnapshotInfo, selectedPath: String? = null): List<ReviewRow> {
        val files = selectedPath?.let { path -> snapshot.files.filter { it.path == path } } ?: snapshot.files
        if (files.isEmpty()) return listOf(
            ReviewRow.Notice(
                if (snapshot.mode == "files") ReviewRow.Notice.Kind.PROJECT_EMPTY else ReviewRow.Notice.Kind.EMPTY,
            ),
        )
        return buildList {
            files.forEach { file ->
                add(ReviewRow.FileHeader(file.path, file.oldPath, file.status, file.additions, file.deletions))
                if (file.isPrivate) add(ReviewRow.Notice(ReviewRow.Notice.Kind.PRIVATE))
                else if (file.binary) add(ReviewRow.Notice(ReviewRow.Notice.Kind.BINARY))
                file.hunks.forEach { hunk ->
                    if (hunk.header.isNotEmpty()) add(ReviewRow.HunkHeader(hunk.header))
                    hunk.lines.forEach { line -> add(ReviewRow.Line(file.path, line)) }
                }
                if (file.truncated) add(ReviewRow.Notice(ReviewRow.Notice.Kind.FILE_TRUNCATED))
            }
            if (snapshot.truncated && selectedPath == null) {
                add(ReviewRow.Notice(ReviewRow.Notice.Kind.SNAPSHOT_TRUNCATED))
            }
        }
    }
}
