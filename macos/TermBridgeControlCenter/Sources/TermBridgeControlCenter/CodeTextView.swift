import AppKit
import CodeEditTextView

/// Text for the code view, one entry per line in `gutter` and `backgrounds`.
struct CodeDocument {
    var text: NSAttributedString
    /// Gutter label per line; nil numbers lines from 1.
    var gutter: [String]?
    /// Full-width line background per line, for diffs and the jumped-to line.
    var backgrounds: [NSColor?] = []
    /// A line the document is about; it is scrolled to and marked.
    var focusLine: Int?

    static let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    static let maxCharacters = 4_000_000
    static let maxHighlightedCharacters = 1_000_000

    /// Source as the code view shows it: coloured when the language is known,
    /// plain otherwise. Very large text is cut, and the cut is said.
    static func source(_ text: String, language: CodeLanguage?, focusLine: Int? = nil) -> (CodeDocument, truncated: Bool) {
        var body = text.replacingOccurrences(of: "\r\n", with: "\n")
        var truncated = false
        let characters = body as NSString
        if characters.length > maxCharacters {
            // Cut on a whole character, never inside a surrogate pair.
            body = characters.substring(to: characters.rangeOfComposedCharacterSequence(at: maxCharacters).location)
            truncated = true
        }
        if body.hasSuffix("\n") { body.removeLast() }
        let storage = NSMutableAttributedString(string: body, attributes: [.font: font, .foregroundColor: NSColor.labelColor])
        if let language, body.utf16.count <= maxHighlightedCharacters {
            CodeHighlighter.apply(CodeHighlighter.tokens(body, language: language), to: storage, font: font)
        }
        return (CodeDocument(text: storage, gutter: nil, focusLine: focusLine), truncated)
    }
}

/// Native CoreText editor surface. Only visible lines are laid out by
/// CodeEditTextView; diff decorations and find stay native AppKit views.
@MainActor
final class CodeTextView: NSView, @preconcurrency NSTextFinderClient {
    let scrollView = NSScrollView()
    let textView = CodeSurface(string: "", font: CodeDocument.font, textColor: .labelColor,
                               wrapLines: false, isEditable: false, isSelectable: true)
    private let finder = NSTextFinder()
    private let decorations = CodeDecorations()
    private let gutter = CodeGutterView()
    private var gutterWidth: NSLayoutConstraint!
    private(set) var lineStarts: [Int] = [0]
    private var labels: [String]?
    private var backgrounds: [NSColor?] = []
    var onLink: ((URL) -> Void)?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        textView.allowsUndo = false
        textView.overscrollAmount = 0.15
        textView.textInsets = .init(left: 8, right: 8)
        textView.setAccessibilityLabel("文件内容")
        decorations.editor = textView
        decorations.backgrounds = { [weak self] line in
            guard let self, line < self.backgrounds.count else { return nil }
            return self.backgrounds[line]
        }
        textView.addSubview(decorations, positioned: .below, relativeTo: nil)
        let click = NSClickGestureRecognizer(target: self, action: #selector(openLink(_:)))
        click.delaysPrimaryMouseButtonEvents = false
        textView.addGestureRecognizer(click)
        textView.onFind = { [weak self] in self?.finder.performAction($0) }
        gutter.owner = self
        scrollView.documentView = textView
        scrollView.contentView.postsBoundsChangedNotifications = true
        scrollView.contentView.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(updateDecorations), name: NSView.boundsDidChangeNotification, object: scrollView.contentView)
        NotificationCenter.default.addObserver(self, selector: #selector(updateDecorations), name: NSView.frameDidChangeNotification, object: scrollView.contentView)
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = true
        scrollView.backgroundColor = .textBackgroundColor
        scrollView.automaticallyAdjustsContentInsets = false
        scrollView.contentInsets = NSEdgeInsetsZero
        gutter.translatesAutoresizingMaskIntoConstraints = false
        addSubview(gutter)
        gutterWidth = gutter.widthAnchor.constraint(equalToConstant: 40)
        finder.client = self
        finder.findBarContainer = scrollView
        // Selection-based find avoids drawing a second copy of editor glyphs.
        finder.isIncrementalSearchingEnabled = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(scrollView)
        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: topAnchor),
            gutter.topAnchor.constraint(equalTo: topAnchor),
            gutter.bottomAnchor.constraint(equalTo: bottomAnchor),
            gutter.leadingAnchor.constraint(equalTo: leadingAnchor),
            gutterWidth,
            scrollView.leadingAnchor.constraint(equalTo: gutter.trailingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }
    required init?(coder: NSCoder) { nil }

    var string: String { textView.string }
    func show(_ document: CodeDocument) {
        finder.noteClientStringWillChange()
        labels = document.gutter
        backgrounds = document.backgrounds
        textView.textStorage.setAttributedString(document.text)
        lineStarts = Self.lineStarts(of: document.text.string as NSString)
        gutter.update(lineCount: lineStarts.count, labels: labels)
        gutterWidth.constant = labels?.isEmpty == true ? 0 : gutter.ruleThickness
        textView.selectionManager.setSelectedRange(NSRange(location: 0, length: 0))
        textView.updateFrameIfNeeded()
        scrollView.contentView.scroll(to: .zero)
        scrollView.reflectScrolledClipView(scrollView.contentView)
        textView.needsDisplay = true
        if let line = document.focusLine { reveal(line: line) }
        updateDecorations()
    }

    func reveal(line: Int) {
        guard line >= 0, line < lineStarts.count else { return }
        if backgrounds.count < lineStarts.count { backgrounds += Array(repeating: nil, count: lineStarts.count - backgrounds.count) }
        backgrounds[line] = NSColor.findHighlightColor.withAlphaComponent(0.35)
        let range = paragraphRange(line)
        textView.selectionManager.setSelectedRange(NSRange(location: range.location, length: 0))
        scrollRangeToVisible(range)
        textView.needsDisplay = true
    }

    func paragraphRange(_ line: Int) -> NSRange {
        let start = lineStarts[line]
        let end = line + 1 < lineStarts.count ? lineStarts[line + 1] - 1 : textView.textStorage.length
        return NSRange(location: start, length: max(0, end - start))
    }

    func line(containing character: Int) -> Int {
        var low = 0, high = lineStarts.count - 1
        while low < high {
            let middle = (low + high + 1) / 2
            if lineStarts[middle] <= character { low = middle } else { high = middle - 1 }
        }
        return low
    }

    static func lineStarts(of text: NSString) -> [Int] {
        var starts = [0], location = 0
        while location < text.length {
            let found = text.range(of: "\n", options: .literal, range: NSRange(location: location, length: text.length - location))
            if found.location == NSNotFound { break }
            starts.append(found.location + 1)
            location = found.location + 1
        }
        return starts
    }

    @objc private func updateDecorations() {
        decorations.frame = textView.visibleRect
        decorations.needsDisplay = true
        gutter.needsDisplay = true
    }
    @objc private func openLink(_ gesture: NSClickGestureRecognizer) {
        guard gesture.state == .ended,
              let offset = textView.layoutManager.textOffsetAtPoint(gesture.location(in: textView)),
              offset < textView.textStorage.length,
              let url = textView.textStorage.attribute(.link, at: offset, effectiveRange: nil) as? URL else { return }
        onLink?(url)
    }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard !isHidden, event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              event.charactersIgnoringModifiers == "f" else { return super.performKeyEquivalent(with: event) }
        finder.performAction(.showFindInterface)
        return true
    }
    @objc func showFind() { finder.performAction(.showFindInterface) }
    @objc func findNext() { finder.performAction(.nextMatch) }
    @objc func findPrevious() { finder.performAction(.previousMatch) }

    // MARK: Native find bar (⌘F)
    override var isSelectable: Bool { true }
    var isEditable: Bool { false }
    var allowsMultipleSelection: Bool { false }
    var firstSelectedRange: NSRange { textView.selectedRange() }
    var selectedRanges: [NSValue] {
        get { [NSValue(range: firstSelectedRange)] }
        set { if let first = newValue.first { textView.selectionManager.setSelectedRange(first.rangeValue) } }
    }
    var visibleCharacterRanges: [NSValue] { textView.visibleTextRange.map { [NSValue(range: $0)] } ?? [] }
    func scrollRangeToVisible(_ range: NSRange) {
        guard let position = textView.layoutManager.textLineForOffset(range.location) else { return }
        let visible = scrollView.contentView.bounds
        let y = max(0, position.yPos - visible.height / 2)
        scrollView.contentView.scroll(to: NSPoint(x: 0, y: y))
        textView.layoutManager.layoutLines()
        if let rect = textView.layoutManager.rectForOffset(range.location) { textView.scrollToVisible(rect) }
        scrollView.reflectScrolledClipView(scrollView.contentView)
        updateDecorations()
    }
    func contentView(at index: Int, effectiveCharacterRange outRange: NSRangePointer) -> NSView {
        outRange.pointee = NSRange(location: 0, length: textView.textStorage.length)
        return textView
    }
    func rects(forCharacterRange range: NSRange) -> [NSValue]? {
        textView.layoutManager.rectForOffset(range.location).map { [NSValue(rect: $0)] }
    }
}

/// Native responder support around the open-source editor.
final class CodeSurface: CodeEditTextView.TextView {
    var onFind: ((NSTextFinder.Action) -> Void)?
    override func performTextFinderAction(_ sender: Any?) {
        onFind?(NSTextFinder.Action(rawValue: (sender as? NSMenuItem)?.tag ?? 1) ?? .showFindInterface)
    }

}

/// A viewport-sized background, behind reused glyph views. Never allocate a
/// layer the height of the whole document just to paint visible diff lines.
private final class CodeDecorations: NSView {
    weak var editor: CodeEditTextView.TextView?
    var backgrounds: ((Int) -> NSColor?)?
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func draw(_ dirtyRect: NSRect) {
        guard let editor, let first = editor.layoutManager.textLineForPosition(max(0, frame.minY)) else { return }
        var index = first.index
        while let line = editor.layoutManager.textLineForIndex(index), line.yPos < frame.maxY {
            if let color = backgrounds?(index) {
                color.setFill()
                NSRect(x: 0, y: line.yPos - frame.minY, width: bounds.width, height: line.height).fill()
            }
            index += 1
        }
    }
}

@MainActor
private final class CodeGutterView: NSView {
    private(set) var ruleThickness: CGFloat = 40
    weak var owner: CodeTextView?
    private var labels: [String]?
    private let font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    func update(lineCount: Int, labels: [String]?) {
        self.labels = labels
        let widest = labels?.max(by: { $0.count < $1.count }) ?? String(max(lineCount, 10))
        ruleThickness = ceil((widest as NSString).size(withAttributes: [.font: font]).width + 18)
        needsDisplay = true
    }
    override var isFlipped: Bool { true }
    override func draw(_ rect: NSRect) {
        guard let owner else { return }
        NSColor.textBackgroundColor.setFill(); bounds.fill()
        NSColor.separatorColor.setFill()
        NSRect(x: bounds.maxX - 1, y: rect.minY, width: 1, height: rect.height).fill()
        let editor = owner.textView
        let visible = editor.visibleRect
        guard let first = editor.layoutManager.textLineForPosition(max(0, visible.minY)) else { return }
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.secondaryLabelColor]
        var index = first.index
        while let line = editor.layoutManager.textLineForIndex(index), line.yPos < visible.maxY {
            let text = labels.map { index < $0.count ? $0[index] : "" } ?? String(index + 1)
            let y = convert(NSPoint(x: 0, y: line.yPos), from: editor).y
            let size = (text as NSString).size(withAttributes: attributes)
            (text as NSString).draw(at: NSPoint(x: ruleThickness - size.width - 8, y: y + (line.height - size.height) / 2), withAttributes: attributes)
            index += 1
        }
    }
}
