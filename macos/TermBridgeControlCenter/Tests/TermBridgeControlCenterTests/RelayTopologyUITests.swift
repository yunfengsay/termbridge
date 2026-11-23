import AppKit
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

final class RelayTopologyUITests: XCTestCase {
    @MainActor private func until(_ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(25)
        while !predicate() && Date() < deadline { try await Task.sleep(for: .milliseconds(30)) }
        XCTAssertTrue(predicate(), "Native relay state did not converge")
    }
    @MainActor func testRealRelayOnlyJoinClientTopologyAndReconnect() async throws {
        guard let path = ProcessInfo.processInfo.environment["TB_TEST_LAN_RUNTIME"],
              let output = ProcessInfo.processInfo.environment["TB_TOPOLOGY_UI_PROOF"] else { throw XCTSkip("Isolated packaged runtime and native proof path required") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tb-topology-native-" + UUID().uuidString)
        let relay = MacLANService(runtimeURL: URL(fileURLWithPath: path), storageDirectory: directory.appendingPathComponent("relay"))
        let host = MacLANService(runtimeURL: URL(fileURLWithPath: path), storageDirectory: directory.appendingPathComponent("host"))
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout.size(ofValue: address))
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        XCTAssertEqual(withUnsafePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }, 0)
        var length = socklen_t(MemoryLayout.size(ofValue: address))
        _ = withUnsafeMutablePointer(to: &address) { pointer in pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        Darwin.close(fd)
        let port = Int(UInt16(bigEndian: address.sin_port))
        defer { relay.stop(); host.stop(); try? FileManager.default.removeItem(at: directory) }
        relay.start(address: "127.0.0.1", port: port, password: "fixture-password", mode: .relay, shareLocalHost: false)
        try await until { relay.phase == .ready && relay.topology != nil }
        XCTAssertEqual(relay.topology?.nodes.count, 1); XCTAssertFalse(relay.sharesHost)
        host.start(address: "127.0.0.1", port: port, password: "fixture-password", mode: .join)
        try await until { host.phase == .ready && host.topology != nil }
        let profile = try XCTUnwrap(host.profile)
        let model = ControlCenterModel(contextURL: directory.appendingPathComponent("context.json"), profiles: [profile], startServices: false)
        let probe = TopologyProbe()
        let client = TermbridgeClient(settings: profile, listener: probe)
        client.connect(); defer { client.disconnect() }
        try await until { probe.topology != nil && relay.topology?.nodes.contains(where: { $0.role == .client }) == true }
        let topology = try XCTUnwrap(probe.topology)
        XCTAssertEqual(topology.nodes.first { $0.id == topology.selfNodeId }?.role, .client)
        XCTAssertEqual(topology.selectedHostId, profile.hostID)
        XCTAssertEqual(host.topology?.selfNodeId, "host:" + profile.hostID)
        _ = NSApplication.shared
        func render<V: View>(_ root: V, name: String, width: CGFloat, height: CGFloat) async throws {
            let view = NSHostingView(rootView: root); view.frame = NSRect(x: 0, y: 0, width: width, height: height)
            let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = view; window.orderFront(nil)
            defer { window.orderOut(nil) }
            try await Task.sleep(for: .milliseconds(200)); view.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds)); view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: output).appendingPathComponent(name + ".png"))
        }
        try await render(RelayTopologyView(topology: topology).padding(20).background(Color(nsColor: .windowBackgroundColor)), name: "client-topology", width: 600, height: 240)
        relay.stop(); try await until { relay.phase == .stopped && host.phase == .reconnecting && probe.topology == nil }
        XCTAssertNil(host.topology)
        relay.start(address: "127.0.0.1", port: port, password: nil, mode: .relay, shareLocalHost: false)
        try await until { relay.phase == .ready && host.phase == .ready && host.topology != nil }
        client.disconnect(); client.connect(); try await until { probe.topology != nil }
        host.stop(); try await until { host.phase == .stopped && relay.topology?.nodes.count == 1 }
        relay.stop(); try await until { relay.phase == .stopped }
    }
    @MainActor func testRelayAddressesAndLegacyConfiguration() throws {
        for value in ["relay", "mac-mini.local", "192.168.0.4"] { XCTAssertTrue(MacLANService.validRelayAddress(value)) }
        for value in ["", "ws://relay", "relay:7400", "224.0.0.1", "-host", "01.2.3.4"] { XCTAssertFalse(MacLANService.validRelayAddress(value)) }
        let legacy = try JSONDecoder().decode(LANServiceConfiguration.self, from: Data(#"{"address":"192.168.0.4","port":7400,"password":"2468"}"#.utf8))
        XCTAssertEqual(legacy.mode ?? .direct, .direct)
        XCTAssertTrue(legacy.shareLocalHost ?? true)
    }
}

@MainActor private final class TopologyProbe: @preconcurrency TermbridgeClientListener {
    var topology: RelayTopology?
    func clientIsReady(_ client: TermbridgeClient) {}
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        if state == .disconnected { topology = nil }
        if case .failed = state { topology = nil }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        if message.type == "relay_topology" { topology = RelayTopology.decode(message: message) }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
