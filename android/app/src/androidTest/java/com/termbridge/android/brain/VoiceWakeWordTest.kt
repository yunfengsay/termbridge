package com.termbridge.android.brain

import android.os.Debug
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileNotFoundException
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Real native model + production gate replay. No AudioRecord, playback, cloud or phone actions. */
@RunWith(AndroidJUnit4::class)
class VoiceWakeWordTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test fun defaultKeywordWakesAndAnswerReturnsToZeroUploadStandby() {
        val session = VoiceWakeSession()
        val outbox = VoiceAudioOutbox(1_000_000)
        var starts = 0
        var uploaded = 0
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        val memoryBefore = Debug.getNativeHeapAllocatedSize()
        val started = SystemClock.elapsedRealtime()
        WakeWordCaptureGate(context, session, { "你好小桥" }, { starts++ }).use { gate ->
            fun replay(name: String) {
                frames(name).forEach { frame ->
                    val epoch = gate.accept(frame, 1) ?: return@forEach
                    val preRoll = gate.takeApprovedPreRoll()
                    assertTrue(preRoll.size <= WakeWordCaptureGate.PRE_ROLL_FRAMES)
                    session.forward(epoch) {
                        preRoll.forEach { outbox.offerAudio(ByteArray(it.size * 2)) }
                        outbox.offerAudio(ByteArray(frame.size * 2))
                        outbox.flush({ uploaded += it.size; true }, { true })
                    }
                }
            }
            repeat(3) { replay("negative") }
            assertEquals(0, starts)
            assertEquals(0, uploaded)
            assertEquals(0, outbox.queuedBytes)
            replay("positive")
            assertEquals("Real keyword model must recognize the configured wake phrase", 1, starts)
            assertTrue(uploaded > 0)
            session.responseStarted()
            session.responseFinished(true, 1_000)
            assertTrue(session.shouldPark(2_000, false, false))
            session.park()
            outbox.clear()
            val previousBytes = uploaded
            repeat(3) { replay("negative") }
            assertEquals(previousBytes, uploaded)
            assertEquals(0, outbox.queuedBytes)
            replay("positive")
            assertEquals(2, starts)
            session.stop()
            val stoppedBytes = uploaded
            replay("positive")
            assertEquals(stoppedBytes, uploaded)
            Log.i("VoiceWakeTest", "replayMs=${SystemClock.elapsedRealtime() - started} nativeHeapDelta=${Debug.getNativeHeapAllocatedSize() - memoryBefore} wakeCount=$starts standbyUploadBytes=0")
        }
    }

    @Test fun changingKeywordDoesNotKeepTheDefaultPhraseEnabled() {
        OnDeviceWakeWord(context, "你好助手").use { detector ->
            assertFalse(frames("positive").any { detector.accept(it) })
            detector.reset()
            assertTrue("Custom wake phrase must be recognized", frames("custom").any { detector.accept(it) })
        }
    }

    @Test fun silenceAndSyntheticNoiseStayLocal() {
        val session = VoiceWakeSession()
        var wakes = 0
        session.start(VoiceInteractionMode.WAKE_WORD, 0)
        val random = java.util.Random(42)
        WakeWordCaptureGate(context, session, { "你好小桥" }, { wakes++ }).use { gate ->
            repeat(1_875) { assertNull(gate.accept(ShortArray(512), it * 32L)) }
            repeat(312) {
                val noise = ShortArray(512) { (random.nextGaussian() * 2_000).toInt().coerceIn(-32768, 32767).toShort() }
                assertNull(gate.accept(noise, 60_000 + it * 32L))
            }
            assertEquals(0, wakes)
        }
    }

    @Test fun modeAndKeywordPersistIndependentlyFromDictationSendKeyword() {
        val store = VoiceSettingsStore(context)
        val previous = store.load()
        try {
            store.save(previous.sendKeyword, previous.playbackRate, previous.provider,
                previous.speakerVerificationEnabled, previous.technicalTerms.joinToString(","),
                previous.keepScreenAwake, previous.noiseFilterEnabled, previous.noiseSensitivity,
                VoiceInteractionMode.WAKE_WORD, "你好助手")
            assertEquals("你好助手", VoiceSettingsStore(context).load().wakeWord)
            assertEquals(previous.sendKeyword, store.load().sendKeyword)
            assertEquals(VoiceInteractionMode.WAKE_WORD, store.load().interactionMode)
            store.setInteractionMode(VoiceInteractionMode.CONTINUOUS)
            assertEquals("你好助手", store.load().wakeWord)
        } finally {
            store.save(previous.sendKeyword, previous.playbackRate, previous.provider,
                previous.speakerVerificationEnabled, previous.technicalTerms.joinToString(","),
                previous.keepScreenAwake, previous.noiseFilterEnabled, previous.noiseSensitivity,
                previous.interactionMode, previous.wakeWord)
        }
    }

    private fun frames(name: String): List<ShortArray> {
        val bytes = try {
            instrumentation.context.assets.open("wake/$name.pcm").use { it.readBytes() }
        } catch (_: FileNotFoundException) {
            null
        }
        assumeNotNull("Optional local androidTest asset wake/$name.pcm is not bundled", bytes)
        val shorts = ByteBuffer.wrap(bytes!!).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val samples = ShortArray(shorts.remaining()).also { shorts.get(it) }
        return samples.toList().chunked(512).map { chunk -> ShortArray(512) { chunk.getOrElse(it) { 0 } } } +
            List(30) { ShortArray(512) }
    }
}
