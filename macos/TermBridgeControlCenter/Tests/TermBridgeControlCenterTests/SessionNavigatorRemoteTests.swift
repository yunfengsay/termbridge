import AppKit
import XCTest
@testable import TermBridgeControlCenter

@MainActor
private final class NavigatorProbe: @preconcurrency TermbridgeClientListener {
    var client: TermbridgeClient!
    var ready = false
    var messages: [ControlMessage] = []
    init(_ settings: ConnectionSettings) { client = TermbridgeClient(settings: settings, listener: self) }
    func clientIsReady(_ client: TermbridgeClient) { ready = true }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {}
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) { messages.append(message) }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}

/// The navigator against a real disposable Host: the Host's own viewer counts
/// say which sessions are attached. Run `node scripts/test-session-navigator.mjs`.
final class SessionNavigatorRemoteTests: XCTestCase {
    @MainActor
    func testNavigatorKeepsRecentSessionsAttachedAndDetachesTheRest() async throws {
        guard let url = ProcessInfo.processInfo.environment["TB_MACOS_NAVIGATOR_RELAY"] else {
            throw XCTSkip("Run scripts/test-session-navigator.mjs with a built disposable Host")
        }
        _ = NSApplication.shared
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: SessionWindowMode.defaultsKey)
        defer { defaults.set(previous, forKey: SessionWindowMode.defaultsKey) }
        defaults.set(SessionWindowMode.navigator.rawValue, forKey: SessionWindowMode.defaultsKey)

        let profile = ConnectionSettings(relayURL: url, hostID: "navigator", secret: "session-navigator-test", tlsFingerprint: "",
                                         hostName: "Navigator fixture")
        // The creator is attached to what it creates until it disconnects; the
        // probe that counts viewers never attaches to anything.
        let creator = NavigatorProbe(profile), probe = NavigatorProbe(profile)
        creator.client.connect(); probe.client.connect()
        defer { probe.client.disconnect() }
        try await until { creator.ready && probe.ready }
        let count = SessionNavigatorController.liveLimit + 1
        for _ in 0..<count { creator.client.sendControl(["t": .string("session_create"), "command": .string("/bin/cat")]) }
        try await until { creator.messages.filter { $0.type == "session_created" }.count == count }
        let ids = creator.messages.filter { $0.type == "session_created" }.compactMap { $0.string("sessionId") }
        creator.client.disconnect()
        defer { ids.forEach { probe.client.sendControl(["t": .string("kill"), "sessionId": .string($0)]) } }
        func viewers() async throws -> [String: Int] {
            probe.messages.removeAll { $0.type == "session_list_result" }
            probe.client.sendControl(["t": .string("session_list")])
            try await until { probe.messages.contains { $0.type == "session_list_result" } }
            let list = try XCTUnwrap(probe.messages.last { $0.type == "session_list_result" }).sessions()
            return Dictionary(uniqueKeysWithValues: list.map { ($0.sessionID, $0.viewers) })
        }
        let records = AgentRecord.remoteRecords(try await { () async throws -> [SessionInfo] in
            probe.client.sendControl(["t": .string("session_list")])
            try await until { probe.messages.contains { $0.type == "session_list_result" } }
            return try XCTUnwrap(probe.messages.last { $0.type == "session_list_result" }).sessions()
        }())
        let agents = try ids.map { id in try XCTUnwrap(records.first { $0.sessionId == id }) }
        try await until { try await viewers().values.allSatisfy { $0 == 0 } }

        let model = ControlCenterModel(profiles: [profile], startServices: false)
        defer { model.disconnectTerminals() }
        model.selectProfile(profile.id)
        // Polled, so it must not record a failure while the session is opening.
        func navigator() -> SessionNavigatorController? {
            NSApp.windows.compactMap { $0.windowController as? SessionNavigatorController }
                .first { $0.liveSessions.contains { $0.agent.sessionId == ids[0] } }
        }
        func visible() -> TerminalSessionController? { navigator()?.visibleSession }
        func type(_ text: String, into session: TerminalSessionController) {
            session.terminal.send(source: session.terminal.getTerminal(), data: Array((text + "\r").utf8)[...])
        }
        func screen(_ session: TerminalSessionController) -> String {
            String(decoding: session.terminal.getTerminal().getBufferAsData(), as: UTF8.self)
        }

        model.open(agents[0])
        try await until { visible()?.attachments.isConnected() == true }
        let first = try XCTUnwrap(visible())
        type("NAVIGATOR_FIRST", into: first)
        try await until { screen(first).contains("NAVIGATOR_FIRST") }

        model.open(agents[1])
        try await until { visible()?.agent.sessionId == ids[1] && visible()?.attachments.isConnected() == true }
        let second = try XCTUnwrap(visible())
        type("NAVIGATOR_SECOND", into: second)
        try await until { screen(second).contains("NAVIGATOR_SECOND") }
        XCTAssertNil(first.view.window)
        XCTAssertTrue(first.attachments.isConnected(), "the session out of sight stays attached")
        XCTAssertFalse(screen(first).contains("NAVIGATOR_SECOND"), "input goes only to the session on screen")
        var counts = try await viewers()
        XCTAssertEqual(counts[ids[0]], 1); XCTAssertEqual(counts[ids[1]], 1)

        // Back to the first: no reconnect, so its screen was never reset.
        model.open(agents[0])
        XCTAssertTrue(visible() === first)
        XCTAssertTrue(first.attachments.isConnected())
        XCTAssertTrue(screen(first).contains("NAVIGATOR_FIRST"))
        type("NAVIGATOR_AGAIN", into: first)
        try await until { screen(first).contains("NAVIGATOR_AGAIN") }

        // Past the limit the least recently viewed session detaches on the Host.
        for agent in agents[2...] {
            model.open(agent)
            try await until { visible()?.agent.sessionId == agent.sessionId && visible()?.attachments.isConnected() == true }
        }
        counts = try await viewers()
        XCTAssertEqual(ids.map { counts[$0] ?? -1 }.reduce(0, +), SessionNavigatorController.liveLimit,
                       "never more attached viewers than the live limit: \(counts)")
        XCTAssertEqual(counts[ids[1]], 0, "the least recently viewed session is the one detached")
        XCTAssertEqual(counts[ids[0]], 1, "revisiting a session made it recent again")

        // Closing the navigator detaches everything; the sessions keep running.
        try XCTUnwrap(navigator()).close()
        try await until { (try? await viewers())?.values.allSatisfy { $0 == 0 } == true }
        let remaining = try await viewers()
        XCTAssertEqual(Set(remaining.keys), Set(ids))
    }

    @MainActor private func until(_ condition: () async throws -> Bool) async throws {
        for _ in 0..<200 {
            if (try? await condition()) == true { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw NSError(domain: "SessionNavigatorRemoteTests.timeout", code: 1)
    }
}
