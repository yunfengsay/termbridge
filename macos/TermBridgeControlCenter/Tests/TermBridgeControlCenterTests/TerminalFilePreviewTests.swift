import AppKit
import Quartz
import XCTest
@testable import TermBridgeControlCenter

final class TerminalFilePreviewTests: XCTestCase {
    @MainActor func testRealHostFilesModeLoadsWithoutOpeningFile() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let relay = env["TB_FILE_PREVIEW_TEST_RELAY"], let session = env["TB_FILE_PREVIEW_TEST_SESSION"] else {
            throw XCTSkip("Run scripts/test-desktop-files.ts --ui against an isolated Host")
        }
        _ = NSApplication.shared
        let browser = TerminalFilePreview.shared
        browser.close()
        browser.presentChanges(sessionID: session, settings: ConnectionSettings(relayURL: relay,
            hostID: "desktop-file-test", secret: "desktop-test-secret", tlsFingerprint: ""))
        defer { browser.close() }
        let window = try XCTUnwrap(browser.window)
        let tabs = try XCTUnwrap(descendants(window.contentView!).compactMap { $0 as? NSSegmentedControl }
            .first { $0.accessibilityLabel() == "改动或文件" })
        tabs.selectedSegment = 1
        _ = tabs.sendAction(tabs.action, to: tabs.target)
        let files = try XCTUnwrap(outline(in: window, label: "远端项目文件目录"))
        try await until { files.numberOfRows > 1 }
        let names = (0..<files.numberOfRows).compactMap {
            (files.view(atColumn: 0, row: $0, makeIfNecessary: true) as? NSTableCellView)?.textField?.stringValue
        }
        XCTAssertTrue(names.contains("reports"), "Files must load before any terminal file link is clicked")
        try await capture(window, "files-without-file-link")
        let folderRow = try XCTUnwrap(names.firstIndex(of: "reports"))
        files.expandItem(files.item(atRow: folderRow))
        func fileRow() -> Int? {
            (0..<files.numberOfRows).first {
                (files.view(atColumn: 0, row: $0, makeIfNecessary: true) as? NSTableCellView)?.textField?.stringValue == "second.txt"
            }
        }
        try await until { fileRow() != nil }
        files.selectRowIndexes(IndexSet(integer: try XCTUnwrap(fileRow())), byExtendingSelection: false)
        try await until { !browser.codeView.isHidden && browser.codeView.string == "Second remote file" }
        try await capture(window, "files-tree-selected")
    }

    @MainActor func testRealHostBrowserReusesWindowAndRevealsTree() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let relay = env["TB_FILE_PREVIEW_TEST_RELAY"], let session = env["TB_FILE_PREVIEW_TEST_SESSION"] else {
            throw XCTSkip("Run scripts/test-desktop-files.ts --ui against an isolated Host")
        }
        _ = NSApplication.shared
        let settings = ConnectionSettings(relayURL: relay, hostID: "desktop-file-test", secret: "desktop-test-secret", tlsFingerprint: "")
        let browser = TerminalFilePreview.shared
        browser.present(sessionID: session, path: "reports/large.md", settings: settings)
        defer { browser.close() }
        let window = try XCTUnwrap(browser.window)
        let split = try XCTUnwrap(window.contentViewController as? NSSplitViewController)
        let outline = try XCTUnwrap(outline(in: window, label: "远端项目文件目录"))
        let preview = try XCTUnwrap(descendants(window.contentView!).compactMap { $0 as? QLPreviewView }.first)
        func selectedName() -> String? {
            guard outline.selectedRow >= 0 else { return nil }
            return (outline.view(atColumn: 0, row: outline.selectedRow, makeIfNecessary: true) as? NSTableCellView)?.textField?.stringValue
        }
        // Markdown opens in the Tiptap preview by default, across all chunks.
        try await until { !browser.markdownView.isHidden && browser.markdownView.currentMarkdown.hasPrefix("# Remote preview") && selectedName() == "large.md" }
        XCTAssertGreaterThan(browser.markdownView.currentMarkdown.utf8.count, 128 * 1024)
        browser.present(sessionID: session, path: "reports/second.txt", settings: settings)
        XCTAssertTrue(browser.window === window)
        try await until { browser.codeView.string == "Second remote file" && selectedName() == "second.txt" }
        // Pictures go to Quick Look; moving on removes the temporary copy.
        browser.present(sessionID: session, path: "reports/chart.png", settings: settings)
        try await until { preview.previewItem?.previewItemURL?.lastPathComponent == "chart.png" && !preview.isHidden }
        let pictureURL = try XCTUnwrap(preview.previewItem?.previewItemURL ?? nil)
        browser.present(sessionID: session, path: "reports/second.txt", settings: settings)
        try await until { browser.codeView.string == "Second remote file" && preview.isHidden }
        XCTAssertFalse(FileManager.default.fileExists(atPath: pictureURL.path), "Old preview is removed after switching")
        let toggle = try XCTUnwrap(descendants(window.contentView!).compactMap { $0 as? NSButton }.first { $0.toolTip == "显示或收起目录树" })
        toggle.performClick(nil)
        try await until { split.splitViewItems[0].isCollapsed }
        toggle.performClick(nil)
        try await until { !split.splitViewItems[0].isCollapsed }
        let row = try XCTUnwrap((0..<outline.numberOfRows).first { row in
            (outline.view(atColumn: 0, row: row, makeIfNecessary: true) as? NSTableCellView)?.textField?.stringValue == "large.md"
        })
        outline.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        try await until { !browser.markdownView.isHidden && browser.markdownView.currentMarkdown.hasPrefix("# Remote preview") }
        if let workspace = env["TB_FILE_PREVIEW_TEST_WORKSPACE"] {
            let late = URL(fileURLWithPath: workspace).appendingPathComponent("reports/created-later.txt")
            try Data("created after the directory was cached".utf8).write(to: late)
            browser.present(sessionID: session, path: "reports/created-later.txt", settings: settings)
            try await until { browser.codeView.string == "created after the directory was cached" && selectedName() == "created-later.txt" }
        }
        browser.close()
        XCTAssertNil(preview.previewItem)
        browser.present(sessionID: session, path: "reports/second.txt", settings: settings)
        try await until { browser.codeView.string == "Second remote file" && selectedName() == "second.txt" }
        XCTAssertTrue(browser.window === window)
    }

    /// The conversation's repositories stacked in one list, each repository's
    /// overview, a file diff, a picture compared, and a committed file.
    @MainActor func testRealHostChangesStackRepositoriesWithDiffsAndImages() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let relay = env["TB_FILE_PREVIEW_TEST_RELAY"], let session = env["TB_FILE_PREVIEW_TEST_CHANGES_SESSION"],
              let workspace = env["TB_FILE_PREVIEW_TEST_WORKSPACE"] else {
            throw XCTSkip("Run scripts/test-desktop-files.ts --ui against an isolated Host")
        }
        _ = NSApplication.shared
        let settings = ConnectionSettings(relayURL: relay, hostID: "desktop-file-test", secret: "desktop-test-secret", tlsFingerprint: "")
        let browser = TerminalFilePreview.shared
        browser.presentChanges(sessionID: session, settings: settings)
        defer { browser.close() }
        let window = try XCTUnwrap(browser.window)
        let split = try XCTUnwrap(window.contentViewController as? NSSplitViewController)
        split.splitViewItems[0].isCollapsed = false
        let changes = try XCTUnwrap(outline(in: window, label: "这次对话涉及的 Git 改动"))
        try await until { browser.repositories.count == 2 && changes.numberOfRows > 2 }
        XCTAssertEqual(browser.repositories.map(\.repository), ["project", "other"])
        XCTAssertTrue(browser.repositories[0].current)
        XCTAssertEqual(Set(browser.repositories[1].touched), ["README.md", "docs/done.md"])
        func names() -> [String] {
            (0..<changes.numberOfRows).compactMap { (changes.view(atColumn: 0, row: $0, makeIfNecessary: true) as? NSTableCellView)?.textField?.stringValue }
        }
        func choose(_ name: String) throws {
            let row = try XCTUnwrap(names().firstIndex(of: name), "\(name) in \(names())")
            changes.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        }
        // Sections stack: each repository row is followed by its own files.
        let rows = names()
        let other = try XCTUnwrap(rows.firstIndex(of: "other"))
        XCTAssertEqual(rows.first, "project")
        XCTAssertTrue(Set(rows[1..<other]).isSuperset(of: ["app.ts", "logo.png", "new.md", "chart.png"]), "\(rows)")
        XCTAssertEqual(Array(rows[(other + 1)...]), ["README.md", "done.md"])
        // Rows fit the sidebar: counts at the end of a row are not clipped.
        let visibleWidth = try XCTUnwrap(changes.enclosingScrollView).contentView.bounds.width
        for row in 0..<changes.numberOfRows {
            let cell = try XCTUnwrap(changes.view(atColumn: 0, row: row, makeIfNecessary: true))
            XCTAssertLessThanOrEqual(cell.frame.maxX, visibleWidth + 1, "row \(row) fits the sidebar")
        }

        // The first repository opens on its overview.
        try await until { browser.codeView.string.contains("src/app.ts") && browser.codeView.string.contains("art/logo.png") }
        // A private file is listed with its note; its contents never reach the Mac.
        XCTAssertTrue(browser.codeView.string.contains(".env"))
        XCTAssertTrue(browser.codeView.string.contains(DiffDocument.privateNote))
        XCTAssertFalse(browser.codeView.string.contains("never-return-this"))
        try await capture(window, "changes-overview")

        try choose("app.ts")
        try await until {
            browser.codeView.string.contains("// A changed line") && browser.codeView.string.contains("hello ${name}")
                && !browser.codeView.string.contains("art/logo.png")
        }
        let editor = browser.codeView.textView
        editor.layoutManager.layoutLines()
        try await Task.sleep(nanoseconds: 500_000_000)
        let firstCharacter = try XCTUnwrap(editor.layoutManager.rectForOffset(0))
        let clip = browser.codeView.scrollView.contentView
        XCTAssertGreaterThanOrEqual(editor.convert(firstCharacter, to: clip).minX, clip.bounds.minX, "The beginning of every diff must be visible")
        try await capture(window, "changes-file-diff")
        if env["TB_FILE_PREVIEW_RENDER_DIR"] != nil {
            window.appearance = NSAppearance(named: .darkAqua)
            try await capture(window, "changes-file-diff-dark")
            window.appearance = nil
        }

        try choose(".env")
        try await until { browser.codeView.string.contains(DiffDocument.privateNote) && !browser.codeView.string.contains("src/app.ts") }
        XCTAssertFalse(browser.codeView.string.contains("never-return-this"))

        try choose("logo.png")
        func pictures() -> Int {
            descendants(browser.imageView).compactMap { $0 as? NSImageView }.filter { $0.image != nil && $0.image!.size.width > 0 }.count
        }
        try await until { !browser.imageView.isHidden && pictures() == 2 }
        try await capture(window, "changes-image")

        try choose("other")
        try await until { browser.codeView.string.contains("README.md") && browser.codeView.string.contains("edited by the Agent") }
        try choose("done.md")
        try await until { !browser.markdownView.isHidden && browser.markdownView.currentMarkdown.trimmingCharacters(in: .whitespacesAndNewlines) == "Committed by the Agent" }

        // A link with a line opens the file there.
        browser.present(sessionID: session, path: workspace + "/src/app.ts", settings: settings, line: 3)
        try await until { browser.codeView.string.contains("hi ${name}") && browser.mode == .files }
        let third = browser.codeView.paragraphRange(2)
        XCTAssertEqual(browser.codeView.textView.selectedRange().location, third.location, "line 3 is revealed")
        try await capture(window, "file-line")
    }

    @MainActor private func outline(in window: NSWindow, label: String) -> NSOutlineView? {
        descendants(window.contentView!).compactMap { $0 as? NSOutlineView }.first { $0.accessibilityLabel() == label }
    }
    private func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }

    @MainActor private func capture(_ window: NSWindow, _ name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["TB_FILE_PREVIEW_RENDER_DIR"] else { return }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        try await Task.sleep(nanoseconds: 400_000_000)
        let capture = Process(); capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        capture.arguments = ["-x", "-l", String(window.windowNumber), directory + "/" + name + ".png"]
        try capture.run(); capture.waitUntilExit()
    }
    @MainActor private func until(_ step: String = #function, line: Int = #line, _ predicate: () -> Bool) async throws {
        for _ in 0..<300 { if predicate() { return }; try await Task.sleep(nanoseconds: 50_000_000) }
        if let window = TerminalFilePreview.shared.window { try? await capture(window, "timeout-line-\(line)") }
        let shown = TerminalFilePreview.shared.codeView.string.prefix(120)
        throw NSError(domain: "FileBrowserAcceptance", code: line,
                      userInfo: [NSLocalizedDescriptionKey: "timed out waiting at line \(line); code view shows: \(shown)"])
    }

    func testFileClicksRemainInRemoteNamespace() {
        XCTAssertEqual(TerminalFileLink.parse("/Users/remote/work/report.pdf"), .file("/Users/remote/work/report.pdf"))
        XCTAssertEqual(TerminalFileLink.parse("file://remote/Users/remote/My%20Project/a.png#L12"), .file("/Users/remote/My Project/a.png", line: 12))
        XCTAssertEqual(TerminalFileLink.parse("src/main.swift:12:4"), .file("src/main.swift", line: 12))
        XCTAssertEqual(TerminalFileLink.parse("./README.md#L7"), .file("./README.md", line: 7))
        XCTAssertEqual(TerminalFileLink.parse("src/main.swift:0"), .file("src/main.swift"), "line 0 is not a line")
        XCTAssertEqual(TerminalFileLink.parse("~/project/chart.html"), .file("~/project/chart.html"))
        XCTAssertEqual(TerminalFileLink.parse("https://example.test/report"), .web(URL(string: "https://example.test/report")!))
        for link in ["javascript:alert(1)", "ssh://host/file", "data:text/html,test", "\u{1b}file.txt", ""] { XCTAssertNil(TerminalFileLink.parse(link)) }
    }
    func testChunkValidationRejectsUnsafeNamesAndIncompleteTransfers() {
        var fields: [String: MessagePackValue] = ["t": .string("session_file_result"), "name": .string("report.pdf"),
            "size": .int(3), "version": .string("v1"), "offset": .int(0), "data": .binary(Data([1, 2, 3])), "eof": .bool(true)]
        XCTAssertNotNil(SessionFileChunk(message: ControlMessage(fields: fields)))
        for name in ["../escape", "/tmp/escape", "..", "a\\b", "\nfile"] {
            var invalid = fields; invalid["name"] = .string(name)
            XCTAssertNil(SessionFileChunk(message: ControlMessage(fields: invalid)))
        }
        fields["eof"] = .bool(false)
        XCTAssertNil(SessionFileChunk(message: ControlMessage(fields: fields)))
        fields["data"] = .binary(Data()); fields["eof"] = .bool(false)
        XCTAssertNil(SessionFileChunk(message: ControlMessage(fields: fields)))
    }
}
