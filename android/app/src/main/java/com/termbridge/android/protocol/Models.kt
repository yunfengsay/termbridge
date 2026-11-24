package com.termbridge.android.protocol

// hello.replaceExisting is optional and Host-only: false rejects duplicate
// registration without replacing the existing Host. hostInstanceId is an optional
// process UUID allowing that same Host to recover its stale socket. Clients omit both.
// Generic control maps preserve this field; omitted means legacy replacement.

/** The bundled desktop viewer encrypts pixels and input; the native bridge forwards only these envelopes. */
object RemoteDesktopProtocol {
    const val SUBSCRIBE = "desktop_subscribe"
    const val ATTENTION = "desktop_attention"
    const val OPEN = "desktop_open"
    const val READY = "desktop_ready"
    const val DATA = "desktop_data"
    const val CLOSED = "desktop_closed"
    const val MAX_PACKET_BASE64 = 87408
}

/** Multiplexed TCP proxy tunnel over Control frames for the built-in remote browser. */
object ProxyTunnelProtocol {
    const val TYPE = "proxy_tunnel"
    const val KIND_OPEN = "open"
    const val KIND_OPENED = "opened"
    const val KIND_DATA = "data"
    const val KIND_ACK = "ack"
    const val KIND_CLOSE = "close"
    const val MAX_CHUNK_BYTES = 48 * 1024
    const val ACK_BATCH_BYTES = 64 * 1024
}

object CompletionReviewProtocol {
    const val ACTION = "brain_completion_action"
    const val RESULT = "brain_completion_result"
    fun approvalId(itemId: String): String? = itemId.removeSuffix(":handoff").takeIf {
        itemId.endsWith(":handoff") && Regex("completion-[a-f0-9]{32}").matches(it)
    }
}

// session_upload additionally accepts application/octet-stream and optional
// fileName (<=255 chars). Generic control maps preserve these desktop fields;
// Android image uploads are unchanged. Host retains only a safe extension.
// AgentChat capabilities.fileAttachments is optional (missing means false).

// peer_register also carries desktop CLI/Mac App peers (peer.desktop/peer.exec/peer.fs).
// These are not Android capabilities. Existing generic tool envelopes are
// unchanged; phone operations still route only to the native phone executor.

/** v1: six normalized features; UUID row/group IDs; safe integers; reviewed labels only. */
object VoiceLearningProtocol {
    const val CONTEXT_VERSION = 2 // contextConsent + bounded reviewed text; optional assist training receipt.
    const val CAPABILITY = "voiceLearning"
    const val SYNC = "voice_learning_sync"
    const val RESULT = "voice_learning_result"
}

/** System reminders are model-only history, deliberately separate from BrainMessageInfo/UI rows. */
object VoicePresentationProtocol {
    const val UPDATE = "brain_voice_presentation"
    const val FOREGROUND = "foreground"
    const val OVERLAY = "overlay"
    const val SYSTEM_REMINDERS = "systemReminders"
    const val SCREEN_CAPTURE_ACTION = "screen.capture"
}

/** brain_send uses Host-allowlisted tiers; no endpoint or model command comes from the phone. */
enum class BrainWorkflow(val wireValue: String) { STANDARD("standard"), SILENT("silent") }
enum class BrainModelTier(val wireValue: String) {
    ADVANCED("advanced"), DEEP("deep");
    companion object {
        fun from(value: String?) = entries.firstOrNull { it.wireValue == value } ?: ADVANCED
    }
}
object DictationProtocol {
    // brain_voice_start: same visible call with a text-only advanced execution lane.
    const val SILENT_CALL_CAPABILITY = "silentCall"
    const val CALL_WORKFLOW = "workflow"
    const val CALL_MODEL_TIER = "modelTier"
    const val START = "brain_transcribe_start"
    const val CANCEL = "brain_transcribe_cancel"
    const val RESULT = "brain_transcribe_result"
    const val FINISHED = "finished"
    const val HINTS = "hints"
}

object BrainSilentProtocol {
    const val CANCEL = "brain_cancel"
    const val CANCEL_RESULT = "brain_cancel_result"
    const val TEXT_RESULT = "brain_text_result"
}

/** Host acknowledges before clients stop legacy polling. */
object ClientStreamPolicy {
    const val REQUEST = "client_stream_policy"
    const val RESULT = "client_stream_policy_result"
}

/** Shared IDs for the encrypted local watch companion link. */
object WatchCompanionProtocol {
    const val ACTIVITY_SNAPSHOT = 0x30
    const val NAVIGATION_CUE = 0x31
    const val DAILY_SNAPSHOT = 0x32
    const val WORK_SNAPSHOT = 0x33
    const val ACTIVITY_COMMAND = 0x34
    const val PHONE_ACTION = 0x35
    const val ACTIVITY_VERSION = 2
    const val ACTION_VERSION = 1
    const val ELEVATION_OFFSET_DECIMETERS = 100_000
}

data class WatchCompanionRoute(
    val hostId: String,
    val sessionId: String,
) {
    init {
        require(hostId.length <= 256 && sessionId.length <= 512)
    }
}

data class SessionInfo(
    val sessionId: String,
    val command: String,
    val cols: Int,
    val rows: Int,
    val createdAt: Long,
    val viewers: Int,
    val source: String = "pty",
    val name: String? = null,
    val workspace: String? = null,
    val paneId: String? = null,
    val agent: String? = null,
    val status: String? = null,
    val completedAt: Long? = null,
    val preview: String? = null,
) {
    val isActive: Boolean get() = viewers > 0
    val isHerdr: Boolean get() = source == "herdr"
    val displayName: String get() = name?.takeIf(String::isNotBlank) ?: workspace?.takeIf(String::isNotBlank) ?: command

    companion object {
        fun fromMap(map: Map<String, Any?>): SessionInfo? {
            val sessionId = map["sessionId"] as? String ?: return null
            return SessionInfo(
                sessionId = sessionId,
                command = (map["command"] as? String).orEmpty().ifBlank { sessionId },
                cols = (map["cols"] as? Number)?.toInt() ?: 80,
                rows = (map["rows"] as? Number)?.toInt() ?: 24,
                createdAt = (map["createdAt"] as? Number)?.toLong() ?: 0L,
                viewers = (map["viewers"] as? Number)?.toInt() ?: 0,
                source = map["source"] as? String ?: "pty",
                name = map["name"] as? String,
                workspace = map["workspace"] as? String,
                paneId = map["paneId"] as? String,
                agent = map["agent"] as? String,
                status = map["status"] as? String,
                completedAt = (map["completedAt"] as? Number)?.toLong(),
                preview = map["preview"] as? String,
            )
        }
    }
}

// ---- graphical Agent conversation (agent_chat_*) ----
// A second VIEW of one already-running Agent, never a second Agent. The phone
// decodes what the Host read out of that session's own structured records; it
// never parses a terminal screen and never infers a tool outcome.
// chat/AgentChatActivity subscribes independently of terminal attach and renders
// this shared wire contract through the packaged transcript surface.

object AgentChatProtocol {
    const val LIST = "agent_chat_list"
    const val LIST_RESULT = "agent_chat_list_result"
    const val SUBSCRIBE = "agent_chat_subscribe"
    const val UNSUBSCRIBE = "agent_chat_unsubscribe"
    const val SNAPSHOT = "agent_chat_snapshot"
    const val APPEND = "agent_chat_append"
    const val EARLIER = "agent_chat_earlier"
    const val EARLIER_RESULT = "agent_chat_earlier_result"
    const val SEND = "agent_chat_send"
    const val DELIVERY = "agent_chat_delivery"

    /**
     * A control key for this conversation's own pane.
     *
     * The client names a key from the protocol's closed set and the Host decides
     * the bytes, so nothing here can become an arbitrary escape sequence or a
     * chat message. Authorized by the live subscription and its generation, and
     * the result echoes both back.
     */
    const val KEY = "agent_chat_key"
    const val KEY_RESULT = "agent_chat_key_result"
    /**
     * Carried on subscribe, earlier and every answer to them. The client owns
     * this counter; the Host echoes it unchanged, so an event produced for a
     * conversation view the user has left is discarded instead of applied.
     */
    const val GENERATION = "generation"
}

/** One page of older history. `generation` must match the live subscription. */
data class AgentChatEarlierPage(
    val requestId: String,
    val conversationId: String,
    val generation: Int,
    val messages: List<AgentChatMessage>,
    val cursor: Long?,
    val atHead: Boolean,
    val error: String?,
) {
    companion object {
        @Suppress("UNCHECKED_CAST")
        fun fromMap(map: Map<String, Any?>): AgentChatEarlierPage? {
            val requestId = map["requestId"] as? String ?: return null
            val conversationId = map["conversationId"] as? String ?: return null
            return AgentChatEarlierPage(
                requestId = requestId,
                conversationId = conversationId,
                generation = (map["generation"] as? Number)?.toInt() ?: return null,
                messages = (map["messages"] as? List<*>).orEmpty()
                    .mapNotNull { (it as? Map<String, Any?>)?.let(AgentChatMessage::fromMap) },
                cursor = (map["cursor"] as? Number)?.toLong(),
                atHead = map["atHead"] == true,
                error = map["error"] as? String,
            )
        }
    }
}

/** What the bound adapter can really do. A false flag disables its control. */
data class AgentChatCapabilities(
    val history: Boolean,
    val send: Boolean,
    val stop: Boolean,
    val attachments: Boolean,
    val approvals: Boolean,
    val questions: Boolean,
    val terminal: Boolean,
    val degraded: String? = null,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>?): AgentChatCapabilities = AgentChatCapabilities(
            history = map?.get("history") == true,
            send = map?.get("send") == true,
            stop = map?.get("stop") == true,
            attachments = map?.get("attachments") == true,
            approvals = map?.get("approvals") == true,
            questions = map?.get("questions") == true,
            terminal = map?.get("terminal") != false,
            degraded = map?.get("degraded") as? String,
        )
    }
}

/** One block of a message. Unknown block types are dropped, never guessed at. */
sealed interface AgentChatBlock {
    data class Text(val text: String) : AgentChatBlock
    data class ToolCall(
        val name: String,
        val input: String,
        val callId: String? = null,
        val truncated: Boolean = false,
    ) : AgentChatBlock
    data class ToolResult(
        val output: String,
        val isError: Boolean = false,
        val callId: String? = null,
        val truncated: Boolean = false,
    ) : AgentChatBlock
    data class ImageRef(
        val url: String? = null,
        val name: String? = null,
        val alt: String? = null,
    ) : AgentChatBlock

    companion object {
        fun fromMap(map: Map<String, Any?>): AgentChatBlock? {
            return when (map["type"] as? String) {
                "text" -> (map["text"] as? String)?.let(::Text)
                "tool-call" -> (map["name"] as? String)?.let { name ->
                    ToolCall(
                        name = name,
                        input = map["input"] as? String ?: "",
                        callId = map["callId"] as? String,
                        truncated = map["truncated"] == true,
                    )
                }
                "tool-result" -> ToolResult(
                    output = map["output"] as? String ?: "",
                    isError = map["isError"] == true,
                    callId = map["callId"] as? String,
                    truncated = map["truncated"] == true,
                )
                "image-ref" -> ImageRef(
                    url = map["url"] as? String,
                    name = map["name"] as? String,
                    alt = map["alt"] as? String,
                )
                else -> null
            }
        }
    }
}

data class AgentChatMessage(
    val id: String,
    val role: String,
    val blocks: List<AgentChatBlock>,
    val timestamp: Long?,
    val source: String,
    val seq: Long,
    val turnId: String? = null,
) {
    companion object {
        @Suppress("UNCHECKED_CAST")
        fun fromMap(map: Map<String, Any?>): AgentChatMessage? {
            val id = map["id"] as? String ?: return null
            val blocks = (map["blocks"] as? List<*>).orEmpty()
                .mapNotNull { (it as? Map<String, Any?>)?.let(AgentChatBlock::fromMap) }
            return AgentChatMessage(
                id = id,
                role = map["role"] as? String ?: "assistant",
                blocks = blocks,
                timestamp = (map["timestamp"] as? Number)?.toLong(),
                source = map["source"] as? String ?: "transcript",
                seq = (map["seq"] as? Number)?.toLong() ?: 0L,
                turnId = map["turnId"] as? String,
            )
        }
    }
}

/** One row of agent_chat_list_result: `chat` false means show the terminal. */
data class AgentChatConversation(
    val conversationId: String,
    val paneId: String,
    val provider: String?,
    val title: String?,
    val workspace: String?,
    val status: String,
    val chat: Boolean,
    val reason: String?,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>): AgentChatConversation? {
            val conversationId = map["conversationId"] as? String ?: return null
            return AgentChatConversation(
                conversationId = conversationId,
                paneId = map["paneId"] as? String ?: "",
                provider = map["provider"] as? String,
                title = map["title"] as? String,
                workspace = map["workspace"] as? String,
                status = map["status"] as? String ?: "unknown",
                chat = map["chat"] == true,
                reason = map["reason"] as? String,
            )
        }
    }
}

/**
 * Send receipts. `delivered` means the Agent's input channel took the bytes;
 * only `observed` means the Agent's own record contains the prompt. `uncertain`
 * is an unknown write outcome — the client must not resend it.
 */
enum class AgentChatDeliveryState(val wireName: String) {
    ACCEPTED("accepted"),
    DELIVERED("delivered"),
    OBSERVED("observed"),
    UNCERTAIN("uncertain"),
    FAILED("failed");

    /** Only an outright rejection is safe to send again. */
    val mayResend: Boolean get() = this == FAILED

    companion object {
        fun fromWire(value: String?): AgentChatDeliveryState =
            entries.firstOrNull { it.wireName == value } ?: ACCEPTED
    }
}

data class AgentChatDelivery(
    val requestId: String,
    val conversationId: String,
    val generation: Int,
    val state: AgentChatDeliveryState,
    val at: Long,
    val messageId: String? = null,
    val error: String? = null,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>): AgentChatDelivery? {
            val requestId = map["requestId"] as? String ?: return null
            return AgentChatDelivery(
                requestId = requestId,
                conversationId = map["conversationId"] as? String ?: return null,
                generation = (map["generation"] as? Number)?.toInt() ?: 0,
                state = AgentChatDeliveryState.fromWire(map["state"] as? String),
                at = (map["at"] as? Number)?.toLong() ?: 0L,
                messageId = map["messageId"] as? String,
                error = map["error"] as? String,
            )
        }
    }
}

// Optional relay-owned topology, requested with hello.wantsTopology.
// clientInstanceId is a per-process UUID for grouping sockets, never authorization.
data class RelayTopologyNode(val id: String, val role: String, val name: String, val hostId: String?, val connections: Int)
data class RelayTopologyEdge(val from: String, val to: String)
data class RelayTopologyInfo(
    val relayId: String, val selfNodeId: String, val selectedHostId: String?, val generatedAt: Long,
    val nodes: List<RelayTopologyNode>, val edges: List<RelayTopologyEdge>, val truncated: Boolean,
) {
    companion object {
        @Suppress("UNCHECKED_CAST")
        fun fromMap(map: Map<String, Any?>): RelayTopologyInfo? {
            val relay = map["relayId"] as? String ?: return null
            val self = map["selfNodeId"] as? String ?: return null
            val target = map["selectedHostId"] as? String
            val time = (map["generatedAt"] as? Number)?.toLong() ?: return null
            val raw = map["nodes"] as? List<*> ?: return null
            if (raw.size !in 1..128 || time < 0 || (target?.length ?: 0) > 128) return null
            val nodes = raw.map { item ->
                val node = item as? Map<String, Any?> ?: return null
                val id = node["id"] as? String ?: return null
                val role = node["role"] as? String ?: return null
                val name = node["name"] as? String ?: return null
                val host = node["hostId"] as? String
                val count = (node["connections"] as? Number)?.toLong() ?: return null
                if (id.length !in 1..256 || role !in listOf("relay", "host", "client") || name.length > 96
                    || (host?.length ?: 0) > 128 || count !in 1..1_000_000) return null
                RelayTopologyNode(id, role, name, host, count.toInt())
            }
            val ids = nodes.map { it.id }.toSet()
            if (ids.size != nodes.size || self !in ids || nodes.filter { it.role == "relay" }.map { it.id } != listOf(relay)) return null
            val rawEdges = map["edges"] as? List<*> ?: return null
            if (rawEdges.size != nodes.size - 1) return null
            val edges = rawEdges.map { item ->
                val edge = item as? Map<String, Any?> ?: return null
                val from = edge["from"] as? String ?: return null
                val to = edge["to"] as? String ?: return null
                if (to != relay || from == relay || from !in ids) return null
                RelayTopologyEdge(from, to)
            }
            if (edges.map { it.from }.toSet().size != edges.size) return null
            return RelayTopologyInfo(relay, self, target, time, nodes, edges, map["truncated"] as? Boolean ?: return null)
        }
    }
}

data class HostInfo(
    val hostId: String,
    val name: String,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>): HostInfo? {
            val hostId = map["hostId"] as? String ?: return null
            return HostInfo(hostId, (map["name"] as? String).orEmpty().ifBlank { hostId })
        }
    }
}

enum class HostNetworkPolicy(val wireName: String) {
    SYSTEM("system"),
    DIRECT("direct");

    companion object {
        fun fromWire(value: String?): HostNetworkPolicy =
            entries.firstOrNull { it.wireName == value } ?: SYSTEM
    }
}

data class HostNetworkPolicyInfo(
    val policy: HostNetworkPolicy,
    val changed: Boolean,
    val proxyDetected: Boolean,
)

data class ReviewLineInfo(
    val kind: String,
    val oldLine: Int? = null,
    val newLine: Int? = null,
    val text: String,
)

data class ReviewHunkInfo(
    val header: String,
    val oldStart: Int,
    val oldLines: Int,
    val newStart: Int,
    val newLines: Int,
    val lines: List<ReviewLineInfo>,
)

data class ReviewFileInfo(
    val path: String,
    val oldPath: String? = null,
    val status: String,
    val additions: Int,
    val deletions: Int,
    val binary: Boolean,
    val truncated: Boolean,
    val hunks: List<ReviewHunkInfo>,
    /** An environment file, key or credential: listed, its contents withheld by the Host. */
    val isPrivate: Boolean = false,
)

data class ReviewSnapshotInfo(
    val repository: String,
    val repositoryPath: String,
    val branch: String,
    val detached: Boolean,
    val mode: String,
    val baseBranch: String? = null,
    val dirty: Boolean,
    val canSwitchBranch: Boolean,
    val branches: List<String>,
    val files: List<ReviewFileInfo>,
    val changedFileCount: Int,
    val additions: Int,
    val deletions: Int,
    val truncated: Boolean,
) {
    companion object {
        private val modes = setOf("working", "branch", "files")

        @Suppress("UNCHECKED_CAST")
        fun fromMap(map: Map<String, Any?>): ReviewSnapshotInfo? {
            val mode = map.boundedString("mode", 16)?.takeIf(modes::contains) ?: return null
            val fileLimit = if (mode == "files") 20_000 else 80
            val files = (map["files"] as? List<*>)?.take(fileLimit)?.mapNotNull(::parseReviewFile).orEmpty()
            return ReviewSnapshotInfo(
                repository = map.boundedString("repository", 256) ?: return null,
                repositoryPath = map.boundedString("repositoryPath", 2_048) ?: return null,
                branch = map.boundedString("branch", 256) ?: return null,
                detached = map["detached"] as? Boolean ?: false,
                mode = mode,
                baseBranch = map.boundedString("baseBranch", 256),
                dirty = map["dirty"] as? Boolean ?: false,
                canSwitchBranch = map["canSwitchBranch"] as? Boolean ?: false,
                branches = (map["branches"] as? List<*>)?.filterIsInstance<String>()?.take(100).orEmpty(),
                files = files,
                changedFileCount = (map["changedFileCount"] as? Number)?.toInt()?.coerceAtLeast(0) ?: files.size,
                additions = (map["additions"] as? Number)?.toInt()?.coerceAtLeast(0) ?: 0,
                deletions = (map["deletions"] as? Number)?.toInt()?.coerceAtLeast(0) ?: 0,
                truncated = map["truncated"] as? Boolean ?: false,
            )
        }
    }
}

private val reviewFileStatuses = setOf("added", "deleted", "modified", "renamed", "untracked", "unchanged")
private val reviewLineKinds = setOf("context", "add", "delete")

/** One changed file; a repository list carries the same fields without hunks. */
@Suppress("UNCHECKED_CAST")
private fun parseReviewFile(rawFile: Any?): ReviewFileInfo? {
    val file = rawFile as? Map<String, Any?> ?: return null
    val path = file.boundedString("path", 1_024) ?: return null
    val status = file.boundedString("status", 16)?.takeIf(reviewFileStatuses::contains) ?: return null
    val hunks = (file["hunks"] as? List<*>)?.take(800)?.mapNotNull { rawHunk ->
        val hunk = rawHunk as? Map<String, Any?> ?: return@mapNotNull null
        val lines = (hunk["lines"] as? List<*>)?.take(20_000)?.mapNotNull { rawLine ->
            val line = rawLine as? Map<String, Any?> ?: return@mapNotNull null
            val kind = line.boundedString("kind", 16)?.takeIf(reviewLineKinds::contains) ?: return@mapNotNull null
            ReviewLineInfo(
                kind = kind,
                oldLine = (line["oldLine"] as? Number)?.toInt(),
                newLine = (line["newLine"] as? Number)?.toInt(),
                text = (line["text"] as? String)?.take(1_000) ?: return@mapNotNull null,
            )
        }.orEmpty()
        ReviewHunkInfo(
            header = (hunk["header"] as? String)?.take(500) ?: return@mapNotNull null,
            oldStart = (hunk["oldStart"] as? Number)?.toInt() ?: 0,
            oldLines = (hunk["oldLines"] as? Number)?.toInt() ?: 0,
            newStart = (hunk["newStart"] as? Number)?.toInt() ?: 0,
            newLines = (hunk["newLines"] as? Number)?.toInt() ?: 0,
            lines = lines,
        )
    }.orEmpty()
    return ReviewFileInfo(
        path = path,
        oldPath = file.boundedString("oldPath", 1_024),
        status = status,
        additions = (file["additions"] as? Number)?.toInt()?.coerceAtLeast(0) ?: 0,
        deletions = (file["deletions"] as? Number)?.toInt()?.coerceAtLeast(0) ?: 0,
        binary = file["binary"] as? Boolean ?: false,
        truncated = file["truncated"] as? Boolean ?: false,
        hunks = hunks,
        isPrivate = file["private"] as? Boolean ?: false,
    )
}

/**
 * One repository a conversation is associated with, from `review_repositories_result`:
 * the session's own (`current`) or one holding a file its Agent changed (`touched`).
 * `files` are the current uncommitted changes, listed without hunks.
 */
data class ReviewRepositoryInfo(
    val repository: String,
    val repositoryPath: String,
    val branch: String,
    val detached: Boolean,
    val current: Boolean,
    val files: List<ReviewFileInfo>,
    val changedFileCount: Int,
    val additions: Int,
    val deletions: Int,
    val truncated: Boolean,
    val touched: List<String>,
    val touchedTruncated: Boolean,
    val error: String? = null,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>): ReviewRepositoryInfo? {
            val files = (map["files"] as? List<*>)?.take(200)?.mapNotNull(::parseReviewFile).orEmpty()
            return ReviewRepositoryInfo(
                repository = map.boundedString("repository", 256) ?: return null,
                repositoryPath = map.boundedString("repositoryPath", 2_048) ?: return null,
                branch = map.boundedString("branch", 256) ?: return null,
                detached = map["detached"] as? Boolean ?: false,
                current = map["current"] as? Boolean ?: false,
                files = files,
                changedFileCount = (map["changedFileCount"] as? Number)?.toInt()?.coerceAtLeast(0) ?: files.size,
                additions = (map["additions"] as? Number)?.toInt()?.coerceAtLeast(0) ?: 0,
                deletions = (map["deletions"] as? Number)?.toInt()?.coerceAtLeast(0) ?: 0,
                truncated = map["truncated"] as? Boolean ?: false,
                touched = (map["touched"] as? List<*>)?.filterIsInstance<String>()
                    ?.filter { it.isNotBlank() && it.length <= 1_024 }?.take(500).orEmpty(),
                touchedTruncated = map["touchedTruncated"] as? Boolean ?: false,
                error = map.boundedString("error", 1_000),
            )
        }
    }
}

data class BrainMessageInfo(
    val id: String,
    val role: String,
    val text: String,
    val createdAt: Long,
    val taskId: String? = null,
    val modality: String? = null,
    val voiceStatus: String? = null,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>): BrainMessageInfo? {
            val id = map["id"] as? String ?: return null
            val role = map["role"] as? String ?: return null
            val text = map["text"] as? String ?: return null
            return BrainMessageInfo(
                id = id,
                role = role,
                text = text,
                createdAt = (map["createdAt"] as? Number)?.toLong() ?: 0L,
                taskId = map["taskId"] as? String,
                modality = map["modality"] as? String,
                voiceStatus = map["voiceStatus"] as? String,
            )
        }
    }
}

data class BrainTaskInfo(
    val taskId: String,
    val requestId: String,
    val text: String,
    val agent: String,
    val status: String,
    val createdAt: Long,
    val updatedAt: Long,
    val sessionId: String? = null,
    val error: String? = null,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>): BrainTaskInfo? {
            val taskId = map["taskId"] as? String ?: return null
            return BrainTaskInfo(
                taskId = taskId,
                requestId = map["requestId"] as? String ?: return null,
                text = map["text"] as? String ?: return null,
                agent = map["agent"] as? String ?: return null,
                status = map["status"] as? String ?: return null,
                createdAt = (map["createdAt"] as? Number)?.toLong() ?: 0L,
                updatedAt = (map["updatedAt"] as? Number)?.toLong() ?: 0L,
                sessionId = map["sessionId"] as? String,
                error = map["error"] as? String,
            )
        }
    }
}

data class AgentDescriptorInfo(
    val agentId: String,
    val name: String,
    val runtime: String,
    val purpose: String,
    val capabilities: List<String>,
    val defaultWorkspace: String? = null,
) {
    companion object {
        private val runtimes = setOf("codex", "claude", "shell", "custom")
        private val supportedCapabilities = setOf(
            "coding", "research", "design", "writing", "data", "browser", "terminal", "files",
        )

        fun fromMap(map: Map<String, Any?>): AgentDescriptorInfo? {
            return AgentDescriptorInfo(
                agentId = map.boundedString("agentId", 128) ?: return null,
                name = map.boundedString("name", 160) ?: return null,
                runtime = map.boundedString("runtime", 32)?.takeIf(runtimes::contains) ?: return null,
                purpose = map.boundedString("purpose", 500) ?: return null,
                capabilities = (map["capabilities"] as? List<*>)
                    ?.filterIsInstance<String>()
                    ?.filter(supportedCapabilities::contains)
                    ?.take(8)
                    .orEmpty(),
                defaultWorkspace = map.boundedString("defaultWorkspace", 1_024),
            )
        }
    }
}

data class BrainRouteDecisionInfo(
    val id: String,
    val requestId: String,
    val action: String,
    val outcome: String,
    val createdAt: Long,
    val targetAgentId: String? = null,
    val targetSessionId: String? = null,
    val reason: String? = null,
    val confidence: Double? = null,
) {
    companion object {
        private val actions = setOf("answer", "continue_agent", "dispatch_agent")
        private val outcomes = setOf("accepted", "rejected")

        fun fromMap(map: Map<String, Any?>): BrainRouteDecisionInfo? {
            return BrainRouteDecisionInfo(
                id = map.boundedString("id", 128) ?: return null,
                requestId = map.boundedString("requestId", 128) ?: return null,
                action = map.boundedString("action", 32)?.takeIf(actions::contains) ?: return null,
                outcome = map.boundedString("outcome", 16)?.takeIf(outcomes::contains) ?: return null,
                createdAt = (map["createdAt"] as? Number)?.toLong()?.takeIf { it >= 0L } ?: return null,
                targetAgentId = map.boundedString("targetAgentId", 128),
                targetSessionId = map.boundedString("targetSessionId", 256),
                reason = map.boundedString("reason", 500),
                confidence = (map["confidence"] as? Number)?.toDouble()?.takeIf { it in 0.0..1.0 },
            )
        }
    }
}

data class BrainRunEventInfo(
    val eventId: String,
    val runId: String,
    val requestId: String,
    val type: String,
    val createdAt: Long,
    val agentId: String,
    val sessionId: String? = null,
    val summary: String? = null,
) {
    companion object {
        private val types = setOf("queued", "dispatched", "completed", "failed", "cancelled")

        fun fromMap(map: Map<String, Any?>): BrainRunEventInfo? {
            return BrainRunEventInfo(
                eventId = map.boundedString("eventId", 160) ?: return null,
                runId = map.boundedString("runId", 128) ?: return null,
                requestId = map.boundedString("requestId", 128) ?: return null,
                type = map.boundedString("type", 32)?.takeIf(types::contains) ?: return null,
                createdAt = (map["createdAt"] as? Number)?.toLong()?.takeIf { it >= 0L } ?: return null,
                agentId = map.boundedString("agentId", 128) ?: return null,
                sessionId = map.boundedString("sessionId", 256),
                summary = map.boundedString("summary", 1_000),
            )
        }
    }
}

data class BrainToolDescriptorInfo(
    val name: String,
    val label: String,
    val description: String,
    val category: String,
    val execution: String,
    val approval: String,
) {
    companion object {
        private val categories = setOf("context", "web", "files", "device", "agent")
        private val executions = setOf("direct", "worker")
        private val approvals = setOf("none", "device")

        fun fromMap(map: Map<String, Any?>): BrainToolDescriptorInfo? {
            return BrainToolDescriptorInfo(
                name = map.boundedString("name", 128) ?: return null,
                label = map.boundedString("label", 160) ?: return null,
                description = map.boundedString("description", 1_000) ?: return null,
                category = map.boundedString("category", 32)?.takeIf(categories::contains) ?: return null,
                execution = map.boundedString("execution", 32)?.takeIf(executions::contains) ?: return null,
                approval = map.boundedString("approval", 32)?.takeIf(approvals::contains) ?: return null,
            )
        }
    }
}

data class ExecutionForkEventInfo(
    val eventId: String,
    val forkId: String,
    val requestId: String,
    val phase: String,
    val createdAt: Long,
    val model: String? = null,
    val turn: Int? = null,
    val callId: String? = null,
    val toolName: String? = null,
    val summary: String? = null,
    val workflow: String? = null,
) {
    companion object {
        private val phases = setOf(
            "fork_started", "model_started", "model_completed",
            "tool_started", "tool_completed", "tool_failed",
            "fork_completed", "fork_failed", "fork_cancelled",
        )

        fun fromMap(map: Map<String, Any?>): ExecutionForkEventInfo? {
            return ExecutionForkEventInfo(
                eventId = map.boundedString("eventId", 160) ?: return null,
                forkId = map.boundedString("forkId", 128) ?: return null,
                requestId = map.boundedString("requestId", 128) ?: return null,
                phase = map.boundedString("phase", 32)?.takeIf(phases::contains) ?: return null,
                workflow = map.boundedString("workflow", 16),
                createdAt = (map["createdAt"] as? Number)?.toLong()?.takeIf { it >= 0L } ?: return null,
                model = map.boundedString("model", 128),
                turn = (map["turn"] as? Number)?.toInt()?.takeIf { it >= 0 },
                callId = map.boundedString("callId", 128),
                toolName = map.boundedString("toolName", 128),
                summary = map.boundedString("summary", 512),
            )
        }
    }
}

data class BrainDeliverableInfo(
    val id: String,
    val runId: String,
    val kind: String,
    val title: String,
    val createdAt: Long,
    val sessionId: String? = null,
    val url: String? = null,
    val path: String? = null,
) {
    val isOpenable: Boolean get() = !url.isNullOrBlank() || !sessionId.isNullOrBlank()

    companion object {
        private val kinds = setOf("preview", "report", "canvas", "diff", "file", "link")

        fun fromMap(map: Map<String, Any?>): BrainDeliverableInfo? {
            val url = map.boundedString("url", 2_048)?.takeIf { it.startsWith("https://") }
            val path = map.boundedString("path", 1_024)
            if (url == null && path == null) return null
            return BrainDeliverableInfo(
                id = map.boundedString("id", 160) ?: return null,
                runId = map.boundedString("runId", 128) ?: return null,
                kind = map.boundedString("kind", 32)?.takeIf(kinds::contains) ?: return null,
                title = map.boundedString("title", 200) ?: return null,
                createdAt = (map["createdAt"] as? Number)?.toLong()?.takeIf { it >= 0L } ?: return null,
                sessionId = map.boundedString("sessionId", 256),
                url = url,
                path = path,
            )
        }
    }
}

data class BrainConversationSummaryInfo(
    val id: String,
    val title: String,
    val createdAt: Long,
    val updatedAt: Long,
    val messageCount: Int,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>): BrainConversationSummaryInfo? {
            val id = map.boundedString("id", 128) ?: return null
            val title = map.boundedString("title", 160) ?: return null
            return BrainConversationSummaryInfo(
                id = id,
                title = title,
                createdAt = (map["createdAt"] as? Number)?.toLong()?.coerceAtLeast(0L) ?: 0L,
                updatedAt = (map["updatedAt"] as? Number)?.toLong()?.coerceAtLeast(0L) ?: 0L,
                messageCount = (map["messageCount"] as? Number)?.toInt()?.coerceAtLeast(0) ?: 0,
            )
        }
    }
}

data class BrainConversationHistoryInfo(
    val summary: BrainConversationSummaryInfo,
    val messages: List<BrainMessageInfo>,
    val tasks: List<BrainTaskInfo>,
    val toolResults: List<BrainToolResultInfo>,
    val routeDecisions: List<BrainRouteDecisionInfo>,
    val runEvents: List<BrainRunEventInfo>,
    val deliverables: List<BrainDeliverableInfo>,
    val executionEvents: List<ExecutionForkEventInfo>,
) {
    companion object {
        @Suppress("UNCHECKED_CAST")
        fun fromMap(map: Map<String, Any?>): BrainConversationHistoryInfo? {
            val summary = BrainConversationSummaryInfo.fromMap(map) ?: return null
            return BrainConversationHistoryInfo(
                summary = summary,
                messages = (map["messages"] as? List<*>)
                    ?.takeLast(200)
                    ?.mapNotNull { BrainMessageInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
                    .orEmpty(),
                tasks = (map["tasks"] as? List<*>)
                    ?.takeLast(100)
                    ?.mapNotNull { BrainTaskInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
                    .orEmpty(),
                toolResults = (map["toolResults"] as? List<*>)
                    ?.takeLast(100)
                    ?.mapNotNull { BrainToolResultInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
                    .orEmpty(),
                routeDecisions = (map["routeDecisions"] as? List<*>)
                    ?.takeLast(100)
                    ?.mapNotNull { BrainRouteDecisionInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
                    .orEmpty(),
                runEvents = (map["runEvents"] as? List<*>)
                    ?.takeLast(300)
                    ?.mapNotNull { BrainRunEventInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
                    .orEmpty(),
                deliverables = (map["deliverables"] as? List<*>)
                    ?.takeLast(100)
                    ?.mapNotNull { BrainDeliverableInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
                    .orEmpty(),
                executionEvents = (map["executionEvents"] as? List<*>)
                    ?.takeLast(300)
                    ?.mapNotNull { ExecutionForkEventInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
                    .orEmpty(),
            )
        }
    }
}

data class VoiceUsageInfo(
    val responseCount: Int,
    val estimatedCostCny: Double,
    val totalTokens: Long,
    val inputAudioSeconds: Double,
    val outputAudioSeconds: Double,
    val updatedAt: String? = null,
) {
    companion object {
        fun fromMap(map: Map<String, Any?>): VoiceUsageInfo? {
            val responseCount = (map["responseCount"] as? Number)?.toInt() ?: return null
            val estimatedCostCny = (map["estimatedCostCny"] as? Number)?.toDouble() ?: return null
            return VoiceUsageInfo(
                responseCount = responseCount,
                estimatedCostCny = estimatedCostCny,
                totalTokens = (map["totalTokens"] as? Number)?.toLong() ?: 0L,
                inputAudioSeconds = (map["inputAudioSeconds"] as? Number)?.toDouble() ?: 0.0,
                outputAudioSeconds = (map["outputAudioSeconds"] as? Number)?.toDouble() ?: 0.0,
                updatedAt = map["updatedAt"] as? String,
            )
        }
    }
}

data class VoiceToolViewItemInfo(
    val id: String,
    val title: String,
    val subtitle: String? = null,
    val detail: String? = null,
    val status: String? = null,
    val timestamp: Long? = null,
    val sessionId: String? = null,
    val source: String? = null,
) {
    val isOpenable: Boolean get() = !sessionId.isNullOrBlank()

    companion object {
        fun fromMap(map: Map<String, Any?>): VoiceToolViewItemInfo? {
            val id = map.boundedString("id", 128) ?: return null
            val title = map.boundedString("title", 160) ?: return null
            val source = map.boundedString("source", 16)?.takeIf { it == "pty" || it == "herdr" }
            return VoiceToolViewItemInfo(
                id = id,
                title = title,
                subtitle = map.boundedString("subtitle", 256),
                detail = map.boundedString("detail", 600),
                status = map.boundedString("status", 64),
                timestamp = (map["timestamp"] as? Number)?.toLong()?.takeIf { it >= 0L },
                sessionId = map.boundedString("sessionId", 128),
                source = source,
            )
        }
    }
}

data class VoiceToolViewInfo(
    val kind: String,
    val title: String,
    val items: List<VoiceToolViewItemInfo>,
) {
    companion object {
        private val supportedKinds = setOf("agent_list", "completion_list", "task_list", "agent", "receipt")

        @Suppress("UNCHECKED_CAST")
        fun fromMap(map: Map<String, Any?>): VoiceToolViewInfo? {
            val kind = map.boundedString("kind", 32)?.takeIf(supportedKinds::contains) ?: return null
            val title = map.boundedString("title", 160) ?: return null
            val items = (map["items"] as? List<*>)
                ?.take(8)
                ?.mapNotNull { VoiceToolViewItemInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
                .orEmpty()
            return VoiceToolViewInfo(kind, title, items)
        }
    }
}

data class BrainToolResultInfo(
    val id: String,
    val requestId: String,
    val callId: String,
    val toolName: String,
    val createdAt: Long,
    val view: VoiceToolViewInfo,
) {
    companion object {
        @Suppress("UNCHECKED_CAST")
        fun fromMap(map: Map<String, Any?>): BrainToolResultInfo? {
            val view = (map["view"] as? Map<String, Any?>)?.let(VoiceToolViewInfo::fromMap) ?: return null
            return BrainToolResultInfo(
                id = map.boundedString("id", 128) ?: return null,
                requestId = map.boundedString("requestId", 128) ?: return null,
                callId = map.boundedString("callId", 128) ?: return null,
                toolName = map.boundedString("toolName", 128) ?: return null,
                createdAt = (map["createdAt"] as? Number)?.toLong()?.takeIf { it >= 0L } ?: return null,
                view = view,
            )
        }
    }
}

data class ControlMessage(
    val type: String,
    val fields: Map<String, Any?>,
) {
    // peer_call_result is a Host->client RPC receipt, not an instruction for this
    // phone to execute a tool. Android keeps its existing native-tool allowlist.
    fun peerCallResult(): Map<String, Any?>? =
        if (type == "peer_call_result" && !string("id").isNullOrEmpty() && boolean("ok") != null) fields else null
    // attach/attach_ok negotiate nativeTerminal=true for desktop terminal streams.
    // Mobile clients leave it unset and retain the mobile presentation contract.
    val nativeTerminal: Boolean get() = boolean("nativeTerminal") == true
    // Optional compatible-terminal history; absence means the Host does not support it.
    val historyScroll: Boolean get() = boolean("historyScroll") == true

    fun string(name: String): String? = fields[name] as? String
    fun int(name: String): Int? = (fields[name] as? Number)?.toInt()
    fun boolean(name: String): Boolean? = fields[name] as? Boolean
    fun bytes(name: String): ByteArray? = fields[name] as? ByteArray

    fun relayTopology(): RelayTopologyInfo? = if (type == "relay_topology") RelayTopologyInfo.fromMap(fields) else null

    fun hostNetworkPolicy(): HostNetworkPolicyInfo? {
        if (type != "network_policy_result") return null
        return HostNetworkPolicyInfo(
            policy = HostNetworkPolicy.fromWire(string("policy")),
            changed = boolean("changed") ?: false,
            proxyDetected = boolean("proxyDetected") ?: false,
        )
    }

    @Suppress("UNCHECKED_CAST")
    fun stringList(name: String): List<String> =
        (fields[name] as? List<*>)?.filterIsInstance<String>().orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun sessions(): List<SessionInfo> =
        (fields["sessions"] as? List<*>)
            ?.mapNotNull { SessionInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun hosts(): List<HostInfo> =
        (fields["hosts"] as? List<*>)
            ?.mapNotNull { HostInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun agentRegistry(): List<AgentDescriptorInfo> =
        (fields["agentRegistry"] as? List<*>)
            ?.take(100)
            ?.mapNotNull { AgentDescriptorInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainMessages(): List<BrainMessageInfo> =
        (fields["messages"] as? List<*>)
            ?.mapNotNull { BrainMessageInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainTasks(): List<BrainTaskInfo> =
        (fields["tasks"] as? List<*>)
            ?.mapNotNull { BrainTaskInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainToolResults(): List<BrainToolResultInfo> =
        (fields["toolResults"] as? List<*>)
            ?.takeLast(100)
            ?.mapNotNull { BrainToolResultInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainRouteDecisions(): List<BrainRouteDecisionInfo> =
        (fields["routeDecisions"] as? List<*>)
            ?.takeLast(100)
            ?.mapNotNull { BrainRouteDecisionInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainRunEvents(): List<BrainRunEventInfo> =
        (fields["runEvents"] as? List<*>)
            ?.takeLast(300)
            ?.mapNotNull { BrainRunEventInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainDeliverables(): List<BrainDeliverableInfo> =
        (fields["deliverables"] as? List<*>)
            ?.takeLast(100)
            ?.mapNotNull { BrainDeliverableInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainToolCatalog(): List<BrainToolDescriptorInfo> =
        (fields["toolCatalog"] as? List<*>)
            ?.take(32)
            ?.mapNotNull { BrainToolDescriptorInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainExecutionEvents(): List<ExecutionForkEventInfo> =
        (fields["executionEvents"] as? List<*>)
            ?.takeLast(300)
            ?.mapNotNull { ExecutionForkEventInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null) }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainExecutionEvent(): ExecutionForkEventInfo? =
        (fields["event"] as? Map<String, Any?>)?.let(ExecutionForkEventInfo::fromMap)

    @Suppress("UNCHECKED_CAST")
    fun brainHistory(): List<BrainConversationSummaryInfo> =
        (fields["history"] as? List<*>)
            ?.takeLast(30)
            ?.mapNotNull {
                BrainConversationSummaryInfo.fromMap(it as? Map<String, Any?> ?: return@mapNotNull null)
            }
            .orEmpty()

    @Suppress("UNCHECKED_CAST")
    fun brainHistoryConversation(): BrainConversationHistoryInfo? =
        (fields["conversation"] as? Map<String, Any?>)?.let(BrainConversationHistoryInfo::fromMap)

    @Suppress("UNCHECKED_CAST")
    fun voiceUsage(): VoiceUsageInfo? =
        (fields["voiceUsage"] as? Map<String, Any?>)?.let(VoiceUsageInfo::fromMap)

    @Suppress("UNCHECKED_CAST")
    fun voiceToolView(): VoiceToolViewInfo? =
        (fields["view"] as? Map<String, Any?>)?.let(VoiceToolViewInfo::fromMap)

    @Suppress("UNCHECKED_CAST")
    fun reviewSnapshot(): ReviewSnapshotInfo? =
        (fields["snapshot"] as? Map<String, Any?>)?.let(ReviewSnapshotInfo::fromMap)

    /** `review_repositories_result`: the conversation's repositories, current first. */
    @Suppress("UNCHECKED_CAST")
    fun reviewRepositories(): List<ReviewRepositoryInfo> =
        (fields["repositories"] as? List<*>)?.take(12)?.mapNotNull { raw ->
            (raw as? Map<String, Any?>)?.let(ReviewRepositoryInfo::fromMap)
        }.orEmpty()
}

private fun Map<String, Any?>.boundedString(name: String, maxLength: Int): String? =
    (this[name] as? String)?.trim()?.takeIf { it.isNotEmpty() }?.take(maxLength)

sealed interface IncomingFrame {
    data class Control(val message: ControlMessage) : IncomingFrame
    data class PtyOutput(val sid: Int, val data: ByteArray) : IncomingFrame
    data class PtyInput(val sid: Int, val data: ByteArray) : IncomingFrame
    data class Resize(val sid: Int, val cols: Int, val rows: Int) : IncomingFrame
}

/** Read-only workspace file transfer; offsets are bytes and the version must remain stable. */
object SessionFileProtocol {
    /** Explicit Global previews are confined to the Host's configured projects root. */
    const val GLOBAL_SESSION = "@global"
    const val NATIVE_SCROLL = "session_scroll"
    const val DIRECTORY_LIST = "session_directory_list"
    const val DIRECTORY_RESULT = "session_directory_result"
    const val READ = "session_file_read"
    const val RESULT = "session_file_result"
    /** `revision` value that reads the committed file instead of the working copy. */
    const val REVISION_HEAD = "HEAD"
    const val MAX_CHUNK_BYTES = 128 * 1024
    const val MAX_FILE_BYTES = 20 * 1024 * 1024
}
data class SessionFileChunk(
    val requestId: String, val sessionId: String, val name: String,
    val size: Long, val version: String, val offset: Long, val data: ByteArray, val eof: Boolean,
    val path: String? = null, val rootPath: String? = null,
)

data class SessionDirectoryEntry(val name: String, val directory: Boolean)
data class SessionDirectoryResult(
    val requestId: String, val sessionId: String, val path: String?, val rootPath: String?,
    val entries: List<SessionDirectoryEntry>, val truncated: Boolean, val error: String?,
)
