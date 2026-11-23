import AppKit
import Combine
import SwiftUI

/// What the navigator's sidebar and empty detail show. The controller owns it;
/// the SwiftUI views only read it and call back, so they hold no reference to
/// the window that hosts them.
@MainActor
final class SessionNavigatorState: ObservableObject {
    struct Host: Identifiable, Equatable {
        let id: String
        let profileID: UUID?
        let title: String
    }

    enum Placeholder: Equatable {
        case empty
        case opening(String)
        case failed(String)
    }

    @Published fileprivate(set) var groups: [SessionDirectory.Group] = []
    @Published fileprivate(set) var hosts: [Host] = []
    @Published fileprivate(set) var activeHostID = "local"
    @Published fileprivate(set) var listState: ControlCenterModel.LoadState = .loading
    /// The selected session's ID, when it belongs to the Host the list shows.
    @Published fileprivate(set) var selectedRowID: String?
    /// What the detail shows instead of a session; nil while one is on screen.
    @Published fileprivate(set) var placeholder: Placeholder? = .empty

    var choose: (SessionDirectory.Row) -> Void = { _ in }
    var chooseHost: (String) -> Void = { _ in }
    var refresh: () -> Void = {}
    var prepareNewSession: () -> Void = {}

    var rows: [SessionDirectory.Row] { groups.flatMap(\.rows) }
    func row(_ id: String) -> SessionDirectory.Row? { rows.first { $0.id == id } }
}

/// Every session in one window, listed by workspace the way Herdr lists them.
///
/// Only a few sessions stay connected: the one on screen and the most recently
/// viewed, so going back to one is instant. Every other row is just a row until
/// it is chosen. A connected session holds a Host connection and, for a native
/// Herdr terminal, that pane's control lease; keeping one for every Agent ever
/// clicked would rebuild, out of sight, the pile of windows this mode replaces.
@MainActor
final class SessionNavigatorController: NSWindowController, NSWindowDelegate, NSToolbarDelegate {
    nonisolated static let liveLimit = 4
    private static let frameName = "TermBridgeSessionNavigator"

    let state = SessionNavigatorState()
    private weak var model: ControlCenterModel?
    /// Connected sessions, the most recently shown first.
    private(set) var liveSessions: [TerminalSessionController] = []
    private(set) var visibleSession: TerminalSessionController?
    private var target: Target?
    private var activeProfileID: UUID?
    /// A click opens a session to type in; arrow keys keep moving through the list.
    private var focusIntent = true
    private var observations: Set<AnyCancellable> = []
    private let detail = SessionNavigatorDetailController()
    /// Opens a chosen row: through the model, which brings the session back
    /// here. Replaced only by tests.
    var openRow: (AgentRecord) -> Void = { _ in }
    private var sidebar: NSViewController?

    /// The session the user asked for, which may still be opening.
    private struct Target: Equatable {
        let key: String
        let profileID: UUID?
        let sessionID: String
        let title: String
        /// Whether showing it moves keyboard focus into it.
        let focus: Bool

        init(_ agent: AgentRecord, key: String, profileID: UUID?, focus: Bool) {
            self.key = key; self.profileID = profileID; sessionID = agent.sessionId
            title = SessionDirectory.title(agent); self.focus = focus
        }
    }

    static func key(_ session: TerminalSessionController) -> String {
        MacConnectionCatalog.terminalKey(profileID: session.connection?.id, sessionID: session.agent.sessionId)
    }

    init(model: ControlCenterModel) {
        self.model = model
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1180, height: 720),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false
        )
        window.title = "TermBridge"
        window.minSize = NSSize(width: 760, height: 420)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.toolbarStyle = .unifiedCompact
        super.init(window: window)
        window.delegate = self
        let sidebar = NSHostingController(rootView: SessionNavigatorSidebar(state: state))
        self.sidebar = sidebar
        let split = NSSplitViewController()
        let sidebarItem = NSSplitViewItem(sidebarWithViewController: sidebar)
        sidebarItem.minimumThickness = 250
        sidebarItem.maximumThickness = 420
        split.addSplitViewItem(sidebarItem)
        let detailItem = NSSplitViewItem(viewController: detail)
        detailItem.minimumThickness = 480
        split.addSplitViewItem(detailItem)
        split.splitView.autosaveName = Self.frameName
        detail.placeholder = NSHostingView(rootView: SessionNavigatorPlaceholderView(state: state))
        window.contentViewController = split
        let toolbar = NSToolbar(identifier: Self.frameName)
        toolbar.delegate = self
        toolbar.displayMode = .iconOnly
        window.toolbar = toolbar
        window.setContentSize(NSSize(width: 1180, height: 720))
        if !window.setFrameUsingName(Self.frameName) { window.center() }
        window.setFrameAutosaveName(Self.frameName)
        bind(model)
        updateTitle()
    }

    required init?(coder: NSCoder) { nil }

    private func bind(_ model: ControlCenterModel) {
        openRow = { [weak model] in model?.open($0) }
        state.choose = { [weak self] row in self?.choose(row) }
        state.chooseHost = { [weak self, weak model] id in
            guard let host = self?.state.hosts.first(where: { $0.id == id }) else { return }
            model?.selectProfile(host.profileID)
        }
        state.refresh = { [weak model] in model?.refresh() }
        state.prepareNewSession = { [weak model] in model?.prepareNewSession() }
        // `@Published` delivers the new value before the property changes, so
        // each sink uses the value it is given rather than reading the model.
        // The list refreshes every few seconds; unchanged values publish nothing.
        model.$agents.sink { [weak self] agents in
            let groups = SessionDirectory.groups(agents)
            if self?.state.groups != groups { self?.state.groups = groups }
        }.store(in: &observations)
        model.$profiles.sink { [weak self] profiles in
            let hosts = [SessionNavigatorState.Host(id: "local", profileID: nil, title: "本机")] + profiles.map {
                SessionNavigatorState.Host(id: $0.id.uuidString, profileID: $0.id, title: MacConnectionCatalog.tabTitle($0, in: profiles))
            }
            if self?.state.hosts != hosts { self?.state.hosts = hosts }
        }.store(in: &observations)
        model.$activeProfileID.sink { [weak self] id in
            guard let self else { return }
            if self.activeProfileID != id {
                self.detail.show(nil)
                self.visibleSession = nil
                self.target = nil
                self.state.placeholder = .empty
                self.updateTitle()
            }
            self.activeProfileID = id
            self.state.activeHostID = id?.uuidString ?? "local"
            self.syncSelection()
        }.store(in: &observations)
        model.$state.sink { [weak self] value in
            if self?.state.listState != value { self?.state.listState = value }
        }.store(in: &observations)
    }

    func present() {
        showWindow(nil)
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    /// Shows a session that is already connected here, applying `route` exactly
    /// as a standalone window does. False when it has to be opened, including
    /// when its connection settings changed since.
    func reveal(key: String, connection: ConnectionSettings?, route: MacNotificationRoute?) -> Bool {
        guard let session = liveSessions.first(where: { Self.key($0) == key }) else { return false }
        guard session.usesConnection(connection) else {
            // Edited settings: this viewer belongs to the old connection.
            remove(session)
            return false
        }
        target = Target(session.agent, key: key, profileID: session.connection?.id, focus: focusIntent)
        syncSelection()
        session.openFromNotification(route)
        display(session)
        present()
        return true
    }

    /// Selects a session that is still being prepared; `insert` shows it. The
    /// session on screen until now stays connected, just out of sight.
    func expect(key: String, profileID: UUID?, agent: AgentRecord) {
        let next = Target(agent, key: key, profileID: profileID, focus: focusIntent)
        target = next
        syncSelection()
        if visibleSession != nil { detail.show(nil); visibleSession = nil }
        state.placeholder = .opening(next.title)
        updateTitle()
        present()
    }

    /// Adds a prepared session. It is shown only if it is still the one asked
    /// for; otherwise the user has moved on and it closes unseen.
    func insert(_ session: TerminalSessionController) {
        let key = Self.key(session)
        guard target?.key == key else { session.close(); return }
        for stale in liveSessions where Self.key(stale) == key && stale !== session { remove(stale) }
        adoptClosures(session)
        display(session)
    }

    func fail(key: String, message: String) {
        guard target?.key == key else { return }
        state.placeholder = .failed(message)
    }

    /// Takes over sessions from standalone windows, listed back to front, so the
    /// front-most one is left on screen. Past the live limit the oldest close.
    func adopt(_ sessions: [TerminalSessionController]) {
        var front: TerminalSessionController?
        for session in sessions {
            if liveSessions.contains(where: { Self.key($0) == Self.key(session) }) { session.close(); continue }
            adoptClosures(session)
            liveSessions.insert(session, at: 0)
            front = session
        }
        guard let front else { return }
        target = Target(front.agent, key: Self.key(front), profileID: front.connection?.id, focus: true)
        syncSelection()
        display(front)
    }

    /// Hands the session on screen to a standalone window and closes the rest,
    /// together with this window.
    func releaseVisible() -> TerminalSessionController? {
        let kept = visibleSession
        if let kept {
            detail.show(nil)
            visibleSession = nil
            liveSessions.removeAll { $0 === kept }
            kept.onSurfaceChange = nil
            kept.mayTakeFocus = { true }
        }
        closeAll()
        window?.close()
        return kept
    }

    /// The connection was deleted: its sessions close with it.
    func closeSessions(profileID: UUID) {
        for session in liveSessions where session.connection?.id == profileID { remove(session) }
        if target?.profileID == profileID {
            target = nil
            state.placeholder = .empty
            syncSelection(); updateTitle()
        }
    }

    func disconnectAll() { liveSessions.forEach { $0.disconnect() } }

    @objc func selectNextSession(_ sender: Any?) { step(1) }
    @objc func selectPreviousSession(_ sender: Any?) { step(-1) }

    /// The same menu actions a standalone window answers, for the session on screen.
    @objc func showTerminalForSession(_ sender: Any?) { visibleSession?.selectChat(false) }
    @objc func showChatForSession(_ sender: Any?) { visibleSession?.selectChat(true) }
    @objc func showChangesForSession(_ sender: Any?) { visibleSession?.openChanges() }

    private func choose(_ row: SessionDirectory.Row) {
        focusIntent = NSApp.currentEvent?.type != .keyDown
        defer { focusIntent = true }
        openRow(row.agent)
    }

    private func step(_ offset: Int) {
        let rows = state.rows
        guard !rows.isEmpty else { return }
        let current = state.selectedRowID.flatMap { id in rows.firstIndex { $0.id == id } }
        let next = current.map { min(max($0 + offset, 0), rows.count - 1) } ?? (offset > 0 ? 0 : rows.count - 1)
        guard next != current else { return }
        openRow(rows[next].agent)
    }

    private func adoptClosures(_ session: TerminalSessionController) {
        session.onSurfaceChange = nil
        session.mayTakeFocus = { [weak self, weak session] in
            guard let self, let session else { return false }
            return self.allowsFocus(for: session)
        }
    }

    /// Only the session on screen may take focus, and not from the sidebar.
    private func allowsFocus(for session: TerminalSessionController) -> Bool {
        guard session === visibleSession else { return false }
        guard let responder = window?.firstResponder as? NSView, let sidebar = sidebar?.view else { return true }
        return !responder.isDescendant(of: sidebar)
    }

    private func display(_ session: TerminalSessionController) {
        let focus = target.map { $0.key != Self.key(session) || $0.focus } ?? true
        liveSessions.removeAll { $0 === session }
        liveSessions.insert(session, at: 0)
        if visibleSession !== session {
            visibleSession = session
            detail.show(session)
        }
        state.placeholder = nil
        session.activate(focus: focus)
        updateTitle()
        evict()
    }

    /// Keeps the live limit. The session on screen and any with a conversation
    /// send still waiting for its receipt stay, whatever the count.
    private func evict() {
        var kept: [TerminalSessionController] = []
        for session in liveSessions {
            if kept.count < Self.liveLimit || session === visibleSession || session.holdsUnconfirmedSend {
                kept.append(session)
            } else {
                session.close()
            }
        }
        liveSessions = kept
    }

    private func remove(_ session: TerminalSessionController) {
        if session === visibleSession {
            detail.show(nil)
            visibleSession = nil
            state.placeholder = .empty
        }
        session.close()
        liveSessions.removeAll { $0 === session }
        updateTitle()
    }

    private func closeAll() {
        detail.show(nil)
        liveSessions.forEach { $0.close() }
        liveSessions = []
        visibleSession = nil
        target = nil
        state.placeholder = .empty
        syncSelection()
        updateTitle()
    }

    private func syncSelection() {
        let id = target.flatMap { $0.profileID == activeProfileID ? $0.sessionID : nil }
        if state.selectedRowID != id { state.selectedRowID = id }
    }

    private func updateTitle() {
        guard let window else { return }
        if let session = visibleSession {
            window.title = SessionDirectory.title(session.agent)
        } else if let target {
            window.title = target.title
            window.subtitle = ""
        } else {
            window.title = "TermBridge"
            window.subtitle = ""
        }
        // Keep a useful Window-menu / accessibility title without duplicating
        // the selected sidebar row, workspace and Host in the visible toolbar.
        window.subtitle = ""
    }

    func windowDidBecomeKey(_ notification: Notification) {
        guard let visibleSession, allowsFocus(for: visibleSession) else { return }
        visibleSession.focus()
    }

    /// Closing the navigator only detaches, as closing a session window does.
    func windowWillClose(_ notification: Notification) { closeAll() }

    func toolbarDefaultItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.toggleSidebar, .sidebarTrackingSeparator]
    }

    func toolbarAllowedItemIdentifiers(_ toolbar: NSToolbar) -> [NSToolbarItem.Identifier] {
        [.toggleSidebar, .sidebarTrackingSeparator, .flexibleSpace]
    }

    func toolbar(_ toolbar: NSToolbar, itemForItemIdentifier itemIdentifier: NSToolbarItem.Identifier,
                 willBeInsertedIntoToolbar flag: Bool) -> NSToolbarItem? { nil }
}

/// The navigator's right side: the session on screen, or what stands in for one.
@MainActor
final class SessionNavigatorDetailController: NSViewController {
    private(set) weak var session: TerminalSessionController?
    var placeholder: NSView? {
        didSet {
            oldValue?.removeFromSuperview()
            guard let placeholder else { return }
            placeholder.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(placeholder, positioned: .below, relativeTo: nil)
            pin(placeholder)
            placeholder.isHidden = session != nil
        }
    }

    override func loadView() { view = NSView() }

    func show(_ next: TerminalSessionController?) {
        // A session handed on to a standalone window is no longer ours to remove.
        if let current = session, current.view.superview === view { current.view.removeFromSuperview() }
        session = next
        placeholder?.isHidden = next != nil
        guard let next else { return }
        next.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(next.view)
        pin(next.view)
    }

    /// Only the sidebar has window controls. The detail uses the full height;
    /// it has no duplicate session / directory / Host heading.
    private func pin(_ content: NSView) {
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: view.topAnchor),
            content.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }
}

struct SessionNavigatorSidebar: View {
    @ObservedObject var state: SessionNavigatorState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 0) {
            if state.hosts.count > 1 {
                SessionHostPicker(state: state)
                    .frame(maxWidth: .infinity).frame(height: 30)
                .padding(.horizontal, 12).padding(.top, 4).padding(.bottom, 8)
            }
            List(selection: Binding(get: { state.selectedRowID }, set: { id in
                if let id, let row = state.row(id) { state.choose(row) }
            })) {
                ForEach(state.groups) { group in
                    Section {
                        ForEach(group.rows) { row in
                            SessionNavigatorRow(row: row).tag(row.id)
                        }
                    } header: {
                        SessionNavigatorGroupHeader(group: group)
                    }
                }
            }
            .listStyle(.sidebar)
            .overlay { listOverlay }
            Divider()
            HStack(spacing: 10) {
                Button {
                    state.prepareNewSession()
                    openWindow(id: "new-session")
                    NSApp.activate(ignoringOtherApps: true)
                } label: {
                    Label("新建对话", systemImage: "plus")
                }
                .buttonStyle(.borderless)
                .help("在当前 Host 新建 Agent 会话（⌘N）")
                Spacer()
                Button(action: state.refresh) { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help("刷新会话列表")
                    .accessibilityLabel("刷新会话列表")
            }
            .padding(.horizontal, 14).padding(.vertical, 9)
        }
    }

    @ViewBuilder private var listOverlay: some View {
        if state.groups.isEmpty {
            switch state.listState {
            case .loading:
                ProgressView().controlSize(.small)
            case .error(let message):
                Text(message).font(.callout).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).padding(16)
            case .ready:
                Text("还没有会话").font(.callout).foregroundStyle(.secondary)
            }
        }
    }
}

private struct SessionNavigatorGroupHeader: View {
    let group: SessionDirectory.Group

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: group.id.isEmpty ? "terminal" : "folder")
            Text(group.title).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            if group.attention > 0 {
                Text("\(group.attention)")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.orange))
                    .help("\(group.attention) 个会话需要处理")
            } else if group.working > 0 {
                Circle().fill(Color.green).frame(width: 6, height: 6).help("\(group.working) 个会话工作中")
            }
        }
        .help(group.title)
    }
}

private struct SessionNavigatorRow: View {
    let row: SessionDirectory.Row
    @Environment(\.controlActiveState) private var activeState

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(statusColor).frame(width: 7, height: 7)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title).font(.system(size: 13)).lineLimit(1)
                // An inactive sidebar dims its default text but not an explicit
                // style; dim the summary too, or it outweighs its own title.
                Text(row.detail).font(.system(size: 11)).lineLimit(1)
                    .foregroundStyle(activeState == .inactive ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
            }
        }
        .padding(.vertical, 2)
        .help(row.detail)
        .accessibilityElement(children: .combine)
    }

    private var statusColor: Color {
        if row.agent.needsAttention { return .orange }
        if row.agent.isWorking { return .green }
        return .secondary.opacity(0.55)
    }
}

struct SessionNavigatorPlaceholderView: View {
    @ObservedObject var state: SessionNavigatorState

    var body: some View {
        Group {
            switch state.placeholder {
            case .none:
                Color.clear
            case .empty?:
                message(icon: "sidebar.left", title: "选择一个会话",
                        detail: "左侧按工作区（目录）列出当前 Host 的 Agent。点选即在这里切换，Agent 不会因此重启。")
            case .opening(let title)?:
                VStack(spacing: 12) {
                    ProgressView().controlSize(.small)
                    Text("正在打开 \(title)…").foregroundStyle(.secondary)
                }
            case .failed(let reason)?:
                message(icon: "exclamationmark.triangle", title: "无法打开此会话", detail: reason)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func message(icon: String, title: String, detail: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 30, weight: .light)).foregroundStyle(.secondary)
            Text(title).font(.system(size: 15, weight: .semibold))
            Text(detail).font(.system(size: 12)).foregroundStyle(.secondary)
                .multilineTextAlignment(.center).frame(maxWidth: 360)
                .textSelection(.enabled)
        }
        .padding(24)
    }
}

/// A native pop-up keeps the whole row clickable and always displays its arrow.
private struct SessionHostPicker: NSViewRepresentable {
    @ObservedObject var state: SessionNavigatorState
    func makeCoordinator() -> Coordinator { Coordinator(state: state) }
    func makeNSView(context: Context) -> NSPopUpButton {
        let button = NSPopUpButton(frame: .zero, pullsDown: false)
        button.bezelStyle = .rounded
        button.controlSize = .regular
        button.alignment = .left
        button.font = .systemFont(ofSize: 13, weight: .medium)
        button.setContentHuggingPriority(.defaultLow, for: .horizontal)
        button.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        button.cell?.lineBreakMode = .byTruncatingMiddle
        button.target = context.coordinator
        button.action = #selector(Coordinator.choose(_:))
        button.setAccessibilityLabel("切换主机")
        button.toolTip = "切换要查看的主机"
        return button
    }
    func updateNSView(_ button: NSPopUpButton, context: Context) {
        context.coordinator.state = state
        if button.itemArray.map({ $0.representedObject as? String }) != state.hosts.map({ Optional($0.id) })
            || button.itemTitles != state.hosts.map(\.title) {
            button.removeAllItems()
            for host in state.hosts {
                button.addItem(withTitle: host.title)
                button.lastItem?.representedObject = host.id
                button.lastItem?.image = NSImage(systemSymbolName: host.id == "local" ? "desktopcomputer" : "network", accessibilityDescription: nil)
            }
        }
        button.selectItem(at: state.hosts.firstIndex { $0.id == state.activeHostID } ?? 0)
    }
    final class Coordinator: NSObject {
        var state: SessionNavigatorState
        init(state: SessionNavigatorState) { self.state = state }
        @MainActor @objc func choose(_ sender: NSPopUpButton) {
            if let id = sender.selectedItem?.representedObject as? String { state.chooseHost(id) }
        }
    }
}
