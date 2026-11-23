package com.termbridge.android.review

import com.termbridge.android.protocol.ReviewFileInfo
import com.termbridge.android.protocol.ReviewHunkInfo
import com.termbridge.android.protocol.ReviewLineInfo
import com.termbridge.android.protocol.ReviewSnapshotInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewPresentationTest {
    @Test
    fun `shows one primary line number instead of duplicate old and new columns`() {
        assertEquals("12", ReviewPresentation.lineNumber(ReviewLineInfo("context", 12, 12, "same")))
        assertEquals("13", ReviewPresentation.lineNumber(ReviewLineInfo("add", newLine = 13, text = "added")))
        assertEquals("14", ReviewPresentation.lineNumber(ReviewLineInfo("delete", oldLine = 14, text = "removed")))
    }

    @Test
    fun `flattens files and hunks into a phone friendly single column review`() {
        val rows = ReviewPresentation.rows(snapshot())

        assertTrue(rows.first() is ReviewRow.FileHeader)
        assertTrue(rows[1] is ReviewRow.HunkHeader)
        assertEquals(listOf("delete", "add"), rows.filterIsInstance<ReviewRow.Line>().map { it.line.kind })
        assertEquals(listOf("src/example.ts", "src/example.ts"), rows.filterIsInstance<ReviewRow.Line>().map { it.path })
        assertEquals(ReviewRow.Notice.Kind.SNAPSHOT_TRUNCATED, (rows.last() as ReviewRow.Notice).kind)
    }

    @Test
    fun `a private file says its contents stay on the Host`() {
        val secret = ReviewFileInfo(path = ".env", status = "untracked", additions = 0, deletions = 0,
            binary = false, truncated = false, hunks = emptyList(), isPrivate = true)
        val rows = ReviewPresentation.rows(snapshot(files = listOf(secret), truncated = false))

        assertEquals(listOf(".env"), rows.filterIsInstance<ReviewRow.FileHeader>().map { it.path })
        assertEquals(listOf(ReviewRow.Notice.Kind.PRIVATE), rows.filterIsInstance<ReviewRow.Notice>().map { it.kind })
    }

    @Test
    fun `shows an explicit empty state when no changes exist`() {
        val row = ReviewPresentation.rows(snapshot(files = emptyList(), truncated = false)).single()
        assertEquals(ReviewRow.Notice.Kind.EMPTY, (row as ReviewRow.Notice).kind)
    }

    @Test
    fun `single file selection excludes unrelated diffs`() {
        val second = snapshot().files.single().copy(path = "src/other.ts")
        val rows = ReviewPresentation.rows(snapshot(files = snapshot().files + second), selectedPath = "src/other.ts")

        assertEquals(listOf("src/other.ts"), rows.filterIsInstance<ReviewRow.FileHeader>().map { it.path })
        assertTrue(rows.none { it == ReviewRow.Notice(ReviewRow.Notice.Kind.SNAPSHOT_TRUNCATED) })
    }

    @Test
    fun `project file content renders without a fake diff hunk header`() {
        val file = snapshot().files.single().copy(
            path = "src/App.tsx",
            status = "unchanged",
            additions = 0,
            deletions = 0,
            hunks = listOf(
                ReviewHunkInfo(
                    header = "",
                    oldStart = 1,
                    oldLines = 1,
                    newStart = 1,
                    newLines = 1,
                    lines = listOf(ReviewLineInfo("context", oldLine = 1, newLine = 1, text = "const app = true;")),
                ),
            ),
        )
        val browse = snapshot(files = listOf(file), truncated = false).copy(mode = "files")

        val rows = ReviewPresentation.rows(browse, selectedPath = file.path)

        assertEquals(1, rows.filterIsInstance<ReviewRow.FileHeader>().size)
        assertEquals(1, rows.filterIsInstance<ReviewRow.Line>().size)
        assertTrue(rows.none { it is ReviewRow.HunkHeader })
    }

    private fun snapshot(
        files: List<ReviewFileInfo> = listOf(
            ReviewFileInfo(
                path = "src/example.ts",
                status = "modified",
                additions = 1,
                deletions = 1,
                binary = false,
                truncated = false,
                hunks = listOf(
                    ReviewHunkInfo(
                        header = "@@ -1 +1 @@",
                        oldStart = 1,
                        oldLines = 1,
                        newStart = 1,
                        newLines = 1,
                        lines = listOf(
                            ReviewLineInfo("delete", oldLine = 1, text = "before"),
                            ReviewLineInfo("add", newLine = 1, text = "after"),
                        ),
                    ),
                ),
            ),
        ),
        truncated: Boolean = true,
    ) = ReviewSnapshotInfo(
        repository = "termbridge",
        repositoryPath = "/code/termbridge",
        branch = "feature/review",
        detached = false,
        mode = "working",
        dirty = true,
        canSwitchBranch = false,
        branches = listOf("feature/review", "main"),
        files = files,
        changedFileCount = files.size,
        additions = 1,
        deletions = 1,
        truncated = truncated,
    )
}
