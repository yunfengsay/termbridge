import AppKit
import WebKit
import XCTest
@testable import TermBridgeControlCenter

final class MacAgentChatViewTests: XCTestCase {
    @MainActor
    func testBundledTranscriptAndNativeComposer() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let session = MacAgentChatSession(sessionID: "fixture:chat", settings: ConnectionSettings(
            relayURL: "ws://127.0.0.1:1", hostID: "fixture", secret: "", tlsFingerprint: ""))
        session.composer.draft = "请检查这份文件\n保留下一行"
        let view = MacAgentChatView(session: session)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 820, height: 620),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = view
        window.center()
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }
        let ready = expectation(description: "WK portable bridge ready")
        view.onReady = { ready.fulfill() }
        view.load()
        await fulfillment(of: [ready], timeout: 15)
        view.focusComposer()
        XCTAssertTrue(window.firstResponder === view.composer)
        XCTAssertEqual(view.composer.string, session.composer.draft)
        let capabilities: [String: Any] = ["send": true, "attachments": false, "stop": false,
            "approvals": false, "questions": false, "history": true]
        view.render(["op": "snapshot", "generation": 2, "status": "ready", "capabilities": capabilities,
            "messages": [["id": "u1", "seq": 1, "role": "user", "source": "transcript", "timestamp": NSNull(),
                          "blocks": [["type": "text", "text": "帮我整理今天的工作"]]],
                         ["id": "a1", "seq": 2, "role": "assistant", "source": "transcript", "timestamp": NSNull(),
                          "blocks": [["type": "text", "text": "可以。请把需要整理的内容发给我。"],
                                     ["type": "tool-call", "name": "查看文件", "input": "合成验收内容"]]]]])
        var body = ""
        for _ in 0..<60 {
            body = (try? await view.web.evaluateJavaScript("document.body.innerText")) as? String ?? ""
            if body.contains("可以。请把") { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(body.contains("帮我整理今天的工作"))
        XCTAssertTrue(body.contains("可以。请把需要整理的内容发给我。"))
        let theme = try await view.web.evaluateJavaScript("document.documentElement.dataset.theme") as? String
        XCTAssertEqual(theme, "dark")
        try await capture(view: view, window: window)
    }

    /// Whole-window capture needs the Screen Recording permission, which a test
    /// runner usually does not have. WebKit can still rasterise what it drew, so
    /// the evidence is a real render either way — each file says how it was made.
    @MainActor
    private func capture(view: MacAgentChatView, window: NSWindow) async throws {
        guard let directory = ProcessInfo.processInfo.environment["TB_CHAT_RENDER_DIR"] else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        window.contentView?.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 250_000_000)
        var notes: [String] = []

        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        let snapshot = try? await view.web.takeSnapshot(configuration: configuration)
        if let data = snapshot.flatMap(Self.png) {
            try data.write(to: URL(fileURLWithPath: directory + "/mac-agent-chat-transcript-wk-snapshot.png"))
            notes.append("mac-agent-chat-transcript-wk-snapshot.png = WKWebView.takeSnapshot of the bundled transcript renderer")
        }
        if let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: representation)
            if let data = representation.representation(using: .png, properties: [:]) {
                try data.write(to: URL(fileURLWithPath: directory + "/mac-agent-chat-view-cachedisplay.png"))
                notes.append("mac-agent-chat-view-cachedisplay.png = NSView.cacheDisplay of the whole chat view:"
                    + " the WebKit transcript above the native AppKit composer, status line and send button")
            }
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-l", String(window.windowNumber), directory + "/mac-agent-chat-window-screencapture.png"]
        try process.run(); process.waitUntilExit()
        notes.append(process.terminationStatus == 0
            ? "mac-agent-chat-window-screencapture.png = /usr/sbin/screencapture of the live window"
            : "no OS window capture: /usr/sbin/screencapture exited \(process.terminationStatus)"
                + " (Screen Recording permission is not granted to this test runner)")
        try (notes.joined(separator: "\n") + "\n")
            .write(toFile: directory + "/mac-agent-chat-render-notes.txt", atomically: true, encoding: .utf8)
        XCTAssertNotNil(snapshot, "WebKit must be able to rasterise the transcript it rendered")
    }

    private static func png(_ image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let representation = NSBitmapImageRep(data: tiff) else { return nil }
        return representation.representation(using: .png, properties: [:])
    }

    /// Renders the composer card in the states M02 is judged on, from a
    /// synthetic conversation: no relay, no Host, no real transcript.
    ///
    /// Writes PNGs only when `TB_CHAT_RENDER_DIR` is set, so the acceptance
    /// evidence is produced by the same code path the app runs.
    @MainActor
    func testComposerCardRendersInEveryStateItIsJudgedOn() async throws {
        _ = NSApplication.shared
        let (session, transport) = try liveFixture(draft: "第二行之前的一段草稿，用来看清输入框的换行和高度。")
        let view = MacAgentChatView(session: session)
        let window = hosted(view, width: 820)
        defer { window.close(); session.stop() }

        // Three pictures: one the Host accepts, one it refuses outright, and one
        // it acknowledges without a usable path — which is unresolved, not
        // failed, because the bytes may already be stored.
        view.attachments.add([.clipboard(try Self.png()), .clipboard(try Self.png()),
                              .clipboard(try Self.png())])
        for _ in 0..<200 where view.attachments.items.contains(where: { $0.image == nil }) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(view.attachments.items.count, 3)
        let uploads = transport.sentUploads()
        XCTAssertEqual(uploads.count, 3, "every picture was written to the conversation")
        session.receive(ControlMessage(fields: ["t": .string("session_upload_result"),
            "sessionId": .string("fixture:chat"), "id": .string(uploads[0]),
            "path": .string("/tmp/fixture-a.png")]))
        session.receive(ControlMessage(fields: ["t": .string("session_upload_result"),
            "sessionId": .string("fixture:chat"), "id": .string(uploads[1]),
            "error": .string("Host 拒绝了这张图片")]))
        session.receive(ControlMessage(fields: ["t": .string("session_upload_result"),
            "sessionId": .string("fixture:chat"), "id": .string(uploads[2]),
            "path": .string("relative/not-a-host-path.png")]))
        // Looked up by id: the two pictures encode concurrently, so the order
        // they were written in is not the order they sit in the draft. Bound to
        // locals as well — an `if case ... = try XCTUnwrap(x).state {}` hands the
        // empty body to XCTUnwrap's autoclosure message instead of matching.
        let accepted = try XCTUnwrap(view.attachments.items.first { $0.id.uuidString == uploads[0] }).state
        let refused = try XCTUnwrap(view.attachments.items.first { $0.id.uuidString == uploads[1] }).state
        guard case .ready = accepted else { return XCTFail("the accepted picture must show a Host path") }
        guard case .failed = refused else { return XCTFail("the refused picture must show as failed and retryable") }
        let unresolved = try XCTUnwrap(view.attachments.items.first { $0.id.uuidString == uploads[2] }).state
        guard case .unknown = unresolved else { return XCTFail("an unusable path is unresolved, not a clean failure") }
        XCTAssertTrue(refused.isRetryable, "a refusal stored nothing, so it is safe to try again")
        XCTAssertFalse(unresolved.isRetryable, "an unresolved upload must not offer a retry that could duplicate it")
        XCTAssertNil(view.attachments.references, "one bad picture blocks the whole message")
        // The badge under a 40pt thumbnail has to distinguish the two: the full
        // sentences both truncate to "上传…", leaving only the colour.
        XCTAssertNotEqual(refused.badge, unresolved.badge)
        XCTAssertEqual(refused.badge, "失败")
        XCTAssertEqual(unresolved.badge, "未确认")
        XCTAssertEqual(accepted.badge, "", "a picture the Host took needs no badge at all")

        // A real transcript above the card, so the capture shows the reading
        // surface the user actually gets rather than an empty half-window.
        let ready = expectation(description: "bridge ready")
        view.onReady = { ready.fulfill() }
        view.load()
        await fulfillment(of: [ready], timeout: 15)
        view.render(Self.syntheticTranscript)

        for (name, appearance) in [("dark", NSAppearance.Name.darkAqua), ("light", .aqua)] {
            window.appearance = NSAppearance(named: appearance)
            window.setContentSize(NSSize(width: 820, height: 620))
            view.layoutSubtreeIfNeeded()
            // The page redraws on the theme it was just told about.
            let theme = try await Self.settledTheme(view, expecting: name)
            XCTAssertEqual(theme, name, "the transcript must follow the window's appearance")
            try capture(view, "mac-composer-\(name)-attachments")
            window.setContentSize(NSSize(width: 520, height: 620))
            view.layoutSubtreeIfNeeded()
            try await Task.sleep(nanoseconds: 200_000_000)
            try capture(view, "mac-composer-\(name)-narrow")
            // The smallest window M02 has to stay usable in: short as well as
            // narrow, so the card and the transcript both have to give way.
            window.setContentSize(NSSize(width: 600, height: 360))
            view.layoutSubtreeIfNeeded()
            try await Task.sleep(nanoseconds: 200_000_000)
            XCTAssertLessThanOrEqual(view.composerHeightForTesting, MacAgentChatView.maxComposerHeight)
            XCTAssertGreaterThan(view.web.frame.height, 0, "the transcript must not be squeezed out of the window")
            try capture(view, "mac-composer-\(name)-minimum")
        }
    }

    /// A transcript with the things M02 has to show at once: Markdown, a tool
    /// call and a plain answer. Entirely synthetic — no real conversation.
    private static let syntheticTranscript: [String: Any] = [
        "op": "snapshot", "generation": 2, "status": "ready",
        "capabilities": ["send": true, "attachments": true, "stop": false, "approvals": false,
                         "questions": false, "history": true],
        "messages": [
            ["id": "u1", "seq": 1, "role": "user", "source": "transcript", "timestamp": NSNull(),
             "blocks": [["type": "text", "text": "帮我看看 **合成会话** 里的这两张图，并列一下要点。"]]],
            ["id": "a1", "seq": 2, "role": "assistant", "source": "transcript", "timestamp": NSNull(),
             "blocks": [
                ["type": "text", "text": "好的，要点如下：\n\n1. 第一点：`chat.js` 由构建生成\n"
                    + "2. 第二点：附件走会话自己的订阅\n\n> 引用一行，用来看排版。\n\n"
                    + "```swift\nlet composer = MacChatTextView()\ncomposer.isRichText = false\n```"],
                ["type": "tool-call", "name": "读取文件", "input": "Sources/TermBridgeControlCenter/MacAgentChatView.swift"],
                ["type": "text", "text": "以上都是合成内容，不来自任何真实会话。"]]],
        ],
    ]

    @MainActor
    private static func settledTheme(_ view: MacAgentChatView, expecting: String) async throws -> String {
        var theme = ""
        for _ in 0..<60 {
            theme = (try? await view.web.evaluateJavaScript("document.documentElement.dataset.theme")) as? String ?? ""
            if theme == expecting { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        // One more turn so the page has painted what it was just told.
        try await Task.sleep(nanoseconds: 250_000_000)
        return theme
    }

    /// Rasterises the native view itself; no screen recording permission needed.
    @MainActor
    private func capture(_ view: NSView, _ name: String) throws {
        guard let directory = ProcessInfo.processInfo.environment["TB_CHAT_RENDER_DIR"] else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let representation = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: representation)
        let data = try XCTUnwrap(representation.representation(using: .png, properties: [:]))
        try data.write(to: URL(fileURLWithPath: directory + "/\(name).png"))
    }

    /// The Agent answering must not take the keyboard away mid-sentence.
    ///
    /// The transcript is a WebKit view living in the same window as the native
    /// composer; a rendered append that made it first responder would drop the
    /// next keystrokes into the page and lose the caret.
    @MainActor
    func testARemoteAppendDoesNotStealFocusFromTheComposer() async throws {
        _ = NSApplication.shared
        let (session, _) = try liveFixture(draft: "正在输入的半句话")
        let view = MacAgentChatView(session: session)
        let window = hosted(view, width: 820)
        defer { window.close(); session.stop() }
        let ready = expectation(description: "bridge ready")
        view.onReady = { ready.fulfill() }
        view.load()
        await fulfillment(of: [ready], timeout: 15)

        let capabilities: [String: Any] = ["send": true, "attachments": true, "stop": false,
            "approvals": false, "questions": false, "history": true]
        view.render(["op": "snapshot", "generation": 2, "status": "ready", "capabilities": capabilities,
            "messages": [["id": "u1", "seq": 1, "role": "user", "source": "transcript", "timestamp": NSNull(),
                          "blocks": [["type": "text", "text": "第一条"]]]]])
        for _ in 0..<60 {
            let text = (try? await view.web.evaluateJavaScript("document.body.innerText")) as? String ?? ""
            if text.contains("第一条") { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        view.focusComposer()
        let caret = NSRange(location: 4, length: 0)
        view.composer.setSelectedRange(caret)
        XCTAssertTrue(window.firstResponder === view.composer)

        view.render(["op": "append", "generation": 2, "status": "working",
            "capabilities": capabilities,
            "messages": [["id": "a9", "seq": 9, "role": "assistant", "source": "transcript",
                          "timestamp": NSNull(),
                          "blocks": [["type": "text", "text": "远端追加的一段回复"]]]]])
        var body = ""
        for _ in 0..<60 {
            body = (try? await view.web.evaluateJavaScript("document.body.innerText")) as? String ?? ""
            if body.contains("远端追加的一段回复") { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(body.contains("远端追加的一段回复"), "the append has to have been rendered for this to mean anything")
        XCTAssertTrue(window.firstResponder === view.composer, "the transcript took the keyboard")
        XCTAssertEqual(view.composer.selectedRange(), caret, "and moved the caret")
        XCTAssertEqual(view.composer.string, "正在输入的半句话")
    }

    // MARK: - Native composer fixtures

    /// Records what the composer writes, so a fixture can answer as the Host.
    private final class FixtureTransport: AgentChatTransport {
        private(set) var sent: [[String: MessagePackValue]] = []
        func connect() {}
        func disconnect() {}
        func sendControl(_ fields: [String: MessagePackValue]) -> Bool { sent.append(fields); return true }
        func last(_ type: String) -> [String: MessagePackValue]? { sent.last { $0["t"]?.stringValue == type } }
        func count(_ type: String) -> Int { sent.filter { $0["t"]?.stringValue == type }.count }
        func sentUploads() -> [String] {
            sent.filter { $0["t"]?.stringValue == "session_upload" }.compactMap { $0["id"]?.stringValue }
        }
    }

    /// A synthetic conversation: no relay, no Host, no real transcript.
    @MainActor
    private func liveFixture(draft: String = "", attachments: Bool = true)
        throws -> (MacAgentChatSession, FixtureTransport) {
        let transport = FixtureTransport()
        let session = MacAgentChatSession(sessionID: "fixture:chat", settings: ConnectionSettings(
            relayURL: "ws://127.0.0.1:7400", hostID: "fixture", secret: "", tlsFingerprint: ""))
        session.makeTransport = { _, _ in transport }
        session.composer.draft = draft
        session.start()
        session.surfaceReady()
        session.transportIsReady()
        let list = try XCTUnwrap(transport.last(AgentChatProtocol.list))
        session.receive(ControlMessage(fields: ["t": .string(AgentChatProtocol.listResult),
            "requestId": .string(try XCTUnwrap(list["requestId"]?.stringValue)),
            "conversations": .array([.map(["conversationId": .string("fixture:chat"), "paneId": .string("p1"),
                "status": .string("ready"), "chat": .bool(true)])])]))
        let subscribe = try XCTUnwrap(transport.last(AgentChatProtocol.subscribe))
        session.receive(ControlMessage(fields: ["t": .string(AgentChatProtocol.snapshot),
            "requestId": .string(try XCTUnwrap(subscribe["requestId"]?.stringValue)),
            "conversationId": .string("fixture:chat"),
            "generation": .int(Int64(try XCTUnwrap(subscribe["generation"]?.intValue))),
            "status": .string("ready"),
            "capabilities": .map(["send": .bool(true), "history": .bool(true),
                                  "attachments": .bool(attachments)]),
            "messages": .array([])]))
        return (session, transport)
    }

    @MainActor
    private func hosted(_ view: MacAgentChatView, width: CGFloat) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 620),
                              styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.makeKeyAndOrderFront(nil)
        view.layoutSubtreeIfNeeded()
        return window
    }

    @MainActor
    private func button(_ view: NSView, _ identifier: String) throws -> NSButton {
        func search(_ node: NSView) -> NSButton? {
            if let button = node as? NSButton, button.accessibilityIdentifier() == identifier { return button }
            for child in node.subviews { if let found = search(child) { return found } }
            return nil
        }
        return try XCTUnwrap(search(view), "no \(identifier) button in the composer")
    }

    private static func png() throws -> Data {
        let image = NSImage(size: NSSize(width: 6, height: 6))
        image.lockFocus(); NSColor.systemTeal.drawSwatch(in: NSRect(x: 0, y: 0, width: 6, height: 6)); image.unlockFocus()
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: image.tiffRepresentation ?? Data()))
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }

    /// A draft that fits one line in a wide window wraps in a narrow one, and
    /// the card has to grow to show it.
    ///
    /// `layout()` used to only recolour, so the text was still measured against
    /// the previous width: the window narrowed, the draft wrapped underneath,
    /// and the card kept its old height with the tail hidden. The same pass
    /// must also settle — a layout that re-triggers itself would spin against
    /// the thumbnails and the WebKit view sharing this pass.
    @MainActor
    func testTheComposerReflowsWhenTheWindowNarrowsAndSettlesWhenItDoesNot() throws {
        _ = NSApplication.shared
        // Long enough to fill one line of a 960pt window and to need two in a
        // 600pt one, so the reflow is what the height is measuring.
        let draft = String(repeating: "换行测试", count: 13)
        let (session, _) = try liveFixture(draft: draft)
        let view = MacAgentChatView(session: session)
        let window = hosted(view, width: 960)
        defer { window.close(); session.stop() }

        let wide = view.composerHeightForTesting
        XCTAssertEqual(view.composer.string, draft)
        XCTAssertGreaterThanOrEqual(wide, MacAgentChatView.minComposerHeight)

        window.setContentSize(NSSize(width: 600, height: 620))
        view.layoutSubtreeIfNeeded()
        let narrow = view.composerHeightForTesting
        XCTAssertGreaterThan(narrow, wide, "a narrowed window has to grow the card for the wrapped line")
        XCTAssertLessThanOrEqual(narrow, MacAgentChatView.maxComposerHeight)

        // Idle: the same width laid out again changes nothing and leaves nothing
        // dirty, so the pass cannot feed itself.
        for _ in 0..<5 {
            view.layoutSubtreeIfNeeded()
            XCTAssertEqual(view.composerHeightForTesting, narrow, accuracy: 0.5, "an idle layout must not resize")
        }
        XCTAssertFalse(view.needsLayout, "the layout pass left itself dirty")

        window.setContentSize(NSSize(width: 960, height: 620))
        view.layoutSubtreeIfNeeded()
        XCTAssertEqual(view.composerHeightForTesting, wide, accuracy: 0.5, "widening again restores the single line")
    }

    /// Clicking send while the input method still holds a candidate would send a
    /// half-typed word. The candidate belongs to the IME until it is committed.
    @MainActor
    func testTheSendButtonRefusesWhileTheInputMethodHoldsACandidate() throws {
        _ = NSApplication.shared
        let (session, transport) = try liveFixture(draft: "已经输入的内容")
        let view = MacAgentChatView(session: session)
        let window = hosted(view, width: 820)
        defer { window.close(); session.stop() }
        window.makeFirstResponder(view.composer)
        let send = try button(view, "agent-chat-send")
        XCTAssertTrue(send.isEnabled, "a committed draft on a live conversation can be sent")

        view.composer.setMarkedText("shuru", selectedRange: NSRange(location: 5, length: 0),
                                    replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(view.composer.hasMarkedText())
        send.performClick(nil)
        XCTAssertEqual(transport.count(AgentChatProtocol.send), 0, "a candidate is not a message")

        view.composer.unmarkText()
        send.performClick(nil)
        XCTAssertEqual(transport.count(AgentChatProtocol.send), 1, "the committed draft goes out")
    }

    /// A refused send keeps the draft and the images. Clearing the queue for a
    /// message that was never written loses the pictures, and a retry would then
    /// send text naming images the Agent never received.
    @MainActor
    func testARefusedOverlongSendKeepsTheImagesInTheDraft() async throws {
        _ = NSApplication.shared
        let (session, transport) = try liveFixture()
        let view = MacAgentChatView(session: session)
        let window = hosted(view, width: 820)
        defer { window.close(); session.stop() }

        view.attachments.add([.clipboard(try Self.png())])
        for _ in 0..<200 where view.attachments.items.first?.image == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let upload = try XCTUnwrap(transport.last("session_upload"))
        session.receive(ControlMessage(fields: ["t": .string("session_upload_result"),
            "sessionId": .string("fixture:chat"), "id": .string(try XCTUnwrap(upload["id"]?.stringValue)),
            "path": .string("/tmp/fixture-upload.png")]))
        XCTAssertNotNil(view.attachments.references, "the image has a Host path and may be named")

        session.composer.draft = String(repeating: "长", count: 16_000)
        view.composer.string = session.composer.draft
        window.makeFirstResponder(view.composer)
        let enter = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "\r",
            charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36))
        view.composer.keyDown(with: enter)

        XCTAssertEqual(transport.count(AgentChatProtocol.send), 0, "draft plus references is over the limit")
        XCTAssertEqual(view.attachments.items.count, 1, "a refused send keeps the picture")
        XCTAssertNotNil(view.attachments.references, "and keeps its Host path, so a retry names the same image")
        XCTAssertEqual(session.composer.draft.count, 16_000, "the draft is untouched too")
    }

    @MainActor
    func testEnterRespectsMarkedTextAndShift() throws {
        _ = NSApplication.shared
        let view = MacChatTextView(frame: NSRect(x: 0, y: 0, width: 400, height: 80))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        window.makeKeyAndOrderFront(nil); window.makeFirstResponder(view)
        defer { window.close() }
        var sends = 0
        view.onSend = { sends += 1 }
        func enter(_ modifiers: NSEvent.ModifierFlags = []) -> NSEvent {
            NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
                            windowNumber: window.windowNumber, context: nil, characters: "\r",
                            charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)!
        }
        view.string = "第一行"
        view.setSelectedRange(NSRange(location: view.string.utf16.count, length: 0))
        view.keyDown(with: enter(.shift))
        XCTAssertTrue(view.string.contains("\n")); XCTAssertEqual(sends, 0)
        view.setMarkedText("中文候选", selectedRange: NSRange(location: 4, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(view.hasMarkedText())
        view.keyDown(with: enter())
        XCTAssertEqual(sends, 0)
        view.unmarkText()
        view.keyDown(with: enter())
        XCTAssertEqual(sends, 1)
    }
}
