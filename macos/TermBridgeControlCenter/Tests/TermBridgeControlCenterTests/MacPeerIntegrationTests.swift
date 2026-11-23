import Darwin
import XCTest
@testable import TermBridgeControlCenter

final class MacPeerIntegrationTests: XCTestCase {
    @MainActor
    func testNativePeerRoundTripWithoutTerminalAndRevokeReconnect() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let relay = env["TB_MACOS_PEER_RELAY"], let folder = env["TB_MACOS_PEER_ROOT"] else {
            throw XCTSkip("Run scripts/test-mac-peer.mjs with a built disposable Relay/Host")
        }
        let root = URL(fileURLWithPath: folder).appendingPathComponent("files")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("native-file-receipt".utf8).write(to: root.appendingPathComponent("report.txt"))
        let a = ConnectionSettings(relayURL: relay, hostID: "peer-a", secret: "mac-peer-test-secret", tlsFingerprint: "")
        var b = a; b.hostID = "peer-b"
        let file = URL(fileURLWithPath: folder).appendingPathComponent("mac-peer.json")
        let service = MacPeerService(file: file), second = MacPeerService(file: URL(fileURLWithPath: folder).appendingPathComponent("second-peer.json"))
        defer { service.disconnect(); second.disconnect() }
        let id = service.configuration.deviceID
        service.refresh(profiles: [a, a, b]) // Multiple windows/profiles must not duplicate this installation.
        try await devices("peer-a", count: 1)
        try await devices("peer-b", count: 1)
        let info = try await request("peer-a", "info", ["deviceId": id])
        XCTAssertEqual((info["data"] as? [String: Any])?["exposed"] as? Bool, false)
        let denied = try await request("peer-a", "fs.read", ["deviceId": id, "path": "report.txt"])
        XCTAssertEqual(denied["ok"] as? Bool, false)
        let grant = try MacPeerPermission(enabled: true, root: root.path, files: .rw, execute: true).validated()
        service.setPermission(grant, for: a)
        XCTAssertNil(service.error)
        let read = try await run("cli", "peer-a", ["read", "--device", id, "report.txt"])
        XCTAssertEqual(read.trimmingCharacters(in: .whitespacesAndNewlines), "native-file-receipt")
        let networkExec = try await run("cli", "peer-a", ["exec", "--device", id, "--", "/usr/bin/printf", "NETWORK_EXEC"])
        XCTAssertTrue(networkExec.contains("NETWORK_EXEC"))
        let write = try await request("peer-a", "fs.write", ["deviceId": id, "path": "result.txt", "content": "written-on-peer"])
        XCTAssertEqual(write["ok"] as? Bool, true)
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("result.txt")), "written-on-peer")
        let extra = URL(fileURLWithPath: folder).appendingPathComponent("second root 中文")
        try FileManager.default.createDirectory(at: extra, withIntermediateDirectories: true)
        var multiple = grant; multiple.roots.append(extra.path)
        service.setPermission(multiple, for: a)
        XCTAssertNil(service.error)
        let multiInfo = try await request("peer-a", "info", ["deviceId": id])
        XCTAssertEqual(((multiInfo["data"] as? [String: Any])?["roots"] as? [String])?.count, 2)
        let extraFile = extra.appendingPathComponent("receipt.txt").path
        let extraWrite = try await request("peer-a", "fs.write", ["deviceId": id, "path": extraFile, "content": "multi-root-live"])
        XCTAssertEqual(extraWrite["ok"] as? Bool, true)
        let extraRead = try await run("cli", "peer-a", ["read", "--device", id, extraFile])
        XCTAssertEqual(extraRead.trimmingCharacters(in: .whitespacesAndNewlines), "multi-root-live")
        service.setPermission(grant, for: a)
        let removedRoot = try await request("peer-a", "fs.read", ["deviceId": id, "path": extraFile])
        XCTAssertEqual(removedRoot["ok"] as? Bool, false)
        print("LIVE RECEIPT: second root write/read succeeded; removing root denied the next request")
        let otherHost = try await request("peer-b", "fs.read", ["deviceId": id, "path": root.appendingPathComponent("report.txt").path])
        XCTAssertEqual(otherHost["ok"] as? Bool, false, "Host B must not inherit Host A's permission")
        let outside = try await request("peer-a", "fs.read", ["deviceId": id, "path": "../mac-peer.json"])
        XCTAssertEqual(outside["ok"] as? Bool, false)
        let command = try await request("peer-a", "exec", ["deviceId": id, "argv": ["/bin/sh", "-c", "printf NATIVE_EXEC; printf done > executed.txt"]])
        XCTAssertEqual(command["stdout"] as? String, "NATIVE_EXEC")
        XCTAssertEqual(try String(contentsOf: root.appendingPathComponent("executed.txt")), "done")
        second.refresh(profiles: [a])
        try await devices("peer-a", count: 2)
        let ambiguous = try await request("peer-a", "fs.read", ["path": "report.txt"])
        XCTAssertEqual(ambiguous["ok"] as? Bool, false)
        XCTAssertTrue((ambiguous["error"] as? String)?.contains("--device") == true)
        let selected = try await request("peer-a", "fs.read", ["deviceId": id, "path": "report.txt"])
        XCTAssertEqual(selected["ok"] as? Bool, true)

        // The receipt must survive a live local permission change, and the actual PID must die.
        let pending = Task { try await request("peer-a", "exec", ["deviceId": id,
            "argv": ["/bin/sh", "-c", "echo $$ > running.pid; exec /bin/sleep 30"]]) }
        let pidFile = root.appendingPathComponent("running.pid")
        try await until { FileManager.default.fileExists(atPath: pidFile.path) }
        let pid = try XCTUnwrap(Int32(try String(contentsOf: pidFile).trimmingCharacters(in: .whitespacesAndNewlines)))
        XCTAssertEqual(kill(pid, 0), 0)
        service.setPermission(MacPeerPermission(), for: a)
        let cancelled = try await pending.value
        XCTAssertEqual((cancelled["data"] as? [String: Any])?["status"] as? String, "cancelled")
        XCTAssertEqual(kill(pid, 0), -1)
        print("LIVE RECEIPT: exec -> local permission revoked -> cancelled; child PID no longer exists")

        service.disconnect()
        try await devices("peer-a", count: 1)
        service.refresh(profiles: [a, b])
        try await devices("peer-a", count: 2)
        XCTAssertEqual(service.configuration.deviceID, id)
        XCTAssertEqual(try MacPeerConfiguration.load(from: file).deviceID, id)
        let stillDenied = try await request("peer-a", "fs.read", ["deviceId": id, "path": "report.txt"])
        XCTAssertEqual(stillDenied["ok"] as? Bool, false, "Reconnect must not resurrect revoked grants")
        service.setPermission(grant, for: a)
        service.refresh(profiles: [b])
        try await devices("peer-a", count: 1)
        XCTAssertNil(try MacPeerConfiguration.load(from: file).permissions[MacPeerConfiguration.scope(a)], "Removing a Host must forget its grant")
    }

    @MainActor
    private func devices(_ host: String, count: Int) async throws {
        for _ in 0..<80 {
            let response = try await request(host, "peer.list", [:])
            if (response["data"] as? [[String: Any]])?.count == count { return }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NSError(domain: "MacPeerIntegration.deviceCount", code: count)
    }
    @MainActor
    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<100 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        throw NSError(domain: "MacPeerIntegration.timeout", code: 1)
    }
    private func request(_ host: String, _ op: String, _ args: [String: Any]) async throws -> [String: Any] {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: args), as: UTF8.self)
        let output = try await run("request", host, [op, json])
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(output.utf8)) as? [String: Any])
    }
    private func run(_ mode: String, _ host: String, _ arguments: [String]) async throws -> String {
        let env = ProcessInfo.processInfo.environment
        let node = try XCTUnwrap(env["TB_MACOS_PEER_NODE"]), script = try XCTUnwrap(env["TB_MACOS_PEER_SCRIPT"])
        let socket = try XCTUnwrap(env["TB_MACOS_PEER_ROOT"]) + "/" + host + "/bridge.sock"
        let args = mode == "cli" ? [String(decoding: try JSONSerialization.data(withJSONObject: arguments), as: UTF8.self)] : arguments
        return try await Task.detached {
            let process = Process(), pipe = Pipe()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [script, mode, socket] + args
            process.standardOutput = pipe; process.standardError = FileHandle.standardError
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw NSError(domain: "MacPeerIntegration.child", code: Int(process.terminationStatus)) }
            return String(decoding: data, as: UTF8.self)
        }.value
    }
}
