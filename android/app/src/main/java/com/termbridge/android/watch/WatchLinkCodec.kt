package com.termbridge.android.watch

import com.termbridge.android.protocol.WatchCompanionProtocol
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Small ordered-message layer for the TermBridge Watch GATT characteristics.
 *
 * BLE preserves notification order but its MTU is negotiated at runtime. Every
 * logical message is therefore split into self-describing fragments. PCM stays
 * byte-for-byte PCM; fragmentation must never become an implicit low-bitrate
 * codec.
 */
object WatchLinkCodec {
    const val VERSION = 1
    const val HEADER_BYTES = 9
    const val FLAG_START = 1
    const val FLAG_END = 2

    fun fragment(type: Int, sequence: Int, payload: ByteArray, mtuPayload: Int): List<ByteArray> {
        require(type in 0..0xff)
        require(sequence in 0..0xffff)
        require(payload.size <= 0xffff) { "watch message exceeds 65535 bytes" }
        require(mtuPayload > HEADER_BYTES) { "watch MTU payload is too small" }
        val chunkBytes = mtuPayload - HEADER_BYTES
        val chunkCount = maxOf(1, (payload.size + chunkBytes - 1) / chunkBytes)
        return List(chunkCount) { index ->
            val start = index * chunkBytes
            val end = minOf(payload.size, start + chunkBytes)
            val flags = (if (index == 0) FLAG_START else 0) or
                (if (index == chunkCount - 1) FLAG_END else 0)
            ByteBuffer.allocate(HEADER_BYTES + end - start)
                .order(ByteOrder.BIG_ENDIAN)
                .put(MAGIC_T)
                .put(MAGIC_B)
                .put(VERSION.toByte())
                .put(type.toByte())
                .putShort(sequence.toShort())
                .put(flags.toByte())
                .putShort(payload.size.toShort())
                .put(payload, start, end - start)
                .array()
        }
    }

    class Reassembler(private val maximumBytes: Int = 0xffff) {
        private var activeType = -1
        private var activeSequence = -1
        private var expectedBytes = 0
        private var received = ByteArray(0)

        fun accept(fragment: ByteArray): WatchLinkMessage? {
            require(fragment.size >= HEADER_BYTES) { "short watch fragment" }
            val buffer = ByteBuffer.wrap(fragment).order(ByteOrder.BIG_ENDIAN)
            require(buffer.get() == MAGIC_T && buffer.get() == MAGIC_B) { "bad watch fragment magic" }
            require((buffer.get().toInt() and 0xff) == VERSION) { "unsupported watch protocol" }
            val type = buffer.get().toInt() and 0xff
            val sequence = buffer.short.toInt() and 0xffff
            val flags = buffer.get().toInt() and 0xff
            val totalBytes = buffer.short.toInt() and 0xffff
            require(flags and (FLAG_START or FLAG_END).inv() == 0) { "bad watch fragment flags" }
            require(totalBytes <= maximumBytes) { "watch message is too large" }
            val chunk = ByteArray(buffer.remaining()).also(buffer::get)

            if (flags and FLAG_START != 0) {
                activeType = type
                activeSequence = sequence
                expectedBytes = totalBytes
                received = ByteArray(0)
            } else {
                require(type == activeType && sequence == activeSequence) { "interleaved watch message" }
                require(totalBytes == expectedBytes) { "watch message length changed" }
            }
            require(received.size + chunk.size <= expectedBytes) { "watch message overflow" }
            received += chunk

            if (flags and FLAG_END == 0) return null
            require(received.size == expectedBytes) { "incomplete watch message" }
            val message = WatchLinkMessage(activeType, activeSequence, received)
            reset()
            return message
        }

        fun reset() {
            activeType = -1
            activeSequence = -1
            expectedBytes = 0
            received = ByteArray(0)
        }
    }

    private const val MAGIC_T: Byte = 0x54
    private const val MAGIC_B: Byte = 0x42
}

data class WatchLinkMessage(
    val type: Int,
    val sequence: Int,
    val payload: ByteArray,
)

object WatchMessageType {
    const val HELLO = 0x01
    const val PROVISION = 0x02
    const val PROVISIONED = 0x03
    const val WATCH_STATUS = 0x04
    const val MOTION_STATUS = 0x05
    const val VOICE_START = 0x10
    const val VOICE_INPUT_PCM = 0x11
    const val VOICE_COMMIT = 0x12
    const val VOICE_CANCEL = 0x13
    const val VOICE_READY = 0x14
    const val VOICE_OUTPUT_PCM = 0x15
    const val VOICE_TEXT = 0x16
    const val VOICE_STATUS = 0x17
    const val VOICE_STOP = 0x18
    const val AGENT_NOTIFICATION = 0x20
    const val OPEN_CONVERSATION = 0x21
    const val ACTIVITY_SNAPSHOT = WatchCompanionProtocol.ACTIVITY_SNAPSHOT
    const val NAVIGATION_CUE = WatchCompanionProtocol.NAVIGATION_CUE
    const val DAILY_SNAPSHOT = WatchCompanionProtocol.DAILY_SNAPSHOT
    const val WORK_SNAPSHOT = WatchCompanionProtocol.WORK_SNAPSHOT
    const val ACTIVITY_COMMAND = WatchCompanionProtocol.ACTIVITY_COMMAND
    const val PHONE_ACTION = WatchCompanionProtocol.PHONE_ACTION
}
