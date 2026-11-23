package com.termbridge.android.watch

import com.termbridge.android.protocol.MessagePackCodec
import com.termbridge.android.protocol.WatchCompanionProtocol

data class WatchActivitySnapshot(
    val active: Boolean,
    val paused: Boolean,
    val elapsedSeconds: Long,
    val speedCentiKph: Int,
    val distanceMeters: Int,
    val elevationDecimeters: Int,
    val gpsAccuracyDecimeters: Int,
    val heartRate: Int = 0,
    val cadence: Int = 0,
    val label: String = "",
) {
    init {
        require(elapsedSeconds >= 0 && speedCentiKph in 0..20_000)
        require(distanceMeters >= 0 && elevationDecimeters in -100_000..100_000 && gpsAccuracyDecimeters >= 0)
        require(heartRate in 0..300 && cadence in 0..300 && label.length <= 128)
    }

    fun encode(): ByteArray = MessagePackCodec.packMap(
        linkedMapOf(
            "version" to WatchCompanionProtocol.ACTIVITY_VERSION,
            "active" to active,
            "paused" to paused,
            "elapsedSeconds" to elapsedSeconds,
            "speedCentiKph" to speedCentiKph,
            "distanceMeters" to distanceMeters,
            // MessagePack subset is unsigned; v2 offsets signed elevation by 10 km.
            "elevationDecimeters" to elevationDecimeters + WatchCompanionProtocol.ELEVATION_OFFSET_DECIMETERS,
            "gpsAccuracyDecimeters" to gpsAccuracyDecimeters,
            "heartRate" to heartRate,
            "cadence" to cadence,
            "label" to label,
        ),
    )

}

data class WatchAction(
    val action: String,
    val hostId: String = "",
    val sessionId: String = "",
) {
    companion object {
        fun decode(bytes: ByteArray): WatchAction {
            val map = MessagePackCodec.unpackMap(bytes)
            require((map["version"] as? Number)?.toInt() == WatchCompanionProtocol.ACTION_VERSION)
            val action = map["action"] as? String ?: error("missing watch action")
            require(action.length in 1..64)
            val hostId = (map["hostId"] as? String).orEmpty()
            require(hostId.length <= 256)
            val sessionId = (map["sessionId"] as? String).orEmpty()
            require(sessionId.length <= 512)
            return WatchAction(action = action, hostId = hostId, sessionId = sessionId)
        }
    }
}

data class WatchMotionStatus(val steps: Long, val activeMinutes: Long) {
    companion object {
        fun decode(bytes: ByteArray): WatchMotionStatus {
            val map = MessagePackCodec.unpackMap(bytes)
            require((map["version"] as? Number)?.toInt() == 1)
            val steps = (map["steps"] as? Number)?.toLong() ?: error("missing steps")
            val active = (map["activeMinutes"] as? Number)?.toLong() ?: error("missing active minutes")
            require(steps >= 0 && active >= 0)
            return WatchMotionStatus(steps, active)
        }
    }
}
