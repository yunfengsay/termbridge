package com.termbridge.android.watch

import com.termbridge.android.protocol.MessagePackCodec

data class WatchDailySnapshot(
    val temperatureDeciC: Int,
    val weather: String,
    val agendaTitle: String,
    val agendaAt: Long,
    val doNotDisturb: Boolean,
) {
    fun encode(): ByteArray = MessagePackCodec.packMap(
        linkedMapOf(
            "version" to 1,
            // Wire value is unsigned while retaining -100.0..100.0 C.
            "temperatureDeciC" to (temperatureDeciC.coerceIn(-1_000, 1_000) + 1_000),
            "weather" to weather.take(128),
            "agendaTitle" to agendaTitle.take(256),
            "agendaAt" to agendaAt.coerceAtLeast(0),
            "doNotDisturb" to doNotDisturb,
        ),
    )
}

data class WatchWorkSnapshot(
    val hostId: String,
    val sessionId: String,
    val title: String,
    val summary: String,
    val status: String,
    val priority: Int,
    val updatedAt: Long,
) {
    fun encode(): ByteArray = MessagePackCodec.packMap(
        linkedMapOf(
            "version" to 1,
            "hostId" to hostId.take(256),
            "sessionId" to sessionId.take(512),
            "title" to title.take(256),
            "summary" to summary.take(1_024),
            "status" to status.take(64),
            "priority" to priority.coerceIn(0, 5),
            "updatedAt" to updatedAt.coerceAtLeast(0),
        ),
    )
}

data class WatchNavigationCue(
    val distanceMeters: Int,
    val instruction: String,
    val kind: String = "navigation",
) {
    fun encode(): ByteArray = MessagePackCodec.packMap(
        linkedMapOf(
            "version" to 1,
            "distanceMeters" to distanceMeters.coerceAtLeast(0),
            "instruction" to instruction.take(256),
            "kind" to kind.take(32),
        ),
    )
}
