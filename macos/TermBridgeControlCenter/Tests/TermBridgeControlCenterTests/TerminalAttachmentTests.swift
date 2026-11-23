import AppKit
import ImageIO
import SwiftTerm
import UniformTypeIdentifiers
import XCTest
@testable import TermBridgeControlCenter

final class TerminalAttachmentTests: XCTestCase {
    static func picture(width: Int = 32, height: Int = 24, type: UTType = .png) throws -> Data {
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(red: 0.9, green: 0.15, blue: 0.2, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let image = try XCTUnwrap(context.makeImage())
        let output = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }

    func testScreenshotEncodingAndPrivateLocalCopy() throws {
        let image = try TerminalImage.encode(.clipboard(Self.picture(width: 4096, height: 1024, type: .tiff)))
        XCTAssertEqual(image.mime, "image/png")
        XCTAssertLessThanOrEqual(image.data.count, TerminalImage.maxBytes)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(image.data as CFData, nil))
        let decoded = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        XCTAssertEqual(decoded.width, 2048); XCTAssertEqual(decoded.height, 512)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let path = try image.saveLocal(root: root)
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: path)), image.data)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path)[.posixPermissions] as? Int, 0o700)
        XCTAssertThrowsError(try TerminalImage.encode(.clipboard(Data("text is not an image".utf8))))
    }

    @MainActor
    func testClipboardImageAndFinderFileUseUnifiedAttachmentEntry() throws {
        let clipboard = NSPasteboard.withUniqueName()
        defer { clipboard.releaseGlobally() }
        let terminal = AttachmentTerminalView(frame: .zero)
        var received: [TerminalImageSource] = []
        terminal.receiveImages = { received = $0 }
        let tiff = try Self.picture(type: .tiff)
        clipboard.setData(tiff, forType: .tiff)
        XCTAssertTrue(terminal.pasteImages(from: clipboard))
        guard case .clipboard(let data) = received.first else { return XCTFail("Expected screenshot bytes") }
        XCTAssertEqual(data, tiff)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".png")
        try Self.picture().write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        clipboard.clearContents(); clipboard.writeObjects([file as NSURL]); clipboard.setData(tiff, forType: .tiff)
        XCTAssertTrue(terminal.pasteImages(from: clipboard))
        guard case .file(let selected) = received.first else { return XCTFail("Finder original must win over icon preview") }
        XCTAssertEqual(selected, file)
        clipboard.clearContents(); clipboard.setString("ordinary text", forType: .string)
        XCTAssertFalse(terminal.pasteImages(from: clipboard))
    }

    @MainActor
    func testLocalAttachmentReferencesAreRetainedAfterInsertion() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let manager = TerminalAttachments(sessionID: "herdr:test:one", remote: false, localRoot: root)
        manager.isConnected = { true }
        manager.add([.clipboard(try Self.picture())])
        try await until { manager.references != nil }
        guard case .ready(let path) = manager.items.first?.state else { return XCTFail("Expected local copy") }
        XCTAssertEqual(manager.references, " [Image: \(path)] ")
        manager.clear()
        XCTAssertTrue(FileManager.default.fileExists(atPath: path), "Agent may read the file after insertion")
    }

    @MainActor
    func testRemoteAcknowledgementsStayBoundToSessionAndRequest() async throws {
        let manager = TerminalAttachments(sessionID: "session-one", remote: true, timeout: 1)
        manager.isConnected = { true }
        var sent: [UUID] = []
        manager.upload = { id, image in sent.append(id); return image.mime == "image/png" }
        manager.add([.clipboard(try Self.picture())])
        try await until { sent.count == 1 }
        let original = sent[0]
        func ack(_ id: UUID, session: String = "session-one", path: String = "/remote/images/test.png") -> ControlMessage {
            ControlMessage(fields: ["t": .string("session_upload_result"), "id": .string(id.uuidString),
                "sessionId": .string(session), "path": .string(path)])
        }
        manager.receive(ack(original, session: "other-session"))
        XCTAssertNil(manager.references)

        // An upload that was already written has an unknown outcome once the
        // connection goes: the bytes may be on the Host, so it is not offered
        // for retry and a second copy is never created behind the user's back.
        manager.connectionLost()
        guard case .unknown = manager.items.first?.state else { return XCTFail("Expected an unknown outcome") }
        manager.retry(original)
        XCTAssertEqual(sent.count, 1, "an unknown upload must not be resent")
        XCTAssertNotNil(manager.error)

        // The user removes it and adds the picture again themselves.
        manager.remove(original)
        manager.add([.clipboard(try Self.picture())])
        try await until { sent.count == 2 }
        // A result for the request that was abandoned cannot complete the new one.
        manager.receive(ack(original)); XCTAssertNil(manager.references)

        // Accepted, but with a path nothing may safely reference. The bytes were
        // written, so this is unresolved rather than a clean failure to repeat.
        manager.receive(ack(sent[1], path: "/remote/file.png\rcommand"))
        XCTAssertNil(manager.references)
        guard case .unknown = manager.items.first?.state else { return XCTFail("Expected an unresolved upload") }
        manager.retry(sent[1])
        XCTAssertEqual(sent.count, 2, "an unresolved upload is never resent on its own")

        // A valid acknowledgement on the same subscription still settles it.
        manager.receive(ack(sent[1]))
        XCTAssertEqual(manager.references, " [Image: /remote/images/test.png] ")
        manager.clear(); manager.receive(ack(sent[1])); XCTAssertTrue(manager.items.isEmpty)
    }

    @MainActor
    func testUploadTimeoutAndDisconnectedQueueAreExplicit() async throws {
        let manager = TerminalAttachments(sessionID: "session-one", remote: true, timeout: 0.05)
        let image = try Self.picture()
        manager.add([.clipboard(image)])
        XCTAssertTrue(manager.items.isEmpty); XCTAssertNotNil(manager.error)
        manager.isConnected = { true }; manager.upload = { _, _ in true }
        manager.add([.clipboard(image)])
        // The frame went out and nothing came back: unknown, not failed. A
        // retry here could put the same image on the Host twice.
        try await until { if case .unknown = manager.items.first?.state { return true }; return false }
        XCTAssertNil(manager.references)
        XCTAssertFalse(manager.items[0].state.isRetryable)
    }

    /// An image encoded while the grant was absent must wait, not be discarded:
    /// the user picked it, and asking for it again is losing their work.
    @MainActor
    func testAnImageEncodedBeforeAuthorizationUploadsOnTheNextGrant() async throws {
        let manager = TerminalAttachments(sessionID: "session-one", remote: true, timeout: 5)
        var granted = false
        var sent: [UUID] = []
        // The conversation takes images, but the subscription has not been
        // answered yet: choosing is allowed, uploading waits.
        manager.isConnected = { true }
        manager.canUpload = { granted }
        manager.upload = { id, _ in sent.append(id); return true }

        manager.add([.clipboard(try Self.picture())])
        try await until { manager.items.first?.image != nil }
        XCTAssertEqual(sent.count, 0, "nothing goes out before the grant")
        XCTAssertEqual(manager.items.count, 1, "the picture stays in the draft")

        granted = true
        manager.uploadsAllowed()
        try await until { sent.count == 1 }
        XCTAssertEqual(sent.count, 1, "exactly once, on the grant that authorized it")
    }

    /// A result issued under a subscription the view has left cannot complete an
    /// image. The Host stopped associating it with this view when the generation
    /// changed, so the honest state is unresolved.
    @MainActor
    func testAResultFromAnAbandonedSubscriptionDoesNotCompleteAnImage() async throws {
        let manager = TerminalAttachments(sessionID: "session-one", remote: true, timeout: 5)
        manager.isConnected = { true }
        var sent: [UUID] = []
        manager.upload = { id, _ in sent.append(id); return true }
        manager.add([.clipboard(try Self.picture())])
        try await until { sent.count == 1 }

        manager.expire(sent[0])
        guard case .unknown = manager.items.first?.state else { return XCTFail("Expected an unresolved upload") }
        // And a late acknowledgement for it is refused rather than applied.
        manager.receive(ControlMessage(fields: ["t": .string("session_upload_result"),
            "id": .string(sent[0].uuidString), "sessionId": .string("session-one"),
            "path": .string("/remote/images/late.png")]))
        XCTAssertNil(manager.references)
    }

    @MainActor
    func testReferencesArePastedWithoutAgentShortcutOrEnter() throws {
        let view = AttachmentTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        let probe = PasteProbe()
        view.terminalDelegate = probe
        view.feed(text: "\u{1b}[?2004h")
        view.insertAttachmentReferences(" [Image: /remote/images/test.png] ")
        XCTAssertEqual(String(decoding: probe.bytes, as: UTF8.self), "\u{1b}[200~ [Image: /remote/images/test.png] \u{1b}[201~")
        XCTAssertFalse(probe.bytes.contains(13)); XCTAssertFalse(probe.bytes.contains(10))
        XCTAssertFalse(TerminalAttachments.validPath("/tmp/file\u{1b}[A.png"))
        XCTAssertFalse(TerminalAttachments.validPath("/tmp/a]b.png"))
        XCTAssertFalse(TerminalAttachments.validPath("/tmp/$(command).png"))
        XCTAssertTrue(TerminalAttachments.validPath("/Users/测试/Library/Application Support/图片.png"))
    }

    @MainActor
    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<100 { if predicate() { return }; try await Task.sleep(nanoseconds: 20_000_000) }
        XCTFail("Attachment operation did not finish"); throw TerminalImage.Failure("Test timed out")
    }

    @MainActor
    func testEnterInsertsReadyImagesAtCursorAsOneWriteAndClearsOnce() async throws {
        _ = NSApplication.shared
        let agent = AgentRecord(sessionId: "fixture", source: "direct", name: "Attachment fixture", workspace: nil, paneId: nil,
            agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
        let window = TerminalWindowController(agent: agent, launch: nil, connection: .defaults)
        defer { window.close() }
        window.attachments.isConnected = { true }
        var request: UUID?
        window.attachments.upload = { id, _ in request = id; return true }
        window.attachments.add([.clipboard(try Self.picture())])
        try await until { request != nil }
        window.attachments.receive(ControlMessage(fields: ["t": .string("session_upload_result"), "id": .string(request!.uuidString),
            "sessionId": .string("fixture"), "path": .string("/remote/current cursor.png")]))
        var writes: [Data] = []
        window.terminal.writeAttachmentInput = { writes.append($0); return true }
        let probe = PasteProbe(); window.terminal.terminalDelegate = probe
        window.terminal.feed(text: "\u{1b}[?2004h")
        window.terminal.send(source: window.terminal.getTerminal(), data: [13][...])
        try await until { !writes.isEmpty }
        XCTAssertEqual(writes, [Data("\u{1b}[200~ [Image: /remote/current cursor.png] \u{1b}[201~\r".utf8)])
        XCTAssertTrue(window.attachments.items.isEmpty)
        window.terminal.send(source: window.terminal.getTerminal(), data: [13][...])
        XCTAssertEqual(writes.count, 1, "The next Enter must not insert the same image again")
        XCTAssertEqual(probe.bytes, Data([13]))
    }

    @MainActor
    func testEnterDuringUploadKeepsTypingAndSendsOnceAfterAcknowledgement() async throws {
        _ = NSApplication.shared
        let agent = AgentRecord(sessionId: "fixture", source: "direct", name: "Attachment fixture", workspace: nil, paneId: nil,
            agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
        let window = TerminalWindowController(agent: agent, launch: nil, connection: .defaults)
        defer { window.close() }
        window.attachments.isConnected = { true }
        var request: UUID?
        window.attachments.upload = { id, _ in request = id; return true }
        window.attachments.add([.clipboard(try Self.picture())])
        try await until { request != nil }
        let probe = PasteProbe(); window.terminal.terminalDelegate = probe
        window.terminal.send(source: window.terminal.getTerminal(), data: Array("still typing".utf8)[...])
        XCTAssertEqual(probe.bytes, Data("still typing".utf8), "Upload must not swallow ordinary input")
        var writes: [Data] = []
        window.terminal.writeAttachmentInput = { writes.append($0); return true }
        window.terminal.send(source: window.terminal.getTerminal(), data: [13][...])
        window.terminal.send(source: window.terminal.getTerminal(), data: [13][...])
        XCTAssertTrue(writes.isEmpty, "No submission before the image is stored")
        let result = ControlMessage(fields: ["t": .string("session_upload_result"), "id": .string(request!.uuidString),
            "sessionId": .string("fixture"), "path": .string("/remote/image.png")])
        window.attachments.receive(result)
        try await until { !writes.isEmpty }
        XCTAssertEqual(writes, [Data(" [Image: /remote/image.png] \r".utf8)])
        XCTAssertTrue(window.attachments.items.isEmpty)
        window.attachments.receive(result)
        XCTAssertEqual(writes.count, 1)
    }

    @MainActor
    func testUploadingAndRejectedWritesBlockEnterAndRetainImages() async throws {
        _ = NSApplication.shared
        let agent = AgentRecord(sessionId: "fixture", source: "direct", name: "Attachment fixture", workspace: nil, paneId: nil,
            agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
        let window = TerminalWindowController(agent: agent, launch: nil, connection: .defaults)
        defer { window.close() }
        window.attachments.isConnected = { true }
        var request: UUID?
        window.attachments.upload = { id, _ in request = id; return true }
        window.attachments.add([.clipboard(try Self.picture())])
        try await until { request != nil }
        let probe = PasteProbe(); window.terminal.terminalDelegate = probe
        var writes = 0
        window.terminal.writeAttachmentInput = { _ in writes += 1; return false }
        window.terminal.send(source: window.terminal.getTerminal(), data: [13][...])
        XCTAssertEqual(writes, 0); XCTAssertTrue(probe.bytes.isEmpty)
        XCTAssertEqual(window.attachments.items.count, 1)
        XCTAssertNotNil(window.attachments.pendingSubmission)
        XCTAssertNil(window.attachments.error)
        let shiftEnter = Data("\u{1b}[13;2u".utf8)
        window.terminal.send(source: window.terminal.getTerminal(), data: Array(shiftEnter)[...])
        XCTAssertEqual(probe.bytes, shiftEnter)
        window.attachments.receive(ControlMessage(fields: ["t": .string("session_upload_result"), "id": .string(request!.uuidString),
            "sessionId": .string("fixture"), "path": .string("/remote/image.png")]))
        try await until { writes == 1 }
        XCTAssertEqual(writes, 1); XCTAssertEqual(window.attachments.items.count, 1)
        XCTAssertNil(window.attachments.pendingSubmission)
        XCTAssertNotNil(window.attachments.error)
        window.terminal.writeAttachmentInput = { payload in
            let key = Data("\u{1b}[13;1u".utf8)
            XCTAssertTrue(payload.suffix(key.count).elementsEqual(key)); return true
        }
        window.terminal.send(source: window.terminal.getTerminal(), data: Array("\u{1b}[13;1u".utf8)[...])
        try await until { window.attachments.items.isEmpty }
        XCTAssertTrue(window.attachments.items.isEmpty)
    }

    @MainActor func testKittyEnterAndModifiedKeysUseTheOriginalEncodedEvent() throws {
        let view = AttachmentTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
        var sequence: Data?
        view.submitPendingAttachments = { sequence = $0; return true }
        view.feed(text: "\u{1b}[>31u")
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: 0, context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        view.keyDown(with: event)
        XCTAssertEqual(sequence, Data("\u{1b}[13u".utf8))
        for text in ["\u{1b}[13;2u", "\u{1b}[13;5u", "\u{1b}[13;1:3u", "some\rtext"] {
            XCTAssertFalse(AttachmentTerminalView.isSubmitKey(Array(text.utf8)[...]))
        }
    }

    @MainActor
    func testNativeDraftStaysEditableAndWaitsForEveryImageAndIMECommit() async throws {
        _ = NSApplication.shared
        let agent = AgentRecord(sessionId: "fixture", source: "direct", name: "Uploads", workspace: nil, paneId: nil,
            agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
        let window = TerminalWindowController(agent: agent, launch: nil, connection: .defaults)
        defer { window.close() }
        window.attachments.isConnected = { true }
        var requests: [UUID] = []
        window.attachments.upload = { id, _ in requests.append(id); return true }
        window.terminal.receiveImages?([.clipboard(try Self.picture()), .clipboard(try Self.picture())])
        try await until { requests.count == 2 }
        let input = window.session.attachmentComposer.input
        input.insertText("说明", replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertEqual(window.attachments.draft, "说明")
        var writes: [Data] = []
        window.terminal.writeAttachmentInput = { writes.append($0); return true }
        input.onSend?()
        XCTAssertNotNil(window.attachments.pendingSubmission, "The send button must show its waiting state")
        XCTAssertTrue(window.session.holdsUnconfirmedSend, "Navigation must retain this queued send")
        XCTAssertTrue(input.isEditable)
        input.insertText("补充", replacementRange: NSRange(location: NSNotFound, length: 0))
        func ack(_ i: Int) {
            window.attachments.receive(ControlMessage(fields: ["t": .string("session_upload_result"),
                "sessionId": .string("fixture"), "id": .string(window.attachments.items[i].id.uuidString), "path": .string("/remote/\(i).png")]))
        }
        ack(0)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(writes.isEmpty)
        input.setMarkedText("中文", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        ack(1)
        try await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertTrue(writes.isEmpty, "Do not send an uncommitted IME candidate")
        input.unmarkText()
        try await until { writes.count == 1 }
        XCTAssertEqual(String(decoding: writes[0], as: UTF8.self), "说明补充中文 [Image: /remote/0.png] [Image: /remote/1.png] \r")
        XCTAssertTrue(window.attachments.draft.isEmpty)
        XCTAssertTrue(input.string.isEmpty)
        XCTAssertNil(window.attachments.pendingSubmission)
    }

    @MainActor
    func testCancelledFailedOrDisconnectedUploadNeverSendsOnLateAcknowledgement() async throws {
        _ = NSApplication.shared
        for reason in ["cancel", "failure", "disconnect", "remove", "close"] {
            let agent = AgentRecord(sessionId: "fixture", source: "direct", name: "Uploads", workspace: nil, paneId: nil,
                agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true)
            let window = TerminalWindowController(agent: agent, launch: nil, connection: .defaults)
            defer { window.close() }
            window.attachments.isConnected = { true }
            var request: UUID?
            window.attachments.upload = { id, _ in request = id; return true }
            window.attachments.add([.clipboard(try Self.picture())])
            try await until { request != nil }
            window.attachments.draft = "keep this draft"
            var writes = 0
            window.terminal.writeAttachmentInput = { _ in writes += 1; return true }
            window.session.sendAttachments()
            let fields: [String: MessagePackValue] = ["t": .string("session_upload_result"),
                "sessionId": .string("fixture"), "id": .string(request!.uuidString)]
            switch reason {
            case "cancel": window.attachments.cancelSubmission()
            case "failure": window.attachments.receive(ControlMessage(fields: fields.merging(["error": .string("failed")]) { _, new in new }))
            case "disconnect": window.session.disconnect()
            case "remove": window.attachments.remove(request!)
            default: window.session.close()
            }
            window.attachments.receive(ControlMessage(fields: fields.merging(["path": .string("/remote/late.png")]) { _, new in new }))
            try await Task.sleep(nanoseconds: 30_000_000)
            XCTAssertNil(window.attachments.pendingSubmission, reason)
            XCTAssertEqual(writes, 0, reason)
            XCTAssertEqual(window.attachments.draft, "keep this draft", reason)
        }
    }
}

@MainActor
private final class PasteProbe: @preconcurrency TerminalViewDelegate {
    var bytes = Data()
    func send(source: TerminalView, data: ArraySlice<UInt8>) { bytes.append(contentsOf: data) }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
