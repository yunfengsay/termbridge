import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class MacAgentChatSessionTests: XCTestCase {
    @MainActor
    func testDraftCacheUsesEndpointHostAndSessionRatherThanTransientProfileID() {
        let endpoint = "ws://example.invalid/" + UUID().uuidString
        let settings = ConnectionSettings(relayURL: endpoint, hostID: "host-a", secret: "", tlsFingerprint: "")
        let first = MacAgentChatSession(sessionID: "herdr:test:p1", settings: settings)
        first.composer.draft = "保留的草稿"
        let reopened = MacAgentChatSession(sessionID: "herdr:test:p1", settings:
            ConnectionSettings(relayURL: endpoint, hostID: "host-a", secret: "", tlsFingerprint: ""))
        XCTAssertEqual(reopened.composer.draft, "保留的草稿")
        let otherHost = MacAgentChatSession(sessionID: "herdr:test:p1", settings:
            ConnectionSettings(relayURL: endpoint, hostID: "host-b", secret: "", tlsFingerprint: ""))
        XCTAssertEqual(otherHost.composer.draft, "")
        XCTAssertEqual(MacAgentChatSession(sessionID: "herdr:test:p2", settings: settings).composer.draft, "")
        let otherEndpoint = MacAgentChatSession(sessionID: "herdr:test:p1", settings:
            ConnectionSettings(relayURL: endpoint + "-other", hostID: "host-a", secret: "", tlsFingerprint: ""))
        XCTAssertEqual(otherEndpoint.composer.draft, "")
    }

    @MainActor
    func testClosingAnUnconfirmedSendPreservesItsTextWithoutOfferingAutomaticRetry() {
        let session = MacAgentChatSession(sessionID: UUID().uuidString, settings: .defaults)
        session.composer.draft = "需要确认"
        session.composer.begin(requestID: "request-a", generation: 3)
        session.stop()
        XCTAssertEqual(session.composer.state, .uncertain)
        XCTAssertEqual(session.composer.draft, "需要确认")
        XCTAssertFalse(session.composer.pending)
        XCTAssertFalse(session.composer.canRetry)
        XCTAssertFalse(session.canSend)
        XCTAssertTrue(session.receiptLabel?.contains("结果未知") == true)
        session.send()
        XCTAssertEqual(session.composer.requestID, "request-a", "A closed viewer must not start another send")
    }

    @MainActor
    func testInvalidSettingsFailBeforeAnyConnectionAndIgnoreForeignClientCallbacks() {
        let settings = ConnectionSettings(relayURL: "invalid-url", hostID: "test", secret: "", tlsFingerprint: "")
        let session = MacAgentChatSession(sessionID: UUID().uuidString, settings: settings)
        var failures: [String] = []
        session.onUnavailable = { failures.append($0) }
        session.start()
        XCTAssertEqual(failures.count, 1)
        XCTAssertNotNil(session.unavailable)
        XCTAssertFalse(session.connected)
        let foreign = TermbridgeClient(settings: settings, listener: session)
        session.clientIsReady(foreign)
        session.client(foreign, receivedControl: ControlMessage(fields: ["t": .string(AgentChatProtocol.snapshot)]))
        XCTAssertFalse(session.connected)
        XCTAssertFalse(session.canSend)
        XCTAssertEqual(failures.count, 1)
        session.stop()
    }

    @MainActor
    func testNotificationCannotOpenADifferentConversation() {
        let agent = AgentRecord(sessionId: "herdr:test:original", source: "herdr", name: "Fixture", workspace: nil,
            paneId: nil, agent: "codex", status: "ready", preview: nil, lastSeenAt: 0,
            statusChangedAt: 0, present: true, createdAt: nil)
        let route = MacNotificationRoute(agent: agent, profile: nil)
        let session = MacAgentChatSession(sessionID: "herdr:test:other", settings: .defaults, notificationRoute: route)
        session.start()
        XCTAssertTrue(session.unavailable?.contains("不一致") == true)
        XCTAssertFalse(session.connected)
        session.stop()
    }

    // MARK: - Subscription state machine

    /// Collects what the viewer writes so a test can answer with the Host's real
    /// replies instead of standing up a relay.
    private final class FakeChatTransport: AgentChatTransport {
        private(set) var sent: [[String: MessagePackValue]] = []
        private(set) var connectCount = 0
        private(set) var disconnectCount = 0
        func connect() { connectCount += 1 }
        func disconnect() { disconnectCount += 1 }
        func sendControl(_ fields: [String: MessagePackValue]) -> Bool { sent.append(fields); return true }
        func last(_ type: String) -> [String: MessagePackValue]? {
            sent.last { $0["t"]?.stringValue == type }
        }
        func count(_ type: String) -> Int { sent.filter { $0["t"]?.stringValue == type }.count }
    }

    private static let fixtureSettings = ConnectionSettings(
        relayURL: "ws://127.0.0.1:7400", hostID: "fixture-host", secret: "", tlsFingerprint: "")

    @MainActor
    func testOpaqueFileRequiresCapabilityAndReturnsReceiptOnSameSubscription() throws {
        let (session, transport, subscription, _) = try liveSession(conversationID: "herdr:fixture:files")
        defer { session.stop() }
        let generation = try XCTUnwrap(subscription["generation"]?.intValue)
        var fields: [String: MessagePackValue] = [
            "t": .string(AgentChatProtocol.snapshot), "conversationId": .string(session.conversationID),
            "requestId": subscription["requestId"]!, "generation": .int(Int64(generation)),
            "status": .string("ready"), "messages": .array([]),
            "capabilities": .map(["send": .bool(true), "attachments": .bool(true), "history": .bool(true)])]
        session.receive(ControlMessage(fields: fields))
        let file = TerminalImage(data: Data("hello\n".utf8), mime: "application/octet-stream", fileName: "note.txt")
        let id = UUID()
        XCTAssertFalse(session.upload(id: id, image: file), "old Host must not receive an unsupported control frame")
        XCTAssertEqual(transport.count("session_upload"), 0)
        fields["capabilities"] = .map(["send": .bool(true), "attachments": .bool(true),
            "fileAttachments": .bool(true), "history": .bool(true)])
        session.receive(ControlMessage(fields: fields))
        XCTAssertTrue(session.upload(id: id, image: file))
        let sent = try XCTUnwrap(transport.last("session_upload"))
        XCTAssertEqual(sent["fileName"]?.stringValue, "note.txt")
        XCTAssertEqual(sent["data"], .binary(file.data))
        var receipt: ControlMessage?
        session.onUploadResult = { receipt = $0 }
        session.receive(ControlMessage(fields: ["t": .string("session_upload_result"),
            "sessionId": .string(session.conversationID), "id": .string(id.uuidString),
            "path": .string("/tmp/fixture/note.txt")]))
        XCTAssertEqual(receipt?.string("path"), "/tmp/fixture/note.txt")
    }

    private func listResult(requestID: String, conversationID: String, chat: Bool = true) -> ControlMessage {
        ControlMessage(fields: ["t": .string(AgentChatProtocol.listResult), "requestId": .string(requestID),
            "conversations": .array([.map(["conversationId": .string(conversationID), "paneId": .string("p1"),
                "status": .string("ready"), "chat": .bool(chat)])])])
    }

    private func snapshot(requestID: String, conversationID: String, generation: Int,
                          texts: [String], status: String = "ready") -> ControlMessage {
        ControlMessage(fields: ["t": .string(AgentChatProtocol.snapshot), "requestId": .string(requestID),
            "conversationId": .string(conversationID), "generation": .int(Int64(generation)),
            "status": .string(status),
            "capabilities": .map(["send": .bool(true), "history": .bool(true)]),
            "messages": .array(texts.enumerated().map { index, text in
                .map(["id": .string("m\(index)"), "seq": .int(Int64(index + 1)), "role": .string("assistant"),
                      "blocks": .array([.map(["type": .string("text"), "text": .string(text)])])])
            })])
    }

    private func renderedTexts(_ payload: [String: Any]?) -> [String] {
        guard let messages = payload?["messages"] as? [[String: Any]] else { return [] }
        return messages.compactMap { message in
            (message["blocks"] as? [[String: Any]])?.first?["text"] as? String
        }
    }

    /// Brings a viewer to a live subscription without touching the network.
    @MainActor
    private func liveSession(conversationID: String = "herdr:test:p1")
        throws -> (MacAgentChatSession, FakeChatTransport, [String: MessagePackValue], Box) {
        let transport = FakeChatTransport()
        let session = MacAgentChatSession(sessionID: conversationID, settings: Self.fixtureSettings)
        session.makeTransport = { _, _ in transport }
        let surface = Box()
        session.onSurface = { surface.payloads.append($0) }
        session.start()
        session.surfaceReady()
        session.transportIsReady()
        let list = try XCTUnwrap(transport.last(AgentChatProtocol.list))
        session.receive(listResult(requestID: try XCTUnwrap(list["requestId"]?.stringValue),
                                   conversationID: conversationID))
        let subscribe = try XCTUnwrap(transport.last(AgentChatProtocol.subscribe))
        return (session, transport, subscribe, surface)
    }

    private func snapshotWithAttachments(requestID: String, conversationID: String, generation: Int,
                                        attachments: Bool) -> ControlMessage {
        ControlMessage(fields: ["t": .string(AgentChatProtocol.snapshot), "requestId": .string(requestID),
            "conversationId": .string(conversationID), "generation": .int(Int64(generation)),
            "status": .string("ready"),
            "capabilities": .map(["send": .bool(true), "history": .bool(true),
                                  "attachments": .bool(attachments)]),
            "messages": .array([])])
    }

    /// Wires a real queue to a real session exactly as the composer does.
    @MainActor
    private func liveQueue(_ session: MacAgentChatSession) -> TerminalAttachments {
        let queue = TerminalAttachments(sessionID: session.conversationID, remote: true, timeout: 5)
        queue.isConnected = { session.acceptsAttachments }
        queue.canUpload = { session.canAttach }
        queue.upload = { id, image in session.upload(id: id, image: image) }
        session.onUploadsAllowed = { queue.uploadsAllowed() }
        session.onConnectionLost = { queue.connectionLost() }
        session.onUploadResult = { queue.receive($0) }
        session.onUploadExpired = { queue.expire($0) }
        return queue
    }

    /// Encoding runs off the main actor; the draft is not ready until it lands.
    @MainActor
    private func waitForEncoding(_ queue: TerminalAttachments, count: Int) async throws {
        for _ in 0..<200 where queue.items.prefix(count).contains(where: { $0.image == nil }) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(queue.items.filter { $0.image != nil }.count, count, "the picture never finished encoding")
    }

    /// Drives a fresh handshake on a new socket and returns its subscribe frame.
    @MainActor
    private func handshake(_ session: MacAgentChatSession, _ transport: FakeChatTransport,
                           conversationID: String) throws -> [String: MessagePackValue] {
        session.transportIsReady()
        let list = try XCTUnwrap(transport.last(AgentChatProtocol.list))
        session.receive(listResult(requestID: try XCTUnwrap(list["requestId"]?.stringValue),
                                   conversationID: conversationID))
        return try XCTUnwrap(transport.last(AgentChatProtocol.subscribe))
    }

    @MainActor
    private func deliver(_ session: MacAgentChatSession, snapshotFor subscribe: [String: MessagePackValue],
                         conversationID: String, attachments: Bool) throws {
        session.receive(snapshotWithAttachments(
            requestID: try XCTUnwrap(subscribe["requestId"]?.stringValue), conversationID: conversationID,
            generation: try XCTUnwrap(subscribe["generation"]?.intValue), attachments: attachments))
    }

    /// An image chosen before the Host answered must go out when it does.
    ///
    /// The grant used to be announced while `capabilities` still held the reset
    /// defaults, so the queue asked "may I upload?", was told no, and then
    /// waited for a grant that had already happened. Driven through the real
    /// session and the real queue, because the bug lived in the order those two
    /// talk to each other — calling `uploadsAllowed()` by hand would pass.
    @MainActor
    func testAnImageChosenBeforeTheFirstSnapshotUploadsWhenTheHostAnswers() async throws {
        let conversationID = "herdr:test:p1"
        let (session, transport, subscribe, _) = try liveSession(conversationID: conversationID)
        let queue = liveQueue(session)

        // The user picks an image while the snapshot is still in flight. Nothing
        // has said this conversation takes images yet, so the very first
        // handshake is also the first time the paperclip may open.
        try deliver(session, snapshotFor: subscribe, conversationID: conversationID, attachments: true)
        XCTAssertTrue(session.canAttach, "the snapshot's own capabilities decide")
        queue.add([.clipboard(try Self.picture())])
        try await waitForEncoding(queue, count: 1)
        XCTAssertEqual(transport.count("session_upload"), 1, "the encoded image goes out once")
    }

    /// A real reconnect: new socket, new client, full ready/list/subscribe round.
    ///
    /// Not a replayed snapshot on the live subscription — that never clears
    /// `connected`, `receivedSnapshot` or `capabilities`, so it cannot show
    /// whether the grant survives the reset those three go through.
    @MainActor
    func testAnImageChosenWhileReconnectingUploadsOnceTheNewSubscriptionLands() async throws {
        let conversationID = "herdr:test:p1"
        let (session, first, subscribe, _) = try liveSession(conversationID: conversationID)
        let queue = liveQueue(session)
        try deliver(session, snapshotFor: subscribe, conversationID: conversationID, attachments: true)

        let second = FakeChatTransport()
        session.makeTransport = { _, _ in second }
        session.reconnect()
        XCTAssertEqual(first.disconnectCount, 1, "the old socket is closed")
        XCTAssertFalse(session.canAttach, "no subscription answers for this conversation yet")
        XCTAssertTrue(session.acceptsAttachments, "but the conversation still takes images")

        // Chosen in the gap, while the new socket is still handshaking.
        queue.add([.clipboard(try Self.picture())])
        try await waitForEncoding(queue, count: 1)
        XCTAssertEqual(queue.items.count, 1, "the picture waits in the draft rather than being refused")
        XCTAssertEqual(second.count("session_upload"), 0, "nothing goes out before the Host answers")

        let resubscribe = try handshake(session, second, conversationID: conversationID)
        try deliver(session, snapshotFor: resubscribe, conversationID: conversationID, attachments: true)
        XCTAssertEqual(second.count("session_upload"), 1, "the waiting image goes out on the new grant, once")

        // A later append on the same subscription is not another grant.
        session.receive(ControlMessage(fields: ["t": .string(AgentChatProtocol.append),
            "conversationId": .string(conversationID),
            "generation": .int(Int64(try XCTUnwrap(resubscribe["generation"]?.intValue))),
            "status": .string("ready"),
            "capabilities": .map(["send": .bool(true), "history": .bool(true), "attachments": .bool(true)]),
            "messages": .array([])]))
        XCTAssertEqual(second.count("session_upload"), 1, "an in-flight upload is never re-sent")
    }

    /// The Host drops `attachments` while the Agent is blocked in its terminal
    /// and restores it by append. An image that finished encoding inside that
    /// window stopped at `preparing`; a snapshot-only grant left it there.
    @MainActor
    func testAnImageEncodedWhileTheAgentWasBlockedGoesOutWhenItBecomesReady() async throws {
        let conversationID = "herdr:test:p1"
        let (session, transport, subscribe, _) = try liveSession(conversationID: conversationID)
        let queue = liveQueue(session)
        try deliver(session, snapshotFor: subscribe, conversationID: conversationID, attachments: true)
        let generation = Int64(try XCTUnwrap(subscribe["generation"]?.intValue))

        // The Agent starts waiting on something in its own terminal.
        session.receive(ControlMessage(fields: ["t": .string(AgentChatProtocol.append),
            "conversationId": .string(conversationID), "generation": .int(generation),
            "status": .string("ready"),
            "capabilities": .map(["send": .bool(false), "history": .bool(true), "attachments": .bool(false),
                                  "degraded": .string("这个 Agent 正在终端里等待确认")]),
            "messages": .array([])]))
        XCTAssertFalse(session.canAttach)

        queue.add([.clipboard(try Self.picture())])
        XCTAssertTrue(queue.items.isEmpty, "a conversation that is not taking images says so instead of queueing")

        // Encoded before the block, still unsent when it lifts.
        try deliver(session, snapshotFor: subscribe, conversationID: conversationID, attachments: true)
        queue.add([.clipboard(try Self.picture())])
        try await waitForEncoding(queue, count: 1)
        XCTAssertEqual(transport.count("session_upload"), 1)
        queue.connectionLost()

        session.receive(ControlMessage(fields: ["t": .string(AgentChatProtocol.append),
            "conversationId": .string(conversationID), "generation": .int(generation),
            "status": .string("ready"),
            "capabilities": .map(["send": .bool(true), "history": .bool(true), "attachments": .bool(true)]),
            "messages": .array([])]))
        XCTAssertEqual(transport.count("session_upload"), 1,
                       "an upload whose result is unknown is never written a second time")
    }

    /// A reloaded page resubscribes on the same socket. A result issued under
    /// the subscription it left is not this view's to apply.
    @MainActor
    func testAResultFromTheSubscriptionThePageLeftIsRefused() async throws {
        let conversationID = "herdr:test:p1"
        let (session, transport, subscribe, _) = try liveSession(conversationID: conversationID)
        let queue = liveQueue(session)
        try deliver(session, snapshotFor: subscribe, conversationID: conversationID, attachments: true)
        queue.add([.clipboard(try Self.picture())])
        try await waitForEncoding(queue, count: 1)
        let uploaded = try XCTUnwrap(transport.last("session_upload"))
        let uploadID = try XCTUnwrap(uploaded["id"]?.stringValue)
        let firstGeneration = try XCTUnwrap(subscribe["generation"]?.intValue)

        // The renderer reloads: same socket, new subscription.
        session.surfaceReady()
        let resubscribe = try XCTUnwrap(transport.last(AgentChatProtocol.subscribe))
        XCTAssertGreaterThan(try XCTUnwrap(resubscribe["generation"]?.intValue), firstGeneration)
        try deliver(session, snapshotFor: resubscribe, conversationID: conversationID, attachments: true)

        session.receive(ControlMessage(fields: ["t": .string("session_upload_result"),
            "sessionId": .string(conversationID), "id": .string(uploadID),
            "path": .string("/tmp/should-not-be-applied.png")]))
        let state = try XCTUnwrap(queue.items.first).state
        if case .ready = state { XCTFail("a result from the previous subscription completed an upload") }
        XCTAssertNil(queue.references, "an unresolved image blocks the send rather than naming a path")
    }

    private static func picture() throws -> Data {
        let image = NSImage(size: NSSize(width: 4, height: 4))
        image.lockFocus(); NSColor.systemPink.drawSwatch(in: NSRect(x: 0, y: 0, width: 4, height: 4)); image.unlockFocus()
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: image.tiffRepresentation ?? Data()))
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }

    /// A conversation may legitimately take text and not images.
    @MainActor
    func testASnapshotThatRefusesAttachmentsKeepsThePaperclipShut() throws {
        let conversationID = "herdr:test:p1"
        let (session, transport, subscribe, _) = try liveSession(conversationID: conversationID)
        session.composer.draft = "只发文字"
        session.receive(snapshotWithAttachments(
            requestID: try XCTUnwrap(subscribe["requestId"]?.stringValue),
            conversationID: conversationID, generation: try XCTUnwrap(subscribe["generation"]?.intValue), attachments: false))
        XCTAssertTrue(session.canSend, "text still works")
        XCTAssertFalse(session.canAttach, "send true does not mean images are accepted")
        XCTAssertFalse(session.acceptsAttachments)
        XCTAssertFalse(session.upload(id: UUID(), image: TerminalImage(data: Data([1]), mime: "image/png")))
        XCTAssertEqual(transport.count("session_upload"), 0)
    }

    private final class Box { var payloads: [[String: Any]] = [] }

    /// A Host transcript rewind replays the snapshot under the same request and
    /// generation. Dropping it would keep messages the Agent no longer has.
    @MainActor
    func testTranscriptRewindReplacesTheTranscriptOnTheSameSubscription() throws {
        let (session, _, subscribe, surface) = try liveSession()
        let requestID = try XCTUnwrap(subscribe["requestId"]?.stringValue)
        let generation = try XCTUnwrap(subscribe["generation"]?.intValue)
        session.receive(snapshot(requestID: requestID, conversationID: session.conversationID,
                                 generation: generation, texts: ["first", "second"]))
        XCTAssertEqual(surface.payloads.last?["op"] as? String, "snapshot")
        XCTAssertEqual(renderedTexts(surface.payloads.last), ["first", "second"])
        let afterFirst = surface.payloads.count

        session.receive(snapshot(requestID: requestID, conversationID: session.conversationID,
                                 generation: generation, texts: ["rewritten"]))
        XCTAssertEqual(surface.payloads.count, afterFirst + 1, "the replacement snapshot must reach the renderer")
        XCTAssertEqual(surface.payloads.last?["op"] as? String, "snapshot")
        XCTAssertEqual(renderedTexts(surface.payloads.last), ["rewritten"])

        // A snapshot produced for a subscription the user already left is dropped.
        session.receive(snapshot(requestID: requestID, conversationID: session.conversationID,
                                 generation: generation - 1, texts: ["stale"]))
        XCTAssertEqual(surface.payloads.count, afterFirst + 1)
        XCTAssertEqual(renderedTexts(surface.payloads.last), ["rewritten"])
        // Appends still ride on the same subscription after a rewind.
        session.receive(ControlMessage(fields: ["t": .string(AgentChatProtocol.append),
            "conversationId": .string(session.conversationID), "generation": .int(Int64(generation)),
            "status": .string("ready"), "capabilities": .map(["send": .bool(true), "history": .bool(true)]),
            "messages": .array([.map(["id": .string("m9"), "role": .string("assistant"),
                "blocks": .array([.map(["type": .string("text"), "text": .string("later")])])])])]))
        XCTAssertEqual(surface.payloads.last?["op"] as? String, "append")
        XCTAssertNil(session.unavailable)
        session.stop()
    }

    /// The subscription ID is held for rewinds, so it must not turn every later
    /// untagged Host error into "chat is unavailable".
    @MainActor
    func testUntaggedErrorsClosetheViewOnlyWhileTheOpenHandshakeIsOutstanding() throws {
        let (session, _, subscribe, _) = try liveSession()
        let requestID = try XCTUnwrap(subscribe["requestId"]?.stringValue)
        let generation = try XCTUnwrap(subscribe["generation"]?.intValue)
        let untagged = ControlMessage(fields: ["t": .string("error"), "message": .string("其他请求失败")])

        // Before the snapshot the handshake is still outstanding: this is fatal.
        session.receive(untagged)
        XCTAssertEqual(session.unavailable, "其他请求失败")
        XCTAssertFalse(session.connected)

        let (live, _, resubscribe, _) = try liveSession(conversationID: "herdr:test:p2")
        let liveRequest = try XCTUnwrap(resubscribe["requestId"]?.stringValue)
        let liveGeneration = try XCTUnwrap(resubscribe["generation"]?.intValue)
        live.receive(snapshot(requestID: liveRequest, conversationID: live.conversationID,
                              generation: liveGeneration, texts: ["ready"]))
        live.receive(untagged)
        XCTAssertNil(live.unavailable, "an unrelated error must not close a subscription that already rendered")
        XCTAssertTrue(live.connected)
        // An error that names the subscription still closes it.
        live.receive(ControlMessage(fields: ["t": .string("error"), "requestId": .string(liveRequest),
            "message": .string("记录已无法读取")]))
        XCTAssertEqual(live.unavailable, "记录已无法读取")
        _ = requestID; _ = generation
        session.stop(); live.stop()
    }

    /// A notification whose target is gone must stay rejected: the fallback view
    /// would otherwise reach a replacement session that reused the same ID.
    @MainActor
    func testRejectedNotificationTargetSurvivesRestartsAndClearsOnlyWithANewTarget() throws {
        let conversationID = "herdr:test:p1"
        let transport = FakeChatTransport()
        let route = MacNotificationRoute(agent: AgentRecord(sessionId: conversationID, source: "herdr",
            name: "Fixture", workspace: nil, paneId: nil, agent: "codex", status: "ready", preview: nil,
            lastSeenAt: 0, statusChangedAt: 0, present: true, createdAt: nil), profile: nil)
        let session = MacAgentChatSession(sessionID: conversationID, settings: Self.fixtureSettings,
                                          notificationRoute: route)
        session.makeTransport = { _, _ in transport }
        session.start()
        session.transportIsReady()
        XCTAssertEqual(transport.last("session_list")?["t"]?.stringValue, "session_list")

        // The Host now reports a different session under that ID.
        session.receive(ControlMessage(fields: ["t": .string("session_list_result"),
            "sessions": .array([.map(["sessionId": .string("herdr:test:p9"), "source": .string("herdr")])])]))
        XCTAssertNotNil(session.routeRejection)
        XCTAssertNotNil(session.unavailable)
        XCTAssertFalse(session.connected)

        // Reopening the same target must not try again.
        let attemptsBefore = transport.connectCount
        session.stop()
        session.start()
        XCTAssertEqual(transport.connectCount, attemptsBefore, "a rejected target must not reconnect")
        XCTAssertNotNil(session.routeRejection)

        // Opening from the live session list drops the stale claim.
        session.stop()
        session.notificationRoute = nil
        XCTAssertNil(session.routeRejection)
        session.start()
        XCTAssertEqual(transport.connectCount, attemptsBefore + 1)
        session.stop()
    }

    @MainActor
    func testSurfacePayloadKeepsRendererFieldsAndNeverCopiesRoutingMetadata() throws {
        let message = ControlMessage(fields: [
            "t": .string(AgentChatProtocol.snapshot), "requestId": .string("request-a"),
            "conversationId": .string("herdr:test:p1"), "generation": .int(7), "status": .string("ready"),
            "messages": .array([.map(["id": .string("m1"), "role": .string("assistant"),
                "blocks": .array([.map(["type": .string("text"), "text": .string("<b>ordinary text</b>")])])])]),
            "privateMetadata": .string("not-renderer-data"), "earlierCursor": .null,
        ])
        let payload = MacAgentChatSession.surfacePayload(message, op: "snapshot")
        XCTAssertNil(payload["requestId"])
        XCTAssertNil(payload["conversationId"])
        XCTAssertNil(payload["privateMetadata"])
        XCTAssertEqual(payload["op"] as? String, "snapshot")
        XCTAssertTrue(JSONSerialization.isValidJSONObject(payload))
        let data = try JSONSerialization.data(withJSONObject: payload)
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(decoded["generation"] as? Int, 7)
        let messages = try XCTUnwrap(decoded["messages"] as? [[String: Any]])
        let blocks = try XCTUnwrap(messages.first?["blocks"] as? [[String: Any]])
        XCTAssertEqual(blocks.first?["text"] as? String, "<b>ordinary text</b>")
    }
}
