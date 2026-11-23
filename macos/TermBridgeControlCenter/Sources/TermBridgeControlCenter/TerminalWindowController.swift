import AppKit

/// One session in a window of its own: the standalone session window mode.
///
/// The session itself lives in `TerminalSessionController`; this only gives it
/// a window, and can hand it on to the navigator without disconnecting.
@MainActor
final class TerminalWindowController: NSWindowController, NSWindowDelegate {
    let session: TerminalSessionController
    var onClose: (() -> Void)?
    /// Set while the session moves to another container, so closing this window
    /// does not end the connection that moves with it.
    private var releasing = false

    convenience init(agent: AgentRecord, launch: TerminalLaunch?, connection: ConnectionSettings? = nil, notificationRoute: MacNotificationRoute? = nil,
                     chatConnection: ConnectionSettings? = nil, preference: SessionUIPreference = .terminal) {
        self.init(session: TerminalSessionController(agent: agent, launch: launch, connection: connection,
            notificationRoute: notificationRoute, chatConnection: chatConnection, preference: preference))
    }

    init(session: TerminalSessionController) {
        self.session = session
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 960, height: 660),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false
        )
        window.title = session.agent.displayName
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unifiedCompact
        window.toolbar = NSToolbar(identifier: "TermBridgeTerminalToolbar")
        window.titlebarSeparatorStyle = .line
        window.subtitle = [session.connection?.displayName, session.agent.workspace ?? session.agent.sessionId]
            .compactMap { $0 }.joined(separator: " · ")
        window.minSize = NSSize(width: 600, height: 360)
        window.isReleasedWhenClosed = false
        super.init(window: window)
        window.delegate = self
        guard let content = window.contentView else { return }
        let view = session.view
        view.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(view)
        NSLayoutConstraint.activate([
            view.topAnchor.constraint(equalTo: content.topAnchor),
            view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        session.mayTakeFocus = { true }
        session.onSurfaceChange = { [weak self] in self?.applySurfaceAppearance() }
        applySurfaceAppearance()
        window.initialFirstResponder = session.terminal
        window.center()
    }

    required init?(coder: NSCoder) { nil }

    var terminal: AttachmentTerminalView { session.terminal }
    var attachments: TerminalAttachments { session.attachments }
    var connectionStatus: TerminalStatusView { session.connectionStatus }
    var terminalContainer: NSView { session.terminalContainer }
    var chatSession: MacAgentChatSession? { session.chatSession }
    var chatView: MacAgentChatView? { session.chatView }
    var showingChat: Bool { session.showingChat }
    var routeRejection: String? { session.routeRejection }

    func present() {
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.contentView?.layoutSubtreeIfNeeded()
        session.activate()
    }

    /// The secondary way back to this session's own terminal, for a degraded
    /// conversation. It is a menu action, not a control on every window.
    @objc func showTerminalForSession(_ sender: Any?) { session.selectChat(false) }

    /// Back to the conversation in this same window, keeping the draft and the
    /// connection. Which view a session *opens* in remains a setting.
    @objc func showChatForSession(_ sender: Any?) { session.selectChat(true) }

    /// The Git repositories and files this conversation changed.
    @objc func showChangesForSession(_ sender: Any?) { session.openChanges() }

    func selectChat(_ value: Bool) { session.selectChat(value) }
    func openFromNotification(_ route: MacNotificationRoute?) { session.openFromNotification(route) }
    func usesConnection(_ profile: ConnectionSettings?) -> Bool { session.usesConnection(profile) }
    func disconnect() { session.disconnect() }

    /// Gives the session to another container and closes this window. The
    /// connection, draft and terminal screen move with it.
    func releaseSession() -> TerminalSessionController {
        releasing = true
        session.onSurfaceChange = nil
        session.view.removeFromSuperview()
        close()
        return session
    }

    private func applySurfaceAppearance() {
        // Scope fixed dark to the complete terminal surface, including the title
        // bar and margins. Chat restores the inherited system appearance.
        window?.appearance = session.prefersDarkChrome ? NSAppearance(named: .darkAqua) : nil
        window?.backgroundColor = session.surfaceBackground
    }

    func windowDidBecomeKey(_ notification: Notification) { session.focus() }

    func windowWillClose(_ notification: Notification) {
        if !releasing { session.close() }
        onClose?()
    }
}
