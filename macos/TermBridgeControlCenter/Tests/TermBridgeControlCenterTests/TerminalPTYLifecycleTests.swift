import AppKit
import Darwin
import XCTest
@testable import TermBridgeControlCenter

final class TerminalPTYLifecycleTests: XCTestCase {
    @MainActor
    func testNaturalExitAndRepeatedReconnectReleasePTYMasters() async throws {
        _ = NSApplication.shared
        let terminal = AttachmentTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        defer { terminal.stopLocalProcess() }
        for _ in 0..<10 {
            terminal.startProcess(executable: "/bin/sh", args: ["-c", "sleep 0.05; exit 0"])
            let fd = terminal.process.childfd
            XCTAssertGreaterThanOrEqual(fd, 0)
            let deadline = Date().addingTimeInterval(3)
            while fcntl(fd, F_GETFD) != -1 && Date() < deadline {
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            XCTAssertEqual(fcntl(fd, F_GETFD), -1, "Ended local terminal retained its PTY master")
            XCTAssertFalse(terminal.process.running)
        }
        terminal.startProcess(executable: "/bin/sh", args: ["-c", "sleep 30"])
        let fd = terminal.process.childfd
        terminal.stopLocalProcess()
        terminal.stopLocalProcess()
        let deadline = Date().addingTimeInterval(3)
        while fcntl(fd, F_GETFD) != -1 && Date() < deadline {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(fcntl(fd, F_GETFD), -1)
    }
}
