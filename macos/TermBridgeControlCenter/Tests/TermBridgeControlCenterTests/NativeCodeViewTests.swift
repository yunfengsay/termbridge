import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class NativeCodeViewTests: XCTestCase {
    @MainActor func testLargeDocumentLaysOutViewportAndCanJumpToLastLine() throws {
        _ = NSApplication.shared
        let view = CodeTextView(frame: NSRect(x: 0, y: 0, width: 900, height: 600))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        defer { window.close() }
        window.orderFront(nil)
        window.contentView?.layoutSubtreeIfNeeded()
        let source = String(repeating: "let value = 42 // source line\n", count: 100_000)
        let document = CodeDocument.source(source, language: .swift).0
        var timings: [Double] = []
        for _ in 0..<5 {
            view.show(CodeDocument(text: NSAttributedString(string: ""), gutter: nil))
            let start = CFAbsoluteTimeGetCurrent()
            view.show(document)
            view.textView.layoutManager.layoutLines()
            view.displayIfNeeded()
            timings.append((CFAbsoluteTimeGetCurrent() - start) * 1_000)
        }
        XCTAssertEqual(view.lineStarts.count, 100_000)
        XCTAssertLessThan(view.textView.subviews.count, 300, "The editor must reuse visible glyph views rather than create a view per line")
        let start = CFAbsoluteTimeGetCurrent()
        view.reveal(line: 99_999)
        view.textView.layoutManager.layoutLines()
        let jump = (CFAbsoluteTimeGetCurrent() - start) * 1_000
        XCTAssertEqual(view.textView.selectedRange().location, view.paragraphRange(99_999).location)
        XCTAssertGreaterThan(view.scrollView.contentView.bounds.minY, 1_000_000)
        XCTAssertLessThan(timings.max()!, 5_000, "A 100k-line document must not stall the UI for seconds")
        XCTAssertLessThan(jump, 1_000)
        print("CODE_EDITOR_BENCHMARK lines=100000 bytes=\(source.utf8.count) layoutMs=\(timings) jumpMs=\(jump) glyphViews=\(view.textView.subviews.count)")
    }

    @MainActor func testNativeFindBarSelectsMatchAndDocumentReplacementResetsScroll() async throws {
        _ = NSApplication.shared
        let view = CodeTextView(frame: NSRect(x: 0, y: 0, width: 720, height: 480))
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view
        defer { window.close() }
        window.orderFront(nil)
        view.show(CodeDocument.source("first\nfind_target\nlast", language: nil).0)
        view.showFind()
        window.contentView?.layoutSubtreeIfNeeded()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(view.scrollView.isFindBarVisible)
        let bar = try XCTUnwrap(view.scrollView.findBarView)
        let field = try XCTUnwrap(descendants(bar).compactMap { $0 as? NSSearchField }.first)
        field.stringValue = "find_target"
        field.sendAction(field.action, to: field.target)
        let next = NSMenuItem(); next.tag = NSTextFinder.Action.nextMatch.rawValue
        view.textView.performTextFinderAction(next)
        XCTAssertEqual(view.firstSelectedRange, NSRange(location: 6, length: 11))
        view.show(CodeDocument.source(String(repeating: "long", count: 1_000), language: nil).0)
        view.scrollView.contentView.scroll(to: NSPoint(x: 800, y: 0))
        view.show(CodeDocument.source("new document", language: nil).0)
        try await Task.sleep(nanoseconds: 100_000_000)
        let first = try XCTUnwrap(view.textView.layoutManager.rectForOffset(0))
        let clip = view.scrollView.contentView
        XCTAssertGreaterThanOrEqual(view.textView.convert(first, to: clip).minX, clip.bounds.minX)
    }

    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
}
