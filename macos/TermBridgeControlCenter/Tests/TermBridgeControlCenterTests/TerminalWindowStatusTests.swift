import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class TerminalWindowStatusTests: XCTestCase {
    private func agent(_ session: String = "herdr:test:p1") -> AgentRecord {
        AgentRecord(sessionId: session, source: "herdr", name: "Terminal acceptance", workspace: "TermBridge",
            paneId: nil, agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
    }

    /// Reserves an ephemeral port and then releases it, so nothing owns it. A
    /// socket that is bound but never listening drops the SYN instead of
    /// refusing it, which turns this acceptance into a race against URLSession's
    /// own request timeout (measured at 7.8s against a 7.5s wait budget). A
    /// closed port is refused in about 9ms, so the failure under test is the
    /// one the viewport is supposed to explain.
    private func refusedEndpoint() throws -> String {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        var closed = false
        defer { if !closed { Darwin.close(fd) } }
        var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout.size(ofValue: address))
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        XCTAssertEqual(withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }, 0)
        var length = socklen_t(MemoryLayout.size(ofValue: address))
        _ = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        Darwin.close(fd); closed = true
        return "ws://127.0.0.1:\(UInt16(bigEndian: address.sin_port))"
    }

    @MainActor
    func testFailedConnectionExplainsFailureInViewport() async throws {
        _ = NSApplication.shared
        let profile = ConnectionSettings(relayURL: try refusedEndpoint(), hostID: "test", secret: "", tlsFingerprint: "")
        let controller = TerminalWindowController(agent: agent(), launch: nil, connection: profile)
        controller.present(); defer { controller.close() }
        try await until { controller.connectionStatus.title.stringValue == "终端连接中断" }
        XCTAssertFalse(controller.connectionStatus.isHidden)
        XCTAssertFalse(controller.connectionStatus.detail.stringValue.isEmpty)
        XCTAssertEqual(controller.window?.appearance?.name, .darkAqua, "terminal chrome must match its canvas")
        XCTAssertEqual(controller.terminalContainer.appearance?.name, .darkAqua)
        try await capture(controller, "connection-error")
    }

    @MainActor
    func testLocalTerminalRendersInputAndAttachmentChrome() async throws {
        _ = NSApplication.shared
        let previousAppearance = NSApp.appearance
        NSApp.appearance = NSAppearance(named: .aqua)
        defer { NSApp.appearance = previousAppearance }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let executable = directory.appendingPathComponent("herdr-fixture")
        try #"""
        #!/bin/sh
        printf '\033[2J\033[H\033[1;32mTermBridge\033[0m  ·  terminal connected\r\n\r\n'
        printf '  UTF-8 input and output ready.\r\n  Close this window to detach.\r\n\r\n❯ '
        printf '\033[48;5;237m  ANSI gray background must stay gray  \033[0m\r\n'
        while IFS= read -r line; do printf '\r\n%s\r\n❯ ' "$line"; done
        """#.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let launch = try TerminalLaunch(herdrExecutable: executable.path, agentPaneId: "test:p1")
        let controller = TerminalWindowController(agent: agent(), launch: launch)
        controller.present(); defer { controller.close() }
        XCTAssertEqual(controller.terminal.getTerminal().ansi256PaletteStrategy, .xterm)
        XCTAssertEqual(controller.window?.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]), .darkAqua)
        try await until { controller.connectionStatus.isHidden }
        controller.terminal.send(source: controller.terminal.getTerminal(), data: Array("终端输入正常\r".utf8)[...])
        try await until {
            String(decoding: controller.terminal.getTerminal().getBufferAsData(), as: UTF8.self)
                .replacingOccurrences(of: "\0", with: "").contains("终端输入正常")
        }
        XCTAssertTrue(controller.window?.firstResponder === controller.terminal)
        try await capture(controller, "terminal-connected")
        controller.attachments.add([.clipboard(try TerminalAttachmentTests.picture(type: .tiff))])
        try await until { controller.attachments.references != nil }
        try await capture(controller, "terminal-attachments")
        controller.window?.setContentSize(NSSize(width: 600, height: 360))
        try await capture(controller, "terminal-compact")
    }

    @MainActor
    func testLiveLegacyHostShowsUpgradeInViewport() async throws {
        guard ProcessInfo.processInfo.environment["TB_TEST_LEGACY_TERMINAL"] == "1" else { throw XCTSkip("Opt in to a read-only attachment to the reported session") }
        struct Target: Decodable { let sessionId: String }
        let target = try JSONDecoder().decode(Target.self, from: Data(contentsOf: URL(fileURLWithPath: "/tmp/tb-live-terminal-target.json")))
        let settings = try MacConnectionStore.loadCLIProfile(from: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/settings.json"), environment: [:])
        let controller = TerminalWindowController(agent: agent(target.sessionId), launch: nil, connection: settings)
        controller.present(); defer { controller.close() }
        try await until { controller.connectionStatus.title.stringValue == "Host 需要更新" }
        XCTAssertFalse(controller.connectionStatus.isHidden)
        XCTAssertTrue(controller.connectionStatus.detail.stringValue.contains("0.1.24"))
        try await capture(controller, "host-upgrade-required")
    }

    @MainActor private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<150 { if condition() { return }; try await Task.sleep(nanoseconds: 50_000_000) }
        throw NSError(domain: "TerminalWindowAcceptance", code: 1)
    }
    @MainActor private func capture(_ controller: TerminalWindowController, _ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["TB_TERMINAL_RENDER_DIR"], let window = controller.window else { return }
        window.contentView?.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 200_000_000)
        let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-l", String(window.windowNumber), directory + "/" + name + ".png"]
        try capture.run(); capture.waitUntilExit(); XCTAssertEqual(capture.terminationStatus, 0)
    }
}
