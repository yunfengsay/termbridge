import AppKit

/// One attached image inside the composer card.
///
/// Preview, state and removal sit with the picture they belong to, in the same
/// surface as the text — not in a separate bar with an "insert into terminal"
/// action, which is the terminal's job and means something else.
@MainActor
final class MacChatThumbnail: NSView {
    let id: UUID
    private let preview = NSImageView()
    private let badge = NSTextField(labelWithString: "")
    private let close = NSButton()
    private let retryButton = NSButton()
    let progress = NSProgressIndicator()
    private let remove: (UUID) -> Void
    private let retry: (UUID) -> Void
    private var popover: NSPopover?

    init(item: TerminalAttachments.Item, remove: @escaping (UUID) -> Void, retry: @escaping (UUID) -> Void) {
        self.id = item.id
        self.remove = remove
        self.retry = retry
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 6
        layer?.borderWidth = 1

        preview.imageScaling = .scaleProportionallyUpOrDown
        preview.wantsLayer = true
        preview.layer?.cornerRadius = 5
        preview.layer?.masksToBounds = true
        badge.font = .systemFont(ofSize: 9)
        badge.textColor = .secondaryLabelColor
        badge.alignment = .center
        badge.lineBreakMode = .byTruncatingTail

        close.image = NSImage(systemSymbolName: "xmark.circle.fill", accessibilityDescription: "移除这张图片")
        close.isBordered = false
        close.bezelStyle = .accessoryBarAction
        close.target = self
        close.action = #selector(removeSelf)
        close.toolTip = "移除这张图片"

        retryButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: "重试上传")
        retryButton.isBordered = false
        retryButton.bezelStyle = .accessoryBarAction
        retryButton.target = self
        retryButton.action = #selector(retrySelf)
        retryButton.toolTip = "重试上传"

        progress.style = .spinning
        progress.controlSize = .small
        progress.isIndeterminate = true
        progress.isDisplayedWhenStopped = false
        progress.setAccessibilityLabel("附件处理中")
        for view in [preview, badge, close, retryButton, progress] {
            view.translatesAutoresizingMaskIntoConstraints = false; addSubview(view)
        }
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 60), heightAnchor.constraint(equalToConstant: 58),
            preview.topAnchor.constraint(equalTo: topAnchor, constant: 1),
            preview.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 1),
            preview.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -1),
            preview.bottomAnchor.constraint(equalTo: badge.topAnchor),
            badge.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 1),
            badge.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -1),
            badge.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -1),
            close.topAnchor.constraint(equalTo: topAnchor, constant: -2),
            close.trailingAnchor.constraint(equalTo: trailingAnchor, constant: 2),
            close.widthAnchor.constraint(equalToConstant: 14), close.heightAnchor.constraint(equalToConstant: 14),
            retryButton.centerXAnchor.constraint(equalTo: centerXAnchor),
            retryButton.centerYAnchor.constraint(equalTo: preview.centerYAnchor),
            retryButton.widthAnchor.constraint(equalToConstant: 16), retryButton.heightAnchor.constraint(equalToConstant: 16),
            progress.centerXAnchor.constraint(equalTo: preview.centerXAnchor),
            progress.centerYAnchor.constraint(equalTo: preview.centerYAnchor),
            progress.widthAnchor.constraint(equalToConstant: 16), progress.heightAnchor.constraint(equalToConstant: 16),
        ])
        let click = NSClickGestureRecognizer(target: self, action: #selector(togglePreview))
        preview.addGestureRecognizer(click)
        preview.toolTip = "点按可放大预览"
        apply(item)
    }

    /// Shows the picture at a readable size.
    ///
    /// Drawn from the bytes already encoded for upload, never by reading a path
    /// off disk: the preview must not become a way to open an arbitrary file.
    @objc private func togglePreview() {
        if let popover, popover.isShown { popover.close(); self.popover = nil; return }
        guard let image = preview.image else { return }
        let side: CGFloat = 320
        let scale = min(side / max(image.size.width, 1), side / max(image.size.height, 1), 1)
        let size = NSSize(width: max(image.size.width * scale, 80), height: max(image.size.height * scale, 80))
        let large = NSImageView(frame: NSRect(origin: .zero, size: size))
        large.image = image
        large.imageScaling = .scaleProportionallyUpOrDown
        let controller = NSViewController()
        controller.view = large
        let popover = NSPopover()
        popover.contentViewController = controller
        popover.contentSize = size
        popover.behavior = .transient
        popover.show(relativeTo: bounds, of: self, preferredEdge: .maxY)
        self.popover = popover
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.borderColor = NSColor.separatorColor.cgColor }
    }

    func apply(_ item: TerminalAttachments.Item) {
        effectiveAppearance.performAsCurrentDrawingAppearance { layer?.borderColor = NSColor.separatorColor.cgColor }
        if let attachment = item.image {
            preview.image = attachment.mime == "application/octet-stream"
                ? NSImage(systemSymbolName: "doc", accessibilityDescription: attachment.fileName)
                : NSImage(data: attachment.data)
        }
        badge.stringValue = item.state.badge
        badge.toolTip = item.state.label
        toolTip = item.state.label
        if let name = item.image?.fileName { toolTip = "\(name) · \(item.state.label)" }
        switch item.state {
        case .ready:
            progress.stopAnimation(nil)
            if let name = item.image?.fileName { badge.stringValue = name }
            badge.textColor = .secondaryLabelColor
        case .failed:
            progress.stopAnimation(nil)
            badge.textColor = .systemRed
        case .unknown:
            progress.stopAnimation(nil)
            // Neither claimed nor discarded: no retry, because the bytes may
            // already be on the Host and a second upload would duplicate them.
            badge.textColor = .systemOrange
        case .preparing, .uploading:
            progress.startAnimation(nil)
            badge.textColor = .secondaryLabelColor
            if item.state == .preparing, item.image != nil { badge.stringValue = "等待上传" }
        }
        retryButton.isHidden = !item.state.isRetryable
        setAccessibilityLabel("附件 · \(item.state.label)")
    }

    @objc private func removeSelf() { remove(id) }
    @objc private func retrySelf() { retry(id) }
}
