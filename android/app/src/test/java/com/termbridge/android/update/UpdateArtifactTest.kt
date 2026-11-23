package com.termbridge.android.update

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.security.MessageDigest

class UpdateArtifactTest {
    private val bytes = "verified fixture, not an APK".toByteArray()
    private fun artifact() = UpdateArtifact("0.1.28", 13, 24, "$RELEASE_ORIGIN/download/termbridge-13.apk", bytes.size.toLong(),
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })

    @Test fun `versionCode is monotonic and respects minimum Android version`() {
        assertTrue(artifact().newerThan(12, 36))
        assertFalse(artifact().newerThan(13, 36))
        assertFalse(artifact().newerThan(14, 36))
        assertFalse(artifact().newerThan(12, 23))
    }

    @Test fun `untrusted URLs and path escapes are rejected`() {
        for (url in listOf("http://termbridge-a0k.pages.dev/download/a.apk", "https://evil.test/download/a.apk",
            "$RELEASE_ORIGIN/download/../a.apk", "$RELEASE_ORIGIN/download/%2e%2e/a.apk",
            "https://user@termbridge-a0k.pages.dev/download/a.apk", "$RELEASE_ORIGIN/download/a.apk#x",
            "$RELEASE_ORIGIN:8443/download/a.apk", "$RELEASE_ORIGIN/download/a.zip")) {
            assertThrows(IllegalArgumentException::class.java) { artifact().copy(url = url) }
        }
    }

    @Test fun `invalid metadata is rejected before downloading`() {
        assertThrows(IllegalArgumentException::class.java) { artifact().copy(size = MAX_APK_BYTES + 1) }
        assertThrows(IllegalArgumentException::class.java) { artifact().copy(size = 0) }
        assertThrows(IllegalArgumentException::class.java) { artifact().copy(sha256 = "bad") }
        assertThrows(IllegalArgumentException::class.java) { artifact().copy(versionCode = 0) }
        assertThrows(IllegalArgumentException::class.java) { artifact().copy(version = "../a") }
    }

    @Test fun `only newer matching package version and signing identity can install`() {
        val installed = UpdatePackageIdentity("com.termbridge.android", "0.1.27", 12, setOf("certificate-a"))
        val candidate = installed.copy(version = "0.1.28", code = 13)
        verifyUpdateIdentity(artifact(), installed, candidate)
        for (invalid in listOf(candidate.copy(name = "other.app"), candidate.copy(version = "0.1.26"),
            candidate.copy(code = 14), candidate.copy(signers = emptySet()), candidate.copy(signers = setOf("certificate-b")))) {
            assertThrows(IllegalArgumentException::class.java) { verifyUpdateIdentity(artifact(), installed, invalid) }
        }
        assertThrows(IllegalArgumentException::class.java) { verifyUpdateIdentity(artifact(), installed.copy(code = 14), candidate) }
        assertThrows(IllegalArgumentException::class.java) { verifyUpdateIdentity(artifact(), installed.copy(signers = emptySet()), candidate) }
    }

    @Test fun `verified streaming copy preserves bytes and reports complete progress`() = withFile { file ->
        val progress = mutableListOf<Int>()
        copyVerifiedApk(ByteArrayInputStream(bytes), file, artifact(), progress::add)
        assertArrayEquals(bytes, file.readBytes())
        assertEquals(100, progress.last())
    }

    @Test fun `truncation oversize and checksum mismatch delete incomplete output`() = withFile { file ->
        for (content in listOf(bytes.dropLast(1).toByteArray(), bytes + byteArrayOf(1), ByteArray(bytes.size))) {
            assertThrows(IllegalArgumentException::class.java) {
                copyVerifiedApk(ByteArrayInputStream(content), file, artifact()) {}
            }
            assertFalse(file.exists())
        }
    }

    @Test fun `cancelled copy does not leave installable bytes`() = withFile { file ->
        try {
            Thread.currentThread().interrupt()
            assertThrows(InterruptedException::class.java) { copyVerifiedApk(ByteArrayInputStream(bytes), file, artifact()) {} }
            assertFalse(file.exists())
        } finally { Thread.interrupted() }
    }

    private fun withFile(block: (java.io.File) -> Unit) {
        val directory = Files.createTempDirectory("tb-update-test").toFile()
        val file = java.io.File(directory, "fixture.part")
        try { block(file) } finally { file.delete(); directory.delete() }
    }
}
