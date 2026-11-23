package com.termbridge.android.brain

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

@RunWith(AndroidJUnit4::class)
class LocalBoundarySpeechDecoderTest {
    @Test fun realLocalStopClosesUploadButKeepsAuthorizedQueueAndPendingAnswer() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val files = BoundaryModelFiles(context)
        assertTrue("Provision the pinned model first", files.verify())
        files.install {} // Verifies existing files; no download is required.
        assertTrue(files.isReady())
        val bytes = File(files.directory, "over.pcm").readBytes()
        val shorts = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val samples = ShortArray(shorts.remaining()).also { shorts.get(it) } + ShortArray(16_000)
        val session = VoiceWakeSession()
        val outbox = VoiceAudioOutbox(1_000_000)
        val stopped = java.util.concurrent.CountDownLatch(1)
        val failure = java.util.concurrent.atomic.AtomicReference<Throwable>()
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        session.wake(1)
        session.toolActivity(true)
        outbox.offerAudio(ByteArray(1024))
        LocalBoundaryAudioMonitor(
            { LocalBoundarySpeechDecoder(files.directory) },
            { epoch, text ->
                if (VoiceStopWords.match(text, VoiceStopWords.DEFAULT) != null && session.finishInput(epoch) {
                    outbox.offerAudio(ByteArray(64_000))
                    outbox.offerCommit()
                }) stopped.countDown()
            },
            { failure.set(it); stopped.countDown() },
        ).use { monitor ->
            samples.toList().chunked(512).forEach { chunk ->
                if (session.state == VoiceWakeSession.State.ACTIVE) {
                    monitor.accept(chunk.toShortArray(), session.generation)
                }
            }
            assertTrue("Local stop prediction must finish", stopped.await(10, java.util.concurrent.TimeUnit.SECONDS))
            failure.get()?.let { throw AssertionError("Native detector failed", it) }
            assertEquals(VoiceWakeSession.State.DRAINING, session.state)
            assertTrue(outbox.hasPending)
            assertEquals(1, outbox.pendingTurnCount)
            assertFalse(session.forward(session.generation) { fail("later ambient speech must stay local") })
            assertFalse(session.shouldPark(3_000, false, false))
            session.toolActivity(false)
            session.responseStarted()
            session.responseFinished(true, 4_000)
            assertFalse(session.shouldPark(5_000, true, false))
            assertTrue(session.shouldPark(5_000, false, false))
        }
    }

    @Test fun localModelRecognizesEnglishEndCommandWithoutCloud() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.noBackupFilesDir, "boundary-sensevoice-2024")
        assertTrue("Provision the pinned local model before this device test", File(directory, "model.int8.onnx").isFile)
        val bytes = File(directory, "over.pcm").readBytes()
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val samples = ShortArray(buffer.remaining()).also { buffer.get(it) }
        LocalBoundarySpeechDecoder(directory).use { decoder ->
            val started = android.os.SystemClock.elapsedRealtime()
            val text = decoder.decode(samples)
            android.util.Log.i("VoiceBoundaryTest", "overReplayMs=${android.os.SystemClock.elapsedRealtime() - started} transcript=$text")
            assertNotNull(VoiceStopWords.match(text, VoiceStopWords.DEFAULT))
        }
    }

    @Test fun correctionStorageIsOptInBoundedAndCanBeRevoked() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = VoiceSettingsStore(context)
        val store = VoiceBoundaryLearningStore(context)
        // Run on a disposable emulator; never erase a user's existing learning samples.
        assertTrue("Use an empty test profile", store.entries().isEmpty())
        val prior = settings.load().boundaryLearningEnabled
        val example = VoiceBoundaryLearningStore.Example(java.util.UUID.randomUUID().toString(),
            VoiceBoundaryLearningStore.Label.MANUAL_END, "查一下进程", "正在查询", "Over", "test-local-v1")
        try {
            settings.setBoundaryLearningEnabled(false)
            assertFalse(store.record(example))
            settings.setBoundaryLearningEnabled(true)
            assertTrue(store.record(example))
            assertFalse(store.record(example))
            val saved = org.json.JSONObject(store.entries().single())
            assertFalse(saved.getBoolean("reviewed"))
            assertFalse(saved.has("audio"))
            assertEquals("manual_end", saved.getString("label"))
            store.disableAndClear()
            assertTrue(store.entries().isEmpty())
            assertFalse(store.record(example.copy(eventId = java.util.UUID.randomUUID().toString())))
        } finally {
            store.delete(example.eventId)
            settings.setBoundaryLearningEnabled(prior)
        }
    }
}
