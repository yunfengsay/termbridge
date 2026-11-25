package com.termbridge.android.content

import org.junit.Assert.*
import org.junit.Test

class ArtifactTargetTest {
    @Test fun markdownAndImagesRetainTheirBase() {
        assertEquals("docs/img/a.png", ArtifactTarget.parse("img/a.png", "docs/readme.md")?.location)
        assertEquals("https://example.com/docs/a.png", ArtifactTarget.parse("a.png", "https://example.com/docs/a.md")?.location)
        assertTrue(ArtifactTarget.parse("https://example.com/a.PNG?x=1")!!.image)
        assertTrue(ArtifactTarget.parse("report.md")!!.markdown)
        assertFalse(ArtifactTarget.parse("report.md")!!.remote)
        assertEquals("docs/my image.png", ArtifactTarget.parse("docs/my%20image.png")?.location)
        assertEquals("/project/src/app.ts", ArtifactTarget.parse("/project/src/app.ts:12")?.location)
        assertEquals(12, ArtifactTarget.parse("/project/src/app.ts:12")?.line)
        assertEquals("timeline.css", ArtifactTarget.parse("timeline.css:42")?.location)
        assertEquals(42, ArtifactTarget.parse("timeline.css:42")?.line)
        val range = ArtifactTarget.parse("design-system/app/features/timeline/timeline.css:12:4-45:8")!!
        assertEquals("design-system/app/features/timeline/timeline.css", range.location)
        assertEquals(12, range.line)
        assertEquals(45, range.endLine)
        val hashRange = ArtifactTarget.parse("timeline.css#L18-L32")!!
        assertEquals("timeline.css", hashRange.location)
        assertEquals(18, hashRange.line)
        assertEquals(32, hashRange.endLine)
        assertTrue(ArtifactTarget.parse("diagram.svg")!!.svg)
        assertTrue(ArtifactTarget.parse("report.html")!!.html)
        assertTrue(ArtifactTarget.parse("slides.pdf")!!.pdf)
        assertTrue(ArtifactTarget.parse("clip.mp4")!!.video)
        assertTrue(ArtifactTarget.parse("voice.wav")!!.audio)
        assertTrue(ArtifactTarget.parse("photo.heic")!!.image)
        assertTrue(ArtifactTarget.parse("hero.avif")!!.image)
    }
    @Test fun modelAuthoredSchemesCannotLaunchAppsOrReadPhoneFiles() {
        for (url in listOf("javascript:alert(1)", "data:image/png,xxx", "file:///etc/passwd", "content://photos/1", "intent://x", "//evil.com/a", "https://user:pass@example.com/a", "a%00.png")) {
            assertNull(url, ArtifactTarget.parse(url))
        }
    }
}
