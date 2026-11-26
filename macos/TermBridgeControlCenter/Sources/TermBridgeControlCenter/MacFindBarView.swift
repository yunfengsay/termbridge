import AppKit
import WebKit

/// Shared AppKit responder actions for ⌘F / ⌘G / ⇧⌘G across terminal, chat, code preview, and browser windows.
@objc protocol TermBridgeFindResponder: AnyObject {
    @objc optional func showFindBar(_ sender: Any?)
    @objc optional func findNextMatch(_ sender: Any?)
    @objc optional func findPreviousMatch(_ sender: Any?)
}

/// Compact native macOS floating find bar anchored top-right of a terminal, chat, or browser surface.
@MainActor
final class MacFindBarView: NSView, NSTextFieldDelegate {
    var onQueryChange: ((String, Bool) -> Void)?
    var onFindNext: ((String, Bool) -> Void)?
    var onFindPrevious: ((String, Bool) -> Void)?
    var onClose: (() -> Void)?

    let field = NSTextField()
    private let background = NSVisualEffectView()
    private let icon = NSImageView()
    private let countLabel = NSTextField(labelWithString: "")
    private let caseButton = NSButton()
    private let previousButton = NSButton()
    private let nextButton = NSButton()
    private let closeButton = NSButton()
    private(set) var isCaseSensitive = false

    var query: String { field.stringValue }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.cornerRadius = 8
        layer?.masksToBounds = false
        shadow = NSShadow()
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.24
        layer?.shadowRadius = 10
        layer?.shadowOffset = NSSize(width: 0, height: -2)

        background.translatesAutoresizingMaskIntoConstraints = false
        background.material = .popover
        background.blendingMode = .withinWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 8
        background.layer?.masksToBounds = true
        background.layer?.borderWidth = 1
        background.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.6).cgColor
        addSubview(background)

        icon.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "查找")
        icon.contentTintColor = .secondaryLabelColor
        icon.translatesAutoresizingMaskIntoConstraints = false

        field.placeholderString = "查找…"
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 13)
        field.lineBreakMode = .byTruncatingHead
        field.usesSingleLineMode = true
        field.delegate = self
        field.setAccessibilityLabel("查找关键字")
        field.translatesAutoresizingMaskIntoConstraints = false

        countLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .medium)
        countLabel.textColor = .secondaryLabelColor
        countLabel.alignment = .right
        countLabel.isHidden = true
        countLabel.setContentHuggingPriority(.required, for: .horizontal)
        countLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        countLabel.translatesAutoresizingMaskIntoConstraints = false

        caseButton.title = "Aa"
        caseButton.font = .monospacedSystemFont(ofSize: 11, weight: .semibold)
        caseButton.bezelStyle = .recessed
        caseButton.setButtonType(.pushOnPushOff)
        caseButton.isBordered = true
        caseButton.toolTip = "区分大小写"
        caseButton.setAccessibilityLabel("区分大小写")
        caseButton.target = self
        caseButton.action = #selector(toggleCaseSensitivity)
        caseButton.translatesAutoresizingMaskIntoConstraints = false

        configureIconButton(previousButton, symbol: "chevron.up", tooltip: "上一个 · ⇧⌘G", action: #selector(triggerPrevious))
        configureIconButton(nextButton, symbol: "chevron.down", tooltip: "下一个 · ⌘G", action: #selector(triggerNext))
        configureIconButton(closeButton, symbol: "xmark", tooltip: "关闭 · Esc", action: #selector(triggerClose))

        let stack = NSStackView(views: [icon, field, countLabel, caseButton, previousButton, nextButton, closeButton])
        stack.orientation = .horizontal
        stack.alignment = .centerY
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(stack)

        NSLayoutConstraint.activate([
            background.topAnchor.constraint(equalTo: topAnchor),
            background.leadingAnchor.constraint(equalTo: leadingAnchor),
            background.trailingAnchor.constraint(equalTo: trailingAnchor),
            background.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.topAnchor.constraint(equalTo: background.topAnchor, constant: 6),
            stack.bottomAnchor.constraint(equalTo: background.bottomAnchor, constant: -6),
            stack.leadingAnchor.constraint(equalTo: background.leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: background.trailingAnchor, constant: -8),
            icon.widthAnchor.constraint(equalToConstant: 14),
            icon.heightAnchor.constraint(equalToConstant: 14),
            field.widthAnchor.constraint(greaterThanOrEqualToConstant: 170),
            field.widthAnchor.constraint(lessThanOrEqualToConstant: 240),
            caseButton.widthAnchor.constraint(equalToConstant: 26),
            caseButton.heightAnchor.constraint(equalToConstant: 22),
            previousButton.widthAnchor.constraint(equalToConstant: 22),
            previousButton.heightAnchor.constraint(equalToConstant: 22),
            nextButton.widthAnchor.constraint(equalToConstant: 22),
            nextButton.heightAnchor.constraint(equalToConstant: 22),
            closeButton.widthAnchor.constraint(equalToConstant: 22),
            closeButton.heightAnchor.constraint(equalToConstant: 22),
        ])
        isHidden = true
    }

    required init?(coder: NSCoder) { nil }

    private func configureIconButton(_ button: NSButton, symbol: String, tooltip: String, action: Selector) {
        button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: tooltip)
        button.bezelStyle = .texturedRounded
        button.isBordered = false
        button.imagePosition = .imageOnly
        button.contentTintColor = .secondaryLabelColor
        button.toolTip = tooltip
        button.setAccessibilityLabel(tooltip)
        button.target = self
        button.action = action
        button.translatesAutoresizingMaskIntoConstraints = false
    }

    func present(initialQuery: String? = nil) {
        if let initialQuery, !initialQuery.isEmpty {
            field.stringValue = initialQuery
        }
        isHidden = false
        window?.makeFirstResponder(field)
        field.currentEditor()?.selectAll(nil)
        if !field.stringValue.isEmpty {
            onQueryChange?(field.stringValue, isCaseSensitive)
        }
    }

    func dismiss() {
        guard !isHidden else { return }
        isHidden = true
        onClose?()
    }

    func updateCount(index: Int, total: Int) {
        let trimmed = field.stringValue
        if trimmed.isEmpty {
            countLabel.stringValue = ""
            countLabel.isHidden = true
            return
        }
        countLabel.isHidden = false
        if total <= 0 {
            countLabel.stringValue = "0/0"
            countLabel.textColor = .systemOrange
        } else {
            let shownIndex = max(1, min(index, total))
            countLabel.stringValue = "\(shownIndex)/\(total)"
            countLabel.textColor = .secondaryLabelColor
        }
    }

    func updateMatchStatus(found: Bool, hasQuery: Bool) {
        if !hasQuery {
            countLabel.stringValue = ""
            countLabel.isHidden = true
            return
        }
        countLabel.isHidden = false
        countLabel.stringValue = found ? "" : "无匹配"
        countLabel.textColor = found ? .secondaryLabelColor : .systemOrange
        if found { countLabel.isHidden = true }
    }

    func findNext() {
        guard !isHidden else { present(); return }
        let term = field.stringValue
        guard !term.isEmpty else { window?.makeFirstResponder(field); return }
        onFindNext?(term, isCaseSensitive)
    }

    func findPrevious() {
        guard !isHidden else { present(); return }
        let term = field.stringValue
        guard !term.isEmpty else { window?.makeFirstResponder(field); return }
        onFindPrevious?(term, isCaseSensitive)
    }

    @objc private func toggleCaseSensitivity() {
        isCaseSensitive = caseButton.state == .on
        if !field.stringValue.isEmpty {
            onQueryChange?(field.stringValue, isCaseSensitive)
        }
    }

    @objc private func triggerNext() { findNext() }
    @objc private func triggerPrevious() { findPrevious() }
    @objc private func triggerClose() { dismiss() }

    func controlTextDidChange(_ obj: Notification) {
        let term = field.stringValue
        if term.isEmpty {
            countLabel.stringValue = ""
            countLabel.isHidden = true
        }
        onQueryChange?(term, isCaseSensitive)
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
            dismiss()
            return true
        }
        if commandSelector == #selector(NSResponder.insertNewline(_:)) {
            let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) == true
            if shift { findPrevious() } else { findNext() }
            return true
        }
        return false
    }
}

/// Shared WKWebView find helper used by Agent Chat and the Proxy Browser.
@MainActor
enum MacWebViewFind {
    static func search(_ web: WKWebView, query: String, backwards: Bool, caseSensitive: Bool, completion: @escaping @MainActor (Bool) -> Void) {
        guard !query.isEmpty else {
            clear(web)
            completion(false)
            return
        }
        let config = WKFindConfiguration()
        config.backwards = backwards
        config.caseSensitive = caseSensitive
        config.wraps = true
        web.find(query, configuration: config) { result in
            Task { @MainActor in
                completion(result.matchFound)
            }
        }
    }

    static func clear(_ web: WKWebView) {
        web.evaluateJavaScript("window.getSelection()?.removeAllRanges()", completionHandler: nil)
    }
}
