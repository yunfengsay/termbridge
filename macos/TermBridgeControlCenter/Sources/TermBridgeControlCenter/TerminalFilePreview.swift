import AppKit
import Quartz

@MainActor
private final class WorkspaceFileNode: NSObject {
    let name: String
    let path: String
    let directory: Bool
    var children: [WorkspaceFileNode]?
    init(name: String, path: String, directory: Bool) { self.name = name; self.path = path; self.directory = directory }
}

/// One row of the changes list: a repository section or a file inside it.
@MainActor
private final class ChangeNode: NSObject {
    enum Kind {
        case repository(ReviewRepositoryInfo)
        /// A file with uncommitted changes; `touched` when this conversation changed it.
        case change(repository: ReviewRepositoryInfo, file: ReviewFileInfo, touched: Bool)
        /// A file this conversation changed that has nothing uncommitted now.
        case touched(repository: ReviewRepositoryInfo, path: String)
        case note(String)
    }
    let kind: Kind
    var children: [ChangeNode] = []
    init(_ kind: Kind) { self.kind = kind }
}

/// The file and Git inspector for one session: its project files, and the
/// repositories this conversation changed with their diffs and images.
///
/// One reusable window. Host + session bind the tree, the changes and every
/// read; the Host decides which paths and repositories a session may see.
@MainActor
final class TerminalFilePreview: NSWindowController, NSWindowDelegate, NSOutlineViewDataSource, NSOutlineViewDelegate,
    @preconcurrency TermbridgeClientListener {
    static let shared = TerminalFilePreview()

    enum Mode: Int { case changes = 0, files = 1 }

    private enum Detail: Equatable {
        case none
        case file(path: String, line: Int?)
        case repository(String)
        case change(repository: String, path: String)
    }

    private enum Purpose {
        case preview
        case before
        case after
        case changedFile
    }

    @MainActor
    private final class Download {
        let id = UUID().uuidString
        let path: String
        let revision: String?
        let purpose: Purpose
        let generation: Int
        var data = Data()
        var name = ""
        var version: String?
        var size: Int?
        var resolvedPath: String?
        var rootPath: String?
        var timeout: Task<Void, Never>?
        init(path: String, revision: String?, purpose: Purpose, generation: Int) {
            self.path = path; self.revision = revision; self.purpose = purpose; self.generation = generation
        }
    }

    private enum SnapshotPurpose {
        case overview(String)
        case file(repository: String, path: String)
        case legacyList
    }

    // Connection
    private var sessionID = ""
    private var settings: ConnectionSettings?
    private var client: TermbridgeClient?
    private var ready = false
    private var connectTimeout: Task<Void, Never>?

    // Files mode
    private var root: WorkspaceFileNode?
    private var revealPath: String?
    private var refreshedPaths: Set<String> = []
    private var listRequests: [String: WorkspaceFileNode] = [:]
    private var listTimeouts: [String: Task<Void, Never>] = [:]
    private var selectingProgrammatically = false

    // Changes mode
    private(set) var repositories: [ReviewRepositoryInfo] = []
    private var changeRoots: [ChangeNode] = []
    private var repositoriesRequest: String?
    private var repositoriesTimeout: Task<Void, Never>?
    private var repositoriesLoadedAt: Date?
    /// The Host predates `review_repositories`: one repository, its working directory's.
    private(set) var legacyHost = false
    private var snapshotRequests: [String: (purpose: SnapshotPurpose, generation: Int)] = [:]
    private var snapshotTimeouts: [String: Task<Void, Never>] = [:]

    // Detail
    private(set) var mode: Mode = .files
    private var detail: Detail = .none
    private var generation = 0
    private var downloads: [String: Download] = [:]
    private var previewDirectory: URL?
    private var previewContent: FilePreviewContent?
    private var previewData: Data?
    private var previewName = ""
    private var previewLine: Int?
    private var images: [Purpose: (data: Data?, note: String?)] = [:]
    private var expectedImages: Set<Purpose> = []
    private var changeFile: ReviewFileInfo?
    private var changeTouched = false
    private var currentRepositoryPath: String?

    // Views
    private let outline = NSOutlineView()
    private let changesOutline = NSOutlineView()
    private let fileScroll = NSScrollView()
    private let changesScroll = NSScrollView()
    private let modeControl = NSSegmentedControl(labels: ["改动", "文件"], trackingMode: .selectOne, target: nil, action: nil)
    private let split = NSSplitViewController()
    private var sidebar: NSSplitViewItem!
    private let label = NSTextField(labelWithString: "")
    private let findButton = NSButton(title: "查找", target: nil, action: nil)
    private let detailControl = NSSegmentedControl()
    private var detailModes: [String] = []
    private let treeStatus = NSTextField(labelWithString: "")
    private let progress = NSProgressIndicator()
    private let content = NSView()
    let codeView = CodeTextView(frame: .zero)
    let imageView = ImageComparisonView(frame: .zero)
    private let preview = QLPreviewView(frame: .zero, style: .normal)!
    private let message = NSTextField(wrappingLabelWithString: "")

    private init() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init(window: window)
        // This singleton reopens its window. QLPreviewView otherwise permanently
        // closes itself and aborts when another preview item is assigned.
        preview.shouldCloseWithWindow = false
        NotificationCenter.default.addObserver(self, selector: #selector(closePreview), name: NSApplication.willTerminateNotification, object: nil)
        window.title = "文件与改动"
        window.isReleasedWhenClosed = false; window.delegate = self
        window.minSize = NSSize(width: 720, height: 420)
        buildSidebar()
        buildDetail()
        window.contentViewController = split
        window.setContentSize(NSSize(width: 1180, height: 760))
        window.center()
    }
    required init?(coder: NSCoder) { nil }

    private func buildSidebar() {
        let sideController = NSViewController(); sideController.view = NSView()
        modeControl.target = self; modeControl.action = #selector(modeChanged)
        modeControl.selectedSegment = mode.rawValue
        modeControl.segmentDistribution = .fillEqually
        modeControl.setToolTip("这次对话涉及的仓库与改动", forSegment: 0)
        modeControl.setToolTip("当前会话的项目文件", forSegment: 1)
        modeControl.setAccessibilityLabel("改动或文件")
        configure(outline, column: "name", label: "远端项目文件目录")
        configure(changesOutline, column: "change", label: "这次对话涉及的 Git 改动")
        changesOutline.floatsGroupRows = false
        fileScroll.documentView = outline
        changesScroll.documentView = changesOutline
        for scroll in [fileScroll, changesScroll] {
            scroll.hasVerticalScroller = true; scroll.hasHorizontalScroller = false; scroll.drawsBackground = false
        }
        treeStatus.font = .systemFont(ofSize: 11); treeStatus.textColor = .secondaryLabelColor
        treeStatus.lineBreakMode = .byTruncatingTail
        for view in [modeControl, fileScroll, changesScroll, treeStatus] {
            view.translatesAutoresizingMaskIntoConstraints = false; sideController.view.addSubview(view)
        }
        NSLayoutConstraint.activate([
            modeControl.topAnchor.constraint(equalTo: sideController.view.topAnchor, constant: 10),
            modeControl.leadingAnchor.constraint(equalTo: sideController.view.leadingAnchor, constant: 10),
            modeControl.trailingAnchor.constraint(equalTo: sideController.view.trailingAnchor, constant: -10),
            treeStatus.leadingAnchor.constraint(equalTo: sideController.view.leadingAnchor, constant: 10),
            treeStatus.trailingAnchor.constraint(equalTo: sideController.view.trailingAnchor, constant: -10),
            treeStatus.bottomAnchor.constraint(equalTo: sideController.view.bottomAnchor, constant: -8),
        ])
        for scroll in [fileScroll, changesScroll] {
            NSLayoutConstraint.activate([
                scroll.topAnchor.constraint(equalTo: modeControl.bottomAnchor, constant: 8),
                scroll.leadingAnchor.constraint(equalTo: sideController.view.leadingAnchor),
                scroll.trailingAnchor.constraint(equalTo: sideController.view.trailingAnchor),
                scroll.bottomAnchor.constraint(equalTo: treeStatus.topAnchor, constant: -6),
            ])
        }
        sidebar = NSSplitViewItem(sidebarWithViewController: sideController)
        sidebar.minimumThickness = 220; sidebar.maximumThickness = 460; sidebar.canCollapse = true
        split.addSplitViewItem(sidebar)
        applyMode()
    }

    private func configure(_ view: NSOutlineView, column identifier: String, label: String) {
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(identifier))
        // One column as wide as the sidebar, so counts at the end of a row stay
        // visible. It starts narrow: a table never shrinks below its columns.
        column.title = identifier; column.width = 40
        column.resizingMask = .autoresizingMask
        view.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        view.addTableColumn(column); view.outlineTableColumn = column
        view.headerView = nil; view.rowHeight = 26
        view.usesAutomaticRowHeights = true
        view.dataSource = self; view.delegate = self
        view.setAccessibilityLabel(label)
    }

    private func buildDetail() {
        let detailController = NSViewController(); detailController.view = NSView()
        let toggle = NSButton(image: NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: "显示或收起目录树")!, target: self, action: #selector(toggleSidebar))
        toggle.bezelStyle = .texturedRounded; toggle.toolTip = "显示或收起目录树"
        let refresh = NSButton(image: NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "刷新")!, target: self, action: #selector(refreshCurrent))
        refresh.bezelStyle = .texturedRounded; refresh.toolTip = "刷新"
        detailControl.target = self; detailControl.action = #selector(detailModeChanged)
        detailControl.isHidden = true
        detailControl.setAccessibilityLabel("显示方式")
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        findButton.target = codeView; findButton.action = #selector(CodeTextView.showFind)
        findButton.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "查找代码")
        findButton.bezelStyle = .texturedRounded; findButton.toolTip = "查找代码 · ⌘F"
        let heading = NSStackView(views: [toggle, refresh, label, spacer, findButton, detailControl]); heading.spacing = 12
        // The heading keeps its own height; the content below takes all the rest,
        // whatever size a preview or picture would like to be.
        heading.setHuggingPriority(.required, for: .vertical)
        label.lineBreakMode = .byTruncatingMiddle
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        progress.style = .bar
        progress.isHidden = true
        message.alignment = .center
        message.textColor = .secondaryLabelColor
        message.font = .systemFont(ofSize: 13)
        for view in [codeView, imageView, preview, message] as [NSView] {
            view.translatesAutoresizingMaskIntoConstraints = false
            for axis in [NSLayoutConstraint.Orientation.horizontal, .vertical] {
                view.setContentHuggingPriority(.defaultLow, for: axis)
                view.setContentCompressionResistancePriority(.defaultLow, for: axis)
            }
            content.addSubview(view)
            let inset: CGFloat = view === message ? 40 : 0
            NSLayoutConstraint.activate([
                view.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: inset),
                view.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -inset),
            ])
            if view === message {
                view.centerYAnchor.constraint(equalTo: content.centerYAnchor).isActive = true
            } else {
                NSLayoutConstraint.activate([
                    view.topAnchor.constraint(equalTo: content.topAnchor),
                    view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
                ])
            }
        }
        codeView.onLink = { [weak self] url in self?.openLink(url) }
        for view in [heading, progress, content] { view.translatesAutoresizingMaskIntoConstraints = false; detailController.view.addSubview(view) }
        NSLayoutConstraint.activate([
            heading.leadingAnchor.constraint(equalTo: detailController.view.leadingAnchor, constant: 12),
            heading.trailingAnchor.constraint(equalTo: detailController.view.trailingAnchor, constant: -12),
            heading.topAnchor.constraint(equalTo: detailController.view.topAnchor, constant: 10),
            progress.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 8),
            progress.leadingAnchor.constraint(equalTo: heading.leadingAnchor),
            progress.trailingAnchor.constraint(equalTo: heading.trailingAnchor),
            content.topAnchor.constraint(equalTo: progress.bottomAnchor, constant: 8),
            content.leadingAnchor.constraint(equalTo: detailController.view.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: detailController.view.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: detailController.view.bottomAnchor),
        ])
        split.addSplitViewItem(NSSplitViewItem(viewController: detailController))
        showMessage("选择左侧的文件或改动")
    }

    @objc private func closePreview() { disconnect(); clearDetail(); preview.close() }
    @objc private func toggleSidebar() { sidebar.animator().isCollapsed.toggle() }

    // MARK: - Entry points

    /// A file link from the terminal: preview it and reveal it in the file tree.
    func present(sessionID: String, path: String, settings: ConnectionSettings, line: Int? = nil) {
        bind(sessionID: sessionID, settings: settings)
        setMode(.files)
        select(.file(path: path, line: line))
    }

    /// The repositories this conversation touched and their changes.
    func presentChanges(sessionID: String, settings: ConnectionSettings) {
        bind(sessionID: sessionID, settings: settings)
        setMode(.changes)
        if repositoriesLoadedAt == nil || repositoriesRequest == nil { loadRepositories() }
    }

    private func bind(sessionID: String, settings: ConnectionSettings) {
        let changed = self.sessionID != sessionID || self.settings != settings
        if changed || client == nil {
            disconnect(); clearDetail()
            root = nil; outline.reloadData(); treeStatus.stringValue = "正在加载…"
            repositories = []; changeRoots = []; changesOutline.reloadData(); repositoriesLoadedAt = nil; legacyHost = false
            detail = .none
        }
        self.sessionID = sessionID; self.settings = settings
        window?.subtitle = "\(settings.displayName) · \(sessionID)"
        showWindow(nil); window?.makeKeyAndOrderFront(nil)
        if client == nil {
            let connection = TermbridgeClient(settings: settings, listener: self)
            client = connection
            connectTimeout?.cancel()
            connectTimeout = Task { [weak self] in
                do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
                guard let self, !self.ready else { return }
                self.showMessage("无法连接 Host，请检查连接后重试。")
                self.treeStatus.stringValue = "Host 未响应"
            }
            connection.connect()
        }
    }

    func windowWillClose(_ notification: Notification) { disconnect(); clearDetail() }

    func windowDidBecomeKey(_ notification: Notification) {
        // Agents keep working; a stale change list refreshes when looked at again.
        if mode == .changes, ready, repositoriesRequest == nil,
           let loaded = repositoriesLoadedAt, Date().timeIntervalSince(loaded) > 10 { loadRepositories() }
    }

    private func disconnect() {
        ready = false; client?.disconnect(); client = nil
        connectTimeout?.cancel(); connectTimeout = nil
        listTimeouts.values.forEach { $0.cancel() }; listTimeouts.removeAll(); listRequests.removeAll()
        repositoriesTimeout?.cancel(); repositoriesTimeout = nil; repositoriesRequest = nil
        snapshotRequests.removeAll()
        snapshotTimeouts.values.forEach { $0.cancel() }; snapshotTimeouts.removeAll()
        downloads.values.forEach { $0.timeout?.cancel() }; downloads.removeAll()
    }

    // MARK: - Modes

    @objc private func modeChanged() {
        setMode(Mode(rawValue: modeControl.selectedSegment) ?? .files)
        if mode == .changes, repositoriesRequest == nil,
           repositoriesLoadedAt.map({ Date().timeIntervalSince($0) > 10 }) ?? true { loadRepositories() }
    }

    private func setMode(_ next: Mode) {
        mode = next
        modeControl.selectedSegment = next.rawValue
        applyMode()
        if next == .files { loadFileRoot() }
    }

    private func applyMode() {
        fileScroll.isHidden = mode != .files
        changesScroll.isHidden = mode != .changes
        updateTreeStatus()
    }

    private func updateTreeStatus() {
        switch mode {
        case .files:
            if root == nil { treeStatus.stringValue = ready ? "正在读取项目目录…" : "正在连接…" }
        case .changes:
            if repositoriesRequest != nil { treeStatus.stringValue = "正在读取改动…"; return }
            guard repositoriesLoadedAt != nil else { treeStatus.stringValue = ""; return }
            let files = repositories.reduce(0) { $0 + $1.changedFileCount }
            let touched = repositories.reduce(0) { $0 + $1.touched.count }
            var parts = ["\(repositories.count) 个仓库", "\(files) 个未提交改动"]
            if touched > 0 { parts.append("本次对话改了 \(touched) 个文件") }
            if legacyHost { parts.append("更新 Host 后可显示其他仓库") }
            treeStatus.stringValue = parts.joined(separator: " · ")
        }
    }

    @objc private func refreshCurrent() {
        if !ready, let settings {
            let current = detail
            disconnect()
            bind(sessionID: sessionID, settings: settings)
            detail = current
            return
        }
        switch mode {
        case .files: refreshDirectory()
        case .changes: loadRepositories()
        }
        let current = detail
        detail = .none
        select(current)
    }

    private func refreshDirectory() {
        guard ready else { return }
        guard let root else { loadFileRoot(); return }
        if outline.selectedRow >= 0, let selected = outline.item(atRow: outline.selectedRow) as? WorkspaceFileNode {
            revealPath = selected.path
        }
        root.children = nil
        selectingProgrammatically = true; outline.reloadData(); selectingProgrammatically = false
        loadChildren(root)
    }

    // MARK: - Detail

    private func select(_ next: Detail) {
        guard next != detail || next == .none else { return }
        clearDetail()
        detail = next
        generation += 1
        switch next {
        case .none:
            showMessage("选择左侧的文件或改动")
        case .file(let path, let line):
            previewLine = line
            label.stringValue = "正在读取 \((path as NSString).lastPathComponent)…"
            startProgress(indeterminate: true)
            revealPath = nil; refreshedPaths.removeAll()
            if ready { startDownload(path: path, revision: nil, purpose: .preview) }
        case .repository(let path):
            currentRepositoryPath = path
            label.stringValue = "正在读取 \((path as NSString).lastPathComponent) 的改动…"
            startProgress(indeterminate: true)
            if ready { requestSnapshot(.overview(path), repository: path, path: nil) }
        case .change(let repository, let path):
            currentRepositoryPath = repository
            label.stringValue = path
            startProgress(indeterminate: true)
            if ready { loadChange(repository: repository, path: path) }
        }
    }

    /// Restarts whatever the current detail needs once the connection is ready.
    private func resumeDetail() {
        let current = detail
        detail = .none
        select(current)
    }

    private func clearDetail() {
        label.stringValue = ""
        downloads.values.forEach { $0.timeout?.cancel() }
        downloads.removeAll()
        snapshotRequests = snapshotRequests.filter { if case .legacyList = $0.value.purpose { return true }; return false }
        for id in Array(snapshotTimeouts.keys) where snapshotRequests[id] == nil {
            snapshotTimeouts.removeValue(forKey: id)?.cancel()
        }
        preview.previewItem = nil
        if let previewDirectory { try? FileManager.default.removeItem(at: previewDirectory) }
        previewDirectory = nil; previewContent = nil; previewData = nil
        images = [:]; expectedImages = []; changeFile = nil
        detailModes = []; detailControl.isHidden = true
        stopProgress()
    }

    private func showMessage(_ text: String) {
        message.stringValue = text
        show(message)
    }

    private func show(_ view: NSView) {
        for candidate in [codeView, imageView, preview, message] as [NSView] { candidate.isHidden = candidate !== view }
        findButton.isHidden = view !== codeView
    }

    private func startProgress(indeterminate: Bool) {
        progress.isHidden = false; progress.isIndeterminate = indeterminate
        if indeterminate { progress.startAnimation(nil) }
    }

    private func stopProgress() { progress.stopAnimation(nil); progress.isHidden = true }

    private func fail(_ text: String) {
        stopProgress()
        label.stringValue = text
        showMessage(text)
    }

    private func setDetailModes(_ titles: [String], selected: Int) {
        detailModes = titles
        detailControl.segmentCount = titles.count
        for (index, title) in titles.enumerated() { detailControl.setLabel(title, forSegment: index); detailControl.setWidth(0, forSegment: index) }
        detailControl.selectedSegment = selected
        detailControl.isHidden = titles.count < 2
    }

    @objc private func detailModeChanged() {
        guard detailControl.selectedSegment >= 0, detailControl.selectedSegment < detailModes.count else { return }
        let choice = detailModes[detailControl.selectedSegment]
        switch detail {
        case .file:
            guard let content = previewContent, let data = previewData else { return }
            let mode = content.modes.first { $0.title == choice } ?? content.modes[0]
            render(content, data: data, mode: mode)
        case .change(let repository, let path):
            if choice == "差异", let file = changeFile {
                codeView.show(DiffDocument.file(file, touched: changeTouched)); show(codeView)
            } else if choice == "文件" {
                // The whole current file, or the committed one for a deletion.
                let deleted = changeFile?.status == "deleted"
                startProgress(indeterminate: true)
                startDownload(path: absolute(path, in: repository), revision: deleted ? ReviewProtocol.headRevision : nil, purpose: .changedFile)
            }
        default: break
        }
    }

    // MARK: - Files

    private func render(_ content: FilePreviewContent, data: Data, mode: FilePreviewContent.Mode) {
        switch mode {
        case .code:
            let (document, truncated) = CodeDocument.source(content.text ?? "", language: content.language,
                                                            focusLine: previewLine.map { max(0, $0 - 1) })
            codeView.show(document)
            show(codeView)
            if truncated { label.stringValue += " · 文件较大，仅显示前 4 MB" }
        case .hex:
            let dump = FilePreviewContent.hexDump(data)
            codeView.show(CodeDocument(text: NSAttributedString(string: dump, attributes: [
                .font: CodeDocument.font, .foregroundColor: NSColor.labelColor,
            ]), gutter: []))
            show(codeView)
        case .quickLook:
            do {
                if previewDirectory == nil {
                    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("TermBridge-Preview-" + UUID().uuidString)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                    previewDirectory = directory
                }
                let url = previewDirectory!.appendingPathComponent(previewName)
                if !FileManager.default.fileExists(atPath: url.path) {
                    guard FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                        throw CocoaError(.fileWriteUnknown)
                    }
                }
                preview.previewItem = url as NSURL
                show(preview)
            } catch { fail("无法保存预览文件，请检查本机可用空间。") }
        }
    }

    private func finishPreview(_ download: Download) {
        stopProgress()
        let content = FilePreviewContent.classify(name: download.name, data: download.data)
        previewContent = content
        previewData = download.data
        previewName = download.name
        var title = download.resolvedPath ?? download.path
        if let language = content.language, content.modes.first == .code { title += " · \(language.title)" }
        else if content.modes.first == .hex { title += " · 二进制文件，显示原始字节" }
        label.stringValue = title
        setDetailModes(content.modes.map(\.title), selected: 0)
        render(content, data: download.data, mode: content.modes[0])
        if let path = download.resolvedPath, let rootPath = download.rootPath { reveal(path, rootPath: rootPath) }
    }

    /// Browsing starts at the session's working directory, even when no file
    /// link has been opened. The Host resolves `.` and returns its canonical path.
    private func loadFileRoot() {
        guard ready, root == nil, !listRequests.values.contains(where: { $0.path == "." }) else { return }
        treeStatus.stringValue = "正在读取项目目录…"
        if detail == .none { showMessage("正在读取项目目录…") }
        loadChildren(WorkspaceFileNode(name: "项目文件", path: ".", directory: true))
    }

    private func loadChildren(_ node: WorkspaceFileNode) {
        guard ready, node.children == nil, !listRequests.values.contains(where: { $0 === node }) else { return }
        let id = UUID().uuidString; listRequests[id] = node
        if client?.sendControl(["t": .string("session_directory_list"), "requestId": .string(id),
            "sessionId": .string(sessionID), "path": .string(node.path)]) != true {
            listRequests.removeValue(forKey: id); treeStatus.stringValue = "目录连接已断开"; return
        }
        listTimeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard let self, let node = self.listRequests.removeValue(forKey: id) else { return }
            self.listTimeouts.removeValue(forKey: id)
            self.treeStatus.stringValue = "目录加载超时，请点击刷新重试；旧版 Host 需要更新。"
            if node.path == ".", self.mode == .files { self.showMessage(self.treeStatus.stringValue) }
        }
    }

    private func reveal(_ canonicalPath: String, rootPath: String) {
        revealPath = canonicalPath
        if root?.path != rootPath {
            root = WorkspaceFileNode(name: (rootPath as NSString).lastPathComponent, path: rootPath, directory: true)
            outline.reloadData()
        }
        revealSelection()
    }

    private func revealSelection() {
        guard var node = root, let target = revealPath else { return }
        while target.hasPrefix(node.path + "/") {
            outline.expandItem(node)
            guard let children = node.children else { loadChildren(node); return }
            guard let next = children.first(where: { target == $0.path || target.hasPrefix($0.path + "/") }) else {
                if refreshedPaths.insert(node.path).inserted { node.children = nil; loadChildren(node) }
                return
            }
            node = next
        }
        guard node.path == target else { return }
        let row = outline.row(forItem: node)
        if row >= 0 {
            selectingProgrammatically = true
            outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            outline.scrollRowToVisible(row)
            selectingProgrammatically = false
            revealPath = nil
        }
    }

    private func receiveDirectory(_ message: ControlMessage) {
        guard let id = message.string("requestId"), var node = listRequests.removeValue(forKey: id) else { return }
        listTimeouts.removeValue(forKey: id)?.cancel()
        let bootstrapping = node.path == "."
        guard message.string("error") == nil, let path = message.string("path"),
              (path == node.path || (bootstrapping && (path as NSString).isAbsolutePath)),
              let entries = message.fields["entries"]?.arrayValue, entries.count <= 1000 else {
            treeStatus.stringValue = message.string("error").map(Self.readError) ?? "目录无法读取，请点击刷新重试。"
            if bootstrapping, mode == .files { showMessage(treeStatus.stringValue) }
            return
        }
        if bootstrapping {
            // A file click may already have revealed a different permitted root.
            guard root == nil else { return }
            node = WorkspaceFileNode(name: (path as NSString).lastPathComponent, path: path, directory: true)
            root = node
            outline.reloadData()
        }
        node.children = entries.compactMap { entry in
            guard let fields = entry.mapValue, let name = fields["name"]?.stringValue,
                  !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
                  !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
                  let directory = fields["directory"]?.boolValue else { return nil }
            return WorkspaceFileNode(name: name, path: (node.path as NSString).appendingPathComponent(name), directory: directory)
        }
        outline.reloadItem(node, reloadChildren: true)
        outline.expandItem(node)
        if mode == .files {
            treeStatus.stringValue = message.bool("truncated") == true ? "目录较大，仅显示前 1000 项" : "单击文件预览 · 展开目录浏览"
        }
        revealSelection()
        if bootstrapping, detail == .none, mode == .files { showMessage("选择左侧的文件查看代码") }
    }

    // MARK: - Downloads

    private func startDownload(path: String, revision: String?, purpose: Purpose) {
        let download = Download(path: path, revision: revision, purpose: purpose, generation: generation)
        downloads[download.id] = download
        requestChunk(download)
    }

    private func requestChunk(_ download: Download) {
        var fields: [String: MessagePackValue] = ["t": .string("session_file_read"),
            "requestId": .string(download.id), "sessionId": .string(sessionID),
            "path": .string(download.path), "offset": .int(Int64(download.data.count))]
        if let version = download.version { fields["version"] = .string(version) }
        if let revision = download.revision { fields["revision"] = .string(revision) }
        download.timeout?.cancel()
        download.timeout = Task { [weak self, id = download.id] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard let self, let download = self.downloads[id] else { return }
            self.downloadFailed(download, "读取超时，请确认 Host 已支持文件预览，然后重试。")
        }
        if client?.sendControl(fields) != true { downloadFailed(download, "连接已断开，请重新打开。") }
    }

    private func receiveChunk(_ message: ControlMessage) {
        guard let id = message.string("requestId"), let download = downloads[id] else { return }
        if let error = message.string("error") { downloadFailed(download, Self.readError(error)); return }
        guard let chunk = SessionFileChunk(message: message), chunk.offset == download.data.count,
              download.version == nil || download.version == chunk.version,
              download.size == nil || download.size == chunk.size else {
            downloadFailed(download, "文件传输校验失败，请重新打开。"); return
        }
        // An older Host ignores `revision` and returns the working copy: never show that as "before".
        if download.revision != nil, !chunk.version.hasPrefix("HEAD:") {
            downloadFailed(download, "更新 Host 后可显示修改前的版本。"); return
        }
        if download.version == nil {
            download.version = chunk.version; download.size = chunk.size; download.name = chunk.name
            download.resolvedPath = chunk.path; download.rootPath = chunk.rootPath
        }
        download.data.append(chunk.data)
        if download.purpose == .preview || download.purpose == .changedFile {
            progress.isIndeterminate = false; progress.maxValue = Double(max(1, chunk.size)); progress.doubleValue = Double(download.data.count)
            if download.purpose == .preview {
                label.stringValue = "正在读取 \(chunk.name) · \(download.data.count / 1024) / \(chunk.size / 1024) KB"
            }
        }
        guard chunk.eof else { requestChunk(download); return }
        download.timeout?.cancel()
        downloads.removeValue(forKey: id)
        guard download.generation == generation else { return }
        switch download.purpose {
        case .preview: finishPreview(download)
        case .before, .after:
            images[download.purpose] = (download.data, nil)
            showImagesIfReady()
        case .changedFile:
            stopProgress()
            let text = FileText.decode(download.data)
            let language = CodeLanguage.detect(fileName: download.name, firstLine: nil)
            if let text {
                codeView.show(CodeDocument.source(text, language: language).0)
            } else {
                codeView.show(CodeDocument(text: NSAttributedString(string: FilePreviewContent.hexDump(download.data),
                    attributes: [.font: CodeDocument.font, .foregroundColor: NSColor.labelColor]), gutter: []))
            }
            show(codeView)
        }
    }

    private func downloadFailed(_ download: Download, _ text: String) {
        download.timeout?.cancel()
        downloads.removeValue(forKey: download.id)
        guard download.generation == generation else { return }
        switch download.purpose {
        case .preview, .changedFile: fail(text)
        case .before, .after:
            images[download.purpose] = (nil, text)
            showImagesIfReady()
        }
    }

    // MARK: - Changes

    private func loadRepositories() {
        guard ready else { treeStatus.stringValue = "正在连接…"; return }
        if legacyHost { requestLegacyList(); return }
        repositoriesTimeout?.cancel()
        let id = UUID().uuidString
        repositoriesRequest = id
        updateTreeStatus()
        guard client?.sendControl(["t": .string(ReviewProtocol.repositories), "requestId": .string(id),
                                   "sessionId": .string(sessionID)]) == true else {
            repositoriesRequest = nil; treeStatus.stringValue = "连接已断开"; return
        }
        // A Host older than `review_repositories` stays silent; fall back to its one repository.
        repositoriesTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 10_000_000_000) } catch { return }
            guard let self, self.repositoriesRequest == id else { return }
            self.repositoriesRequest = nil
            self.legacyHost = true
            self.requestLegacyList()
        }
    }

    private func requestLegacyList() {
        let id = UUID().uuidString
        snapshotRequests[id] = (.legacyList, generation)
        repositoriesRequest = id
        updateTreeStatus()
        if client?.sendControl(["t": .string("review_snapshot"), "requestId": .string(id), "sessionId": .string(sessionID),
                                "mode": .string("working")]) != true {
            repositoriesRequest = nil; snapshotRequests.removeValue(forKey: id)
            treeStatus.stringValue = "连接已断开"
            return
        }
        waitForSnapshot(id)
    }

    private func receiveRepositories(_ message: ControlMessage) {
        guard let id = message.string("requestId"), id == repositoriesRequest else { return }
        repositoriesRequest = nil
        repositoriesTimeout?.cancel(); repositoriesTimeout = nil
        if let error = message.string("error"), message.fields["repositories"] == nil {
            apply(repositories: [], note: Self.reviewError(error))
            return
        }
        apply(repositories: ReviewRepositoryInfo.list(message.fields), note: nil)
    }

    private func apply(repositories next: [ReviewRepositoryInfo], note: String?) {
        repositories = next
        repositoriesLoadedAt = Date()
        let selected = changesOutline.selectedRow >= 0 ? changesOutline.item(atRow: changesOutline.selectedRow) as? ChangeNode : nil
        let selectedKey = selected.map(Self.key)
        changeRoots = next.map { repository in
            let node = ChangeNode(.repository(repository))
            let touched = Set(repository.touched)
            node.children = repository.files.map { ChangeNode(.change(repository: repository, file: $0, touched: touched.contains($0.path))) }
            let changed = Set(repository.files.map(\.path))
            node.children += repository.touched.filter { !changed.contains($0) }.map { ChangeNode(.touched(repository: repository, path: $0)) }
            if let error = repository.error { node.children.append(ChangeNode(.note("无法读取：\(Self.reviewError(error))"))) }
            else if repository.files.isEmpty && repository.touched.isEmpty { node.children.append(ChangeNode(.note("没有未提交的改动"))) }
            if repository.truncated { node.children.append(ChangeNode(.note("改动较多，仅列出前 \(repository.files.count) 个"))) }
            if repository.touchedTruncated { node.children.append(ChangeNode(.note("本次对话改动的文件较多，只列出一部分"))) }
            return node
        }
        if let note, next.isEmpty { changeRoots = [ChangeNode(.note(note))] }
        else if next.isEmpty { changeRoots = [ChangeNode(.note("这次对话还没有涉及任何 Git 仓库"))] }
        changesOutline.reloadData()
        for node in changeRoots { changesOutline.expandItem(node) }
        if next.isEmpty, mode == .changes {
            select(.none)
            showMessage(note ?? "当前会话没有可查看的 Git 仓库，请切到「文件」浏览代码。")
        }
        // Keep the user's place across refreshes; otherwise start at the first repository.
        if let selectedKey, let row = (0..<changesOutline.numberOfRows).first(where: {
            (changesOutline.item(atRow: $0) as? ChangeNode).map(Self.key) == selectedKey
        }) {
            selectingProgrammatically = true
            changesOutline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
            selectingProgrammatically = false
        } else if mode == .changes, case .none = detail, let first = next.first {
            let row = changesOutline.row(forItem: changeRoots.first)
            if row >= 0 {
                selectingProgrammatically = true
                changesOutline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
                selectingProgrammatically = false
            }
            select(.repository(first.repositoryPath))
        }
        updateTreeStatus()
    }

    private static func key(_ node: ChangeNode) -> String {
        switch node.kind {
        case .repository(let repository): return "r\u{0}" + repository.repositoryPath
        case .change(let repository, let file, _): return "c\u{0}" + repository.repositoryPath + "\u{0}" + file.path
        case .touched(let repository, let path): return "t\u{0}" + repository.repositoryPath + "\u{0}" + path
        case .note(let text): return "n\u{0}" + text
        }
    }

    private static func readError(_ error: String) -> String {
        if error.contains("Private configuration") { return DiffDocument.privateNote }
        if error.contains("outside this session workspace") { return "这个文件不在当前会话的工作目录或对话涉及的仓库中。" }
        if error.contains("20 MiB") { return "文件超过 20 MB，无法预览。" }
        if error.contains("not in the last commit") { return "上一次提交里没有这个文件。" }
        return "无法读取：\(error)"
    }

    private static func reviewError(_ error: String) -> String {
        if error.contains("not inside a Git repository") || error.contains("not a git repository") { return "当前目录不在 Git 仓库中" }
        if error.contains("does not expose a working directory") { return "这个会话没有提供工作目录" }
        if error.contains("Unknown repository") { return "这个仓库不属于当前对话" }
        return error
    }

    private func requestSnapshot(_ purpose: SnapshotPurpose, repository: String, path: String?) {
        let id = UUID().uuidString
        snapshotRequests[id] = (purpose, generation)
        var fields: [String: MessagePackValue] = ["t": .string("review_snapshot"), "requestId": .string(id),
            "sessionId": .string(sessionID), "mode": .string("working")]
        if !legacyHost { fields["repository"] = .string(repository) }
        if let path { fields["path"] = .string(path) }
        if client?.sendControl(fields) != true {
            snapshotRequests.removeValue(forKey: id)
            fail("连接已断开，请点击刷新重试。")
            return
        }
        waitForSnapshot(id)
    }

    private func waitForSnapshot(_ id: String) {
        snapshotTimeouts[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard let self, let request = self.snapshotRequests.removeValue(forKey: id) else { return }
            self.snapshotTimeouts.removeValue(forKey: id)
            let note = "读取改动超时，请点击刷新重试；旧版 Host 需要更新。"
            if case .legacyList = request.purpose {
                guard self.repositoriesRequest == id else { return }
                self.repositoriesRequest = nil
                self.apply(repositories: [], note: note)
            }
            if request.generation == self.generation, self.mode == .changes { self.fail(note) }
        }
    }

    private func receiveSnapshot(_ message: ControlMessage) {
        guard let id = message.string("requestId"), let request = snapshotRequests.removeValue(forKey: id) else { return }
        snapshotTimeouts.removeValue(forKey: id)?.cancel()
        let snapshot = message.fields["snapshot"]?.mapValue.flatMap(ReviewSnapshotInfo.init(map:))
        if case .legacyList = request.purpose {
            guard id == repositoriesRequest else { return }
            repositoriesRequest = nil
            guard let snapshot else {
                apply(repositories: [], note: Self.reviewError(message.string("error") ?? "Host 没有返回改动"))
                return
            }
            let repository = ReviewRepositoryInfo(legacy: snapshot)
            apply(repositories: [repository], note: nil)
            return
        }
        guard request.generation == generation else { return }
        stopProgress()
        guard let snapshot else { fail("无法读取改动：\(Self.reviewError(message.string("error") ?? "未知错误"))"); return }
        switch request.purpose {
        case .overview(let repository):
            guard legacyHost || snapshot.repositoryPath == repository else {
                fail("Host 版本过旧，无法显示这个仓库。请更新 Host。"); return
            }
            let touched = Set(repositories.first { $0.repositoryPath == repository }?.touched ?? [])
            label.stringValue = "\(snapshot.repository) · \(snapshot.repositoryPath)"
            codeView.show(DiffDocument.repository(snapshot, touched: touched, title: snapshot.repository))
            show(codeView)
        case .file(let repository, let path):
            guard legacyHost || snapshot.repositoryPath == repository else {
                fail("Host 版本过旧，无法显示这个仓库。请更新 Host。"); return
            }
            guard let file = snapshot.files.first(where: { $0.path == path }) else {
                fail("这个文件已经没有未提交的改动，请刷新列表。"); return
            }
            changeFile = file
            changeTouched = repositories.first { $0.repositoryPath == repository }?.touched.contains(path) ?? false
            label.stringValue = "\(DiffDocument.statusTitle(file.status)) · \(file.oldPath.map { "\($0) → " } ?? "")\(file.path)"
            setDetailModes(file.isPrivate ? [] : ["差异", "文件"], selected: 0)
            codeView.show(DiffDocument.file(file, touched: changeTouched))
            show(codeView)
        case .legacyList: break
        }
    }

    private func loadChange(repository: String, path: String) {
        let file = repositories.first { $0.repositoryPath == repository }?.files.first { $0.path == path }
        // A changed picture is compared, not diffed.
        if let file, file.binary, !file.isPrivate, FilePreviewContent.isImage(path) {
            changeFile = file
            label.stringValue = "\(DiffDocument.statusTitle(file.status)) · \(path)"
            expectedImages = []
            if !["added", "untracked"].contains(file.status) {
                expectedImages.insert(.before)
                startDownload(path: absolute(file.oldPath ?? path, in: repository), revision: ReviewProtocol.headRevision, purpose: .before)
            }
            if file.status != "deleted" {
                expectedImages.insert(.after)
                startDownload(path: absolute(path, in: repository), revision: nil, purpose: .after)
            }
            return
        }
        requestSnapshot(.file(repository: repository, path: path), repository: repository, path: path)
    }

    private func showImagesIfReady() {
        guard expectedImages.allSatisfy({ images[$0] != nil }) else { return }
        stopProgress()
        var versions: [ImageVersion] = []
        let name = changeFile.map { ($0.path as NSString).lastPathComponent } ?? "image"
        if expectedImages.contains(.before) {
            versions.append(ImageVersion(title: "修改前 · 已提交", name: name, data: images[.before]?.data, note: images[.before]?.note))
        }
        if expectedImages.contains(.after) {
            let title = expectedImages.contains(.before) ? "修改后 · 工作区" : "新增 · 工作区"
            versions.append(ImageVersion(title: title, name: name, data: images[.after]?.data, note: images[.after]?.note))
        }
        imageView.show(versions)
        show(imageView)
    }

    private func absolute(_ path: String, in repository: String) -> String {
        (repository as NSString).appendingPathComponent(path)
    }

    private func openLink(_ url: URL) {
        guard let path = DiffDocument.path(from: url), let repository = currentRepositoryPath else { return }
        guard let node = changeRoots.first(where: {
            if case .repository(let info) = $0.kind { return info.repositoryPath == repository }; return false
        })?.children.first(where: {
            if case .change(_, let file, _) = $0.kind { return file.path == path }; return false
        }) else { select(.change(repository: repository, path: path)); return }
        let row = changesOutline.row(forItem: node)
        if row >= 0 { changesOutline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false); changesOutline.scrollRowToVisible(row) }
    }

    // MARK: - Connection

    func clientIsReady(_ client: TermbridgeClient) {
        guard client === self.client else { return }
        ready = true
        connectTimeout?.cancel(); connectTimeout = nil
        if mode == .files { loadFileRoot() }
        if mode == .changes || repositoriesLoadedAt == nil { loadRepositories() }
        resumeDetail()
    }

    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard client === self.client else { return }
        switch state {
        case .failed, .disconnected:
            let busy = !downloads.isEmpty || !snapshotRequests.isEmpty
            disconnect(); treeStatus.stringValue = "Host 已断开，请重新打开。"
            if busy { fail("无法连接 Host，请检查连接后重新打开。") }
        default: break
        }
    }

    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard client === self.client else { return }
        if message.type == "error" {
            if !downloads.isEmpty { fail("Host 暂不支持文件预览，请更新 Host 后重试。") }
            return
        }
        guard message.string("sessionId") == sessionID else { return }
        switch message.type {
        case "session_directory_result": receiveDirectory(message)
        case "session_file_result": receiveChunk(message)
        case ReviewProtocol.repositoriesResult: receiveRepositories(message)
        case "review_snapshot_result": receiveSnapshot(message)
        default: break
        }
    }

    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}

    // MARK: - Outline data

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if outlineView === changesOutline { return (item as? ChangeNode)?.children.count ?? (item == nil ? changeRoots.count : 0) }
        if let node = item as? WorkspaceFileNode { return node.children?.count ?? 0 }
        return root == nil ? 0 : 1
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if outlineView === changesOutline { return (item as? ChangeNode)?.children[index] ?? changeRoots[index] }
        return (item as? WorkspaceFileNode)?.children?[index] ?? root!
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        if let node = item as? ChangeNode { return !node.children.isEmpty }
        return (item as? WorkspaceFileNode)?.directory == true
    }

    func outlineView(_ outlineView: NSOutlineView, shouldExpandItem item: Any) -> Bool {
        if let node = item as? WorkspaceFileNode { loadChildren(node) }; return true
    }

    func outlineView(_ outlineView: NSOutlineView, shouldSelectItem item: Any) -> Bool {
        if let node = item as? ChangeNode, case .note = node.kind { return false }
        return true
    }

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        if let node = item as? ChangeNode { return ChangeCell(node.kind) }
        guard let node = item as? WorkspaceFileNode else { return nil }
        let cell = NSTableCellView()
        let icon = NSImageView(image: NSImage(systemSymbolName: node.directory ? "folder" : "doc", accessibilityDescription: nil)!)
        let text = NSTextField(labelWithString: node.name); text.lineBreakMode = .byTruncatingMiddle
        let stack = NSStackView(views: [icon, text]); stack.spacing = 6; stack.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(stack); cell.textField = text
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
            stack.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -4), stack.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 16), cell.heightAnchor.constraint(greaterThanOrEqualToConstant: 26)])
        return cell
    }

    func outlineViewSelectionDidChange(_ notification: Notification) {
        guard !selectingProgrammatically, let view = notification.object as? NSOutlineView, view.selectedRow >= 0 else { return }
        if view === changesOutline {
            guard let node = view.item(atRow: view.selectedRow) as? ChangeNode else { return }
            switch node.kind {
            case .repository(let repository): select(.repository(repository.repositoryPath))
            case .change(let repository, let file, _): select(.change(repository: repository.repositoryPath, path: file.path))
            case .touched(let repository, let path): select(.file(path: absolute(path, in: repository.repositoryPath), line: nil))
            case .note: break
            }
            return
        }
        guard let node = view.item(atRow: view.selectedRow) as? WorkspaceFileNode, !node.directory else { return }
        select(.file(path: node.path, line: nil))
    }
}

private extension ReviewRepositoryInfo {
    /// A Host without `review_repositories`: its one working-directory repository.
    init(legacy snapshot: ReviewSnapshotInfo) {
        self.init(repository: snapshot.repository, repositoryPath: snapshot.repositoryPath, branch: snapshot.branch,
                  detached: snapshot.detached, current: true, files: snapshot.files, changedFileCount: snapshot.changedFileCount,
                  additions: snapshot.additions, deletions: snapshot.deletions, truncated: snapshot.truncated,
                  touched: [], touchedTruncated: false, error: nil)
    }
}

/// A repository header or one changed file in the changes list.
private final class ChangeCell: NSTableCellView {
    init(_ kind: ChangeNode.Kind) {
        super.init(frame: .zero)
        let stack = NSStackView(); stack.spacing = 6; stack.alignment = .centerY
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 2),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3),
        ])
        switch kind {
        case .repository(let repository):
            let icon = NSImageView(image: NSImage(systemSymbolName: "folder.fill", accessibilityDescription: nil)!)
            icon.contentTintColor = .controlAccentColor
            let name = NSTextField(labelWithString: repository.repository)
            name.font = .systemFont(ofSize: 13, weight: .semibold)
            let detail = NSTextField(labelWithString: repositoryDetail(repository))
            detail.font = .systemFont(ofSize: 11); detail.textColor = .secondaryLabelColor
            detail.lineBreakMode = .byTruncatingTail
            detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let text = NSStackView(views: [name, detail]); text.orientation = .vertical; text.alignment = .leading; text.spacing = 1
            stack.addArrangedSubview(icon); stack.addArrangedSubview(text)
            textField = name
            toolTip = repository.repositoryPath
            setAccessibilityLabel("仓库 \(repository.repository)，\(repositoryDetail(repository))")
        case .change(_, let file, let touched):
            let status = NSTextField(labelWithString: DiffDocument.statusLetter(file.status))
            status.font = .monospacedSystemFont(ofSize: 11, weight: .bold)
            status.textColor = DiffDocument.statusColor(file.status)
            let name = fileName(file.path)
            stack.addArrangedSubview(status); stack.addArrangedSubview(name)
            let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            stack.addArrangedSubview(spacer)
            if file.isPrivate {
                stack.addArrangedSubview(small("私密", .tertiaryLabelColor))
            } else if file.binary {
                stack.addArrangedSubview(small(FilePreviewContent.isImage(file.path) ? "图片" : "二进制", .tertiaryLabelColor))
            } else {
                if file.additions > 0 { stack.addArrangedSubview(small("+\(file.additions)", .systemGreen)) }
                if file.deletions > 0 { stack.addArrangedSubview(small("−\(file.deletions)", .systemRed)) }
            }
            if touched {
                let dot = NSImageView(image: NSImage(systemSymbolName: "circle.fill", accessibilityDescription: "本次对话改过")!)
                dot.symbolConfiguration = .init(pointSize: 6, weight: .regular)
                dot.contentTintColor = .controlAccentColor
                dot.toolTip = "本次对话改过"
                stack.addArrangedSubview(dot)
            }
            textField = name.arrangedSubviews.first as? NSTextField
            toolTip = (file.oldPath.map { "\($0) → " } ?? "") + file.path + " · " + DiffDocument.statusTitle(file.status)
                + (touched ? " · 本次对话改过" : "") + (file.isPrivate ? " · 私密配置，内容不显示" : "")
            setAccessibilityLabel(toolTip)
        case .touched(_, let path):
            let status = NSTextField(labelWithString: "·")
            status.font = .monospacedSystemFont(ofSize: 11, weight: .bold); status.textColor = .tertiaryLabelColor
            let name = fileName(path)
            name.alphaValue = 0.75
            stack.addArrangedSubview(status); stack.addArrangedSubview(name)
            let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
            stack.addArrangedSubview(spacer)
            stack.addArrangedSubview(small("已提交或无差异", .tertiaryLabelColor))
            textField = name.arrangedSubviews.first as? NSTextField
            toolTip = "\(path) · 本次对话改过，当前没有未提交的改动"
            setAccessibilityLabel(toolTip)
        case .note(let text):
            let note = NSTextField(wrappingLabelWithString: text)
            note.font = .systemFont(ofSize: 11); note.textColor = .secondaryLabelColor
            stack.addArrangedSubview(note)
            textField = note
        }
    }

    required init?(coder: NSCoder) { nil }

    private func repositoryDetail(_ repository: ReviewRepositoryInfo) -> String {
        var parts = [repository.branch]
        parts.append(repository.changedFileCount == 0 ? "无改动" : "\(repository.changedFileCount) 个改动 +\(repository.additions) −\(repository.deletions)")
        if repository.current { parts.append("工作目录") }
        if !repository.touched.isEmpty { parts.append("本次对话改了 \(repository.touched.count) 个") }
        return parts.joined(separator: " · ")
    }

    private func fileName(_ path: String) -> NSStackView {
        let name = NSTextField(labelWithString: (path as NSString).lastPathComponent)
        name.lineBreakMode = .byTruncatingMiddle
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let directory = (path as NSString).deletingLastPathComponent
        let folder = NSTextField(labelWithString: directory)
        folder.font = .systemFont(ofSize: 11); folder.textColor = .tertiaryLabelColor
        folder.lineBreakMode = .byTruncatingHead
        folder.setContentCompressionResistancePriority(.defaultLow - 1, for: .horizontal)
        folder.isHidden = directory.isEmpty
        let stack = NSStackView(views: [name, folder]); stack.spacing = 5
        stack.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return stack
    }

    private func small(_ text: String, _ color: NSColor) -> NSTextField {
        let label = NSTextField(labelWithString: text)
        label.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        label.textColor = color
        label.setContentHuggingPriority(.required, for: .horizontal)
        label.setContentCompressionResistancePriority(.required, for: .horizontal)
        return label
    }
}
