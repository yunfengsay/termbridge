package com.termbridge.android

import org.junit.Assert.*
import org.junit.Test

class TerminalImageUploadsTest {
    private val image = EncodedImage("image/jpeg", byteArrayOf(1, 2, 3))

    @Test fun `picker result survives disconnect until original session attaches`() {
        val queue = TerminalImageUploads()
        val id = queue.add("original")
        queue.encoded(id, image)
        assertTrue(queue.interrupted().isEmpty())
        assertTrue(queue.takeReady("different-session").isEmpty())
        val upload = queue.takeReady("original").single()
        assertEquals(id, upload.id)
        assertSame(image, upload.image)
        assertTrue(queue.takeReady("original").isEmpty())
        assertFalse(queue.acknowledge(id, "different-session"))
        assertTrue(queue.acknowledge(id, "original"))
        assertEquals(0, queue.size)
    }

    @Test fun `attachment before image conversion waits without dropping image`() {
        val queue = TerminalImageUploads()
        val id = queue.add("session")
        assertTrue(queue.takeReady("session").isEmpty())
        assertFalse(queue.acknowledge(id, "session"))
        queue.encoded(id, image)
        assertEquals(id, queue.takeReady("session").single().id)
    }

    @Test fun `disconnect clears only in flight uploads and ignores late acknowledgement`() {
        val queue = TerminalImageUploads()
        val sent = queue.add("session")
        queue.encoded(sent, image)
        queue.takeReady("session")
        val waiting = queue.add("session")
        queue.encoded(waiting, image)
        assertEquals(listOf(sent), queue.interrupted())
        queue.interrupted().forEach(queue::remove)
        assertFalse(queue.acknowledge(sent, "session"))
        assertEquals(waiting, queue.takeReady("session").single().id)
    }

    @Test fun `timeout or teardown cannot resurrect a late conversion or accept unknown result`() {
        val queue = TerminalImageUploads()
        val id = queue.add("session")
        assertTrue(queue.remove(id))
        queue.encoded(id, image)
        assertTrue(queue.takeReady("session").isEmpty())
        assertFalse(queue.acknowledge(id, "session"))
        assertFalse(queue.remove(id))
        val next = queue.add("session")
        queue.clear()
        queue.encoded(next, image)
        assertFalse(queue.isNotEmpty())
    }
}
