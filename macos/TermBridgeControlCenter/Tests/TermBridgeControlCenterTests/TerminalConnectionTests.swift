import Darwin
import SwiftTerm
import XCTest
@testable import TermBridgeControlCenter

/// Opt-in acceptance against a disposable Host/session, never a live Agent.
final class TerminalConnectionTests: XCTestCase, LocalProcessDelegate {
    private var output = Data()
    private var pending: (String, XCTestExpectation)?
    private var exitExpectation: XCTestExpectation?

    func testRealTBClientInputResizeAndDetach() throws {
        let env = ProcessInfo.processInfo.environment
        guard let host = env["TB_MACOS_TEST_HOST"], let session = env["TB_MACOS_TEST_SESSION"] else {
            throw XCTSkip("Set TB_MACOS_TEST_HOST and TB_MACOS_TEST_SESSION to a disposable session")
        }
        let launch = try TerminalLaunch(sessionId: session, hostId: host)
        let process = LocalProcess(delegate: self)
        defer { if process.running { process.terminate() } }
        expect("attached")
        process.startProcess(executable: "/bin/zsh", args: launch.arguments,
                             environment: TerminalLaunch.environment())
        waitForExpectedOutput()
        let marker = "TB_MACOS_输入_\(UUID().uuidString)"
        expect("\n\(marker)\n")
        process.send(data: Array("printf '\\n\(marker)\\n'\r".utf8)[...])
        waitForExpectedOutput()
        expect("\n37 101\n")
        process.send(data: Array("stty size\r".utf8)[...])
        waitForExpectedOutput()
        exitExpectation = expectation(description: "Only attach client exits")
        process.send(data: [0x1d][...])
        wait(for: [exitExpectation!], timeout: 10)
        XCTAssertFalse(process.running)
        exitExpectation = nil

        // Reconnect the same client object, as the window's Reconnect button does.
        expect("attached")
        process.startProcess(executable: "/bin/zsh", args: launch.arguments,
                             environment: TerminalLaunch.environment())
        waitForExpectedOutput()
        let reconnected = "RECONNECTED_\(UUID().uuidString)"
        expect("\n\(reconnected)\n")
        process.send(data: Array("printf '\\n\(reconnected)\\n'\r".utf8)[...])
        waitForExpectedOutput()
        // Window close uses SIGTERM on this local client only.
        process.terminate()
        XCTAssertFalse(process.running)
    }

    func testLegacyAgentLaunchStartsARealPTYAndAcceptsInput() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let executable = directory.appendingPathComponent("herdr-fixture")
        let script = """
        #!/bin/sh
        printf 'ATTACH:%s:%s:%s\\n' "$1" "$2" "$3"
        while IFS= read -r line; do printf '\\nINPUT:%s\\n' "$line"; done
        """
        try script.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let snapshot = Data(#"{"result":{"snapshot":{"panes":[{"pane_id":"wA:p2","agent":"codex"}]}}}"#.utf8)
        let launch = try HerdrTerminalIdentity.launch(paneId: "wA:p2", snapshot: snapshot, executable: executable.path)
        let process = LocalProcess(delegate: self)
        defer { if process.running { process.terminate() } }
        expect("ATTACH:agent:attach:wA:p2")
        process.startProcess(executable: launch.executable, args: launch.arguments,
                             environment: TerminalLaunch.environment())
        waitForExpectedOutput()
        XCTAssertTrue(process.running)
        expect("INPUT:公司电脑输入")
        process.send(data: Array("公司电脑输入\r".utf8)[...])
        waitForExpectedOutput()
        process.terminate()
        XCTAssertFalse(process.running)
    }

    private func expect(_ text: String) {
        output.removeAll()
        pending = (text, expectation(description: text))
    }
    private func waitForExpectedOutput() {
        let item = pending!
        wait(for: [item.1], timeout: 15)
        XCTAssertNil(pending, "Received: \(String(reflecting: String(decoding: output, as: UTF8.self)))")
    }
    func dataReceived(slice: ArraySlice<UInt8>) {
        output.append(contentsOf: slice)
        let normalized = String(decoding: output, as: UTF8.self).replacingOccurrences(of: "\r", with: "")
        if let (text, expectation) = pending, normalized.contains(text) {
            pending = nil
            expectation.fulfill()
        }
    }
    func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
        exitExpectation?.fulfill()
    }
    func getWindowSize() -> winsize {
        winsize(ws_row: 37, ws_col: 101, ws_xpixel: 0, ws_ypixel: 0)
    }
}
