import AppKit
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

private func agentRecord(_ id: String, workspace: String?, name: String? = nil, agent: String? = nil,
                    status: String = "idle", preview: String? = nil, source: String = "herdr") -> AgentRecord {
    AgentRecord(sessionId: id, source: source, name: name ?? workspace, workspace: workspace, paneId: nil, agent: agent,
        status: status, preview: preview, lastSeenAt: 0, statusChangedAt: 0, present: true)
}

final class SessionDirectoryTests: XCTestCase {
    func testGroupsByWorkspaceLikeHerdrAndNamesRowsByAgent() {
        let records = [
            agentRecord("herdr:w1V:p2", workspace: "termbridge", agent: "claude", status: "working", preview: "Refactoring\nthe socket"),
            agentRecord("herdr:w1V:p1", workspace: "termbridge", agent: "codex"),
            agentRecord("herdr:w1V:p10", workspace: "termbridge", name: "reviewer", agent: "codex"),
            agentRecord("herdr:w1T:p2", workspace: "canvas-three-gpu", agent: "claude", status: "blocked"),
            agentRecord("herdr:w1T:p1", workspace: "canvas-three-gpu", agent: "claude", status: "done"),
            agentRecord("herdr:w1W:p1", workspace: "Linguist"),
            agentRecord("4f1c2d9a-0000", workspace: nil, name: "qa-shell", source: "pty"),
        ]
        let groups = SessionDirectory.groups(records)
        XCTAssertEqual(groups.map(\.title), ["canvas-three-gpu", "Linguist", "termbridge", SessionDirectory.otherGroupTitle])
        // Herdr names an unnamed Agent after its workspace; the row says which Agent.
        XCTAssertEqual(groups[0].rows.map(\.title), ["Claude · p1", "Claude · p2"], "two Claudes are told apart by pane")
        XCTAssertEqual(groups[0].attention, 1)
        XCTAssertEqual(groups[1].rows.map(\.title), ["终端"], "a plain pane does not repeat its workspace name")
        XCTAssertEqual(groups[2].rows.map(\.title), ["Codex", "Claude", "reviewer"], "panes in natural order, explicit names kept")
        XCTAssertEqual(groups[2].working, 1)
        XCTAssertEqual(groups[2].rows[1].detail, "工作中 · Refactoring the socket")
        XCTAssertEqual(groups[3].rows.map(\.title), ["qa-shell"])
        XCTAssertEqual(SessionDirectory.title(records[0]), "Claude")
    }

    func testStatusChangesNeverMoveGroupsOrRows() {
        let records = [
            agentRecord("herdr:w2:p1", workspace: "beta", agent: "codex"),
            agentRecord("herdr:w2:p2", workspace: "beta", agent: "claude"),
            agentRecord("herdr:w1:p1", workspace: "alpha", agent: "codex", status: "done"),
        ]
        let before = SessionDirectory.groups(records).map { $0.rows.map(\.id) }
        let changed = records.map { $0.sessionId == "herdr:w2:p2" ? agentRecord("herdr:w2:p2", workspace: "beta", agent: "claude", status: "blocked") : $0 }
        XCTAssertEqual(SessionDirectory.groups(changed).map { $0.rows.map(\.id) }, before)
        XCTAssertEqual(SessionDirectory.groups(AgentRecord.prioritized(changed)).map { $0.rows.map(\.id) }, before,
                       "the list's own priority order must not leak into the directory")
    }

    func testStandaloneWindowsRemainTheDefault() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "SessionWindowModeTests-\(UUID().uuidString)"))
        XCTAssertEqual(SessionWindowMode.load(from: defaults), .standalone)
        defaults.set("navigator", forKey: SessionWindowMode.defaultsKey)
        XCTAssertEqual(SessionWindowMode.load(from: defaults), .navigator)
        defaults.set("tabs", forKey: SessionWindowMode.defaultsKey)
        XCTAssertEqual(SessionWindowMode.load(from: defaults), .standalone)
    }
}

final class SessionNavigatorTests: XCTestCase {
    private var directories: [URL] = []

    override func tearDown() {
        directories.forEach { try? FileManager.default.removeItem(at: $0) }
        directories = []
        super.tearDown()
    }

    private func temporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        directories.append(directory)
        return directory
    }

    /// A local attachment that prints `marker` and echoes each line, so "is this
    /// still the same connection?" is answered by the process and its screen.
    private func launch(_ marker: String) throws -> TerminalLaunch {
        let executable = try temporaryDirectory().appendingPathComponent("herdr-navigator-fixture")
        try "#!/bin/sh\nprintf '\\033[1;32m\(marker)\\033[0m ready\\r\\n'\nwhile IFS= read -r line; do printf 'echo: %s\\r\\n' \"$line\"; done\n"
            .write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        return try TerminalLaunch(herdrExecutable: executable.path, agentPaneId: "navigator:p1")
    }

    @MainActor private func model(_ records: [AgentRecord], profiles: [ConnectionSettings] = []) throws -> ControlCenterModel {
        let context = try temporaryDirectory().appendingPathComponent("context.json")
        let rows: [[String: Any]] = records.map { record in
            var row: [String: Any] = ["sessionId": record.sessionId, "source": record.source, "status": record.status,
                                      "lastSeenAt": 0, "statusChangedAt": 0, "present": true]
            row["name"] = record.name; row["workspace"] = record.workspace; row["agent"] = record.agent
            row["preview"] = record.preview
            return row
        }
        try JSONSerialization.data(withJSONObject: ["generatedAt": 1_700_000_000_000, "records": rows]).write(to: context)
        return ControlCenterModel(contextURL: context, profiles: profiles, startServices: false)
    }

    @MainActor private func screen(_ session: TerminalSessionController) -> String {
        String(decoding: session.terminal.getTerminal().getBufferAsData(), as: UTF8.self).replacingOccurrences(of: "\0", with: "")
    }

    @MainActor private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<150 { if condition() { return }; try await Task.sleep(nanoseconds: 50_000_000) }
        throw NSError(domain: "SessionNavigatorTests.timeout", code: 1)
    }

    @MainActor private func open(_ navigator: SessionNavigatorController, _ session: TerminalSessionController) {
        navigator.expect(key: SessionNavigatorController.key(session), profileID: session.connection?.id, agent: session.agent)
        navigator.insert(session)
    }

    @MainActor
    func testSwitchingKeepsRecentSessionsConnectedAndClosesTheOldest() async throws {
        _ = NSApplication.shared
        let agents = (1...5).map { agentRecord("herdr:w9:p\($0)", workspace: "navigator", agent: "codex") }
        let model = try model(agents)
        let navigator = SessionNavigatorController(model: model)
        defer { navigator.close() }
        var sessions: [TerminalSessionController] = []
        for (index, agent) in agents.enumerated() {
            let session = TerminalSessionController(agent: agent, launch: try launch("NAV-\(index)"))
            open(navigator, session)
            try await until { self.screen(session).contains("NAV-\(index)") }
            XCTAssertTrue(navigator.visibleSession === session)
            XCTAssertTrue(session.view.window === navigator.window, "the chosen session is in the one window")
            XCTAssertTrue(navigator.window?.firstResponder === session.terminal, "a chosen session is ready to type in")
            if let previous = sessions.last {
                XCTAssertNil(previous.view.window, "the previous session leaves the screen")
                XCTAssertTrue(previous.terminal.process.running, "and stays connected")
            }
            sessions.append(session)
        }
        XCTAssertEqual(navigator.liveSessions.count, SessionNavigatorController.liveLimit)
        XCTAssertFalse(sessions[0].terminal.process.running, "past the limit the least recent session detaches")
        XCTAssertTrue(sessions[1...].allSatisfy { $0.terminal.process.running })
        XCTAssertEqual(navigator.state.selectedRowID, agents[4].sessionId)

        // Going back to a recent session reuses its live attachment: same
        // process, same screen, no reconnect.
        let pid = sessions[2].terminal.process.shellPid
        XCTAssertTrue(navigator.reveal(key: SessionNavigatorController.key(sessions[2]), connection: nil, route: nil))
        XCTAssertTrue(navigator.visibleSession === sessions[2])
        XCTAssertEqual(sessions[2].terminal.process.shellPid, pid)
        XCTAssertTrue(screen(sessions[2]).contains("NAV-2"))
        XCTAssertEqual(navigator.state.selectedRowID, agents[2].sessionId)
        XCTAssertFalse(navigator.reveal(key: SessionNavigatorController.key(sessions[0]), connection: nil, route: nil),
                       "a detached session is opened again, not revealed")

        // Closing the navigator only detaches, like closing a session window.
        navigator.close()
        XCTAssertTrue(navigator.liveSessions.isEmpty)
        XCTAssertTrue(sessions.allSatisfy { !$0.terminal.process.running })
    }

    @MainActor
    func testAnUnconfirmedConversationSendIsNeverDetachedByNavigation() async throws {
        _ = NSApplication.shared
        let navigator = SessionNavigatorController(model: try model([]))
        defer { navigator.close() }
        let chat = ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "fixture", secret: "", tlsFingerprint: "")
        let sending = TerminalSessionController(agent: agentRecord("herdr:send-\(UUID().uuidString):p1", workspace: "w", agent: "claude"),
            launch: nil, chatConnection: chat, preference: .terminal)
        open(navigator, sending)
        sending.chatSession?.composer.begin(requestID: UUID().uuidString, generation: 1)
        XCTAssertTrue(sending.holdsUnconfirmedSend)
        let others = (1...SessionNavigatorController.liveLimit + 1).map {
            TerminalSessionController(agent: agentRecord("herdr:other:p\($0)", workspace: "w", agent: "codex"), launch: nil)
        }
        others.forEach { open(navigator, $0) }
        XCTAssertTrue(navigator.liveSessions.contains { $0 === sending }, "navigation must not turn a pending send into 结果未知")
        XCTAssertTrue(sending.holdsUnconfirmedSend)
        XCTAssertEqual(navigator.liveSessions.count, SessionNavigatorController.liveLimit + 1)

        // Once the send has an answer it is an ordinary session again.
        sending.chatSession?.composer.loseConfirmation("fixture")
        XCTAssertFalse(sending.holdsUnconfirmedSend)
        open(navigator, TerminalSessionController(agent: agentRecord("herdr:other:p9", workspace: "w", agent: "codex"), launch: nil))
        XCTAssertFalse(navigator.liveSessions.contains { $0 === sending })
        XCTAssertEqual(navigator.liveSessions.count, SessionNavigatorController.liveLimit)
    }

    @MainActor
    func testSwitchingHostClearsTheDetailButRetainsItsSession() async throws {
        _ = NSApplication.shared
        let host = ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "remote", secret: "", tlsFingerprint: "", hostName: "Remote")
        let agent = agentRecord("herdr:host:p1", workspace: "local", agent: "codex")
        let model = try model([agent], profiles: [host])
        let navigator = SessionNavigatorController(model: model)
        defer { navigator.close() }
        let session = TerminalSessionController(agent: agent, launch: try launch("HOST-SWITCH"))
        open(navigator, session)
        try await until { self.screen(session).contains("HOST-SWITCH") }
        model.selectProfile(host.id)
        XCTAssertNil(navigator.visibleSession, "A different Host must not leave the old terminal looking selected")
        XCTAssertTrue(navigator.liveSessions.contains { $0 === session })
        XCTAssertTrue(session.terminal.process.running)
        XCTAssertEqual(navigator.state.activeHostID, host.id.uuidString)
        XCTAssertEqual(navigator.window?.titleVisibility, .hidden)
        XCTAssertEqual(navigator.window?.subtitle, "")
    }

    @MainActor
    func testOnlyTheSessionOnScreenTakesFocusAndNeverFromTheSidebar() async throws {
        _ = NSApplication.shared
        let navigator = SessionNavigatorController(model: try model([agentRecord("herdr:f:p1", workspace: "f", agent: "codex")]))
        defer { navigator.close() }
        let first = TerminalSessionController(agent: agentRecord("herdr:f:p1", workspace: "f", agent: "codex"), launch: try launch("FOCUS-1"))
        let second = TerminalSessionController(agent: agentRecord("herdr:f:p2", workspace: "f", agent: "claude"), launch: try launch("FOCUS-2"))
        open(navigator, first); open(navigator, second)
        XCTAssertFalse(first.mayTakeFocus(), "a session off screen never moves focus")
        XCTAssertTrue(second.mayTakeFocus())
        let table = try await sidebarList(navigator)
        XCTAssertTrue(navigator.window?.makeFirstResponder(table) == true)
        XCTAssertFalse(second.mayTakeFocus(), "moving through the list must not be interrupted by an attaching terminal")
        navigator.window?.makeFirstResponder(second.terminal)
        XCTAssertTrue(second.mayTakeFocus())
    }

    /// Arrow keys move through the list and show each session without taking
    /// focus from the list; a click, or ⌘⌥↑/↓, goes into the session.
    @MainActor
    func testArrowKeysBrowseTheListWithoutLeavingIt() async throws {
        _ = NSApplication.shared
        let agents = (1...3).map { agentRecord("herdr:keys:p\($0)", workspace: "keys", agent: "codex") }
        let navigator = SessionNavigatorController(model: try model(agents))
        defer { navigator.close() }
        var made: [String: TerminalSessionController] = [:]
        navigator.openRow = { [unowned navigator] agent in
            let key = MacConnectionCatalog.terminalKey(profileID: nil, sessionID: agent.sessionId)
            if navigator.reveal(key: key, connection: nil, route: nil) { return }
            let session = TerminalSessionController(agent: agent, launch: try? self.launch(agent.sessionId))
            made[agent.sessionId] = session
            navigator.expect(key: key, profileID: nil, agent: agent)
            navigator.insert(session)
        }
        navigator.present()
        let window = try XCTUnwrap(navigator.window)
        navigator.state.choose(try XCTUnwrap(navigator.state.row(agents[0].sessionId)))
        XCTAssertTrue(window.firstResponder === made[agents[0].sessionId]?.terminal, "a click goes into the session")

        let table = try await sidebarList(navigator)
        XCTAssertTrue(window.makeFirstResponder(table))
        for next in agents[1...] {
            try press(125, in: window)
            try await until { navigator.visibleSession?.agent.sessionId == next.sessionId }
            XCTAssertTrue(window.firstResponder === table, "browsing with arrows must not jump into the terminal")
            XCTAssertEqual(navigator.state.selectedRowID, next.sessionId)
        }
        navigator.selectPreviousSession(nil)
        XCTAssertEqual(navigator.visibleSession?.agent.sessionId, agents[1].sessionId)
        XCTAssertTrue(window.firstResponder === made[agents[1].sessionId]?.terminal, "the menu command goes into the session")
        XCTAssertTrue(made[agents[1].sessionId]?.terminal.process.running == true, "and reuses its live attachment")
    }

    /// The sidebar's list, once SwiftUI has built it.
    @MainActor private func sidebarList(_ navigator: SessionNavigatorController) async throws -> NSTableView {
        let split = try XCTUnwrap(navigator.window?.contentViewController as? NSSplitViewController)
        let sidebar = split.splitViewItems[0].viewController.view
        func list(in view: NSView) -> NSTableView? {
            if let table = view as? NSTableView { return table }
            return view.subviews.lazy.compactMap(list).first
        }
        try await until { sidebar.layoutSubtreeIfNeeded(); return list(in: sidebar) != nil }
        return try XCTUnwrap(list(in: sidebar))
    }

    /// Delivers a real key event the way the run loop does, so the app sees it
    /// as the current event.
    @MainActor private func press(_ keyCode: UInt16, in window: NSWindow) throws {
        let character = keyCode == 125 ? NSDownArrowFunctionKey : NSUpArrowFunctionKey
        let characters = String(Character(try XCTUnwrap(Unicode.Scalar(UInt16(character)))))
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [.numericPad, .function],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber, context: nil,
            characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: keyCode))
        NSApp.postEvent(event, atStart: true)
        let delivered = try XCTUnwrap(NSApp.nextEvent(matching: .keyDown, until: Date().addingTimeInterval(1), inMode: .default, dequeue: true))
        window.sendEvent(delivered)
    }

    /// Switching the setting moves what is open; nothing reconnects.
    @MainActor
    func testSessionsMoveBetweenAWindowAndTheNavigatorWithoutReconnecting() async throws {
        _ = NSApplication.shared
        let navigator = SessionNavigatorController(model: try model([]))
        defer { navigator.close() }
        let session = TerminalSessionController(agent: agentRecord("herdr:move:p1", workspace: "move", agent: "codex"), launch: try launch("MOVE"))
        let standalone = TerminalWindowController(session: session)
        standalone.present()
        try await until { self.screen(session).contains("MOVE") }
        let pid = session.terminal.process.shellPid

        navigator.adopt([standalone.releaseSession()])
        XCTAssertFalse(standalone.window?.isVisible ?? true)
        XCTAssertTrue(session.view.window === navigator.window)
        XCTAssertEqual(session.terminal.process.shellPid, pid)
        XCTAssertTrue(session.terminal.process.running)
        session.terminal.send(source: session.terminal.getTerminal(), data: Array("still here\r".utf8)[...])
        try await until { self.screen(session).contains("echo: still here") }

        let released = try XCTUnwrap(navigator.releaseVisible())
        XCTAssertTrue(released === session)
        XCTAssertFalse(navigator.window?.isVisible ?? true)
        XCTAssertTrue(navigator.liveSessions.isEmpty)
        let window = TerminalWindowController(session: released)
        window.present()
        defer { window.close() }
        XCTAssertTrue(session.view.window === window.window)
        XCTAssertEqual(session.terminal.process.shellPid, pid)
        XCTAssertEqual(window.window?.appearance?.name, .darkAqua, "the standalone window applies the terminal chrome again")
        XCTAssertTrue(window.window?.firstResponder === session.terminal)
    }

    /// The setting itself, through the model: open windows merge into the
    /// navigator, and the session on screen comes back out as a window.
    @MainActor
    func testTheSettingMergesOpenWindowsAndSplitsTheVisibleOneBack() async throws {
        _ = NSApplication.shared
        let defaults = UserDefaults.standard
        let previous = defaults.object(forKey: SessionWindowMode.defaultsKey)
        defer { defaults.set(previous, forKey: SessionWindowMode.defaultsKey) }
        defaults.set(SessionWindowMode.standalone.rawValue, forKey: SessionWindowMode.defaultsKey)
        // An unreachable Host: these windows exist and fail to connect, which is
        // all moving them needs.
        let profile = ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "mode", secret: "", tlsFingerprint: "", hostName: "Mode fixture")
        let first = agentRecord("mode-\(UUID().uuidString)", workspace: nil, name: "first", source: "pty")
        let second = agentRecord("mode-\(UUID().uuidString)", workspace: nil, name: "second", source: "pty")
        let model = try model([], profiles: [profile])
        defer { model.disconnectTerminals() }
        model.selectProfile(profile.id)
        func windows() -> [TerminalWindowController] {
            NSApp.windows.compactMap { $0.windowController as? TerminalWindowController }
                .filter { [first.sessionId, second.sessionId].contains($0.session.agent.sessionId) && $0.window?.isVisible == true }
        }
        model.open(first)
        try await until { windows().count == 1 }
        model.open(second)
        try await until { windows().count == 2 }

        defaults.set(SessionWindowMode.navigator.rawValue, forKey: SessionWindowMode.defaultsKey)
        model.applySessionWindowMode()
        XCTAssertTrue(windows().isEmpty, "the separate windows close")
        let navigator = try XCTUnwrap(NSApp.windows.compactMap { $0.windowController as? SessionNavigatorController }
            .first { $0.window?.isVisible == true && $0.liveSessions.contains { $0.agent.sessionId == second.sessionId } })
        XCTAssertEqual(Set(navigator.liveSessions.map(\.agent.sessionId)), [first.sessionId, second.sessionId])
        XCTAssertEqual(navigator.visibleSession?.agent.sessionId, second.sessionId, "the front window stays on screen")

        // In navigator mode the list's own open goes to the same window.
        model.open(first)
        XCTAssertEqual(navigator.visibleSession?.agent.sessionId, first.sessionId)
        XCTAssertTrue(windows().isEmpty)

        defaults.set(SessionWindowMode.standalone.rawValue, forKey: SessionWindowMode.defaultsKey)
        model.applySessionWindowMode()
        XCTAssertFalse(navigator.window?.isVisible ?? true)
        XCTAssertEqual(windows().map(\.session.agent.sessionId), [first.sessionId], "only the session on screen becomes a window")
        windows().forEach { $0.close() }
    }

    /// Visual acceptance: set TB_TERMINAL_RENDER_DIR to capture the navigator.
    @MainActor
    func testRenderNavigatorWithWorkspaces() async throws {
        guard let directory = ProcessInfo.processInfo.environment["TB_TERMINAL_RENDER_DIR"] else {
            throw XCTSkip("Set TB_TERMINAL_RENDER_DIR to capture the navigator window")
        }
        _ = NSApplication.shared
        let records = [
            agentRecord("herdr:w1T:p1", workspace: "canvas-three-gpu", agent: "codex", status: "idle", preview: "Waiting for the next task"),
            agentRecord("herdr:w1T:p2", workspace: "canvas-three-gpu", agent: "claude", status: "done", preview: "GPU picking merged, 14 tests pass"),
            agentRecord("herdr:w1V:p1", workspace: "termbridge", agent: "codex", status: "working", preview: "Herdr-style navigator for the Mac app"),
            agentRecord("herdr:w1V:p2", workspace: "termbridge", agent: "claude", status: "blocked", preview: "Needs approval to run the release script"),
            agentRecord("herdr:w1W:p1", workspace: "Linguist", agent: "claude", status: "done", preview: "Dictionary import finished"),
            agentRecord("6f2a91c0-tb", workspace: nil, name: "qa-shell", status: "ready", source: "pty"),
        ]
        let hosts = [ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "preview-host", secret: "", tlsFingerprint: "", hostName: "homemini")]
        let navigator = SessionNavigatorController(model: try model(records, profiles: hosts))
        defer { navigator.close() }
        navigator.present()
        try await capture(navigator, directory, "navigator-empty")
        let session = TerminalSessionController(agent: records[2], launch: try launch("termbridge · codex"))
        open(navigator, session)
        try await until { self.screen(session).contains("ready") }
        XCTAssertEqual(navigator.window?.titleVisibility, .hidden)
        XCTAssertEqual(navigator.window?.subtitle, "")
        try await capture(navigator, directory, "navigator-terminal")
        session.terminal.receiveImages?([.clipboard(try TerminalAttachmentTests.picture())])
        try await until { session.attachments.references != nil }
        session.attachmentComposer.input.insertText("上传时可以继续输入文字", replacementRange: NSRange(location: NSNotFound, length: 0))
        try await capture(navigator, directory, "navigator-attachments")
        let previousAppearance = NSApp.appearance
        defer { NSApp.appearance = previousAppearance }
        NSApp.appearance = NSAppearance(named: .darkAqua)
        try await capture(navigator, directory, "navigator-terminal-dark")
    }

    @MainActor private func capture(_ navigator: SessionNavigatorController, _ directory: String, _ name: String) async throws {
        guard let window = navigator.window else { return }
        window.contentView?.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 400_000_000)
        if ProcessInfo.processInfo.environment["TB_MACOS_OFFSCREEN_RENDER"] != "1" {
            let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            capture.arguments = ["-x", "-l", String(window.windowNumber), directory + "/" + name + ".png"]
            try capture.run(); capture.waitUntilExit(); XCTAssertEqual(capture.terminationStatus, 0)
            return
        }
        // Useful while the console is locked, but not full window / material QA.
        let view = try XCTUnwrap(window.contentView)
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: directory).appendingPathComponent(name + ".png"))
    }
}

final class SessionWindowModePickerTests: XCTestCase {
    /// Each option's description is always shown under it, so switching the
    /// mode never changes the height of the settings page.
    @MainActor
    func testSwitchingTheModeNeverChangesTheHeightOfTheSettings() throws {
        _ = NSApplication.shared
        func height(_ mode: SessionWindowMode) -> CGFloat {
            let view = NSHostingView(rootView: SessionWindowModePicker(selection: .constant(mode.rawValue)).frame(width: 460))
            view.layoutSubtreeIfNeeded()
            return view.fittingSize.height
        }
        XCTAssertGreaterThan(height(.standalone), 0)
        XCTAssertEqual(height(.standalone), height(.navigator), "the page must not move when the mode changes")

        // Choosing a segment is what writes the setting.
        var stored = SessionWindowMode.standalone.rawValue
        let picker = NSHostingView(rootView: SessionWindowModePicker(selection: Binding(get: { stored }, set: { stored = $0 })))
        picker.frame = NSRect(x: 0, y: 0, width: 460, height: 80)
        picker.layoutSubtreeIfNeeded()
        func segmented(_ view: NSView) -> NSSegmentedControl? {
            (view as? NSSegmentedControl) ?? view.subviews.lazy.compactMap(segmented).first
        }
        let control = try XCTUnwrap(segmented(picker))
        XCTAssertEqual(control.selectedSegment, 0)
        // SwiftUI's own segmented picker stays at its natural ~171pt, which put
        // the descriptions off centre. Equal segments across the full width line up.
        XCTAssertEqual(control.frame.width, 300, accuracy: 1)
        XCTAssertEqual(control.segmentDistribution, .fillEqually)
        control.selectedSegment = 1
        XCTAssertTrue(NSApp.sendAction(try XCTUnwrap(control.action), to: control.target, from: control))
        XCTAssertEqual(stored, SessionWindowMode.navigator.rawValue)

        guard let destination = ProcessInfo.processInfo.environment["TB_MACOS_RENDER_DIR"] else { return }
        for mode in SessionWindowMode.allCases {
            let hosting = NSHostingView(rootView: Form {
                Section("通用") {
                    SessionWindowModePicker(selection: .constant(mode.rawValue))
                    Picker("默认会话界面", selection: .constant("auto")) { Text("自动选择").tag("auto") }
                }
            }.formStyle(.grouped))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 200), styleMask: [.borderless],
                                  backing: .buffered, defer: false)
            window.contentView = hosting
            hosting.frame = NSRect(x: 0, y: 0, width: 480, height: 200)
            hosting.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: destination).appendingPathComponent("session-window-\(mode.rawValue).png"))
        }
    }
}
