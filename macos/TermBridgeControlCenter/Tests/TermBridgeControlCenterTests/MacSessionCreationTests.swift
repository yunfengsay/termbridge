import AppKit
import XCTest
@testable import TermBridgeControlCenter

@MainActor
private final class CreationProbe: @preconcurrency TermbridgeClientListener {
    var client: TermbridgeClient!
    var ready = false
    var messages: [ControlMessage] = []
    var output = Data()
    init(_ settings: ConnectionSettings) { client = TermbridgeClient(settings: settings, listener: self) }
    func clientIsReady(_ client: TermbridgeClient) { ready = true }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {}
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) { messages.append(message) }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) { output.append(data) }
}

final class MacSessionCreationTests: XCTestCase {
    @MainActor
    func testCreatingConnectionAnswersTerminalQueriesBeforeWindowOpens() async throws {
        guard let url = ProcessInfo.processInfo.environment["TB_MACOS_CREATE_RELAY"] else { throw XCTSkip("Requires disposable Relay") }
        _ = NSApplication.shared
        let settings = ConnectionSettings(relayURL: url, hostID: "create-a", secret: "session-creation-test", tlsFingerprint: "")
        let probe = CreationProbe(settings)
        probe.client.connect()
        defer { probe.client.disconnect() }
        try await until { probe.ready }
        let creator = MacSessionCreation(profile: settings, sourceName: "Test Host")
        defer { creator.cancel() }
        var record: AgentRecord?
        creator.onCreated = { record = $0 }
        creator.connect()
        try await until { creator.phase == .choosing }
        creator.agent = "qa-handshake"
        creator.create()
        try await until { record != nil }
        let id = try XCTUnwrap(record?.sessionId)
        defer { probe.client.sendControl(["t": .string("kill"), "sessionId": .string(id)]) }
        // Hold off opening any window past the TUI's query deadline. Creation
        // must already own an emulator and its transport, without a reattach.
        try await Task.sleep(nanoseconds: 1_000_000_000)
        probe.client.sendControl(["t": .string("attach"), "sessionId": .string(id), "cols": .int(100), "rows": .int(28)])
        try await until { probe.messages.contains { $0.type == "attach_ok" || $0.type == "error" } }
        XCTAssertTrue(probe.messages.contains { $0.type == "attach_ok" }, "A fresh TUI must survive its startup handshake")
        if probe.messages.contains(where: { $0.type == "attach_ok" }) {
            try await until { String(decoding: probe.output, as: UTF8.self).contains("TERMINAL_HANDSHAKE_OK") }
        }
    }

    @MainActor
    func testCreateOnceOnCapturedHostAndAutomaticallyOpenFocusedTerminal() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let url = env["TB_MACOS_CREATE_RELAY"], let cwd = env["TB_MACOS_CREATE_CWD"] else {
            throw XCTSkip("Run scripts/test-session-creation.mjs with a built disposable Host")
        }
        _ = NSApplication.shared
        let a = ConnectionSettings(relayURL: url, hostID: "create-a", secret: "session-creation-test", tlsFingerprint: "")
        let b = ConnectionSettings(relayURL: url, hostID: "create-b", secret: "session-creation-test", tlsFingerprint: "")
        let probeA = CreationProbe(a), probeB = CreationProbe(b)
        probeA.client.connect(); probeB.client.connect()
        defer { probeA.client.disconnect(); probeB.client.disconnect() }
        try await until { probeA.ready && probeB.ready }
        let model = ControlCenterModel(profiles: [a, b], startServices: false)
        model.selectProfile(a.id); model.prepareNewSession()
        let creator = try XCTUnwrap(model.sessionCreator)
        creator.connect()
        try await until { creator.phase == .choosing || creator.phase == .failed }
        XCTAssertEqual(creator.phase, .choosing, creator.error ?? "")
        XCTAssertTrue(creator.agents.contains("qa-shell"))
        creator.agent = "qa-shell"; creator.directory = cwd
        model.selectProfile(b.id)
        creator.create(); creator.create()
        model.prepareNewSession() // Reopening while pending must keep the same request.
        XCTAssertTrue(model.sessionCreator === creator)
        try await until { creator.phase == .finished || creator.phase == .failed }
        XCTAssertEqual(creator.phase, .finished, creator.error ?? "")
        XCTAssertEqual(creator.profile.hostID, "create-a")
        probeA.client.sendControl(["t": .string("session_list")])
        probeB.client.sendControl(["t": .string("session_list")])
        try await until { [probeA, probeB].allSatisfy { $0.messages.contains { $0.type == "session_list_result" } } }
        let sessions = try XCTUnwrap(probeA.messages.last { $0.type == "session_list_result" }).sessions()
        XCTAssertEqual(sessions.count, 1, "Double click must not create two sessions")
        XCTAssertTrue(try XCTUnwrap(probeB.messages.last { $0.type == "session_list_result" }).sessions().isEmpty)
        let id = try XCTUnwrap(sessions.first?.id)
        defer { probeA.client.sendControl(["t": .string("kill"), "sessionId": .string(id)]) }
        var terminal: TerminalWindowController?
        try await until {
            terminal = NSApp.windows.compactMap { $0.windowController as? TerminalWindowController }
                .first { $0.usesConnection(a) }
            return terminal?.attachments.isConnected() == true
        }
        let window = try XCTUnwrap(terminal)
        defer { window.close(); model.disconnectTerminals() }
        XCTAssertTrue(window.window?.firstResponder === window.terminal)
        probeA.client.sendControl(["t": .string("attach"), "sessionId": .string(id), "cols": .int(100), "rows": .int(28)])
        try await until { probeA.messages.contains { $0.type == "attach_ok" } }
        window.terminal.send(source: window.terminal.getTerminal(),
            data: Array("pwd\rprintf 'MAC_CREATE_INPUT_OK\\n'\r".utf8)[...])
        try await until {
            let output = String(decoding: probeA.output, as: UTF8.self)
            return output.contains(cwd) && output.contains("MAC_CREATE_INPUT_OK\r\n")
        }
    }

    @MainActor
    func testRejectedCredentialsNeverCreateOrRetry() async throws {
        guard let url = ProcessInfo.processInfo.environment["TB_MACOS_CREATE_RELAY"] else { throw XCTSkip("Requires disposable Relay") }
        let creator = MacSessionCreation(profile: ConnectionSettings(relayURL: url, hostID: "create-a", secret: "wrong-test-secret", tlsFingerprint: ""), sourceName: "Test Host")
        var created = false
        creator.onCreated = { _ in created = true }
        creator.connect()
        try await until { creator.phase == .failed }
        creator.create(); creator.connect()
        XCTAssertEqual(creator.phase, .failed)
        XCTAssertNotNil(creator.error)
        XCTAssertFalse(created)
    }

    @MainActor
    func testUnspecifiedHostCannotCreateOnAnArbitraryMachine() {
        let creator = MacSessionCreation(profile: ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "", secret: "", tlsFingerprint: ""), sourceName: "Auto")
        creator.connect(); creator.create()
        XCTAssertEqual(creator.phase, .failed)
        XCTAssertTrue(creator.error?.contains("具体的 Host") == true)
    }

    @MainActor
    func testStartupFailureKeepsItsOutputAndDoesNotReattachAnEndedSession() async throws {
        guard let url = ProcessInfo.processInfo.environment["TB_MACOS_CREATE_RELAY"] else { throw XCTSkip("Requires disposable Relay") }
        _ = NSApplication.shared
        let creator = MacSessionCreation(profile: ConnectionSettings(relayURL: url, hostID: "create-a",
            secret: "session-creation-test", tlsFingerprint: ""), sourceName: "Test Host")
        creator.connect()
        try await until { creator.phase == .choosing }
        creator.agent = "qa-failed"
        creator.create()
        try await until { creator.phase == .finished }
        let session = try XCTUnwrap(creator.takeCreatedSession())
        defer { session.disconnect() }
        creator.cancel() // Closing the sheet cannot disconnect the new owner.
        try await until { session.remoteProcessEnded }
        let output = String(decoding: session.terminal.getTerminal().getBufferAsData(), as: UTF8.self)
        XCTAssertTrue(output.contains("FIXTURE_STARTUP_FAILED"))
        XCTAssertTrue(session.connectionStatus.isHidden, "The startup error must remain visible")
        XCTAssertFalse(session.attachments.isConnected())
        session.activate(focus: false)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(session.remoteProcessEnded)
        let reopened = String(decoding: session.terminal.getTerminal().getBufferAsData(), as: UTF8.self)
        XCTAssertEqual(reopened.replacingOccurrences(of: "\n", with: ""), output.replacingOccurrences(of: "\n", with: ""),
            "Resizing may reflow lines, but must not discard startup output")
        XCTAssertTrue(session.connectionStatus.isHidden, "Reopening cannot replace the error with no session")
    }

    @MainActor
    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<300 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        XCTFail("Timed out waiting for session creation acceptance")
        throw NSError(domain: "MacSessionCreationTests", code: 1)
    }
}
