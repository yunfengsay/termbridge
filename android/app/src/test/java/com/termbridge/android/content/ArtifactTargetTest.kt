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
    }
    @Test fun modelAuthoredSchemesCannotLaunchAppsOrReadPhoneFiles() {
        for (url in listOf("javascript:alert(1)", "data:image/png,xxx", "file:///etc/passwd", "content://photos/1", "intent://x", "//evil.com/a", "https://user:pass@example.com/a", "a%00.png")) {
            assertNull(url, ArtifactTarget.parse(url))
        }
    }
}
