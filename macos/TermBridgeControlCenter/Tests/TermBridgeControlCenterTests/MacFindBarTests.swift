import AppKit
import SwiftTerm
import XCTest
@testable import TermBridgeControlCenter

@MainActor
final class MacFindBarTests: XCTestCase {
    func testFindBarPresentDismissAndCountUpdates() {
        let bar = MacFindBarView(frame: NSRect(x: 0, y: 0, width: 320, height: 36))
        XCTAssertTrue(bar.isHidden)

        var lastQuery = ""
        var closed = false
        bar.onQueryChange = { query, _ in lastQuery = query }
        bar.onClose = { closed = true }

        bar.present(initialQuery: "error")
        XCTAssertFalse(bar.isHidden)
        XCTAssertEqual(bar.query, "error")
        XCTAssertEqual(lastQuery, "error")

        bar.updateCount(index: 2, total: 5)
        bar.dismiss()
        XCTAssertTrue(bar.isHidden)
        XCTAssertTrue(closed)
    }

    func testSwiftTermBufferSearchFindsMatchesAndClears() {
        let view = AttachmentTerminalView(frame: NSRect(x: 0, y: 0, width: 640, height: 320))
        view.feed(text: "hello world\r\nsecond line error\r\nthird line ERROR\r\n")

        let foundInsensitive = view.findNext("error", options: SearchOptions(caseSensitive: false), scrollToResult: false)
        XCTAssertTrue(foundInsensitive)
        let summaryInsensitive = view.searchMatchSummary("error", options: SearchOptions(caseSensitive: false))
        XCTAssertEqual(summaryInsensitive.total, 2)
        XCTAssertGreaterThanOrEqual(summaryInsensitive.index, 1)

        view.clearSearch()
        let foundSensitive = view.findNext("ERROR", options: SearchOptions(caseSensitive: true), scrollToResult: false)
        XCTAssertTrue(foundSensitive)
        let summarySensitive = view.searchMatchSummary("ERROR", options: SearchOptions(caseSensitive: true))
        XCTAssertEqual(summarySensitive.total, 1)
    }
}
