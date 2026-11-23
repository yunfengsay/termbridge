package com.termbridge.android.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder

object FrameCodec {
    const val CONTROL = 0
    const val PTY_OUT = 1
    const val PTY_IN = 2
    const val PTY_RESIZE = 3

    fun control(vararg fields: Pair<String, Any?>): ByteArray =
        control(linkedMapOf(*fields))

    fun control(fields: Map<String, Any?>): ByteArray {
        val payload = MessagePackCodec.packMap(fields)
        return ByteArray(1 + payload.size).also { frame ->
            frame[0] = CONTROL.toByte()
            payload.copyInto(frame, destinationOffset = 1)
        }
    }

    fun ptyInput(sid: Int, bytes: ByteArray): ByteArray {
        require(sid in 0..0xffff)
        return ByteBuffer.allocate(3 + bytes.size)
            .order(ByteOrder.BIG_ENDIAN)
            .put(PTY_IN.toByte())
            .putShort(sid.toShort())
            .put(bytes)
            .array()
    }

    fun resize(sid: Int, cols: Int, rows: Int): ByteArray {
        require(sid in 0..0xffff)
        require(cols in 1..0xffff && rows in 1..0xffff)
        return ByteBuffer.allocate(7)
            .order(ByteOrder.BIG_ENDIAN)
            .put(PTY_RESIZE.toByte())
            .putShort(sid.toShort())
            .putShort(cols.toShort())
            .putShort(rows.toShort())
            .array()
    }

    fun decode(bytes: ByteArray): IncomingFrame {
        require(bytes.isNotEmpty()) { "empty termbridge frame" }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
        return when (val type = buffer.get().toInt() and 0xff) {
            CONTROL -> {
                val fields = MessagePackCodec.unpackMap(bytes.copyOfRange(1, bytes.size))
                val messageType = fields["t"] as? String ?: error("control frame has no type")
                IncomingFrame.Control(ControlMessage(messageType, fields))
            }
            PTY_OUT, PTY_IN -> {
                require(buffer.remaining() >= 2) { "short PTY frame" }
                val sid = buffer.short.toInt() and 0xffff
                val payload = ByteArray(buffer.remaining()).also(buffer::get)
                if (type == PTY_OUT) IncomingFrame.PtyOutput(sid, payload)
                else IncomingFrame.PtyInput(sid, payload)
            }
            PTY_RESIZE -> {
                require(buffer.remaining() == 6) { "bad resize frame" }
                IncomingFrame.Resize(
                    sid = buffer.short.toInt() and 0xffff,
                    cols = buffer.short.toInt() and 0xffff,
                    rows = buffer.short.toInt() and 0xffff,
                )
            }
            else -> error("unknown frame type $type")
        }
    }
}
