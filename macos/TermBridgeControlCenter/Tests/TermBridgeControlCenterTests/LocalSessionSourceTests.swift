import XCTest
@testable import TermBridgeControlCenter

private final class LocalSourceFixture: @unchecked Sendable {
    private let lock = NSLock()
    private var failed = false
    func fail() { lock.lock(); failed = true; lock.unlock() }
    func load() throws -> [AgentRecord] {
        lock.lock(); let failed = failed; lock.unlock()
        if failed { throw HerdrTerminalIdentity.ResolutionError.unavailable }
        return try HerdrTerminalIdentity.agents(snapshot: Data(#"{"result":{"snapshot":{"panes":[{"pane_id":"live:p7","agent":"codex","terminal_id":"term_live"}]}}}"#.utf8))
    }
}

@MainActor final class LocalSessionSourceTests: XCTestCase {
    func testLiveLocalSourceReplacesCachedRowsAndFailureClearsThem() async throws {
        let context = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: context) }
        try Data(#"{"generatedAt":1,"records":[{"sessionId":"herdr:old:p1","source":"herdr","status":"ready","lastSeenAt":1,"statusChangedAt":1,"present":true}]}"#.utf8).write(to: context)
        let source = LocalSourceFixture()
        let model = ControlCenterModel(contextURL: context, profiles: [], startServices: false, loadLocalAgents: { try source.load() })
        defer { model.disconnectTerminals() }
        try await until { model.state == .ready }
        XCTAssertEqual(model.agents.map(\.sessionId), ["herdr:live:p7"], "Never list a cached pane missing from the current server")
        source.fail(); model.refresh()
        try await until { if case .error = model.state { return true }; return false }
        XCTAssertTrue(model.agents.isEmpty, "Failure cannot revive the old context file")
    }

    func testLateLocalResultDoesNotReplaceRemoteHostOrReviveShutdown() async throws {
        for shutdown in [false, true] {
            let started = expectation(description: "Local read started")
            started.assertForOverFulfill = false
            let release = DispatchSemaphore(value: 0)
            let source = LocalSourceFixture()
            let profile = ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "remote", secret: "fixture", tlsFingerprint: "")
            let model = ControlCenterModel(profiles: [profile], startServices: false, loadLocalAgents: {
                started.fulfill(); release.wait(); return try source.load()
            })
            defer { model.disconnectTerminals() }
            await fulfillment(of: [started], timeout: 2)
            if shutdown { model.disconnectTerminals() }
            else {
                model.selectProfile(profile.id)
            }
            release.signal(); release.signal()
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertTrue(model.agents.isEmpty)
            if !shutdown { XCTAssertEqual(model.activeProfileID, profile.id) }
        }
    }

    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<100 { if predicate() { return }; try await Task.sleep(for: .milliseconds(20)) }
        XCTFail("Local source did not settle"); throw NSError(domain: "LocalSourceTests", code: 1)
    }
}
