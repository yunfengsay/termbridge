package com.termbridge.android.peer

import org.json.JSONArray
import org.json.JSONObject
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.UUID

data class PhoneActionRequest(
    val actionId: String,
    val requestId: String,
    val callId: String,
    val toolResultId: String,
    val conversationId: String = requestId,
    val action: String,
    val title: String? = null,
    val notes: String? = null,
    val description: String? = null,
    val location: String? = null,
    val scheduledAt: String? = null,
    val startsAt: String? = null,
    val endsAt: String? = null,
    val dueAt: String? = null,
    val eventId: String? = null,
    val todoId: String? = null,
    val repeatDays: List<String> = emptyList(),
    val instructions: String? = null,
    val collection: String = DEFAULT_PHOTO_COLLECTION,
    val maxItems: Int = DEFAULT_PHOTO_MAX,
    val enabled: Boolean? = null,
    val createdAt: Long = System.currentTimeMillis(),
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("actionId", actionId)
        put("requestId", requestId)
        put("callId", callId)
        put("toolResultId", toolResultId)
        put("conversationId", conversationId)
        put("action", action)
        title?.let { put("title", it) }
        notes?.let { put("notes", it) }
        description?.let { put("description", it) }
        location?.let { put("location", it) }
        scheduledAt?.let { put("scheduledAt", it) }
        startsAt?.let { put("startsAt", it) }
        endsAt?.let { put("endsAt", it) }
        dueAt?.let { put("dueAt", it) }
        eventId?.let { put("eventId", it) }
        todoId?.let { put("todoId", it) }
        put("repeatDays", JSONArray(repeatDays))
        instructions?.let { put("instructions", it) }
        put("collection", collection)
        put("maxItems", maxItems)
        enabled?.let { put("enabled", it) }
        put("createdAt", createdAt)
    }

    companion object {
        val actions = setOf(
            "alarm.create",
            "calendar.list", "calendar.create", "calendar.update", "calendar.delete",
            "todo.list", "todo.create", "todo.update", "todo.complete", "todo.delete",
            "photo.count", "photo.fetch", "photo.edit",
            "call.speaker.set",
            "screen.capture",
        )
        private val weekdays = setOf("sun", "mon", "tue", "wed", "thu", "fri", "sat")
        const val MAX_PHOTO_SELECTION = 3
        const val DEFAULT_PHOTO_MAX = 3
        const val DEFAULT_PHOTO_COLLECTION = "camera"
        const val MAX_PHOTO_WINDOW_MS = 31L * 24 * 60 * 60 * 1_000

        fun fromArgs(args: Map<String, Any?>): PhoneActionRequest {
            val action = args.requiredString("action", 64).lowercase()
            require(action in actions) { "unsupported phone action: $action" }
            val repeatDays = (args["repeatDays"] as? List<*>)
                ?.filterIsInstance<String>()
                ?.map { it.trim().lowercase() }
                ?.filter(String::isNotBlank)
                ?.distinct()
                ?.also { days -> require(days.all(weekdays::contains)) { "invalid alarm weekday" } }
                ?.take(7)
                .orEmpty()
            val request = PhoneActionRequest(
                actionId = args.requiredString("actionId", 128),
                requestId = args.requiredString("requestId", 128),
                callId = args.requiredString("callId", 128),
                toolResultId = args.requiredString("toolResultId", 128),
                conversationId = args.optionalString("conversationId", 128)
                    ?: args.requiredString("requestId", 128),
                action = action,
                title = args.optionalString("title", 1_000),
                notes = args.optionalString("notes", 1_000),
                description = args.optionalString("description", 1_000),
                location = args.optionalString("location", 1_000),
                scheduledAt = args.optionalString("scheduledAt", 128),
                startsAt = args.optionalString("startsAt", 128),
                endsAt = args.optionalString("endsAt", 128),
                dueAt = args.optionalString("dueAt", 128),
                eventId = args.optionalString("eventId", 128),
                todoId = args.optionalString("todoId", 128),
                repeatDays = repeatDays,
                instructions = args.optionalString("instructions", 4_000),
                collection = args.optionalString("collection", 32)?.lowercase() ?: DEFAULT_PHOTO_COLLECTION,
                maxItems = ((args["maxItems"] as? Number)?.toInt() ?: DEFAULT_PHOTO_MAX)
                    .coerceIn(1, MAX_PHOTO_SELECTION),
                enabled = args["enabled"] as? Boolean,
            )
            request.validate()
            return request
        }

        fun fromJson(json: JSONObject): PhoneActionRequest = PhoneActionRequest(
            actionId = json.getString("actionId"),
            requestId = json.getString("requestId"),
            callId = json.getString("callId"),
            toolResultId = json.getString("toolResultId"),
            conversationId = json.optString("conversationId").takeIf(String::isNotBlank)
                ?: json.getString("requestId"),
            action = json.getString("action"),
            title = json.stringOrNull("title"),
            notes = json.stringOrNull("notes"),
            description = json.stringOrNull("description"),
            location = json.stringOrNull("location"),
            scheduledAt = json.stringOrNull("scheduledAt"),
            startsAt = json.stringOrNull("startsAt"),
            endsAt = json.stringOrNull("endsAt"),
            dueAt = json.stringOrNull("dueAt"),
            eventId = json.stringOrNull("eventId"),
            todoId = json.stringOrNull("todoId"),
            repeatDays = json.optJSONArray("repeatDays")?.strings().orEmpty(),
            instructions = json.stringOrNull("instructions"),
            collection = json.optString("collection", DEFAULT_PHOTO_COLLECTION).lowercase(),
            maxItems = json.optInt("maxItems", DEFAULT_PHOTO_MAX).coerceIn(1, MAX_PHOTO_SELECTION),
            enabled = if (json.has("enabled")) json.optBoolean("enabled") else null,
            createdAt = json.optLong("createdAt", System.currentTimeMillis()),
        ).also(PhoneActionRequest::validate)

        private fun Map<String, Any?>.requiredString(name: String, max: Int): String =
            optionalString(name, max) ?: error("missing $name")

        private fun Map<String, Any?>.optionalString(name: String, max: Int): String? =
            (this[name] as? String)?.trim()?.takeIf(String::isNotBlank)?.take(max)
    }

    private fun validate() {
        when (action) {
            "alarm.create" -> require(!scheduledAt.isNullOrBlank()) { "missing scheduledAt" }
            "calendar.list" -> {
                require(!startsAt.isNullOrBlank()) { "missing startsAt" }
                require(!endsAt.isNullOrBlank()) { "missing endsAt" }
            }
            "calendar.create" -> {
                require(!title.isNullOrBlank()) { "missing title" }
                require(!startsAt.isNullOrBlank()) { "missing startsAt" }
                require(!endsAt.isNullOrBlank()) { "missing endsAt" }
            }
            "calendar.update" -> {
                require(!eventId.isNullOrBlank()) { "missing eventId" }
                require(listOf(title, description, location, startsAt, endsAt).any { !it.isNullOrBlank() }) {
                    "calendar.update has no changes"
                }
            }
            "calendar.delete" -> require(!eventId.isNullOrBlank()) { "missing eventId" }
            "todo.create" -> require(!title.isNullOrBlank()) { "missing title" }
            "todo.update" -> {
                require(!todoId.isNullOrBlank()) { "missing todoId" }
                require(listOf(title, notes, dueAt).any { !it.isNullOrBlank() }) { "todo.update has no changes" }
            }
            "todo.complete", "todo.delete" -> require(!todoId.isNullOrBlank()) { "missing todoId" }
            "photo.edit" -> require(!instructions.isNullOrBlank()) { "missing photo instructions" }
            "photo.count" -> validatePhotoWindow()
            "photo.fetch" -> {
                validatePhotoWindow()
                require(!instructions.isNullOrBlank()) { "missing photo instructions" }
            }
            "call.speaker.set" -> require(enabled != null) { "missing enabled" }
        }
        if (action.startsWith("photo.")) {
            require(collection in setOf("camera", "all", "screenshots")) { "invalid photo collection" }
        }
    }

    private fun validatePhotoWindow() {
        val start = parsePhoneIsoTime(requireNotNull(startsAt) { "missing startsAt" })
        val end = parsePhoneIsoTime(requireNotNull(endsAt) { "missing endsAt" })
        require(end > start) { "photo endsAt must be after startsAt" }
        require(end - start <= MAX_PHOTO_WINDOW_MS) { "photo time window cannot exceed 31 days" }
    }
}

data class PhoneActionResult(
    val actionId: String,
    val action: String,
    val state: String,
    val summary: String,
    val data: Map<String, Any?> = emptyMap(),
) {
    fun toMap(): Map<String, Any?> = (mapOf(
        "actionId" to actionId,
        "action" to action,
        "state" to state,
        "summary" to summary,
    ) + data).mapValues { (_, value) -> value.toWireValue() }

    fun toJson(): JSONObject = JSONObject(toMap())

    companion object {
        fun fromJson(json: JSONObject): PhoneActionResult {
            val known = setOf("actionId", "action", "state", "summary")
            return PhoneActionResult(
                actionId = json.getString("actionId"),
                action = json.getString("action"),
                state = json.getString("state"),
                summary = json.getString("summary"),
                data = json.keys().asSequence()
                    .filterNot(known::contains)
                    .associateWith { jsonValue(json.get(it)) },
            )
        }
    }
}

data class PhoneActionEvent(
    val eventId: String,
    val actionId: String,
    val requestId: String,
    val callId: String,
    val toolResultId: String,
    val deviceId: String,
    val action: String,
    val state: String,
    val summary: String,
    val createdAt: Long,
    val data: Map<String, Any?> = emptyMap(),
    val error: String? = null,
) {
    fun toControlFields(): Map<String, Any?> = linkedMapOf<String, Any?>(
        "t" to "phone_action_event",
        "eventId" to eventId,
        "actionId" to actionId,
        "requestId" to requestId,
        "callId" to callId,
        "toolResultId" to toolResultId,
        "deviceId" to deviceId,
        "action" to action,
        "state" to state,
        "summary" to summary,
        // Java/Kotlin Long is encoded as MessagePack int64 and msgpackr
        // intentionally decodes it as bigint. ControlMessage expects a JS
        // number and Brain state is JSON, so use a lossless Double for epoch
        // milliseconds and normalize nested provider/result values here.
        "createdAt" to createdAt.toDouble(),
        "data" to data.mapValues { (_, value) -> value.toWireValue() },
    ).apply {
        error?.let { put("error", it) }
    }

    fun toJson(): JSONObject = JSONObject().apply {
        put("eventId", eventId)
        put("actionId", actionId)
        put("requestId", requestId)
        put("callId", callId)
        put("toolResultId", toolResultId)
        put("deviceId", deviceId)
        put("action", action)
        put("state", state)
        put("summary", summary)
        put("createdAt", createdAt)
        put("data", JSONObject(data))
        error?.let { put("error", it) }
    }

    companion object {
        fun create(
            request: PhoneActionRequest,
            deviceId: String,
            state: String,
            summary: String,
            data: Map<String, Any?> = emptyMap(),
            error: String? = null,
        ): PhoneActionEvent = PhoneActionEvent(
            eventId = "phone-event-${UUID.randomUUID()}",
            actionId = request.actionId,
            requestId = request.requestId,
            callId = request.callId,
            toolResultId = request.toolResultId,
            deviceId = deviceId,
            action = request.action,
            state = state,
            summary = summary.take(1_000),
            createdAt = System.currentTimeMillis(),
            data = data,
            error = error?.take(1_000),
        )

        fun fromJson(json: JSONObject): PhoneActionEvent = PhoneActionEvent(
            eventId = json.getString("eventId"),
            actionId = json.getString("actionId"),
            requestId = json.getString("requestId"),
            callId = json.getString("callId"),
            toolResultId = json.getString("toolResultId"),
            deviceId = json.getString("deviceId"),
            action = json.getString("action"),
            state = json.getString("state"),
            summary = json.getString("summary"),
            createdAt = json.getLong("createdAt"),
            data = json.optJSONObject("data")?.toMap().orEmpty(),
            error = json.stringOrNull("error"),
        )
    }
}

private fun Any?.toWireValue(): Any? = when (this) {
    is Long -> {
        val double = toDouble()
        if (double.toLong() == this) double else toString()
    }
    is Map<*, *> -> entries.associate { (key, value) -> key.toString() to value.toWireValue() }
    is Iterable<*> -> map { it.toWireValue() }
    is Array<*> -> map { it.toWireValue() }
    else -> this
}

internal fun JSONObject.stringOrNull(name: String): String? =
    if (!has(name) || isNull(name)) null else optString(name).trim().takeIf(String::isNotBlank)

internal fun JSONObject.toMap(): Map<String, Any?> =
    keys().asSequence().associateWith { jsonValue(get(it)) }

private fun JSONArray.strings(): List<String> =
    (0 until length()).mapNotNull { optString(it).trim().takeIf(String::isNotBlank) }

private fun jsonValue(value: Any?): Any? = when (value) {
    JSONObject.NULL -> null
    is JSONObject -> value.toMap()
    is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
    else -> value
}

internal fun parsePhoneIsoTime(value: String): Long {
    require(Regex("(?:Z|[+-]\\d{2}:\\d{2})$").containsMatchIn(value)) {
        "时间必须是带时区的 ISO 8601 格式"
    }
    for (pattern in listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXX",
        "yyyy-MM-dd'T'HH:mmXXX",
    )) {
        val position = ParsePosition(0)
        val parsed = SimpleDateFormat(pattern, Locale.US).apply { isLenient = false }.parse(value, position)
        if (parsed != null && position.index == value.length) return parsed.time
    }
    throw IllegalArgumentException("时间必须是带时区的 ISO 8601 格式")
}
