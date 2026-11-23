import AppKit
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

final class LANServiceTests: XCTestCase {
    private func availablePort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0); defer { Darwin.close(fd) }
        var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout.size(ofValue: address))
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        XCTAssertEqual(result, 0)
        var length = socklen_t(MemoryLayout.size(ofValue: address))
        _ = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        return Int(UInt16(bigEndian: address.sin_port))
    }
    @MainActor private func until(_ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(25)
        while !predicate() && Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertTrue(predicate())
    }
    @MainActor func testMissingRuntimeDoesNotFallBackToGlobalCLI() {
        let service = MacLANService(runtimeURL: URL(fileURLWithPath: "/missing-termbridge-runtime"))
        service.start(address: "127.0.0.1", port: 7400, password: nil)
        XCTAssertEqual(service.phase, .stopped)
        XCTAssertNil(service.profile)
        XCTAssertTrue(service.message.contains("缺少"))
    }
    func testEnterpriseAddressesAreSelectableWithoutAdmittingWildcardOrMulticast() throws {
        XCTAssertTrue(LANAddress.isUsable("30.20.30.40"))
        XCTAssertTrue(LANConnection.isDirectEndpoint("wss://30.20.30.40:7400"))
        for address in ["0.0.0.0", "224.0.0.1", "255.255.255.255", "030.1.2.3"] {
            XCTAssertFalse(LANAddress.isUsable(address))
        }
        XCTAssertFalse(LANConnection.isDirectEndpoint("wss://30.20.30.40:7400/r/room"))
    }
    @MainActor func testCertificateDiscoveryAndHandshakeCancelPromptly() async throws {
        let fd = socket(AF_INET, SOCK_STREAM, 0); defer { Darwin.close(fd) }
        var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET)
        address.sin_len = UInt8(MemoryLayout.size(ofValue: address)); address.sin_addr.s_addr = inet_addr("127.0.0.1")
        XCTAssertEqual(withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }, 0)
        var length = socklen_t(MemoryLayout.size(ofValue: address))
        _ = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        XCTAssertEqual(listen(fd, 4), 0) // Accept TCP, deliberately never answer TLS.
        let endpoint = "wss://127.0.0.1:\(UInt16(bigEndian: address.sin_port))"
        for discover in [true, false] {
            let task = Task {
                let settings = ConnectionSettings(relayURL: endpoint, hostID: "", secret: "fixture-password",
                                                  tlsFingerprint: discover ? "" : String(repeating: "a", count: 64))
                return try await MacConnectionTest.run(settings, discoverCertificate: discover)
            }
            try await Task.sleep(for: .milliseconds(100))
            let started = Date(); task.cancel()
            do { _ = try await task.value; XCTFail("Cancelled probe must not succeed") }
            catch { XCTAssertTrue(error is CancellationError) }
            XCTAssertLessThan(Date().timeIntervalSince(started), 1, "Cancellation must not wait for the network timeout")
        }
    }
    @MainActor func testRefusedConnectionRetainsFailureStageAndNetworkCode() async throws {
        let endpoint = "wss://127.0.0.1:\(try availablePort())"
        for discover in [true, false] {
            let settings = ConnectionSettings(relayURL: endpoint, hostID: "", secret: "2468",
                tlsFingerprint: discover ? "" : String(repeating: "a", count: 64), mode: .direct)
            do {
                _ = try await MacConnectionTest.run(settings, discoverCertificate: discover)
                XCTFail("An unused port must not connect")
            } catch {
                let message = error.localizedDescription
                XCTAssertTrue(message.contains("NSURLErrorDomain/-1004"), message)
                XCTAssertTrue(message.contains(discover ? "读取证书" : "建立 WebSocket 连接"), message)
                XCTAssertFalse(message.contains(endpoint), "Diagnostics must not expose private URLs")
            }
        }
    }
    @MainActor func testPasswordOnlyConnectionSkipsDiscoveryAndDistinguishesPasswordAndHostFailures() async throws {
        guard let runtime = ProcessInfo.processInfo.environment["TB_TEST_LAN_RUNTIME"] else { throw XCTSkip("Explicit packaged runtime only") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tb-connection-test-" + UUID().uuidString)
        let service = MacLANService(runtimeURL: URL(fileURLWithPath: runtime), storageDirectory: directory)
        defer { service.stop(); try? FileManager.default.removeItem(at: directory) }
        service.start(address: "127.0.0.1", port: try availablePort(), password: "2468")
        try await until { service.phase != .starting }
        let profile = try XCTUnwrap(service.profile, service.message)
        XCTAssertEqual(service.savedPassword(), "2468")
        var manual = profile; manual.tlsFingerprint = ""; manual.hostID = ""
        let verified = try await MacConnectionTest.run(manual, discoverCertificate: true)
        XCTAssertTrue(verified.relayURL.hasPrefix("ws://"))
        XCTAssertTrue(verified.tlsFingerprint.isEmpty)
        XCTAssertEqual(verified.hostID, profile.hostID)
        for (kind, expected) in [("password", "密码"), ("host", "Host 不在线")] {
            var invalid = verified
            if kind == "password" { invalid.secret = "wrong-connection-password" }
            if kind == "host" { invalid.hostID = "does-not-exist" }
            do {
                _ = try await MacConnectionTest.run(invalid, discoverCertificate: true)
                XCTFail("\(kind) should fail")
            } catch { XCTAssertTrue(error.localizedDescription.contains(expected), error.localizedDescription) }
        }
        service.stop(); try await until { service.phase == .stopped }
        XCTAssertEqual(service.savedPassword(), "2468", "A reopened settings view must still show four password placeholders")
    }
    @MainActor func testBundledRuntimeStartsWithoutTLSStopsAndRestartsWithoutExternalCLI() async throws {
        guard let runtime = ProcessInfo.processInfo.environment["TB_TEST_LAN_RUNTIME"] else { throw XCTSkip("Explicit packaged runtime only") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tb-native-lan-" + UUID().uuidString)
        let service = MacLANService(runtimeURL: URL(fileURLWithPath: runtime), storageDirectory: directory)
        defer { service.stop(); try? FileManager.default.removeItem(at: directory) }
        let port = try availablePort()
        service.start(address: "127.0.0.1", port: port, password: "native-lan-test-password")
        try await until { service.phase != .starting }
        XCTAssertEqual(service.phase, .ready, service.message)
        let profile = try XCTUnwrap(service.profile)
        XCTAssertTrue(profile.relayURL.hasPrefix("ws://"))
        XCTAssertTrue(profile.tlsFingerprint.isEmpty)
        let probe = LANClientProbe()
        let client = TermbridgeClient(settings: profile, listener: probe)
        defer { client.disconnect() }
        client.connect()
        try await until { probe.output.contains("APPLE_LAN_PTY_OK") || probe.failed }
        XCTAssertTrue(probe.output.contains("APPLE_LAN_PTY_OK"))
        for invalid in [ConnectionSettings(relayURL: profile.relayURL, hostID: profile.hostID, secret: "wrong-password", tlsFingerprint: "")] {
            let rejected = LANClientProbe()
            let connection = TermbridgeClient(settings: invalid, listener: rejected)
            connection.connect()
            try await until { rejected.failed }
            XCTAssertFalse(rejected.discovered)
            connection.disconnect()
        }
        service.start(address: "127.0.0.1", port: port + 1, password: nil)
        XCTAssertEqual(service.profile, profile, "Starting twice must not replace the owner")
        service.stop(); service.stop()
        try await until { service.phase == .stopped }
        XCTAssertNil(service.profile)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("service.pid").path))
        service.start(address: "127.0.0.1", port: port, password: nil)
        try await until { service.phase != .starting }
        XCTAssertEqual(service.phase, .ready, service.message)
        XCTAssertEqual(service.profile?.tlsFingerprint, profile.tlsFingerprint)
        service.stop(); try await until { service.phase == .stopped }
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("service.pid").path))
    }
}

@MainActor private final class LANClientProbe: @preconcurrency TermbridgeClientListener {
    var output = ""
    var failed = false
    var discovered = false
    func clientIsReady(_ client: TermbridgeClient) {}
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        if case .failed = state { failed = true }
        if state == .disconnected { failed = true }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        if message.type == "host_list_result" && !discovered {
            discovered = true
            client.sendControl(["t": .string("session_create"), "command": .string("/bin/echo"), "args": .array([.string("APPLE_LAN_PTY_OK")]), "cols": .int(80), "rows": .int(24)])
        }
        if message.type == "error" { failed = true }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) { output += String(decoding: data, as: UTF8.self) }
}
