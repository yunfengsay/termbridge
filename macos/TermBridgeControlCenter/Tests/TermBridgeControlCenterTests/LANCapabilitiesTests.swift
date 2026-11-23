import AppKit
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

final class LANCapabilitiesTests: XCTestCase {
    func testLegacyConfigurationsMapToIndependentCapabilities() throws {
        for (mode, shares, relay, host, route) in [
            ("direct", true, true, true, LANSharingRoute.local),
            ("relay", true, true, true, .local),
            ("relay", false, true, false, .local),
            ("join", true, false, true, .remote)
        ] {
            let data = try JSONSerialization.data(withJSONObject: ["mode": mode, "shareLocalHost": shares,
                "address": "192.168.0.2", "port": 7400, "password": "fixture-password"])
            let old = try JSONDecoder().decode(LANServiceConfiguration.self, from: data)
            let converted = LANServicesConfiguration.migrate(old)
            XCTAssertEqual(converted.relay != nil, relay)
            XCTAssertEqual(converted.sharing != nil, host)
            if host { XCTAssertEqual(converted.sharing?.route, route); XCTAssertTrue(converted.sharing!.endpoint.enabled) }
            XCTAssertEqual((converted.relay ?? converted.sharing?.endpoint)?.password, "fixture-password")
        }
    }

    @MainActor func testUnknownNewConfigurationIsPreservedAndDoesNotFallBackToLegacy() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tb-capabilities-invalid-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let unknown = Data(#"{"version":99}"#.utf8)
        try unknown.write(to: root.appendingPathComponent("services.json"))
        try Data(#"{"address":"127.0.0.1","port":7400,"password":"fixture"}"#.utf8).write(to: root.appendingPathComponent("connection.json"))
        let services = MacLANServices(runtimeURL: nil, storageDirectory: root)
        services.resumeSavedServices()
        services.startRelay(.init(address: "127.0.0.1", port: 7400, password: "fixture"))
        services.stopRelay()
        XCTAssertEqual(services.relay.phase, .stopped)
        XCTAssertNotNil(services.message)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("services.json")), unknown)
    }

    @MainActor func testLegacyMigrationPreservesHostScopeAndCredentialsBeforeStarting() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tb-capabilities-migrate-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let legacy = Data(#"{"address":"30.10.1.2","port":7400,"password":"fixture"}"#.utf8)
        try legacy.write(to: root.appendingPathComponent("connection.json"))
        let memory = Data("existing Host state".utf8)
        try memory.write(to: root.appendingPathComponent("memory.md"))
        let services = MacLANServices(runtimeURL: nil, storageDirectory: root)
        XCTAssertEqual(services.configuration.sharing?.route, .local)
        XCTAssertEqual(services.configuration.relay?.password, "fixture")
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("connection.json")), legacy)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("memory.md")), memory)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("services.json").path))
    }

    @MainActor func testIndependentCapabilitiesRealRuntimePersistenceFailureAndDependency() async throws {
        guard let runtime = ProcessInfo.processInfo.environment["TB_TEST_LAN_RUNTIME"] else { throw XCTSkip("Explicit packaged runtime required") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tb-capabilities-native-" + UUID().uuidString)
        let runtimeURL = URL(fileURLWithPath: runtime)
        let external = MacLANService(runtimeURL: runtimeURL, storageDirectory: root.appendingPathComponent("external"))
        let services = MacLANServices(runtimeURL: runtimeURL, storageDirectory: root.appendingPathComponent("app"))
        var resumed: MacLANServices?
        defer { external.stop(); services.stop(); resumed?.stop() }
        let remote = LANEndpointConfiguration(address: "127.0.0.1", port: try port(), password: "external-fixture")
        let local = LANEndpointConfiguration(address: "127.0.0.1", port: try port(), password: "local-fixture")
        external.start(address: remote.address, port: remote.port, password: remote.password, mode: .relay, shareLocalHost: false)
        services.startRelay(local)
        try await until { external.phase == .ready && services.relay.phase == .ready }
        services.startSharing(route: .remote, endpoint: remote)
        try await until { services.sharing.phase == .ready && services.sharing.topology != nil && services.relay.topology != nil }
        XCTAssertFalse(services.sharingUsesLocalRelay)
        XCTAssertNotEqual(services.relay.topology?.relayId, services.sharing.topology?.relayId)
        let client = CapabilityClientProbe()
        let connection = TermbridgeClient(settings: try XCTUnwrap(services.sharing.profile), listener: client)
        connection.connect(); defer { connection.disconnect() }
        try await until { client.topology != nil }
        try await render(services, root: root, name: "relay-and-remote-sharing")

        // Turning off the local relay cannot stop this Mac's outbound Host or its client.
        services.stopRelay()
        try await until { services.relay.phase == .stopped }
        XCTAssertEqual(services.sharing.phase, .ready)
        XCTAssertNotNil(client.topology)
        let received = client.sessionLists
        connection.sendControl(["t": .string("session_list")])
        try await until { client.sessionLists > received }
        services.startRelay(local)
        try await until { services.relay.phase == .ready }
        services.stopSharing()
        try await until { services.sharing.phase == .stopped }
        XCTAssertEqual(services.relay.phase, .ready)
        connection.disconnect()
        let saved = try Data(contentsOf: root.appendingPathComponent("app/services.json"))
        services.startSharing(route: .remote, endpoint: .init(address: remote.address, port: remote.port, password: "wrong"))
        try await until { services.sharing.phase == .stopped }
        XCTAssertTrue(services.sharing.message.contains("密码"), services.sharing.message)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("app/services.json")), saved)
        XCTAssertEqual(services.relay.phase, .ready)

        // Sharing through the local relay has an explicit, enforced dependency.
        services.startSharing(route: .local, endpoint: local)
        try await until { services.sharing.phase == .ready && services.sharing.topology != nil }
        XCTAssertTrue(services.sharingUsesLocalRelay)
        services.stopRelay()
        XCTAssertEqual(services.relay.phase, .ready)
        XCTAssertTrue(services.message?.contains("先停止共享") == true)
        try await render(services, root: root, name: "relay-and-local-sharing")
        let config = services.configuration
        let permission = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("app/services.json").path)[.posixPermissions] as? Int
        XCTAssertEqual(permission, 0o600)
        services.stop()
        try await until { services.relay.phase == .stopped && services.sharing.phase == .stopped }
        let next = MacLANServices(runtimeURL: runtimeURL, storageDirectory: root.appendingPathComponent("app")); resumed = next
        XCTAssertEqual(next.configuration, config)
        next.resumeSavedServices()
        try await until { next.relay.phase == .ready && next.sharing.phase == .ready }
        XCTAssertEqual(next.sharing.profile?.secret, local.password)
        next.stopSharing()
        try await until { next.sharing.phase == .stopped }
        XCTAssertEqual(next.relay.phase, .ready)
        next.stopRelay(); external.stop()
        try await until { next.relay.phase == .stopped && external.phase == .stopped }
        try FileManager.default.removeItem(at: root)
    }

    @MainActor func testCancellingEitherStartupDoesNotResurrectItOrStopTheOther() async throws {
        guard let runtime = ProcessInfo.processInfo.environment["TB_TEST_LAN_RUNTIME"] else { throw XCTSkip("Explicit packaged runtime required") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tb-capabilities-cancel-" + UUID().uuidString)
        let services = MacLANServices(runtimeURL: URL(fileURLWithPath: runtime), storageDirectory: root)
        defer { services.stop() }
        let local = LANEndpointConfiguration(address: "127.0.0.1", port: try port(), password: "fixture")
        services.startRelay(local); services.stopRelay()
        try await until { services.relay.phase == .stopped }
        XCTAssertNotEqual(services.configuration.relay?.enabled, true)
        services.startRelay(local)
        try await until { services.relay.phase == .ready }
        services.startSharing(route: .local, endpoint: local); services.stopSharing()
        try await until { services.sharing.phase == .stopped }
        XCTAssertNotEqual(services.configuration.sharing?.endpoint.enabled, true)
        XCTAssertEqual(services.relay.phase, .ready)
        services.stopRelay()
        try await until { services.relay.phase == .stopped }
        try FileManager.default.removeItem(at: root)
    }

    @MainActor private func until(_ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(25)
        while !predicate() && Date() < deadline { try await Task.sleep(for: .milliseconds(30)) }
        XCTAssertTrue(predicate(), "Capability state did not converge")
        if !predicate() { throw NSError(domain: "LANCapabilitiesTests", code: 1) }
    }
    private func port() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0); defer { Darwin.close(fd) }
        var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout.size(ofValue: address))
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        XCTAssertEqual(withUnsafePointer(to: &address) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }, 0)
        var length = socklen_t(MemoryLayout.size(ofValue: address))
        _ = withUnsafeMutablePointer(to: &address) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        return Int(UInt16(bigEndian: address.sin_port))
    }
    @MainActor private func render(_ services: MacLANServices, root: URL, name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["TB_LAN_CAPABILITIES_UI"] else { return }
        _ = NSApplication.shared
        let model = ControlCenterModel(contextURL: root.appendingPathComponent("context.json"), profiles: [], startServices: false)
        let view = NSHostingView(rootView: LANSettingsView(service: services, model: model))
        view.frame = NSRect(x: 0, y: 0, width: 710, height: 650)
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view; window.makeKeyAndOrderFront(nil)
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(200)); view.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
}

@MainActor private final class CapabilityClientProbe: @preconcurrency TermbridgeClientListener {
    var topology: RelayTopology?
    var sessionLists = 0
    func clientIsReady(_ client: TermbridgeClient) {}
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        if state == .disconnected { topology = nil }
        if case .failed = state { topology = nil }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        if message.type == "relay_topology" { topology = RelayTopology.decode(message: message) }
        if message.type == "session_list_result" { sessionLists += 1 }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
