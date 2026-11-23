import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class TerminalAttachmentRemoteTests: XCTestCase {
    @MainActor
    func testPasteUploadAndReferenceThroughRealHostAndTerminalWindow() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let endpoint = env["TB_MACOS_TEST_RELAY_A"], let hostRoot = env["TB_MACOS_TEST_UPLOAD_ROOT"] else {
            throw XCTSkip("Provide a disposable Host/Relay and upload root for attachment acceptance")
        }
        _ = NSApplication.shared
        let connection = ConnectionSettings(relayURL: endpoint, hostID: "mini", secret: "macos-tabs-test-secret", tlsFingerprint: "")
        let creator = AttachmentSessionCreator(connection)
        creator.client.connect()
        defer { creator.client.disconnect() }
        try await until { creator.ready }
        XCTAssertTrue(creator.client.sendControl(["t": .string("session_create"), "command": .string("/bin/cat"), "cols": .int(100), "rows": .int(30)]))
        try await until { creator.sessionID != nil }
        let session = try XCTUnwrap(creator.sessionID)
        creator.client.disconnect()
        let agent = AgentRecord(sessionId: session, source: "direct", name: "图片附件测试", workspace: nil, paneId: nil,
            agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
        let window = TerminalWindowController(agent: agent, launch: nil, connection: connection)
        window.present()
        defer { window.close() }
        try await until { window.attachments.isConnected() }
        XCTAssertTrue(window.connectionStatus.isHidden, "An attached, silent PTY must allow input immediately")
        let clipboard = NSPasteboard.withUniqueName()
        defer { clipboard.releaseGlobally() }
        clipboard.setData(try TerminalAttachmentTests.picture(type: .tiff), forType: .tiff)
        var storedPath: String?
        var uploadedBytes: Data?
        let update = window.attachments.onChange
        window.attachments.onChange = {
            if case .ready(let path) = window.attachments.items.first?.state {
                storedPath = path; uploadedBytes = window.attachments.items.first?.image?.data
            }
            update?()
        }
        defer { window.attachments.onChange = update }
        XCTAssertTrue(window.terminal.pasteImages(from: clipboard))
        let input = window.session.attachmentComposer.input
        XCTAssertTrue(window.window?.firstResponder === input)
        input.insertText("upload draft 中文", replacementRange: NSRange(location: NSNotFound, length: 0))
        input.onSend?()
        XCTAssertNotNil(window.attachments.pendingSubmission)
        XCTAssertEqual(window.attachments.draft, "upload draft 中文", "Typing is local even while the image is still preparing")
        try await until { window.attachments.items.isEmpty }
        let path = try XCTUnwrap(storedPath)
        XCTAssertTrue(path.hasPrefix(hostRoot + "/"), "Reference must target the receiving Host's copy")
        let remoteData = try Data(contentsOf: URL(fileURLWithPath: path))
        XCTAssertEqual(remoteData, uploadedBytes)
        if let destination = env["TB_MACOS_RENDER_DIR"], let view = window.window?.contentView {
            view.layoutSubtreeIfNeeded()
            try await Task.sleep(nanoseconds: 200_000_000)
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: destination).appendingPathComponent("attachments.png"))
            if env["TB_MACOS_CAPTURE_WINDOW"] == "1", let number = window.window?.windowNumber {
                let capture = Process()
                capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                capture.arguments = ["-x", "-l", String(number), URL(fileURLWithPath: destination).appendingPathComponent("attachment-window.png").path]
                try capture.run(); capture.waitUntilExit()
                XCTAssertEqual(capture.terminationStatus, 0)
            }
        }
        XCTAssertTrue(window.window?.firstResponder === window.terminal)
        XCTAssertTrue(window.attachments.items.isEmpty)
        let filename = URL(fileURLWithPath: path).lastPathComponent
        try await until {
            let screen = String(decoding: window.terminal.getTerminal().getBufferAsData(), as: UTF8.self)
                .replacingOccurrences(of: "\n", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\0", with: "")
            return screen.contains("upload draft 中文") && screen.contains(filename)
        }
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), remoteData, "File remains available after inserting its reference")
        // Finish only the disposable cat process created by this test.
        window.terminal.send(source: window.terminal.getTerminal(), data: [13, 4][...])
    }

    @MainActor
    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<250 { if predicate() { return }; try await Task.sleep(nanoseconds: 20_000_000) }
        XCTFail("Timed out waiting for disposable Host"); throw TerminalImage.Failure("Remote test timed out")
    }
}

@MainActor
private final class AttachmentSessionCreator: @preconcurrency TermbridgeClientListener {
    var client: TermbridgeClient!
    var ready = false
    var sessionID: String?
    init(_ connection: ConnectionSettings) { client = TermbridgeClient(settings: connection, listener: self) }
    func clientIsReady(_ client: TermbridgeClient) { ready = true }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {}
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        if message.type == "session_created" { sessionID = message.string("sessionId") }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
