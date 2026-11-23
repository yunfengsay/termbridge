import XCTest
@testable import TermBridgeControlCenter

@MainActor
private final class RemoteProbe: @preconcurrency TermbridgeClientListener {
    var client: TermbridgeClient!
    var ready = false
    var failed = false
    var messages: [ControlMessage] = []
    var output = Data()
    init(_ settings: ConnectionSettings) { client = TermbridgeClient(settings: settings, listener: self) }
    func clientIsReady(_ client: TermbridgeClient) { ready = true }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        if case .failed = state { failed = true }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) { messages.append(message) }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) { output.append(data) }
    func latest(_ type: String) -> ControlMessage? { messages.last { $0.type == type } }
}

final class RemoteConnectionTests: XCTestCase {
    @MainActor
    func testAuthenticatedMultiSourceInputAndReconnect() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let firstURL = environment["TB_MACOS_TEST_RELAY_A"], let secondURL = environment["TB_MACOS_TEST_RELAY_B"] else {
            throw XCTSkip("Provide two disposable relay endpoints for multi-source acceptance")
        }
        func settings(_ url: String, secret: String = "macos-tabs-test-secret") -> ConnectionSettings {
            ConnectionSettings(relayURL: url, hostID: "mini", secret: secret, tlsFingerprint: "")
        }
        let first = RemoteProbe(settings(firstURL)), second = RemoteProbe(settings(secondURL))
        defer { first.client.disconnect(); second.client.disconnect() }
        first.client.connect(); second.client.connect()
        try await until { first.latest("host_list_result") != nil && second.latest("host_list_result") != nil }
        XCTAssertEqual(Set(first.latest("host_list_result")!.hosts().map(\.hostID)), Set(["mini", "office"]))
        XCTAssertEqual(second.latest("host_list_result")!.hosts().map(\.hostID), ["mini"])
        var anonymousSettings = settings(firstURL); anonymousSettings.hostID = ""
        let anonymous = RemoteProbe(anonymousSettings); anonymous.client.connect()
        defer { anonymous.client.disconnect() }
        try await until { anonymous.latest("host_list_result") != nil }
        XCTAssertEqual(anonymous.latest("host_list_result")!.hosts().count, 2)
        XCTAssertNotNil(anonymous.latest("host_list_result")!.string("selectedHostId"))
        for probe in [first, second] {
            probe.client.sendControl(["t": .string("session_create"), "command": .string("/bin/cat"), "cols": .int(80), "rows": .int(24)])
        }
        try await until { first.latest("session_created") != nil && second.latest("session_created") != nil }
        let firstSession = first.latest("session_created")!, secondSession = second.latest("session_created")!
        defer {
            first.client.sendControl(["t": .string("kill"), "sessionId": .string(firstSession.string("sessionId")!)])
            second.client.sendControl(["t": .string("kill"), "sessionId": .string(secondSession.string("sessionId")!)])
        }
        first.client.sendPTYInput(sid: firstSession.int("sid")!, data: Data("SOURCE_A_中文\n".utf8))
        second.client.sendPTYInput(sid: secondSession.int("sid")!, data: Data("SOURCE_B_中文\n".utf8))
        try await until {
            String(decoding: first.output, as: UTF8.self).contains("SOURCE_A_中文") && String(decoding: second.output, as: UTF8.self).contains("SOURCE_B_中文")
        }
        XCTAssertFalse(String(decoding: first.output, as: UTF8.self).contains("SOURCE_B"))
        XCTAssertFalse(String(decoding: second.output, as: UTF8.self).contains("SOURCE_A"))
        first.client.sendResize(sid: firstSession.int("sid")!, cols: 99, rows: 33)
        first.client.sendControl(["t": .string("session_list")])
        try await until { first.latest("session_list_result")?.sessions().contains { $0.cols == 99 && $0.rows == 33 } == true }
        first.client.disconnect()
        let resumed = RemoteProbe(settings(firstURL)); resumed.client.connect()
        defer { resumed.client.disconnect() }
        try await until { resumed.ready }
        resumed.client.sendControl(["t": .string("attach"), "sessionId": .string(firstSession.string("sessionId")!), "cols": .int(80), "rows": .int(24)])
        try await until { String(decoding: resumed.output, as: UTF8.self).contains("SOURCE_A_中文") }
        resumed.client.sendControl(["t": .string("kill"), "sessionId": .string(firstSession.string("sessionId")!)])
        let rejected = RemoteProbe(settings(firstURL, secret: "incorrect-test-secret")); rejected.client.connect()
        defer { rejected.client.disconnect() }
        try await until { rejected.failed }
        XCTAssertNil(rejected.latest("host_list_result"))
    }

    @MainActor
    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<150 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("Timed out waiting for isolated relay response")
        throw NSError(domain: "RemoteAcceptance", code: 1)
    }
}
