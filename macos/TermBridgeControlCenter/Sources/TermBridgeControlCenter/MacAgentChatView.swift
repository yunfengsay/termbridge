import AppKit
import Combine
import WebKit

/// IME owns Enter until marked text has been committed. Shift+Enter is a newline.
final class MacChatTextView: NSTextView {
    // Injectable for native menu/paste tests without changing the user's clipboard.
    var imagePasteboard: NSPasteboard = .general
    var onSend: (() -> Void)?
    var onCompositionEnd: (() -> Void)?
    /// Images from a paste or a drop. Text paste falls through to AppKit.
    var onImages: (([TerminalImageSource]) -> Void)?

    override var readablePasteboardTypes: [NSPasteboard.PasteboardType] {
        [.fileURL, .png, .tiff] + super.readablePasteboardTypes
    }

    override func readSelection(from pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        let images = MacChatAttachmentReader.sources(from: pboard)
        guard !images.isEmpty else { return super.readSelection(from: pboard, type: type) }
        onImages?(images)
        return true
    }

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if item.action == #selector(paste(_:)), MacChatAttachmentReader.hasImages(imagePasteboard) {
            return isEditable && onImages != nil
        }
        return super.validateUserInterfaceItem(item)
    }

    override func keyDown(with event: NSEvent) {
        let isReturn = [36, 76].contains(event.keyCode)
        // While the IME holds marked text, Return belongs to the candidate
        // window — committing a word must never also send the message.
        guard isReturn, !hasMarkedText() else { super.keyDown(with: event); return }
        // Only the modifiers that change what Return means. Caps Lock and the
        // numeric keypad both show up in the raw flags, and comparing against
        // those made Return stop sending whenever Caps Lock was on or the key
        // came from the keypad.
        let modifiers = event.modifierFlags.intersection([.command, .shift, .control, .option])
        // Plain Return sends; Cmd+Return is the explicit send. Shift+Return is a
        // newline, and Control or Option with Return is neither — those reach
        // AppKit's own bindings rather than quietly sending a message.
        if modifiers.isEmpty || modifiers == .command { onSend?() } else { super.keyDown(with: event) }
    }

    override func paste(_ sender: Any?) {
        let sources = MacChatAttachmentReader.sources(from: imagePasteboard)
        // Only images are intercepted. Ordinary text, including something that
        // merely looks like a path, is pasted as the characters it is.
        if sources.isEmpty { super.paste(sender) } else { onImages?(sources) }
    }

    override var acceptsFirstResponder: Bool { true }

    override func unmarkText() {
        super.unmarkText()
        onCompositionEnd?()
    }

    /// The types a Finder drop actually arrives as.
    ///
    /// Overriding `draggingEntered`/`performDragOperation` is not enough: AppKit
    /// only routes a drag to a view that has registered for one of its types,
    /// and a plain-text `NSTextView` registers none of these — dropping a
    /// screenshot on the composer did nothing at all. Added to whatever the
    /// text view registered for itself, so dragging text in still behaves the
    /// way it does everywhere else.
    /// `.string` is here because a bare `NSTextView` registers nothing at all:
    /// dragging selected text onto the composer was as dead as dragging a
    /// screenshot. Non-image drags are handed to AppKit, which inserts them.
    static let draggedImageTypes: [NSPasteboard.PasteboardType] = [.fileURL, .png, .tiff, .string]

    /// Declaring an initializer stops AppKit's own from being inherited, so
    /// each one is listed and each one ends up registered. `init(frame:)` is
    /// the one that builds the whole text system — funnelling it into
    /// `init(frame:textContainer:)` with a nil container leaves a text view
    /// that silently drops everything assigned to `string`.
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        registerChatDraggedTypes()
    }

    override init(frame frameRect: NSRect, textContainer: NSTextContainer?) {
        super.init(frame: frameRect, textContainer: textContainer)
        registerChatDraggedTypes()
    }

    convenience init() { self.init(frame: .zero) }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        registerChatDraggedTypes()
    }

    private func registerChatDraggedTypes() {
        registerForDraggedTypes(registeredDraggedTypes + Self.draggedImageTypes)
    }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        MacChatAttachmentReader.sources(from: sender).isEmpty ? super.draggingEntered(sender) : .copy
    }
    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        MacChatAttachmentReader.sources(from: sender).isEmpty ? super.draggingUpdated(sender) : .copy
    }
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let sources = MacChatAttachmentReader.sources(from: sender)
        guard !sources.isEmpty else { return super.performDragOperation(sender) }
        onImages?(sources)
        return true
    }
}

@MainActor
final class MacAgentChatView: NSView, NSTextViewDelegate, WKNavigationDelegate {
    let web: WKWebView
    let composer = MacChatTextView()
    var onOpenWebURL: ((URL) -> Void)?
    private let session: MacAgentChatSession
    /// Shown only when something is actually wrong. There is no standing line.
    private let notice = NSTextField(labelWithString: "")
    private let card = NSView()
    private let scroll = NSScrollView()
    private let attachButton = NSButton()
    private let sendButton = NSButton()
    private let slashButton = NSButton()
    /// Native terminal owns the real provider's command catalogue and picker.
    var onNativeCommands: ((String) -> Void)?
    private let thumbnails: NSStackView = {
        let stack = NSStackView(); stack.spacing = 6; stack.orientation = .horizontal; return stack
    }()
    let attachments: TerminalAttachments
    private var composerHeight: NSLayoutConstraint!
    private var thumbnailHeight: NSLayoutConstraint!
    private var noticeHeight: NSLayoutConstraint!
    private lazy var picker: NSOpenPanel = {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.item]
        return panel
    }()
    private let handler = MacChatScriptHandler()
    private var observations: Set<AnyCancellable> = []
    private var ready = false
    var onFailure: ((String) -> Void)?
    var onReady: (() -> Void)?

    static var resourceURL: URL? {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("TermBridgeControlCenter_TermBridgeControlCenter.bundle")
        let bundle = packaged.flatMap(Bundle.init(url:)) ?? Bundle.module
        return bundle.url(forResource: "index", withExtension: "html", subdirectory: "AgentChat")
    }

    init(session: MacAgentChatSession) {
        self.session = session
        // The chat view has no attached terminal, so the queue uploads through
        // the conversation's own subscription rather than saving a local file.
        attachments = TerminalAttachments(sessionID: session.conversationID, remote: true)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(handler, name: "agentChat")
        web = WKWebView(frame: .zero, configuration: config)
        super.init(frame: .zero)
        wantsLayer = true
        handler.receive = { [weak self] in self?.receive($0) }
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.setAccessibilityLabel("Agent 对话记录")

        composer.isRichText = false
        composer.isAutomaticQuoteSubstitutionEnabled = false
        composer.isAutomaticDashSubstitutionEnabled = false
        composer.font = .systemFont(ofSize: 14)
        composer.textColor = .textColor
        composer.insertionPointColor = .textColor
        composer.textContainerInset = NSSize(width: 8, height: 8)
        composer.isVerticallyResizable = true
        composer.isHorizontallyResizable = false
        composer.autoresizingMask = [.width]
        composer.textContainer?.widthTracksTextView = true
        composer.delegate = self
        composer.setAccessibilityLabel("Agent 消息输入")
        composer.setAccessibilityIdentifier("agent-chat-composer")
        composer.onSend = { [weak self] in self?.send() }
        scroll.documentView = composer
        scroll.contentView.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(composerWidthChanged),
            name: NSView.frameDidChangeNotification, object: scroll.contentView)
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.autohidesScrollers = true

        // One surface for text, attachments and actions, in the window's own
        // appearance rather than a fixed dark box.
        card.wantsLayer = true
        card.layer?.cornerRadius = 11
        card.layer?.borderWidth = 1
        card.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
        card.layer?.borderColor = NSColor.separatorColor.cgColor
        composer.backgroundColor = .clear
        composer.drawsBackground = false

        notice.font = .systemFont(ofSize: 11)
        notice.textColor = .systemOrange
        notice.lineBreakMode = .byTruncatingTail
        notice.isHidden = true

        for (button, symbol, help, action) in [
            (attachButton, "paperclip", "添加图片或文件", #selector(chooseImages)),
            (sendButton, "arrow.up.circle.fill", "发送 · Enter 发送，Shift+Enter 换行", #selector(send)),
        ] as [(NSButton, String, String, Selector)] {
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: help)
            button.bezelStyle = .accessoryBarAction
            button.isBordered = false
            button.imageScaling = .scaleProportionallyDown
            button.toolTip = help
            button.setAccessibilityLabel(help)
            button.target = self
            button.action = action
        }
        sendButton.wantsLayer = true
        sendButton.layer?.cornerRadius = 17
        sendButton.contentTintColor = .white
        sendButton.image = NSImage(systemSymbolName: "arrow.up", accessibilityDescription: "发送")?
            .withSymbolConfiguration(.init(pointSize: 21, weight: .semibold))
        attachButton.image = attachButton.image?.withSymbolConfiguration(.init(pointSize: 18, weight: .regular))
        sendButton.setAccessibilityIdentifier("agent-chat-send")
        attachButton.setAccessibilityIdentifier("agent-chat-attach")

        slashButton.title = "/ 命令"
        slashButton.bezelStyle = .accessoryBarAction
        slashButton.isBordered = false
        slashButton.target = self
        slashButton.action = #selector(openNativeCommands)
        slashButton.toolTip = "在此会话的原生终端搜索、选择 Claude/Codex 命令；不自动执行"
        slashButton.setAccessibilityIdentifier("agent-chat-slash")
        let tools = NSStackView(views: [attachButton, slashButton, NSView(), sendButton])
        tools.spacing = 6
        tools.orientation = .horizontal
        tools.setHuggingPriority(.defaultLow, for: .horizontal)

        for view in [web, notice, card] {
            view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view)
        }
        for view in [thumbnails, scroll, tools] {
            view.translatesAutoresizingMaskIntoConstraints = false; card.addSubview(view)
        }
        composerHeight = scroll.heightAnchor.constraint(equalToConstant: Self.minComposerHeight)
        thumbnailHeight = thumbnails.heightAnchor.constraint(equalToConstant: 0)
        noticeHeight = notice.heightAnchor.constraint(equalToConstant: 0)
        thumbnails.isHidden = true
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: leadingAnchor), web.trailingAnchor.constraint(equalTo: trailingAnchor),
            web.topAnchor.constraint(equalTo: topAnchor), web.bottomAnchor.constraint(equalTo: notice.topAnchor, constant: -2),
            notice.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
            notice.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
            notice.bottomAnchor.constraint(equalTo: card.topAnchor, constant: -4), noticeHeight,
            card.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            card.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            card.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
            thumbnails.topAnchor.constraint(equalTo: card.topAnchor, constant: 8),
            thumbnails.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 8),
            thumbnails.trailingAnchor.constraint(lessThanOrEqualTo: card.trailingAnchor, constant: -8),
            thumbnailHeight,
            scroll.topAnchor.constraint(equalTo: thumbnails.bottomAnchor, constant: 4),
            scroll.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 4),
            scroll.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -4),
            composerHeight,
            tools.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 2),
            tools.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 8),
            tools.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -8),
            tools.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -6),
            tools.heightAnchor.constraint(equalToConstant: 34),
            sendButton.widthAnchor.constraint(equalToConstant: 34),
            sendButton.heightAnchor.constraint(equalToConstant: 34),
            attachButton.widthAnchor.constraint(equalToConstant: 32),
            attachButton.heightAnchor.constraint(equalToConstant: 32),
        ])

        composer.onImages = { [weak self] in self?.attach($0) }
        // Choosing an image only needs the conversation to accept images at
        // all; sending it needs the subscription to have been answered.
        // Selection is local draft state, not an upload. A first handshake,
        // busy Agent or an older Host must not silently discard pasted images.
        attachments.isConnected = { true }
        attachments.canUpload = { [weak session] in session?.canAttach == true }
        attachments.upload = { [weak session] id, image in session?.upload(id: id, image: image) == true }
        attachments.onChange = { [weak self] in self?.refresh() }
        session.onUploadResult = { [weak self] in self?.attachments.receive($0); self?.refresh() }
        session.onUploadExpired = { [weak self] in self?.attachments.expire($0); self?.refresh() }
        session.onConnectionLost = { [weak self] in self?.attachments.connectionLost(); self?.refresh() }
        session.onUploadsAllowed = { [weak self] in self?.attachments.uploadsAllowed(); self?.refresh() }

        applyAppearance()
        session.onSurface = { [weak self] in self?.render($0) }
        session.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.refresh() }
        }.store(in: &observations)
        refresh()
    }

    required init?(coder: NSCoder) { nil }

    func load() {
        guard let url = Self.resourceURL else { onFailure?("对话界面资源缺失，请重新安装 App"); return }
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    func focusComposer() { window?.makeFirstResponder(composer) }

    func textDidChange(_ notification: Notification) {
        session.composer.draft = composer.string
        refresh()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyAppearance()
    }

    /// The transcript's own page background, so the window reads as one surface.
    ///
    /// The renderer paints `--tb-bg` from `packages/agent-chat-ui/src/styles.ts`
    /// and the composer sits directly under it; leaving the native half on the
    /// system window colour put a visible seam across the middle of the window.
    /// `MacAgentChatSurfaceTests` reads the packaged CSS and fails if these
    /// drift apart.
    static func surfaceBackground(dark: Bool) -> NSColor {
        dark ? NSColor(srgbRed: 0x16 / 255, green: 0x16 / 255, blue: 0x18 / 255, alpha: 1)
             : NSColor(srgbRed: 0xfb / 255, green: 0xfb / 255, blue: 0xfd / 255, alpha: 1)
    }

    private func applyAppearance() {
        let dark = effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        session.theme = dark ? "dark" : "light"
        layer?.backgroundColor = Self.surfaceBackground(dark: dark).cgColor
        effectiveAppearance.performAsCurrentDrawingAppearance {
            card.layer?.backgroundColor = NSColor.textBackgroundColor.cgColor
            card.layer?.borderColor = NSColor.separatorColor.cgColor
            sendButton.layer?.backgroundColor = NSColor.controlAccentColor.withAlphaComponent(sendButton.isEnabled ? 1 : 0.45).cgColor
        }
    }

    override func layout() {
        super.layout()
        applyAppearance()
    }

    /// A narrower window rewraps the draft, so the card has to be measured again
    /// even though nobody typed.
    ///
    /// Driven by the clip view's own frame change rather than from `layout()`:
    /// during this view's layout pass the scroll view has not been sized yet, so
    /// the draft was still measured against the previous width and the height
    /// arrived a pass late — and changing a constraint mid-pass is what made it
    /// late. Only the composer is re-measured; calling the whole refresh here
    /// would push the pending receipt and rebuild the thumbnails on every pass,
    /// which is a loop with the WebKit view in it.
    @objc private func composerWidthChanged() {
        let width = wrapWidth
        guard width > 0, abs(width - lastComposerWidth) > 0.5 else { return }
        lastComposerWidth = width
        resizeComposer()
    }

    private var lastComposerWidth: CGFloat = 0

    /// The width the draft actually wraps at.
    private var wrapWidth: CGFloat { scroll.contentView.bounds.width }

    @objc private func send() {
        // A click while the IME still holds a candidate would send a half-typed
        // word; the candidate belongs to the input method until it is committed.
        guard !composer.hasMarkedText() else { return }
        if Self.nativeSlashQuery(composer.string) != nil, onNativeCommands != nil {
            openNativeCommands(); return
        }
        guard canSubmit else { return }
        // References are appended by the send itself, once, and only when every
        // image already has a Host path. Nothing here claims the Agent has read
        // them: that is a separate fact the transcript will show or not.
        //
        // The queue is cleared only if the message was actually written. A
        // refusal keeps both the draft and the images, so a retry sends the same
        // message rather than one whose pictures have been thrown away — and the
        // references are never appended twice.
        if session.send(appending: attachments.references) { attachments.clear() }
        refresh()
        focusComposer()
    }

    static let minComposerHeight: CGFloat = 34
    static let maxComposerHeight: CGFloat = 170

    nonisolated static func nativeSlashQuery(_ text: String) -> String? {
        guard text.utf8.count <= 128, text.range(of: "^/[a-zA-Z0-9:_-]*\\z", options: .regularExpression) != nil else { return nil }
        return text
    }

    @objc private func openNativeCommands() {
        guard !composer.hasMarkedText() else { return }
        onNativeCommands?(Self.nativeSlashQuery(composer.string) ?? "/")
    }

    /// The height the card has settled on, for a layout fixture to assert.
    var composerHeightForTesting: CGFloat { composerHeight.constant }

    /// Grows with the text and stops at a cap, after which it scrolls.
    private func resizeComposer() {
        guard let container = composer.textContainer, let manager = composer.layoutManager else { return }
        // Wrap to the width the box actually has now. Without this the used
        // rect is still measured against the previous width, so a narrowed
        // window reports the old line count and the card keeps its old height.
        let width = wrapWidth
        if width > 0, abs(container.size.width - width) > 0.5 {
            container.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
            composer.frame.size.width = width
        }
        manager.ensureLayout(for: container)
        let used = manager.usedRect(for: container).height + composer.textContainerInset.height * 2
        let height = min(max(used, Self.minComposerHeight), Self.maxComposerHeight)
        guard abs(composerHeight.constant - height) > 0.5 else { return }
        composerHeight.constant = height
        // Past the cap the box stops growing and the text scrolls inside it, so
        // a long draft never eats the conversation above it.
        scroll.hasVerticalScroller = height >= Self.maxComposerHeight
    }

    /// The refusal from the window, if any. Nil hides the line entirely.
    func showNotice(_ reason: String?) {
        notice.stringValue = reason ?? ""
        notice.toolTip = reason
        notice.isHidden = reason == nil
        noticeHeight.constant = reason == nil ? 0 : 15
    }

    private func refresh() {
        if composer.string != session.composer.draft, !composer.hasMarkedText() {
            composer.string = session.composer.draft
            composer.setSelectedRange(NSRange(location: composer.string.utf16.count, length: 0))
        }
        resizeComposer()
        renderThumbnails()
        // A conversation that is simply working says so in the transcript, with
        // the shared indicator. Only a real problem earns a line here.
        let waitingForUpload = attachments.items.contains(where: { $0.state == .preparing }) && !session.canAttach
            ? "附件已保留，等待 Host 允许上传；若持续等待，请更新 Host。" : nil
        let needsFileHost = attachments.items.contains { if case .document = $0.source { return true }; return false }
            && session.canAttach && !session.supportsFileUploads
        let problem = session.unavailable ?? session.capabilities.degraded ?? attachments.error
            ?? (needsFileHost ? "此 Host 仅支持图片；普通文件需要更新 Host，附件已保留。" : waitingForUpload)
        showNotice(problem)
        attachButton.isEnabled = attachments.items.count < 6
        sendButton.isEnabled = canSubmit
        applyAppearance()
        slashButton.isEnabled = onNativeCommands != nil && session.capabilities.terminal
        // The receipt for a send belongs to the message it is about; it is
        // pushed into the transcript rather than repeated in a footer.
        session.pushPendingSend()
    }

    /// Every submit path shares this, and it asks about the message that will
    /// actually be sent — draft plus image references — not the draft alone.
    /// An image-only message is still a message: it obeys the pending receipt
    /// and the length limit like any other.
    private var canSubmit: Bool {
        // Every attachment must already have a Host path, or the text would
        // name images that never arrived.
        guard attachments.items.allSatisfy({ if case .ready = $0.state { return true } else { return false } }) else { return false }
        return session.canSend(payload: session.payload(appending: attachments.references))
    }

    private func renderThumbnails() {
        let existing = thumbnails.arrangedSubviews.compactMap { $0 as? MacChatThumbnail }
        if existing.map(\.id) != attachments.items.map(\.id) {
            existing.forEach { thumbnails.removeArrangedSubview($0); $0.removeFromSuperview() }
            for item in attachments.items {
                thumbnails.addArrangedSubview(MacChatThumbnail(item: item, remove: { [weak self] id in
                    self?.attachments.remove(id); self?.refresh()
                }, retry: { [weak self] id in
                    self?.attachments.retry(id); self?.refresh()
                }))
            }
        } else {
            for (view, item) in zip(existing, attachments.items) { view.apply(item) }
        }
        thumbnails.isHidden = attachments.items.isEmpty
        thumbnailHeight.constant = attachments.items.isEmpty ? 0 : 64
    }

    private func attach(_ sources: [TerminalImageSource]) {
        attachments.add(sources)
        refresh()
    }

    @objc private func chooseImages() {
        guard let window else { return }
        picker.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let self else { return }
            self.attach(self.picker.urls.map { MacChatAttachmentReader.isImage($0) ? .file($0) : .document($0) })
        }
    }

    func render(_ value: [String: Any]) {
        guard ready, JSONSerialization.isValidJSONObject(value),
              let bytes = try? JSONSerialization.data(withJSONObject: value),
              let json = String(data: bytes, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.termbridgeChat.receive(\(json))", completionHandler: nil)
    }

    private func receive(_ value: [String: Any]) {
        switch value["op"] as? String {
        case "ready": ready = true; session.surfaceReady(); onReady?()
        case "earlier":
            if let generation = value["generation"] as? Int, let cursor = value["cursor"] as? Int {
                session.loadEarlier(generation: generation, cursor: cursor)
            }
        case "copy":
            if let text = value["data"] as? String {
                NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
            }
        case "open":
            if let value = value["url"] as? String, let url = URL(string: value), ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                if let onOpenWebURL { onOpenWebURL(url) } else { NSWorkspace.shared.open(url) }
            }
        default: break
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // Only the bundled entry point may navigate. Transcript links use the typed bridge.
        decisionHandler(navigationAction.request.url == Self.resourceURL ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onFailure?("无法加载对话界面：\(error.localizedDescription)")
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { ready = false; load() }
}

private final class MacChatScriptHandler: NSObject, WKScriptMessageHandler {
    var receive: (([String: Any]) -> Void)?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let value = message.body as? [String: Any] else { return }
        receive?(value)
    }
}
