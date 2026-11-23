import Darwin
import XCTest
@testable import TermBridgeControlCenter

final class MacAppControlTests: XCTestCase {
    @MainActor func testOwnerSocketDispatchesAndRejectsConflictingOwnerThenRebinds() async throws {
        let root = URL(fileURLWithPath: "/tmp/tb-control-" + UUID().uuidString)
        let path = root.appendingPathComponent("app.sock"), server = MacAppControl(), other = MacAppControl()
        defer { server.stop(); other.stop(); try? FileManager.default.removeItem(at: root) }
        var calls = 0
        server.handler = { request in calls += 1; return ["action": request["action"] as? String ?? ""] }
        try server.start(at: path)
        let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        XCTAssertThrowsError(try other.start(at: path))
        let response = try await request(path, "{\"version\":1,\"action\":\"status\"}\n")
        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual((response["data"] as? [String: Any])?["action"] as? String, "status")
        let invalid = try await request(path, "{\"version\":99,\"action\":\"status\"}\n")
        XCTAssertEqual(invalid["ok"] as? Bool, false); XCTAssertEqual(calls, 1)
        server.stop(); server.stop()
        other.handler = { _ in ["replacement": true] }
        try other.start(at: path)
        let rebound = try await request(path, "{\"version\":1,\"action\":\"status\"}\n")
        XCTAssertEqual((rebound["data"] as? [String: Any])?["replacement"] as? Bool, true)
    }

    @MainActor func testStopCancelsInFlightHandlerAndForeignFileIsPreserved() async throws {
        let root = URL(fileURLWithPath: "/tmp/tb-control-" + UUID().uuidString)
        let path = root.appendingPathComponent("app.sock"), server = MacAppControl()
        defer { server.stop(); try? FileManager.default.removeItem(at: root) }
        var started = false, completed = false
        server.handler = { _ in started = true; try await Task.sleep(for: .seconds(30)); completed = true; return [:] }
        try server.start(at: path)
        let pending = Task { try await self.request(path, "{\"version\":1,\"action\":\"status\"}\n") }
        for _ in 0..<100 { if started { break }; try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(started); server.stop()
        do { _ = try await pending.value; XCTFail("Stopped request must not succeed") } catch {}
        XCTAssertFalse(completed)
        try Data("foreign".utf8).write(to: path)
        XCTAssertThrowsError(try server.start(at: path))
        XCTAssertEqual(try String(contentsOf: path), "foreign")
    }

    @MainActor func testRemoteLANAutomationRequiresCurrentExecuteGrantAndRejectsCancelledWork() async throws {
        let root = URL(fileURLWithPath: "/tmp/tb-automation-" + UUID().uuidString)
        let service = MacLANServices(runtimeURL: nil, storageDirectory: root), automation = MacLANAutomation(service: service)
        defer { service.stop(); try? FileManager.default.removeItem(at: root) }
        let request: [String: MessagePackValue] = ["action": .string("relay.ensure")]
        let denied = await automation.peer(request, permission: MacPeerPermission(), cancellation: MacPeerCancellation())
        XCTAssertEqual(denied["ok"]?.boolValue, false)
        XCTAssertEqual(service.relay.phase, .stopped)
        let cancelled = MacPeerCancellation(); cancelled.cancel()
        let result = await automation.peer(request, permission: MacPeerPermission(enabled: true, root: "/tmp", files: .off, execute: true), cancellation: cancelled)
        XCTAssertEqual(result["ok"]?.boolValue, false)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        let forbidden = await automation.peer(["action": .string("connection.add")],
            permission: MacPeerPermission(enabled: true, root: "/tmp", files: .off, execute: true), cancellation: MacPeerCancellation())
        XCTAssertEqual(forbidden["ok"]?.boolValue, false)
    }

    @MainActor func testPackagedRuntimeProvisioningIsIdempotentAndPreservesConflictingServices() async throws {
        guard let runtime = ProcessInfo.processInfo.environment["TB_TEST_LAN_RUNTIME"] else { throw XCTSkip("Explicit packaged runtime only") }
        guard let address = LANAddress.available().first(where: { !$0.address.hasPrefix("127.") })?.address else { throw XCTSkip("No local interface") }
        let root = URL(fileURLWithPath: "/tmp/tb-automation-live-" + UUID().uuidString)
        let service = MacLANServices(runtimeURL: URL(fileURLWithPath: runtime), storageDirectory: root)
        let automation = MacLANAutomation(service: service)
        defer { service.stop(); try? FileManager.default.removeItem(at: root) }
        let port = try freePort()
        let request: [String: Any] = ["action": "relay.ensure", "address": address, "port": port]
        let endpoint = try await automation.handle(request)
        XCTAssertEqual(service.relay.phase, .ready); XCTAssertEqual(service.sharing.phase, .stopped)
        let repeated = try await automation.handle(request)
        XCTAssertEqual(repeated["password"] as? String, endpoint["password"] as? String)
        do { _ = try await automation.handle(["action": "relay.ensure", "port": port + 1]); XCTFail("Must retain existing relay") } catch {}
        XCTAssertEqual(service.configuration.relay?.port, port)
        var join = endpoint; join["action"] = "sharing.join"
        let shared = try await automation.handle(join)
        XCTAssertEqual(shared["status"] as? String, "ready"); XCTAssertEqual(service.sharing.phase, .ready)
        XCTAssertNotNil(service.sharing.bridgeSocket)
        _ = try await automation.handle(join)
        var conflict = join; conflict["port"] = port + 1
        do { _ = try await automation.handle(conflict); XCTFail("Must retain existing Host") } catch {}
        XCTAssertEqual(service.configuration.sharing?.endpoint.port, port)
        service.stopSharing()
        for _ in 0..<100 { if service.sharing.phase == .stopped { break }; try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(service.relay.phase, .ready, "Stopping sharing must not stop the relay")
        service.stopRelay()
        for _ in 0..<100 { if service.relay.phase == .stopped { break }; try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(service.relay.phase, .stopped)
    }

    private func freePort() throws -> Int {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0); defer { Darwin.close(fd) }
        var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout.size(ofValue: address))
        guard withUnsafePointer(to: &address, { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }) == 0 else { throw CocoaError(.fileReadUnknown) }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
        return Int(UInt16(bigEndian: address.sin_port))
    }

    @MainActor private func request(_ path: URL, _ body: String) async throws -> [String: Any] {
        let data = try await Task.detached { () throws -> Data in
            let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw CocoaError(.fileReadUnknown) }; defer { Darwin.close(fd) }
            var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(path.path.utf8CString)
            withUnsafeMutableBytes(of: &address.sun_path) { dest in bytes.withUnsafeBytes { dest.copyBytes(from: $0) } }
            let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            guard connected == 0 else { throw CocoaError(.fileReadUnknown) }
            var timeout = timeval(tv_sec: 3, tv_usec: 0), noSignal: Int32 = 1
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
            setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
            let input = Data(body.utf8); _ = input.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
            var output = Data(), buffer = [UInt8](repeating: 0, count: 2048)
            while !output.contains(10) {
                let count = Darwin.read(fd, &buffer, buffer.count); if count <= 0 { break }
                output.append(contentsOf: buffer.prefix(count))
            }
            return output
        }.value
        let object = try JSONSerialization.jsonObject(with: data)
        return try XCTUnwrap(object as? [String: Any])
    }
}
