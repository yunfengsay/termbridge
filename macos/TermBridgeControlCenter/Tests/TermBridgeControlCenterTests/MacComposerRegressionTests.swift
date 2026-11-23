import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class MacComposerRegressionTests: XCTestCase {
    @MainActor
    func testImageOnlyPasteIsEnabledByNativeMenuAndEnqueuesOnce() throws {
        _ = NSApplication.shared
        let board = NSPasteboard(name: .init(UUID().uuidString))
        defer { board.releaseGlobally() }
        board.setData(try TerminalAttachmentTests.picture(type: .png), forType: .png)
        let composer = MacChatTextView()
        composer.isRichText = false
        composer.imagePasteboard = board
        var count = 0
        composer.onImages = { count += $0.count }
        XCTAssertTrue(composer.readablePasteboardTypes.contains(.png))
        XCTAssertTrue(composer.readablePasteboardTypes.contains(.fileURL))
        let paste = NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        XCTAssertTrue(composer.validateUserInterfaceItem(paste))
        composer.paste(paste)
        XCTAssertEqual(count, 1)
        XCTAssertTrue(composer.string.isEmpty)
        XCTAssertTrue(composer.readSelection(from: board, type: .png))
        XCTAssertEqual(count, 2, "AppKit's readSelection entrypoint also enqueues exactly once")
    }

    @MainActor
    func testFilePasteKeepsOriginalBytesAndNeverBecomesAnImage() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("review.swift")
        let data = Data("let value = 42\n".utf8)
        try data.write(to: file)
        let encoded = try TerminalImage.encode(.document(file))
        XCTAssertEqual(encoded.data, data)
        XCTAssertEqual(encoded.mime, "application/octet-stream")
        XCTAssertEqual(encoded.fileName, "review.swift")
        let board = NSPasteboard(name: .init(UUID().uuidString))
        defer { board.releaseGlobally() }
        board.writeObjects([file as NSURL])
        let composer = MacChatTextView()
        var sources: [TerminalImageSource] = []
        composer.onImages = { sources = $0 }
        XCTAssertTrue(composer.readSelection(from: board, type: .fileURL))
        guard case .document(let selected) = sources.first else { return XCTFail("Finder file was discarded") }
        XCTAssertEqual(selected, file)
        XCTAssertThrowsError(try TerminalImage.encode(.document(directory)))
    }

    func testNativeSlashHandoffNeverIncludesEnterOrControls() {
        for text in ["/", "/model", "/project:review"] {
            XCTAssertEqual(MacAgentChatView.nativeSlashQuery(text), text)
        }
        for text in ["/model\n", "/exit\r", "/x\u{1b}", "/tmp/file", "normal message"] {
            XCTAssertNil(MacAgentChatView.nativeSlashQuery(text))
        }
    }

    @MainActor
    func testNativeSlashHandoffWritesOnlyQueryToOwnedFixtureTerminal() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let executable = directory.appendingPathComponent("herdr-fixture")
        try #"""
        #!/bin/sh
        stty -echo -icanon min 1 time 0
        printf 'COMMAND_FIXTURE_READY\r\n'
        payload=$(dd bs=128 count=1 2>/dev/null | od -An -tx1)
        printf 'CAPTURE:%s:END\r\n' "$payload"
        sleep 1
        """#.write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        let launch = try TerminalLaunch(herdrExecutable: executable.path, agentPaneId: "fixture:p1")
        let agent = AgentRecord(sessionId: "fixture:slash", source: "herdr", name: "Fixture", workspace: nil,
            paneId: nil, agent: "codex", status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
        let controller = TerminalWindowController(agent: agent, launch: launch)
        controller.present()
        defer { controller.close() }
        func output() -> String {
            String(decoding: controller.terminal.getTerminal().getBufferAsData(), as: UTF8.self)
                .replacingOccurrences(of: "\0", with: "")
        }
        for _ in 0..<100 {
            if output().contains("COMMAND_FIXTURE_READY") { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        XCTAssertTrue(output().contains("COMMAND_FIXTURE_READY"))
        controller.session.openNativeCommands("/model")
        for _ in 0..<100 {
            if output().contains("CAPTURE:") { break }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let capture = output().components(separatedBy: "CAPTURE:").last?
            .components(separatedBy: ":END").first?
            .split(whereSeparator: \.isWhitespace).map(String.init)
        XCTAssertEqual(capture, ["2f", "6d", "6f", "64", "65", "6c"],
                       "query must reach PTY without Return, paste wrappers or a second write")
    }

    @MainActor
    func testPastingBeforeSubscriptionKeepsVisibleRemovableDraft() throws {
        let session = MacAgentChatSession(sessionID: "fixture:paste", settings: ConnectionSettings(
            relayURL: "ws://127.0.0.1:1", hostID: "fixture", secret: "", tlsFingerprint: ""))
        let view = MacAgentChatView(session: session)
        view.composer.onImages?([.clipboard(try TerminalAttachmentTests.picture(type: .png))])
        XCTAssertEqual(view.attachments.items.count, 1, "selecting local data must not depend on remote upload permission")
        XCTAssertFalse(session.canAttach)
        if let item = view.attachments.items.first { view.attachments.remove(item.id) }
        XCTAssertTrue(view.attachments.items.isEmpty)
    }

    @MainActor
    func testWindowChromeMatchesTerminalAndRestoresSystemAppearanceForChat() throws {
        _ = NSApplication.shared
        let agent = AgentRecord(sessionId: "fixture:theme", source: "herdr", name: "Fixture", workspace: nil,
            paneId: nil, agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
        let profile = ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "fixture", secret: "", tlsFingerprint: "")
        let controller = TerminalWindowController(agent: agent, launch: nil, chatConnection: profile)
        defer { controller.close() }
        XCTAssertEqual(controller.window?.backgroundColor, controller.terminal.nativeBackgroundColor)
        XCTAssertEqual(controller.window?.appearance?.name, .darkAqua)
        controller.selectChat(true)
        XCTAssertEqual(controller.window?.backgroundColor, NSColor.windowBackgroundColor)
        XCTAssertNil(controller.window?.appearance)
    }
}
