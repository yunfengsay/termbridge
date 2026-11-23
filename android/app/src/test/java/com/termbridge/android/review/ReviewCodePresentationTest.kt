package com.termbridge.android.review

import com.termbridge.android.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReviewCodePresentationTest {
    @Test
    fun `maps common repository files to bundled Prism grammars`() {
        assertEquals("kotlin", ReviewLanguage.forPath("android/MainActivity.kt"))
        assertEquals("javascript", ReviewLanguage.forPath("packages/host/index.ts"))
        assertEquals("groovy", ReviewLanguage.forPath("android/app/build.gradle.kts"))
        assertEquals("git", ReviewLanguage.forPath(".gitignore"))
        assertNull(ReviewLanguage.forPath("assets/archive.bin"))
    }

    @Test
    fun `maps source files and directories to vscode icon assets`() {
        assertEquals(R.drawable.ic_file_kotlin, ReviewFileIcon.file("MainActivity.kt"))
        assertEquals(R.drawable.ic_file_typescript, ReviewFileIcon.file("index.ts"))
        assertEquals(R.drawable.ic_file_gradle, ReviewFileIcon.file("build.gradle.kts"))
        assertEquals(R.drawable.ic_folder_source, ReviewFileIcon.directory("android/src", expanded = true))
        assertEquals(R.drawable.ic_folder, ReviewFileIcon.directory("docs", expanded = false))
        assertEquals(R.drawable.ic_folder_open, ReviewFileIcon.directory("docs", expanded = true))
    }
}
