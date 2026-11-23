package com.termbridge.android.watch

import com.termbridge.android.protocol.MessagePackCodec
import com.termbridge.android.protocol.SessionInfo

data class WatchNotificationPayload(
    val hostId: String,
    val sessionId: String,
    val title: String,
    val body: String,
    val completedAt: Long,
) {
    fun encode(): ByteArray = MessagePackCodec.packMap(
        linkedMapOf(
            "version" to VERSION,
            "hostId" to hostId,
            "sessionId" to sessionId,
            "title" to title,
            "body" to body,
            "completedAt" to completedAt,
        ),
    )

    companion object {
        private const val VERSION = 1

        fun fromSession(hostId: String, session: SessionInfo): WatchNotificationPayload =
            WatchNotificationPayload(
                hostId = hostId,
                sessionId = session.sessionId,
                title = session.displayName.take(256),
                body = (session.preview ?: session.command).take(2_048),
                completedAt = session.completedAt ?: System.currentTimeMillis(),
            )

        fun decode(bytes: ByteArray): WatchNotificationPayload {
            val map = MessagePackCodec.unpackMap(bytes)
            require((map["version"] as? Number)?.toInt() == VERSION) { "unsupported watch notification" }
            return WatchNotificationPayload(
                hostId = map["hostId"] as? String ?: "",
                sessionId = map["sessionId"] as? String ?: error("missing session ID"),
                title = map["title"] as? String ?: error("missing title"),
                body = map["body"] as? String ?: "",
                completedAt = (map["completedAt"] as? Number)?.toLong() ?: 0L,
            )
        }

        fun decodeConversationOpen(bytes: ByteArray): WatchConversationRoute {
            val map = MessagePackCodec.unpackMap(bytes)
            require((map["version"] as? Number)?.toInt() == VERSION) { "unsupported conversation route" }
            val sessionId = map["sessionId"] as? String ?: error("missing session ID")
            return WatchConversationRoute(
                hostId = (map["hostId"] as? String).orEmpty(),
                sessionId = sessionId,
                title = (map["title"] as? String).orEmpty(),
            )
        }
    }
}

data class WatchConversationRoute(
    val hostId: String,
    val sessionId: String,
    val title: String,
)
