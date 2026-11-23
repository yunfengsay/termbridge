import AppKit
import UserNotifications
import XCTest
@testable import TermBridgeControlCenter

final class MacNotificationTests: XCTestCase {
    private func profile(_ endpoint: String = "ws://127.0.0.1:7400") -> ConnectionSettings {
        ConnectionSettings(relayURL: endpoint, hostID: "mini", secret: "private-test-secret", tlsFingerprint: "", hostName: "Mac mini")
    }
    private func record(_ status: String = "working", source: String = "herdr", createdAt: Double = 100) -> AgentRecord {
        AgentRecord(sessionId: "herdr:wA:p1", source: source, name: "Test", workspace: nil, paneId: nil,
            agent: nil, status: status, preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true, createdAt: createdAt)
    }

    func testRouteRoundTripScopesSameHostAndSessionAcrossConnectionsWithoutCredentials() throws {
        let a = profile(), b = profile("ws://127.0.0.1:7401")
        let first = MacNotificationRoute(agent: record(), profile: a)
        let second = MacNotificationRoute(agent: record(), profile: b)
        XCTAssertNotEqual(first.key, second.key)
        XCTAssertNotEqual(first.endpoint, second.endpoint)
        XCTAssertEqual(MacNotificationRoute(userInfo: first.userInfo), first)
        XCTAssertEqual(try first.resolve(in: [b, a])?.id, a.id)
        let data = try XCTUnwrap(first.userInfo["termbridge.route"] as? String)
        XCTAssertFalse(data.contains(a.secret)); XCTAssertFalse(data.contains(a.relayURL))
        XCTAssertNil(MacNotificationRoute(userInfo: [:]))
        XCTAssertNil(MacNotificationRoute(userInfo: ["termbridge.route": "{}"])); XCTAssertNil(MacNotificationRoute(userInfo: ["sessionId": "legacy"]))
    }

    func testDeletedOrRetargetedProfileAndReusedPTYAreRejected() throws {
        var a = profile()
        let route = MacNotificationRoute(agent: record(source: "pty"), profile: a)
        XCTAssertThrowsError(try route.resolve(in: []))
        a.hostName = "New name"; a.secret = "rotated-secret"
        XCTAssertEqual(try route.resolve(in: [a])?.id, a.id)
        a.hostID = "another-host"
        XCTAssertThrowsError(try route.resolve(in: [a]))
        XCTAssertTrue(route.matches(record(source: "pty")))
        XCTAssertFalse(route.matches(record(source: "pty", createdAt: 101)))
        XCTAssertFalse(route.matches(record(source: "herdr")))
        let local = MacNotificationRoute(agent: record(), profile: nil)
        XCTAssertNil(try local.resolve(in: [a]))
        XCTAssertTrue(local.matches(record(createdAt: 999)), "Herdr pane identity survives Host restart")
    }

    func testTransitionsRetainIndependentBaselinesAndDoNotFloodAtStartup() {
        var tracker = MacNotificationTransitions()
        XCTAssertTrue(tracker.changes([record()], scope: "a").isEmpty)
        XCTAssertTrue(tracker.changes([record("done")], scope: "b").isEmpty)
        XCTAssertEqual(tracker.changes([record("blocked")], scope: "a").count, 1)
        XCTAssertTrue(tracker.changes([record("done")], scope: "b").isEmpty)
        XCTAssertTrue(tracker.changes([record("blocked")], scope: "a").isEmpty)
        XCTAssertEqual(tracker.changes([record("done")], scope: "a").count, 1)
        tracker.remove(scope: "a")
        XCTAssertTrue(tracker.changes([record("blocked")], scope: "a").isEmpty)
    }

    @MainActor
    func testColdLaunchQueuesClicksDeduplicatesAndIgnoresDismiss() {
        let coordinator = MacNotificationCoordinator()
        let a = MacNotificationRoute(agent: record(), profile: profile())
        let b = MacNotificationRoute(agent: record(), profile: profile())
        coordinator.receive(action: UNNotificationDismissActionIdentifier, userInfo: a.userInfo)
        coordinator.receive(action: UNNotificationDefaultActionIdentifier, userInfo: a.userInfo)
        coordinator.receive(action: UNNotificationDefaultActionIdentifier, userInfo: a.userInfo)
        coordinator.receive(action: UNNotificationDefaultActionIdentifier, userInfo: b.userInfo)
        var opened: [MacNotificationRoute] = [], errors: [String] = []
        coordinator.bind(open: { opened.append($0) }, error: { errors.append($0) })
        XCTAssertEqual(opened, [a, b])
        coordinator.receive(action: UNNotificationDefaultActionIdentifier, userInfo: [:])
        XCTAssertEqual(errors.count, 1); XCTAssertEqual(opened.count, 2)
        let reqA = MacNotificationCoordinator.request(agent: record("blocked"), profile: profile())
        let reqB = MacNotificationCoordinator.request(agent: record("blocked"), profile: profile())
        XCTAssertNotEqual(reqA.identifier, reqB.identifier)
        XCTAssertNotNil(MacNotificationRoute(userInfo: reqA.content.userInfo))
    }

    @MainActor
    func testDeletedProfileClickDoesNotFallBackToSelectedConnection() {
        let current = profile(), removed = profile()
        let coordinator = MacNotificationCoordinator()
        let model = ControlCenterModel(profiles: [current], startServices: false, notifications: coordinator)
        model.selectProfile(current.id)
        coordinator.receive(action: UNNotificationDefaultActionIdentifier,
            userInfo: MacNotificationRoute(agent: record(), profile: removed).userInfo)
        XCTAssertEqual(model.activeProfileID, current.id)
        XCTAssertTrue(model.notificationError?.contains("删除") == true)
    }

    @MainActor
    func testRemoteNotificationValidatesLiveSessionAndRejectsReusedIdentity() async throws {
        guard let endpoint = ProcessInfo.processInfo.environment["TB_MACOS_TEST_RELAY_A"] else { throw XCTSkip("Requires disposable Host") }
        _ = NSApplication.shared
        let settings = ConnectionSettings(relayURL: endpoint, hostID: "mini", secret: "macos-tabs-test-secret", tlsFingerprint: "")
        let probe = NotificationProbe(settings)
        probe.client.connect()
        defer { probe.client.disconnect() }
        try await until { probe.ready }
        probe.client.sendControl(["t": .string("session_create"), "command": .string("/bin/cat")])
        try await until { probe.session != nil }
        let id = try XCTUnwrap(probe.session)
        defer { probe.client.sendControl(["t": .string("kill"), "sessionId": .string(id)]) }
        probe.client.sendControl(["t": .string("session_list")])
        try await until { probe.records.contains { $0.sessionId == id } }
        let agent = try XCTUnwrap(probe.records.first { $0.sessionId == id })
        XCTAssertNotNil(agent.createdAt)
        let route = MacNotificationRoute(agent: agent, profile: settings)
        let window = TerminalWindowController(agent: agent, launch: nil, connection: settings, notificationRoute: route)
        window.present(); defer { window.close() }
        try await until { window.attachments.isConnected() }
        XCTAssertTrue(window.window?.firstResponder === window.terminal)
        window.openFromNotification(route)
        try await until { window.attachments.isConnected() }
        var reused = agent; reused.createdAt = (agent.createdAt ?? 0) + 1
        window.openFromNotification(MacNotificationRoute(agent: reused, profile: settings))
        try await until { !window.connectionStatus.isHidden && window.connectionStatus.title.stringValue == "会话已失效" }
        XCTAssertFalse(window.attachments.isConnected())
    }

    @MainActor
    func testIndependentMonitorsContinueAfterOtherSourceDisconnects() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let a = env["TB_MACOS_TEST_RELAY_A"], let b = env["TB_MACOS_TEST_RELAY_B"] else { throw XCTSkip("Requires two disposable Relays") }
        func connection(_ endpoint: String) -> ConnectionSettings {
            ConnectionSettings(relayURL: endpoint, hostID: "mini", secret: "macos-tabs-test-secret", tlsFingerprint: "")
        }
        let first = MacHostMonitor(profile: connection(a)), second = MacHostMonitor(profile: connection(b))
        defer { first.disconnect(); second.disconnect() }
        var firstCount = 0, secondCount = 0
        first.onSnapshot = { _ in firstCount += 1 }; second.onSnapshot = { _ in secondCount += 1 }
        first.refresh(); second.refresh()
        try await until { firstCount == 1 && secondCount == 1 }
        second.disconnect(); first.refresh()
        try await until { firstCount == 2 }
        XCTAssertEqual(secondCount, 1)
        second.refresh(); try await until { secondCount == 2 }
    }

    @MainActor private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<350 { if condition() { return }; try await Task.sleep(nanoseconds: 20_000_000) }
        throw NSError(domain: "Notification test timeout", code: 1)
    }
}

@MainActor private final class NotificationProbe: @preconcurrency TermbridgeClientListener {
    var client: TermbridgeClient!
    var ready = false
    var session: String?
    var records: [AgentRecord] = []
    init(_ settings: ConnectionSettings) { client = TermbridgeClient(settings: settings, listener: self) }
    func clientIsReady(_ client: TermbridgeClient) { ready = true }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {}
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        if message.type == "session_created" { session = message.string("sessionId") }
        if message.type == "session_list_result" { records = AgentRecord.remoteRecords(message.sessions()) }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
