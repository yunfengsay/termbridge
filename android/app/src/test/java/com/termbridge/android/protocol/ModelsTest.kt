package com.termbridge.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class ModelsTest {
    @Test
    fun `topology requires its self node and complete relay edges`() {
        val nodes = listOf(
            mapOf("id" to "relay:r", "role" to "relay", "name" to "Mini", "connections" to 1),
            mapOf("id" to "client:c", "role" to "client", "name" to "Phone", "connections" to 2),
        )
        val fields = mapOf("relayId" to "relay:r", "selfNodeId" to "client:c", "generatedAt" to 1234L,
            "nodes" to nodes, "edges" to listOf(mapOf("from" to "client:c", "to" to "relay:r")), "truncated" to false)
        val parsed = ControlMessage("relay_topology", fields).relayTopology()
        assertEquals("client:c", parsed?.selfNodeId)
        assertEquals(2, parsed?.nodes?.last()?.connections)
        assertEquals(null, ControlMessage("relay_topology", fields + ("selfNodeId" to "missing")).relayTopology())
        assertEquals(null, ControlMessage("relay_topology", fields + ("edges" to emptyList<Any>())).relayTopology())
        assertEquals(null, ControlMessage("host_list_result", fields).relayTopology())
    }

    @Test
    fun `parses a conversation's repositories with touched files and drops invalid ones`() {
        val message = ControlMessage(
            type = "review_repositories_result",
            fields = mapOf(
                "repositories" to listOf(
                    mapOf(
                        "repository" to "termbridge",
                        "repositoryPath" to "/code/termbridge",
                        "branch" to "master",
                        "detached" to false,
                        "current" to true,
                        "files" to listOf(
                            mapOf("path" to "art/logo.png", "status" to "modified", "additions" to 0,
                                "deletions" to 0, "binary" to true, "truncated" to false),
                            mapOf("path" to ".env", "status" to "untracked", "binary" to false,
                                "truncated" to false, "private" to true),
                            mapOf("path" to "bad.txt", "status" to "exploded"),
                        ),
                        "changedFileCount" to 1,
                        "additions" to 0,
                        "deletions" to 0,
                        "truncated" to false,
                        "touched" to listOf("art/logo.png", "", 7),
                    ),
                    mapOf("repository" to "missing-path"),
                ),
            ),
        )

        val repositories = message.reviewRepositories()
        assertEquals(1, repositories.size)
        val repository = repositories.single()
        assertEquals(true, repository.current)
        assertEquals(listOf("art/logo.png", ".env"), repository.files.map { it.path })
        assertEquals(listOf(true, false), repository.files.map { it.binary })
        assertEquals(listOf(false, true), repository.files.map { it.isPrivate })
        assertEquals(emptyList<ReviewHunkInfo>(), repository.files.first().hunks)
        assertEquals(listOf("art/logo.png"), repository.touched)
        assertEquals("HEAD", SessionFileProtocol.REVISION_HEAD)
    }

    @Test
    fun `parses bounded mobile review snapshots`() {
        val message = ControlMessage(
            type = "review_snapshot_result",
            fields = mapOf(
                "snapshot" to mapOf(
                    "repository" to "termbridge",
                    "repositoryPath" to "/code/termbridge",
                    "branch" to "feature/review",
                    "detached" to false,
                    "mode" to "working",
                    "dirty" to true,
                    "canSwitchBranch" to false,
                    "branches" to listOf("feature/review", "main"),
                    "files" to listOf(
                        mapOf(
                            "path" to "src/index.ts",
                            "status" to "modified",
                            "additions" to 1,
                            "deletions" to 1,
                            "binary" to false,
                            "truncated" to false,
                            "hunks" to listOf(
                                mapOf(
                                    "header" to "@@ -1 +1 @@",
                                    "oldStart" to 1,
                                    "oldLines" to 1,
                                    "newStart" to 1,
                                    "newLines" to 1,
                                    "lines" to listOf(
                                        mapOf("kind" to "delete", "oldLine" to 1, "text" to "before"),
                                        mapOf("kind" to "add", "newLine" to 1, "text" to "after"),
                                    ),
                                ),
                            ),
                        ),
                    ),
                    "changedFileCount" to 1,
                    "additions" to 1,
                    "deletions" to 1,
                    "truncated" to false,
                ),
            ),
        )

        val snapshot = message.reviewSnapshot()
        assertEquals("termbridge", snapshot?.repository)
        assertEquals("after", snapshot?.files?.single()?.hunks?.single()?.lines?.last()?.text)
        assertEquals(false, snapshot?.canSwitchBranch)
    }

    @Test
    fun `parses project file snapshots and unchanged entries`() {
        val snapshot = ReviewSnapshotInfo.fromMap(
            mapOf(
                "repository" to "termbridge",
                "repositoryPath" to "/code/termbridge",
                "branch" to "main",
                "detached" to false,
                "mode" to "files",
                "dirty" to false,
                "canSwitchBranch" to true,
                "branches" to listOf("main"),
                "files" to listOf(
                    mapOf(
                        "path" to "src/index.ts",
                        "status" to "unchanged",
                        "additions" to 0,
                        "deletions" to 0,
                        "binary" to false,
                        "truncated" to false,
                        "hunks" to emptyList<Any>(),
                    ),
                ),
                "changedFileCount" to 1,
                "additions" to 0,
                "deletions" to 0,
                "truncated" to false,
            ),
        )

        assertEquals("files", snapshot?.mode)
        assertEquals("unchanged", snapshot?.files?.single()?.status)
    }

    @Test
    fun `parses the observed completion timestamp`() {
        val session = SessionInfo.fromMap(
            mapOf(
                "sessionId" to "herdr:w1:p1",
                "command" to "project · codex",
                "completedAt" to 1_772_320_000_000L,
            ),
        )

        assertEquals(1_772_320_000_000L, session?.completedAt)
    }

    @Test
    fun `parses brain snapshot entries`() {
        val message = ControlMessage(
            type = "brain_snapshot_result",
            fields = mapOf(
                "messages" to listOf(
                    mapOf(
                        "id" to "request-1",
                        "role" to "user",
                        "text" to "Ship the release",
                        "createdAt" to 1_772_320_000_000L,
                    ),
                ),
                "tasks" to listOf(
                    mapOf(
                        "taskId" to "brain-request-1",
                        "requestId" to "request-1",
                        "text" to "Ship the release",
                        "agent" to "codex",
                        "status" to "dispatched",
                        "createdAt" to 1_772_320_000_000L,
                        "updatedAt" to 1_772_320_001_000L,
                        "sessionId" to "session-1",
                    ),
                ),
                "routeDecisions" to listOf(
                    mapOf(
                        "id" to "route-1",
                        "requestId" to "request-1",
                        "action" to "dispatch_agent",
                        "outcome" to "accepted",
                        "createdAt" to 1_772_320_000_500L,
                        "targetAgentId" to "codex",
                        "confidence" to 0.9,
                    ),
                ),
                "runEvents" to listOf(
                    mapOf(
                        "eventId" to "brain-request-1:dispatched",
                        "runId" to "brain-request-1",
                        "requestId" to "request-1",
                        "type" to "dispatched",
                        "createdAt" to 1_772_320_001_000L,
                        "agentId" to "codex",
                        "sessionId" to "session-1",
                    ),
                ),
                "deliverables" to listOf(
                    mapOf(
                        "id" to "deliverable-1",
                        "runId" to "brain-request-1",
                        "kind" to "preview",
                        "title" to "Web preview",
                        "createdAt" to 1_772_320_002_000L,
                        "sessionId" to "session-1",
                        "url" to "https://example.test/preview",
                    ),
                ),
            ),
        )

        assertEquals("Ship the release", message.brainMessages().single().text)
        assertEquals("session-1", message.brainTasks().single().sessionId)
        assertEquals("codex", message.brainRouteDecisions().single().targetAgentId)
        assertEquals("dispatched", message.brainRunEvents().single().type)
        assertEquals("https://example.test/preview", message.brainDeliverables().single().url)
    }

    @Test
    fun `parses local voice usage estimate from brain snapshot`() {
        val message = ControlMessage(
            type = "brain_snapshot_result",
            fields = mapOf(
                "voiceUsage" to mapOf(
                    "source" to "local_estimate",
                    "responseCount" to 12,
                    "estimatedCostCny" to 1.2345,
                    "totalTokens" to 9_876L,
                    "inputAudioSeconds" to 32.5,
                    "outputAudioSeconds" to 44.0,
                ),
            ),
        )

        assertEquals(12, message.voiceUsage()?.responseCount)
        assertEquals(1.2345, message.voiceUsage()?.estimatedCostCny ?: 0.0, 0.00001)
    }

    @Test
    fun `parses tool catalog and execution fork events`() {
        val snapshot = ControlMessage(
            type = "brain_snapshot_result",
            fields = mapOf(
                "toolCatalog" to listOf(mapOf(
                    "name" to "dispatch_agent",
                    "label" to "Dispatch Agent",
                    "description" to "Create a worker run.",
                    "category" to "agent",
                    "execution" to "worker",
                    "approval" to "none",
                )),
                "executionEvents" to listOf(mapOf(
                    "eventId" to "fork-1:tool:1:tool_started",
                    "forkId" to "fork-1",
                    "requestId" to "request-1",
                    "phase" to "tool_started",
                    "createdAt" to 123L,
                    "model" to "qwen3.8-flash",
                    "callId" to "call-1",
                    "toolName" to "dispatch_agent",
                    "summary" to "正在派发 Agent",
                )),
            ),
        )
        assertEquals("worker", snapshot.brainToolCatalog().single().execution)
        assertEquals("dispatch_agent", snapshot.brainExecutionEvents().single().toolName)

        val update = ControlMessage("brain_execution_event", mapOf(
            "event" to mapOf(
                "eventId" to "fork-1:2",
                "forkId" to "fork-1",
                "requestId" to "request-1",
                "phase" to "fork_completed",
                "createdAt" to 456L,
            ),
        ))
        assertEquals("fork_completed", update.brainExecutionEvent()?.phase)
    }

    @Test
    fun `parses bounded voice tool cards with clickable Agent identity`() {
        val message = ControlMessage(
            type = "brain_voice_tool_result",
            fields = mapOf(
                "view" to mapOf(
                    "kind" to "agent_list",
                    "title" to "Agents",
                    "items" to (0 until 10).map { index ->
                        mapOf(
                            "id" to "herdr:w$index:p1",
                            "title" to if (index == 0) "termbridge" else "workspace-$index",
                            "subtitle" to "codex · herdr:w$index:p1",
                            "detail" to "Working on tool cards",
                            "status" to "working",
                            "sessionId" to "herdr:w$index:p1",
                            "source" to "herdr",
                        )
                    },
                ),
            ),
        )

        val view = message.voiceToolView()
        assertEquals("agent_list", view?.kind)
        assertEquals(8, view?.items?.size)
        assertEquals("herdr:w0:p1", view?.items?.first()?.sessionId)
        assertEquals(true, view?.items?.first()?.isOpenable)
    }

    @Test
    fun `rejects unknown voice tool card kinds and malformed items`() {
        val unknown = ControlMessage(
            type = "brain_voice_tool_result",
            fields = mapOf("view" to mapOf("kind" to "arbitrary_ui", "title" to "Unsafe", "items" to emptyList<Any>())),
        )
        assertEquals(null, unknown.voiceToolView())

        val malformed = ControlMessage(
            type = "brain_voice_tool_result",
            fields = mapOf("view" to mapOf("kind" to "agent_list", "title" to "Agents", "items" to listOf(mapOf("title" to "Missing id")))),
        )
        assertEquals(0, malformed.voiceToolView()?.items?.size)
    }

    @Test
    fun `parses durable voice tool cards from a Global snapshot`() {
        val message = ControlMessage(
            type = "brain_snapshot_result",
            fields = mapOf(
                "toolResults" to listOf(
                    mapOf(
                        "id" to "voice-1-tool-call-1",
                        "requestId" to "voice-1",
                        "callId" to "call-1",
                        "toolName" to "list_agents",
                        "createdAt" to 150L,
                        "view" to mapOf(
                            "kind" to "agent_list",
                            "title" to "Agents",
                            "items" to listOf(
                                mapOf(
                                    "id" to "herdr:wA:p1",
                                    "title" to "termbridge",
                                    "sessionId" to "herdr:wA:p1",
                                    "source" to "herdr",
                                ),
                            ),
                        ),
                    ),
                ),
            ),
        )

        val result = message.brainToolResults().single()
        assertEquals("voice-1", result.requestId)
        assertEquals("herdr:wA:p1", result.view.items.single().sessionId)
    }

    @Test
    fun `parses Global history summaries and archived timelines`() {
        val summary = mapOf(
            "id" to "conversation-1",
            "title" to "Review the Android voice flow",
            "createdAt" to 100L,
            "updatedAt" to 200L,
            "messageCount" to 2,
        )
        val snapshot = ControlMessage(
            type = "brain_snapshot_result",
            fields = mapOf("history" to listOf(summary)),
        )
        val history = ControlMessage(
            type = "brain_history_result",
            fields = mapOf(
                "conversation" to summary + mapOf(
                    "messages" to listOf(
                        mapOf("id" to "user-1", "role" to "user", "text" to "Review it", "createdAt" to 100L),
                    ),
                    "tasks" to emptyList<Any>(),
                    "toolResults" to emptyList<Any>(),
                ),
            ),
        )

        assertEquals("Review the Android voice flow", snapshot.brainHistory().single().title)
        assertEquals("Review it", history.brainHistoryConversation()?.messages?.single()?.text)
    }
}
