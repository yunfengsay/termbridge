import XCTest
@testable import TermBridgeControlCenter

/// Plain WS direct connections use the BSD socket transport. Failures must say
/// where the path stopped, and none of them may wait for the 10-second deadline.
final class DirectSocketTransportTests: XCTestCase {
    private final class Recorder: TermbridgeClientListener, @unchecked Sendable {
        let failed: XCTestExpectation
        private let lock = NSLock()
        private var events: [(String, [String: String])] = []
        init(_ failed: XCTestExpectation) { self.failed = failed }
        func record(_ event: String, _ fields: [String: String]) { lock.lock(); events.append((event, fields)); lock.unlock() }
        func fields(_ event: String) -> [String: String]? { lock.lock(); defer { lock.unlock() }; return events.first { $0.0 == event }?.1 }
        func client(_ client: TermbridgeClient, changedState state: ConnectionState) { if case .failed = state { failed.fulfill() } }
        func clientIsReady(_ client: TermbridgeClient) {}
        func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {}
        func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
    }

    func testRefusedDirectPortFailsImmediatelyWithSocketDiagnostics() {
        let recorder = Recorder(expectation(description: "direct connection fails"))
        let settings = ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "", secret: "test-only", tlsFingerprint: "", mode: .direct)
        let client = TermbridgeClient(settings: settings, listener: recorder, diagnostics: recorder.record)
        let started = Date()
        client.connect()
        wait(for: [recorder.failed], timeout: 5)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "A refused port must not wait for the transport deadline")
        let failure = recorder.fields("connection.transport_failed")
        XCTAssertEqual(failure?["transport"], "socket")
        XCTAssertEqual(failure?["stage"], "connect")
        XCTAssertEqual(failure?["code"], String(URLError.cannotConnectToHost.rawValue))
        XCTAssertEqual(failure?["underlyingDomain"], NSPOSIXErrorDomain)
        XCTAssertEqual(failure?["underlyingCode"], String(ECONNREFUSED))
        XCTAssertNil(recorder.fields("connection.transport_metrics"), "No route exists before a connection opens")
        XCTAssertTrue(ConnectionFailure.description(client.transportError ?? URLError(.unknown) as NSError).contains("无法连接服务器端口"))
        client.disconnect()
    }

    func testLegacyTLSDirectEndpointKeepsNetworkTransport() {
        let recorder = Recorder(expectation(description: "legacy TLS connection fails"))
        let settings = ConnectionSettings(relayURL: "wss://127.0.0.1:1", hostID: "", secret: "test-only",
                                          tlsFingerprint: String(repeating: "a", count: 64), mode: .direct)
        let client = TermbridgeClient(settings: settings, listener: recorder, diagnostics: recorder.record)
        client.connect()
        wait(for: [recorder.failed], timeout: 15)
        XCTAssertEqual(recorder.fields("connection.connect")?["transport"], "network")
        client.disconnect()
    }
}
