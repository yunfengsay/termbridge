import XCTest
@testable import TermBridgeControlCenter

final class CLIConnectionProbeTests: XCTestCase {
    @MainActor
    func testReadOnlyConnectionUsingCLISettings() async throws {
        guard ProcessInfo.processInfo.environment["TB_TEST_LIVE_CLI"] == "1" else {
            throw XCTSkip("Opt in to a read-only probe of the configured relay")
        }
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/settings.json")
        var settings = try MacConnectionStore.loadCLIProfile(from: url, environment: [:])
        if let host = ProcessInfo.processInfo.environment["TB_TEST_LIVE_HOST_ID"] {
            settings.hostID = host
            let verified = try await MacConnectionTest.run(settings, discoverCertificate: false)
            XCTAssertEqual(verified.hostID, host)
        }
        let probe = CLIConnectionProbe()
        let client = TermbridgeClient(settings: settings, listener: probe)
        defer { client.disconnect() }
        client.connect()
        for _ in 0..<300 {
            if probe.receivedList || probe.failure != nil { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(probe.receivedList, probe.failure ?? "Timed out before session list")
    }
}

@MainActor
private final class CLIConnectionProbe: @preconcurrency TermbridgeClientListener {
    var receivedList = false
    var failure: String?
    func clientIsReady(_ client: TermbridgeClient) { client.sendControl(["t": .string("session_list")]) }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        if case .failed(let detail) = state { failure = ConnectionFailure.description(detail) }
        if state == .disconnected { failure = "Disconnected" }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        if message.type == "session_list_result" { receivedList = true }
        if message.type == "error" { failure = "Relay/Host rejected request" }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
