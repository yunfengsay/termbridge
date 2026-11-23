import Darwin
import XCTest
@testable import TermBridgeControlCenter

final class MacPeerTests: XCTestCase {
    private func directory() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tb-peer-test-" + UUID().uuidString).resolvingSymlinksInPath()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        return root.resolvingSymlinksInPath()
    }
    private func permission(_ root: URL, files: MacPeerPermission.FileAccess = .ro, execute: Bool = false) -> MacPeerPermission {
        try! MacPeerPermission(enabled: true, root: root.path, files: files, execute: execute).validated()
    }
    private func call(_ op: String, _ args: [String: MessagePackValue] = [:], _ grant: MacPeerPermission = MacPeerPermission(), cancel: MacPeerCancellation = MacPeerCancellation()) -> ControlMessage {
        ControlMessage(fields: MacPeerExecutor.execute(op: op, args: args, permission: grant, cancellation: cancel))
    }
    func testDefaultDeniedInfoAvailableAndUnsupportedImmediate() {
        for op in ["fs.read", "fs.write", "fs.stat", "fs.ls", "exec", "android.logcat"] {
            XCTAssertEqual(call(op).bool("ok"), false)
        }
        let info = call("info")
        XCTAssertEqual(info.bool("ok"), true)
        XCTAssertEqual(info.fields["data"]?.mapValue?["exposed"], .bool(false))
        XCTAssertEqual(info.fields["data"]?.mapValue?["root"], .string(""))
    }
    func testPermissionPersistsAndCredentialsDoNotLeakOrCarryGrants() throws {
        let file = try directory().appendingPathComponent("mac-peer.json")
        var config = try MacPeerConfiguration.load(from: file)
        let profile = ConnectionSettings(relayURL: "wss://example.invalid", hostID: "one", secret: "fixture-private-room-key", tlsFingerprint: "")
        let key = MacPeerConfiguration.scope(profile)
        config.permissions[key] = permission(file.deletingLastPathComponent())
        try config.save(to: file)
        let reloaded = try MacPeerConfiguration.load(from: file)
        XCTAssertEqual(config.deviceID, reloaded.deviceID)
        XCTAssertEqual(reloaded.permissions[key]?.enabled, true)
        let raw = try String(contentsOf: file)
        XCTAssertFalse(raw.contains(profile.secret)); XCTAssertFalse(raw.contains(profile.relayURL))
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        var changed = profile; changed.secret = "different-room"
        XCTAssertNotEqual(key, MacPeerConfiguration.scope(changed))
        changed = profile; changed.hostID = "two"
        XCTAssertNil(reloaded.permissions[MacPeerConfiguration.scope(changed)])
        try Data("broken".utf8).write(to: file)
        XCTAssertThrowsError(try MacPeerConfiguration.load(from: file))
        XCTAssertThrowsError(try MacPeerPermission(enabled: true, root: "/", files: .ro).validated())
    }
    func testReadWriteListStatBinaryAndLimits() throws {
        let root = try directory(), grant = permission(root, files: .rw)
        let written = call("fs.write", ["path": .string("nested/test.txt"), "content": .string("你好 Peer"), "mkdirp": .bool(true)], grant)
        XCTAssertEqual(written.bool("ok"), true, written.string("error") ?? "")
        let read = call("fs.read", ["path": .string("nested/test.txt")], grant)
        XCTAssertEqual(read.fields["data"]?.mapValue?["content"], .string("你好 Peer"))
        XCTAssertEqual(call("fs.write", ["path": .string("no.txt"), "content": .string("no")], permission(root)).bool("ok"), false)
        XCTAssertEqual(call("fs.ls", [:], grant).fields["data"]?.arrayValue?.count, 1)
        let stat = call("fs.stat", ["path": .string("nested/test.txt")], grant)
        XCTAssertEqual(stat.fields["data"]?.mapValue?["size"]?.doubleValue, 11)
        XCTAssertNotNil(stat.fields["data"]?.mapValue?["mtime"]?.doubleValue)
        let bytes = Data([0, 0xff, 0xab])
        try bytes.write(to: root.appendingPathComponent("binary"))
        XCTAssertEqual(call("fs.read", ["path": .string("binary")], grant).fields["data"]?.mapValue?["content"], .string(bytes.base64EncodedString()))
        let limited = call("fs.read", ["path": .string("binary"), "maxBytes": .int(1)], grant)
        XCTAssertEqual(limited.fields["data"]?.mapValue?["truncated"], .bool(true))
        let big = root.appendingPathComponent("large")
        try Data(repeating: 97, count: MacPeerFiles.limit * 2).write(to: big)
        let capped = call("fs.read", ["path": .string("large")], grant)
        XCTAssertEqual(capped.fields["data"]?.mapValue?["content"]?.stringValue?.utf8.count, MacPeerFiles.limit)
        XCTAssertEqual(capped.fields["data"]?.mapValue?["truncated"], .bool(true))
        XCTAssertNoThrow(try FrameCodec.control(capped.fields))
    }
    func testMultipleRootsPersistAndEnforceBoundaries() throws {
        let first = try directory(), second = try directory(), outside = try directory()
        var grant = permission(first, files: .rw)
        grant.roots += [second.path, first.path]
        grant = try grant.validated()
        XCTAssertEqual(grant.roots.count, 2)
        grant = try JSONDecoder().decode(MacPeerPermission.self, from: JSONEncoder().encode(grant))
        XCTAssertEqual(grant.roots.count, 2)
        let info = call("info", [:], grant)
        XCTAssertEqual(info.fields["data"]?.mapValue?["roots"], .array(grant.roots.map(MessagePackValue.string)))
        let secondFile = second.appendingPathComponent("中文 with space.txt").path
        for path in ["relative.txt", secondFile] {
            XCTAssertEqual(call("fs.write", ["path": .string(path), "content": .string("完整内容")], grant).bool("ok"), true)
            XCTAssertEqual(call("fs.read", ["path": .string(path)], grant).fields["data"]?.mapValue?["content"], .string("完整内容"))
            XCTAssertEqual(call("fs.stat", ["path": .string(path)], grant).bool("ok"), true)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: first.appendingPathComponent("relative.txt").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: second.appendingPathComponent("relative.txt").path))
        var reordered = grant; reordered.roots.reverse()
        XCTAssertEqual(call("fs.write", ["path": .string("new-default.txt"), "content": .string("second")], reordered).bool("ok"), true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: second.appendingPathComponent("new-default.txt").path))
        XCTAssertEqual(call("fs.ls", ["path": .string(second.path)], grant).bool("ok"), true)
        XCTAssertEqual(call("fs.write", ["path": .string(outside.appendingPathComponent("no").path), "content": .string("no")], grant).bool("ok"), false)
        try FileManager.default.createSymbolicLink(at: second.appendingPathComponent("escape"), withDestinationURL: outside)
        XCTAssertEqual(call("fs.write", ["path": .string(second.appendingPathComponent("escape/no").path), "content": .string("no")], grant).bool("ok"), false)
        grant.roots.removeLast()
        grant = try JSONDecoder().decode(MacPeerPermission.self, from: JSONEncoder().encode(grant))
        XCTAssertEqual(call("fs.read", ["path": .string(secondFile)], grant).bool("ok"), false)
    }
    func testLegacyRootMigrationAndManualPathValidation() throws {
        let root = try directory()
        let legacy: [String: Any] = ["enabled": true, "root": root.path, "files": "ro", "execute": false]
        let migrated = try JSONDecoder().decode(MacPeerPermission.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertEqual(migrated.roots, [root.path])
        var empty = legacy; empty["roots"] = [String]()
        let revoked = try JSONDecoder().decode(MacPeerPermission.self, from: JSONSerialization.data(withJSONObject: empty))
        XCTAssertTrue(revoked.root.isEmpty)
        XCTAssertThrowsError(try revoked.validated())
        let home = try MacPeerPermission(root: "~/").validated()
        XCTAssertEqual(home.root, try MacPeerPath.resolve(NSHomeDirectory(), mustExist: true))
        let file = root.appendingPathComponent("file")
        try Data().write(to: file)
        for path in ["relative", "/", file.path, root.appendingPathComponent("missing").path, "/bad\0path"] {
            XCTAssertThrowsError(try MacPeerPermission(root: path).validated(), path)
        }
        var tooMany = MacPeerPermission(); tooMany.roots = Array(repeating: root.path, count: 33)
        XCTAssertThrowsError(try tooMany.validated())
    }
    func testTraversalSymlinkHardlinkAndFifoDenied() throws {
        let outer = try directory(), root = outer.appendingPathComponent("allowed")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let secret = outer.appendingPathComponent("outside.txt")
        try Data("outside-unchanged".utf8).write(to: secret)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape"), withDestinationURL: outer)
        try FileManager.default.linkItem(at: secret, to: root.appendingPathComponent("hard"))
        XCTAssertEqual(mkfifo(root.appendingPathComponent("fifo").path, 0o600), 0)
        let grant = permission(root, files: .rw)
        for path in ["../outside.txt", secret.path, "escape/outside.txt", "hard", "fifo"] {
            XCTAssertEqual(call("fs.read", ["path": .string(path)], grant).bool("ok"), false, path)
            XCTAssertEqual(call("fs.write", ["path": .string(path), "content": .string("must not write")], grant).bool("ok"), false, path)
        }
        XCTAssertEqual(try String(contentsOf: secret), "outside-unchanged")
    }
    func testExecExitStatusOutputCapAndTimeout() throws {
        let grant = permission(try directory(), execute: true)
        let reply = call("exec", ["argv": .array(["/bin/sh", "-c", "printf hello; printf error >&2; exit 7"].map(MessagePackValue.string))], grant)
        XCTAssertEqual(reply.bool("ok"), true); XCTAssertEqual(reply.int("exit"), 7)
        XCTAssertEqual(reply.string("stdout"), "hello"); XCTAssertEqual(reply.string("stderr"), "error")
        let loud = call("exec", ["argv": .array(["/bin/sh", "-c", "dd if=/dev/zero bs=1024 count=600 2>/dev/null; printf END >&2"].map(MessagePackValue.string))], grant)
        XCTAssertEqual(loud.string("stdout")?.utf8.count, 128 * 1024)
        XCTAssertEqual(loud.string("stderr"), "END")
        XCTAssertEqual(loud.fields["data"]?.mapValue?["truncated"], .bool(true))
        let start = Date()
        let timeout = call("exec", ["argv": .array(["/bin/sleep", "30"].map(MessagePackValue.string)), "timeoutMs": .int(100)], grant)
        XCTAssertEqual(timeout.int("exit"), 124); XCTAssertEqual(timeout.bool("ok"), false)
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
    }
    func testRevocationKillsActualCommandAndReturnsCancelled() throws {
        let root = try directory(), grant = permission(root, execute: true), cancel = MacPeerCancellation()
        let pidFile = root.appendingPathComponent("pid")
        let done = expectation(description: "native command cancelled")
        DispatchQueue.global().async {
            let result = self.call("exec", ["argv": .array(["/bin/sh", "-c", "echo $$ > pid; exec /bin/sleep 30"].map(MessagePackValue.string))], grant, cancel: cancel)
            XCTAssertEqual(result.bool("ok"), false)
            XCTAssertEqual(result.fields["data"]?.mapValue?["status"], .string("cancelled"))
            done.fulfill()
        }
        for _ in 0..<100 {
            if FileManager.default.fileExists(atPath: pidFile.path) { break }
            Thread.sleep(forTimeInterval: 0.02)
        }
        let pid = try XCTUnwrap(Int32(try String(contentsOf: pidFile).trimmingCharacters(in: .whitespacesAndNewlines)))
        XCTAssertEqual(kill(pid, 0), 0)
        cancel.cancel()
        wait(for: [done], timeout: 3)
        XCTAssertEqual(kill(pid, 0), -1)
    }
}
