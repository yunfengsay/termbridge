import AppKit
import SwiftTerm
import SwiftUI
import UniformTypeIdentifiers

/// One session's terminal and conversation, and the connections behind them.
///
/// It owns no window. A standalone `TerminalWindowController` and the session
/// navigator both host `view`, and a session moved from one to the other keeps
/// its connection, draft and screen. It owns only a local attachment client;
/// the server owns the terminal lifecycle.
@MainActor
final class TerminalSessionController: NSObject, @preconcurrency LocalProcessTerminalViewDelegate, @preconcurrency TerminalViewDelegate, @preconcurrency TermbridgeClientListener {
    private let launch: TerminalLaunch?
    let connection: ConnectionSettings?
    private var notificationRoute: MacNotificationRoute?
    private var validatingNotificationTarget = false
    /// A route only becomes attachable after the live session list proves it.
    private var notificationRouteValidated = false
    /// A target that failed validation stays rejected for this session in both
    /// views: the terminal fallback must not attach the replacement session that
    /// reused the same ID, and the local launch has nothing of its own to check.
    private(set) var routeRejection: String?
    let agent: AgentRecord
    private var scrollMonitor: Any?
    private var client: TermbridgeClient?
    private var sid: Int?
    private var connecting = false
    private(set) var remoteProcessEnded = false
    private var receivedRemoteOutput = false
    private var usingCompatibleTerminal = false
    private var supportsHistoryScroll = false
    let terminal = AttachmentTerminalView(frame: NSRect(x: 0, y: 0, width: 960, height: 600))
    let attachments: TerminalAttachments
    let attachmentComposer = TerminalAttachmentComposer(frame: .zero)
    private var attachmentUpdateScheduled = false
    private let status = NSTextField(labelWithString: "")
    private let reconnect = NSButton(title: "重连", target: nil, action: nil)
    let connectionStatus = TerminalStatusView(frame: .zero)
    private let statusDot = NSView()
    private var connectionTimeout: Task<Void, Never>?
    /// Fixed dark: a terminal looks like a terminal whatever the system does.
    let terminalContainer = NSView()
    private(set) var chatSession: MacAgentChatSession?
    private(set) var chatView: MacAgentChatView?
    /// Why this session refuses, when it does. Shown by whichever view is up
    /// rather than by a strip that is present even when there is nothing wrong.
    private var chatNotice: String?
    private(set) var showingChat = false
    private var pendingNativeCommand: String?
    /// Everything this session shows. Its container pins it to its own edges.
    let view = NSView()
    /// Called when the session switches between terminal and conversation, so
    /// the container can match its chrome to the surface.
    var onSurfaceChange: (() -> Void)?
    /// Whether the session may move keyboard focus on its own, for example when
    /// its terminal finishes attaching. The navigator answers no while the user
    /// is moving through its list. Explicit actions on the session still focus.
    var mayTakeFocus: () -> Bool = { true }
    /// Whichever window hosts the session right now; nil while it is off screen.
    private var window: NSWindow? { view.window }

    init(agent: AgentRecord, launch: TerminalLaunch?, connection: ConnectionSettings? = nil, notificationRoute: MacNotificationRoute? = nil,
         chatConnection: ConnectionSettings? = nil, preference: SessionUIPreference = .terminal) {
        self.notificationRoute = notificationRoute
        self.launch = launch
        self.connection = connection
        self.agent = agent
        attachments = TerminalAttachments(sessionID: agent.sessionId, remote: connection != nil)
        super.init()
        attachments.isConnected = { [weak self] in
            guard let self else { return false }
            return self.connection == nil ? self.terminal.process.running : self.sid != nil
        }
        attachments.upload = { [weak self] id, image in
            guard let self, self.sid != nil else { return false }
            return self.client?.sendControl(["t": .string("session_upload"), "id": .string(id.uuidString),
                "sessionId": .string(self.agent.sessionId), "mime": .string(image.mime), "data": .binary(image.data)]) == true
        }
        if connection != nil && agent.source == "herdr" {
            terminal.remoteScroll = { [weak self] lines in
                guard let self, let sid = self.sid else { return }
                guard !self.usingCompatibleTerminal || self.supportsHistoryScroll else {
                    self.setStatus("当前 Host 需要更新才能滚动历史", color: .systemOrange)
                    return
                }
                guard let fields = NativeTerminalScroll.fields(sid: sid, lines: lines) else { return }
                self.client?.sendControl(fields)
            }
        }
        terminal.openTerminalLink = { [weak self] in self?.openTerminalLink($0) }
        terminal.receiveImages = { [weak self] sources in self?.addAttachments(sources) }
        terminal.writeAttachmentInput = { [weak self] data in
            guard let self else { return false }
            if self.connection != nil {
                guard let sid = self.sid else { return false }
                return self.client?.sendPTYInput(sid: sid, data: data) == true
            }
            guard self.terminal.process.running else { return false }
            self.terminal.process.send(data: Array(data)[...]); return true
        }
        terminal.submitPendingAttachments = { [weak self] returnSequence in
            guard let self, !self.attachments.items.isEmpty else { return false }
            self.attachments.queueSubmission(returnSequence)
            return true
        }
        attachmentComposer.input.onImages = { [weak self] in self?.addAttachments($0) }
        attachmentComposer.input.onSend = { [weak self] in self?.sendAttachments() }
        attachmentComposer.onChange = { [weak self] in
            guard let self else { return }
            self.attachments.draft = self.attachmentComposer.input.string
        }
        terminal.receivedLocalOutput = { [weak self] in self?.didReceiveScreen() }
        connectionStatus.onRetry = { [weak self] in self?.reconnectClient() }
        terminal.processDelegate = self
        if connection != nil { terminal.terminalDelegate = self }
        terminal.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        terminal.appearance = NSAppearance(named: .darkAqua)
        terminalContainer.appearance = NSAppearance(named: .darkAqua)
        terminal.nativeForegroundColor = NSColor(white: 0.88, alpha: 1)
        terminal.nativeBackgroundColor = NSColor(white: 0.065, alpha: 1)
        // SwiftTerm 1.20 defaults to a LAB-derived palette, which recolours ANSI
        // backgrounds supplied by remote TUIs. Preserve the historical colours.
        terminal.getTerminal().ansi256PaletteStrategy = .xterm
        terminalContainer.wantsLayer = true
        terminalContainer.layer?.backgroundColor = terminal.nativeBackgroundColor.cgColor
        terminal.caretColor = .systemGreen
        terminal.setAccessibilityLabel("TermBridge interactive terminal")
        terminal.translatesAutoresizingMaskIntoConstraints = false
        reconnect.target = self
        reconnect.action = #selector(reconnectClient)
        let paste = NSButton(title: "粘贴", target: self, action: #selector(pasteInput))
        let attach = NSButton(title: "图片", target: self, action: #selector(addImages))
        let changes = NSButton(title: "改动", target: self, action: #selector(openChanges))
        for (button, symbol, hint) in [(changes, "plusminus.circle", "查看这次对话改动的仓库与文件 · ⇧⌘G"),
                                        (attach, "paperclip", "添加图片"),
                                        (paste, "doc.on.clipboard", "粘贴文字或图片 · ⌘V"),
                                        (reconnect, "arrow.clockwise", "重新连接此终端")] {
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: hint)
            button.imagePosition = .imageLeading; button.bezelStyle = .rounded
            button.controlSize = .regular; button.toolTip = hint
            button.setAccessibilityLabel(hint)
        }
        status.font = .systemFont(ofSize: 12, weight: .medium)
        status.textColor = .secondaryLabelColor
        status.lineBreakMode = .byTruncatingTail
        status.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusDot.wantsLayer = true; statusDot.layer?.cornerRadius = 3
        statusDot.translatesAutoresizingMaskIntoConstraints = false
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let footer = NSStackView(views: [statusDot, status, spacer, changes, attach, paste, reconnect])
        footer.spacing = 12
        footer.translatesAutoresizingMaskIntoConstraints = false
        let footerBackground = NSView()
        footerBackground.wantsLayer = true
        footerBackground.layer?.backgroundColor = NSColor(white: 0.105, alpha: 1).cgColor
        footerBackground.translatesAutoresizingMaskIntoConstraints = false
        let content = terminalContainer
        content.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(content)
        // The messages start under the title bar. Which view a session opens in
        // is a setting, not a control worth a full-width row on every window.
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: view.topAnchor),
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        if let chatConnection {
            let session = MacAgentChatSession(sessionID: agent.sessionId, settings: chatConnection, notificationRoute: notificationRoute)
            let view = MacAgentChatView(session: session)
            chatSession = session; chatView = view
            view.onNativeCommands = { [weak self] query in self?.openNativeCommands(query) }
            showingChat = preference.startsInChat(sessionID: agent.sessionId, source: agent.source)
            view.translatesAutoresizingMaskIntoConstraints = false
            self.view.addSubview(view)
            NSLayoutConstraint.activate([
                view.topAnchor.constraint(equalTo: content.topAnchor), view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
                view.leadingAnchor.constraint(equalTo: content.leadingAnchor), view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            ])
            session.onUnavailable = { [weak self] reason in self?.chatUnavailable(reason) }
            view.onFailure = { [weak self] reason in self?.chatUnavailable(reason) }
            view.onReady = { [weak self] in
                guard let self, self.showingChat, self.window?.isKeyWindow == true, self.mayTakeFocus() else { return }
                self.chatView?.focusComposer()
            }
            view.isHidden = !showingChat; content.isHidden = showingChat
            view.load()
        }
        content.addSubview(terminal)
        content.addSubview(footerBackground)
        content.addSubview(footer)
        connectionStatus.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(connectionStatus)
        let attachmentBar = NSHostingView(rootView: TerminalAttachmentBar(attachments: attachments, send: { [weak self] in
            self?.sendAttachments()
        }, focusTerminal: { [weak self] in
            guard let self else { return }
            self.focus()
        }).preferredColorScheme(.dark))
        attachmentBar.appearance = NSAppearance(named: .darkAqua)
        attachmentBar.translatesAutoresizingMaskIntoConstraints = false
        let attachmentArea = NSView()
        attachmentArea.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(attachmentArea)
        attachmentArea.addSubview(attachmentBar)
        attachmentComposer.translatesAutoresizingMaskIntoConstraints = false
        attachmentArea.addSubview(attachmentComposer)
        let attachmentHeight = attachmentArea.heightAnchor.constraint(equalToConstant: 0)
        attachmentArea.isHidden = true
        attachments.onChange = { [weak self, weak attachmentArea, weak attachmentHeight] in
            guard let self else { return }
            let visible = !self.attachments.items.isEmpty || !self.attachments.draft.isEmpty || self.attachments.error != nil
            attachmentArea?.isHidden = !visible
            attachmentHeight?.constant = visible ? 124 : 0
            self.attachmentComposer.sync(self.attachments.draft)
            self.scheduleAttachmentSubmission()
        }
        NSLayoutConstraint.activate([
            attachmentBar.topAnchor.constraint(equalTo: attachmentArea.topAnchor),
            attachmentBar.leadingAnchor.constraint(equalTo: attachmentArea.leadingAnchor),
            attachmentBar.trailingAnchor.constraint(equalTo: attachmentArea.trailingAnchor),
            attachmentBar.heightAnchor.constraint(equalToConstant: 76),
            attachmentComposer.topAnchor.constraint(equalTo: attachmentBar.bottomAnchor),
            attachmentComposer.leadingAnchor.constraint(equalTo: attachmentArea.leadingAnchor),
            attachmentComposer.trailingAnchor.constraint(equalTo: attachmentArea.trailingAnchor),
            attachmentComposer.bottomAnchor.constraint(equalTo: attachmentArea.bottomAnchor),
            terminal.topAnchor.constraint(equalTo: content.topAnchor, constant: 8),
            terminal.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 12),
            terminal.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -12),
            terminal.bottomAnchor.constraint(equalTo: attachmentArea.topAnchor),
            attachmentArea.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            attachmentArea.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            attachmentArea.bottomAnchor.constraint(equalTo: footerBackground.topAnchor),
            attachmentHeight,
            footer.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 16),
            footer.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -16),
            footer.centerYAnchor.constraint(equalTo: footerBackground.centerYAnchor),
            footer.heightAnchor.constraint(equalToConstant: 28),
            footerBackground.heightAnchor.constraint(equalToConstant: 48),
            footerBackground.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            footerBackground.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            footerBackground.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            statusDot.widthAnchor.constraint(equalToConstant: 6), statusDot.heightAnchor.constraint(equalToConstant: 6),
            connectionStatus.topAnchor.constraint(equalTo: terminal.topAnchor),
            connectionStatus.bottomAnchor.constraint(equalTo: terminal.bottomAnchor),
            connectionStatus.leadingAnchor.constraint(equalTo: terminal.leadingAnchor),
            connectionStatus.trailingAnchor.constraint(equalTo: terminal.trailingAnchor),
        ])
        if connection != nil && agent.source == "herdr" {
            scrollMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                // A session off screen has no window and never takes the event.
                guard let self, !self.showingChat, let window = self.window, event.window === window,
                      self.terminal.bounds.contains(self.terminal.convert(event.locationInWindow, from: nil)) else { return event }
                return self.terminal.handleRemoteScroll(event) ? nil : event
            }
        }
    }

    /// Starts whichever view is showing, once `view` is in its container's
    /// window. A session that is already connected is only focused, so a
    /// container can call this every time it brings the session on screen.
    func activate(focus: Bool = true) {
        view.layoutSubtreeIfNeeded()
        if showingChat { startChat(focus: focus) }
        else {
            if focus { self.focus() }
            if !terminal.process.running && client == nil { startClient() }
        }
    }

    /// Puts keyboard focus where this session's visible view takes input.
    func focus() {
        if showingChat { chatView?.focusComposer() }
        else { window?.makeFirstResponder(attachments.items.isEmpty && attachments.draft.isEmpty ? terminal : attachmentComposer.input) }
    }

    /// Ends this viewer: its scroll monitor and every connection. The Host keeps
    /// the session itself running.
    func close() {
        if let scrollMonitor { NSEvent.removeMonitor(scrollMonitor); self.scrollMonitor = nil }
        chatSession?.stop(); disconnect()
    }

    /// A conversation send the Host has not confirmed yet. Ending the viewer now
    /// would turn it into "结果未知", so a navigator keeps such a session connected.
    var holdsUnconfirmedSend: Bool { chatSession?.composer.pending == true || attachments.pendingSubmission != nil }

    /// The chrome a container should give this session: the terminal is fixed
    /// dark, the conversation follows the system.
    var prefersDarkChrome: Bool { !showingChat }
    var surfaceBackground: NSColor { showingChat ? .windowBackgroundColor : terminal.nativeBackgroundColor }

    /// The only way into the chat view. A rejected notification target refuses
    /// here exactly as `startClient` refuses on the terminal side.
    private func startChat(focus: Bool = true) {
        if let routeRejection {
            showNotice(routeRejection)
            chatSession?.stop()
            return
        }
        chatSession?.start()
        if focus { chatView?.focusComposer() }
    }

    /// Carries a refusal to whichever view is on screen.
    ///
    /// Nil clears it. There is no permanent row for this: a window with nothing
    /// wrong should say nothing, and the same sentence must not appear in the
    /// title, a status strip and a footer at once.
    private func showNotice(_ reason: String?) {
        chatNotice = reason
        chatView?.showNotice(reason)
        guard let reason else { return }
        setStatus(reason, color: .systemOrange)
    }

    /// Switches this session between conversation and terminal in place,
    /// keeping the draft and the connection. Which view a session *opens* in
    /// remains a setting; containers expose this as a menu action.
    func selectChat(_ value: Bool) {
        guard chatView != nil else { return }
        showingChat = value
        onSurfaceChange?()
        terminalContainer.isHidden = value; chatView?.isHidden = !value
        if value {
            pendingNativeCommand = nil
            disconnect()
            if routeRejection == nil { showNotice(nil) }
            startChat()
        } else {
            chatSession?.stop()
            if !terminal.process.running && client == nil { startClient() }
            focus()
        }
    }

    /// Mirror the provider's own picker, not a stale list of command names.
    /// Transfer only an editable query; never Return, terminal controls, or a
    /// command that could execute as part of a paste. Connection failure keeps
    /// the original draft and never retries an uncertain write.
    func openNativeCommands(_ query: String) {
        guard routeRejection == nil, MacAgentChatView.nativeSlashQuery(query) != nil else { return }
        selectChat(false)
        pendingNativeCommand = query
        if !connectionStatus.isHidden { return }
        forwardNativeCommandIfReady()
    }

    private func forwardNativeCommandIfReady() {
        guard !showingChat, let query = pendingNativeCommand,
              connection == nil ? terminal.process.running : sid != nil else { return }
        pendingNativeCommand = nil
        terminal.send(source: terminal.getTerminal(), data: Array(query.utf8)[...])
        if chatSession?.composer.draft == query { chatSession?.composer.draft = "" }
    }

    private func chatUnavailable(_ reason: String) {
        guard showingChat else { return }
        showNotice(reason)
        // A rejected notification target is a fact about the session, not about
        // the chat view. Switching to the terminal here would attach it unchecked.
        if let rejection = chatSession?.routeRejection { rejectRoute(rejection); return }
        selectChat(false)
    }

    /// Records a proven-invalid notification target and shows it in whichever
    /// view is on screen. Both `startClient` and `attach` refuse afterwards.
    private func rejectRoute(_ reason: String) {
        routeRejection = reason
        notificationRouteValidated = false
        showNotice(reason)
        disconnect()
        setStatus("会话已失效", color: .systemOrange)
        reconnect.isEnabled = false
        connectionStatus.show(title: "会话已失效", detail: reason, waiting: false)
    }

    private func startClient() {
        guard !remoteProcessEnded else { return }
        if let routeRejection {
            // The cached local launch has no identity check of its own, so this
            // is the only place that can stop it reaching a replacement session.
            rejectRoute(routeRejection)
            return
        }
        terminal.getTerminal().resetToInitialState()
        showWaiting("正在连接终端", detail: connection?.displayName ?? "正在启动本机终端连接")
        if let connection {
            guard client == nil else { return }
            connecting = true; reconnect.isEnabled = false; setStatus("正在连接 · \(connection.displayName)", color: .systemOrange)
            let client = TermbridgeClient(settings: connection, listener: self)
            self.client = client; client.connect()
            return
        }
        guard let launch else { return }
        setStatus("正在启动终端", color: .systemOrange)
        reconnect.isEnabled = false
        terminal.startProcess(executable: launch.executable, args: launch.arguments,
                              environment: TerminalLaunch.environment(searchPath: launch.searchPath),
                              currentDirectory: FileManager.default.homeDirectoryForCurrentUser.path)
        attachments.objectWillChange.send()
        if !terminal.process.running {
            remoteDisconnected("无法启动本机终端连接。请检查 TB 或 Herdr 是否已安装。")
        }
    }

    @objc private func pasteInput() {
        focus()
        if attachments.items.isEmpty && attachments.draft.isEmpty { terminal.paste(self) }
        else { attachmentComposer.input.paste(self) }
    }

    @objc private func addImages() {
        let panel = NSOpenPanel()
        panel.title = "添加图片"; panel.prompt = "添加"
        panel.allowedContentTypes = [.image]; panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK else { return }
        addAttachments(panel.urls.map(TerminalImageSource.file))
    }

    private func addAttachments(_ sources: [TerminalImageSource]) {
        attachments.add(sources)
        view.layoutSubtreeIfNeeded()
        if !attachments.items.isEmpty { window?.makeFirstResponder(attachmentComposer.input) }
    }

    func sendAttachments() {
        guard !attachmentComposer.input.hasMarkedText() else { return }
        attachments.queueSubmission(Data([13]))
        focus()
    }

    private func scheduleAttachmentSubmission() {
        guard !attachmentUpdateScheduled else { return }
        attachmentUpdateScheduled = true
        // Published attachment updates can call back while an upload is being
        // completed. Drain after that mutation, never from inside it.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.attachmentUpdateScheduled = false
            guard let sequence = self.attachments.pendingSubmission,
                  !self.attachmentComposer.input.hasMarkedText(),
                  self.attachments.items.isEmpty || self.attachments.references != nil else { return }
            self.attachments.cancelSubmission() // consume intent before any external write
            self.insertAttachments(returnSequence: sequence, focusAfter: false)
        }
    }

    func insertAttachments(returnSequence: Data? = nil, focusAfter: Bool = true) {
        guard attachments.isConnected(), let references = attachments.references ?? (attachments.items.isEmpty ? "" : nil) else {
            attachments.reportBlockedInsertion(); return
        }
        let shouldFocus = focusAfter || window?.firstResponder === attachmentComposer.input
        if terminal.insertAttachmentReferences(attachments.draft + references, returnSequence: returnSequence) { attachments.clear() }
        else { attachments.reportBlockedInsertion() }
        if shouldFocus { focus() }
    }

    @objc private func reconnectClient() {
        guard !terminal.process.running && client == nil else { return }
        startClient()
        focus()
    }

    /// session_create already attached this transport. Ownership moves before
    /// any queued output is delivered; there is no second hello or attach.
    func adoptCreatedConnection(_ client: TermbridgeClient, sid: Int) {
        precondition(self.client == nil && connection != nil)
        self.client = client; self.sid = sid; connecting = false
        client.transferListener(to: self)
        didReceiveScreen()
        attachments.objectWillChange.send()
    }

    func usesConnection(_ profile: ConnectionSettings?) -> Bool {
        connection == profile
    }

    func openFromNotification(_ route: MacNotificationRoute?) {
        guard let route else {
            // Opened from the live session list. That list is itself the proof of
            // identity, so an older notification's rejection no longer applies.
            guard notificationRoute != nil || routeRejection != nil else { return }
            notificationRoute = nil; routeRejection = nil; notificationRouteValidated = false
            chatSession?.notificationRoute = nil
            showNotice(nil)
            connectionStatus.isHidden = true; reconnect.isEnabled = true
            return
        }
        guard route.sessionID == agent.sessionId else {
            rejectRoute("此通知对应的会话与当前窗口不一致，请从会话列表重新打开。")
            return
        }
        let unchanged = notificationRoute == route
        if !unchanged { routeRejection = nil; notificationRouteValidated = false }
        notificationRoute = route
        // Both views carry the same constraint. Updating only the visible one
        // lets a later manual switch reach the target that was never validated.
        chatSession?.notificationRoute = route
        if showingChat {
            chatSession?.stop()
            startChat()
            return
        }
        if unchanged && (connecting || sid != nil || terminal.process.running) { return }
        // A local session's route was already matched against the Host context
        // snapshot before it got here; restarting the attached process would drop
        // the live terminal without proving anything further.
        guard connection != nil else { return }
        disconnect()
        reconnectClient()
    }

    func disconnect() {
        connectionTimeout?.cancel(); connectionTimeout = nil
        attachments.connectionLost()
        client?.disconnect(); client = nil; sid = nil; connecting = false
        usingCompatibleTerminal = false
        supportsHistoryScroll = false
        // Proof belongs to one connection: the next one validates again.
        validatingNotificationTarget = false; notificationRouteValidated = false
        terminal.stopLocalProcess()
    }

    func clientIsReady(_ client: TermbridgeClient) {
        guard client === self.client else { return }
        if notificationRoute != nil {
            validatingNotificationTarget = true
            client.sendControl(["t": .string("session_list")])
        } else { attach(client) }
    }
    private func attach(_ client: TermbridgeClient) {
        guard routeRejection == nil, notificationRoute == nil || notificationRouteValidated else { return }
        let size = terminal.getTerminal()
        // Native frames preserve the application's cursor, input geometry and
        // resize contract. A visible text snapshot cannot replace this surface.
        let native = agent.source == "herdr" && !usingCompatibleTerminal
        client.sendControl(["t": .string("attach"), "sessionId": .string(agent.sessionId),
            "cols": .int(Int64(size.cols)), "rows": .int(Int64(size.rows)),
            "nativeTerminal": .bool(native)])
    }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard client === self.client else { return }
        if case .failed(let detail) = state { remoteDisconnected(ConnectionFailure.description(detail)) }
        if case .disconnected = state { remoteDisconnected("连接已断开 · 远端会话保留") }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard client === self.client else { return }
        switch message.type {
        case "session_list_result":
            guard validatingNotificationTarget, let notificationRoute else { return }
            validatingNotificationTarget = false
            guard AgentRecord.remoteRecords(message.sessions()).contains(where: notificationRoute.matches) else {
                rejectRoute("此通知对应的会话已结束或已更换，请从会话列表重新打开。")
                return
            }
            notificationRouteValidated = true
            attach(client)
        case "session_upload_result": attachments.receive(message)
        case "attach_ok":
            guard message.string("sessionId") == agent.sessionId else { return }
            supportsHistoryScroll = message.historyScroll
            if agent.source == "herdr" && message.bool("nativeTerminal") != true {
                // Older Hosts already attached the snapshot/input transport.
                // Keep that accepted session; a second attach would duplicate it.
                usingCompatibleTerminal = true
            }
            sid = message.int("sid"); connecting = false
            attachments.objectWillChange.send()
            if agent.source == "herdr" { terminal.feed(text: "\u{1b}[?2004h") }
            if agent.source == "herdr" {
                setStatus("等待终端画面", color: .systemOrange)
                showWaiting("正在载入终端", detail: "已连接 Host，正在等待会话画面。")
            } else {
                // A valid PTY may be silent (for example cat waiting for input).
                // Only Herdr's native protocol promises an initial screen frame.
                didReceiveScreen()
            }
            if mayTakeFocus() { focus() }
        case "session_scroll_result":
            guard message.int("sid") == sid, message.bool("ok") == false else { return }
            setStatus("暂时无法读取终端历史，请重新滚动重试", color: .systemOrange)
        case "session_exit":
            guard message.string("sessionId") == agent.sessionId else { return }
            remoteProcessEnded = true
            disconnect()
            let code = message.int("exitCode").map { "（退出码 \($0)）" } ?? ""
            setStatus("远端程序已结束" + code, color: .systemOrange)
            reconnect.isEnabled = false
            // Keep the real startup error visible instead of covering it with
            // a generic reconnect button for an ID that no longer exists.
            if receivedRemoteOutput { connectionStatus.isHidden = true }
            else { connectionStatus.show(title: "远端程序已结束" + code,
                detail: "程序未输出内容。请检查此 Host 的 Agent 命令和工作目录。", waiting: false, retryAvailable: false) }
        case "error":
            let detail = message.string("message") ?? "Host 拒绝了终端请求"
            if sid == nil, agent.source == "herdr", !usingCompatibleTerminal,
               detail.hasPrefix("Herdr native terminal unavailable") {
                // The same snapshot/input route used by phones supports more
                // than one viewer. Never take over another controller's lease.
                usingCompatibleTerminal = true
                AppDiagnostics.shared.record("terminal.compatible_attach", ["cause": "native_unavailable"])
                attach(client)
                return
            }
            AppDiagnostics.shared.record("terminal.attach_failed", ["stage": sid == nil ? "attach" : "connected"])
            remoteDisconnected("无法接入终端：" + String(detail.prefix(600)))
        default: break
        }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {
        guard client === self.client, sid == self.sid else { return }
        if !data.isEmpty { receivedRemoteOutput = true }
        terminal.feed(byteArray: Array(data)[...])
        if !data.isEmpty { didReceiveScreen() }
    }
    private func setStatus(_ message: String, color: NSColor) {
        status.stringValue = message
        statusDot.layer?.backgroundColor = color.cgColor
    }
    private func showWaiting(_ title: String, detail: String) {
        connectionStatus.show(title: title, detail: detail, waiting: true)
        connectionTimeout?.cancel()
        connectionTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard let self else { return }
            self.remoteDisconnected("等待终端画面超时。请确认运行中的 Host 已更新、会话仍在线，再点击重连。", title: "终端没有响应")
        }
    }
    private func didReceiveScreen() {
        connectionTimeout?.cancel(); connectionTimeout = nil
        connectionStatus.isHidden = true
        forwardNativeCommandIfReady()
        if usingCompatibleTerminal && !supportsHistoryScroll {
            setStatus("已连接 · 更新 Host 后可滚动历史", color: .systemOrange)
        } else { setStatus("已连接", color: .systemGreen) }
        status.toolTip = "Ctrl+C 中断当前程序 · ⌘C 复制 · ⌘V 粘贴 · 关闭窗口只断开连接"
    }
    private func remoteDisconnected(_ message: String, title: String = "终端连接中断") {
        pendingNativeCommand = nil
        disconnect(); setStatus(title, color: .systemOrange); reconnect.isEnabled = true
        connectionStatus.show(title: title, detail: message, waiting: false)
    }
    func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        openTerminalLink(link)
    }
    private func openTerminalLink(_ link: String) {
        guard let target = TerminalFileLink.parse(link) else { return }
        switch target {
        case .web(let url): NSWorkspace.shared.open(url)
        case .file(let path, let line):
            guard let settings = inspectorSettings() else { return }
            TerminalFilePreview.shared.present(sessionID: agent.sessionId, path: path, settings: settings, line: line)
        }
    }

    /// The Git repositories this conversation touched, with their diffs.
    @objc func openChanges() {
        guard let settings = inspectorSettings() else { return }
        TerminalFilePreview.shared.presentChanges(sessionID: agent.sessionId, settings: settings)
    }

    /// The files inspector reads through the session's own Host: the window's
    /// connection, or the local Host for a session on this Mac.
    private func inspectorSettings() -> ConnectionSettings? {
        do {
            var settings = try connection ?? MacConnectionStore.loadCLIProfile(
                from: ProcessInfo.processInfo.environment["TB_SETTINGS"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
                    ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/settings.json"),
                environment: ProcessInfo.processInfo.environment)
            if connection == nil { settings.hostID = try TerminalLaunch.localHostId() }
            return settings
        } catch {
            setStatus("无法读取 Host 连接配置，请先在设置中导入 TB 配置。", color: .systemOrange)
            return nil
        }
    }

    func send(source: TerminalView, data: ArraySlice<UInt8>) {
        if terminal.consumeAttachmentSubmit(data) { return }
        guard let sid else { return }
        let input = agent.source == "herdr" && usingCompatibleTerminal
            ? AttachmentTerminalView.compatibleHerdrInput(data) : Data(data)
        client?.sendPTYInput(sid: sid, data: input)
    }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        guard let sid else { return }
        client?.sendResize(sid: sid, cols: newCols, rows: newRows)
    }
    func setTerminalTitle(source: TerminalView, title: String) {}
    func scrolled(source: TerminalView, position: Double) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}

    func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func processTerminated(source: TerminalView, exitCode: Int32?) {
        attachments.connectionLost()
        connectionTimeout?.cancel(); connectionTimeout = nil
        setStatus(exitCode == 0 ? "已断开 · 会话保留" : "连接已结束", color: .systemOrange)
        if !connectionStatus.isHidden {
            connectionStatus.show(title: "终端连接已结束", detail: "本机终端连接未能启动，请检查 TB 和 Herdr 安装后重试。", waiting: false)
        }
        reconnect.isEnabled = true
    }
}
