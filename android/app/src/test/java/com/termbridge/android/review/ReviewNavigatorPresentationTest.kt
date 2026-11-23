package com.termbridge.android.review

import com.termbridge.android.protocol.ReviewFileInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReviewNavigatorPresentationTest {
    @Test
    fun `tree exposes directories before selectable files with descendant counts`() {
        val rows = ReviewNavigatorPresentation.rows(
            files = listOf(file("README.md"), file("packages/host/index.ts"), file("packages/review/index.ts")),
            mode = ReviewNavigatorMode.TREE,
            selectedPath = "packages/review/index.ts",
        )

        val directories = rows.filterIsInstance<ReviewNavigatorRow.Directory>()
        assertEquals(listOf("packages", "packages/host", "packages/review"), directories.map { it.path })
        assertEquals(2, directories.first().fileCount)
        assertTrue(rows.filterIsInstance<ReviewNavigatorRow.File>().single { it.file.path == "packages/review/index.ts" }.selected)
    }

    @Test
    fun `collapsed directory hides descendants and can be reopened without losing the tree`() {
        val rows = ReviewNavigatorPresentation.rows(
            files = listOf(file("packages/host/index.ts"), file("README.md")),
            mode = ReviewNavigatorMode.TREE,
            collapsedDirectories = setOf("packages/host"),
        )

        assertFalse(rows.any { it is ReviewNavigatorRow.File && it.file.path.startsWith("packages/") })
        assertEquals(false, rows.filterIsInstance<ReviewNavigatorRow.Directory>().single().expanded)
        assertTrue(rows.any { it is ReviewNavigatorRow.File && it.file.path == "README.md" })
    }

    @Test
    fun `tree compacts single-child directories that contain no changed files`() {
        val rows = ReviewNavigatorPresentation.rows(
            files = listOf(
                file("android/app/src/main/java/com/example/app/MainActivity.kt"),
                file("android/app/src/main/java/com/example/app/TerminalActivity.kt"),
            ),
            mode = ReviewNavigatorMode.TREE,
        )

        val directory = rows.filterIsInstance<ReviewNavigatorRow.Directory>().single()
        assertEquals("android/app/src/main/java/com/example/app", directory.path)
        assertEquals("android/app/src/main/java/com/example/app", directory.name)
        assertEquals(0, directory.depth)
        assertEquals(2, directory.fileCount)
    }

    @Test
    fun `flat view shows every full path without directory rows`() {
        val rows = ReviewNavigatorPresentation.rows(
            files = listOf(file("z.ts"), file("src/a.ts")),
            mode = ReviewNavigatorMode.FLAT,
        )

        assertEquals(listOf("src/a.ts", "z.ts"), rows.map { (it as ReviewNavigatorRow.File).title })
    }

    private fun file(path: String) = ReviewFileInfo(
        path = path,
        status = "modified",
        additions = 1,
        deletions = 0,
        binary = false,
        truncated = false,
        hunks = emptyList(),
    )
}
