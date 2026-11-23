import XCTest
@testable import TermBridgeControlCenter

final class AppDiagnosticsTests: XCTestCase {
    private final class Clock: @unchecked Sendable {
        let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 1_728_432_000)
        func now() -> Date { lock.lock(); defer { lock.unlock() }; return value }
        func advance() { lock.lock(); value.addTimeInterval(86_400); lock.unlock() }
    }
    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("tb-log-test-" + UUID().uuidString) }

    func testRotationRetainsOnlyThreeDaysAndDoesNotRemoveUnrelatedFiles() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let clock = Clock(), log = AppDiagnostics(directory: dir, clock: { clock.now() }, maintenance: false)
        log.record("first_day"); _ = try await log.contents()
        let unrelated = dir.appendingPathComponent("user.txt"); try Data("keep".utf8).write(to: unrelated)
        for day in 2...4 {
            clock.advance(); log.record("day_\(day)"); _ = try await log.contents()
        }
        let text = String(decoding: try await log.contents(), as: UTF8.self)
        XCTAssertFalse(text.contains("first_day")); XCTAssertTrue(text.contains("day_2")); XCTAssertTrue(text.contains("day_4"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
        // Startup/export cleans expired files even before the next write.
        clock.advance()
        let reopened = AppDiagnostics(directory: dir, clock: { clock.now() }, maintenance: false)
        let newer = String(decoding: try await reopened.contents(), as: UTF8.self)
        XCTAssertFalse(newer.contains("day_2")); XCTAssertTrue(newer.contains("day_3"))
    }
    func testSizeRotationAndConcurrentWritersStayBoundedAndProduceWholeRecords() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let log = AppDiagnostics(directory: dir, maxBytes: 1024, segments: 3, maintenance: false)
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<200 { group.addTask { log.record("record", ["attempt": String(i), "cause": String(repeating: "x", count: 100)]) } }
        }
        _ = try await log.contents()
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])
        XCTAssertLessThanOrEqual(files.count, 3)
        for file in files {
            XCTAssertLessThanOrEqual(try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0, 1024)
            XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int, 0o600)
            for line in try Data(contentsOf: file).split(separator: 10) { XCTAssertNoThrow(try JSONSerialization.jsonObject(with: Data(line))) }
        }
    }
    func testCredentialsAndPayloadsNeverReachFileOrExport() async throws {
        let dir = directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let log = AppDiagnostics(directory: dir, maintenance: false)
        log.record("connection.failed", ["endpoint": "wss://user:secret-marker@example.test/r/private-room?key=private-key",
            "password": "secret-marker", "pairing": "tb1_private", "payload": "private-transcript", "code": "-1005"])
        let error = NSError(domain: NSURLErrorDomain, code: -1005, userInfo: [NSLocalizedDescriptionKey: "private-message", NSURLErrorFailingURLStringErrorKey: "private-url"])
        log.record("network.error", AppDiagnostics.error(error))
        let file = dir.appendingPathComponent("export.txt"); try await log.export(to: file)
        let output = try String(contentsOf: file, encoding: .utf8)
        for forbidden in ["secret-marker", "private-", "tb1_"] { XCTAssertFalse(output.contains(forbidden)) }
        XCTAssertTrue(output.contains("example.test:443")); XCTAssertTrue(output.contains("-1005"))
    }
}
