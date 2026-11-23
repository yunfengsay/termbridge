import AppKit
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

final class AgentListScrollingTests: XCTestCase {
    @MainActor
    func testScrollingAgentListDoesNotInstallPopupButtons() throws {
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let context = directory.appendingPathComponent("context.json")
        let records: [[String: Any]] = (0..<120).map { index in
            ["sessionId": "scroll-\(index)", "source": "herdr", "name": "Agent \(index)",
             "status": index.isMultiple(of: 3) ? "working" : "ready",
             "preview": String(repeating: "不同长度的会话摘要 ", count: index % 4 + 1),
             "lastSeenAt": 30, "statusChangedAt": 20, "present": true]
        }
        try JSONSerialization.data(withJSONObject: ["generatedAt": 1700000000000, "records": records]).write(to: context)
        let model = ControlCenterModel(contextURL: context, profiles: [], startServices: false)
        let hosting = NSHostingView(rootView: ControlCenterView(model: model))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 390, height: 520),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderBack(nil)
        defer { window.close() }
        hosting.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        // The captured hang repeatedly updated NSPopUpButton menu items during
        // lazy layout. Check the actual hosted controls, not a source-text match.
        XCTAssertFalse(descendants(of: hosting).contains { $0 is NSPopUpButton },
                       "Agent rows must not create popup adaptors while laying out or scrolling")
        let scroll = try XCTUnwrap(descendants(of: hosting).compactMap { $0 as? NSScrollView }
            .first { ($0.documentView?.frame.height ?? 0) > $0.contentView.bounds.height })
        var offsets: Set<Int> = []
        for step in 0..<30 {
            let document = try XCTUnwrap(scroll.documentView)
            let extent = max(0, document.frame.height - scroll.contentView.bounds.height)
            let fraction = CGFloat(step % 10) / 9
            let y = extent * (step / 10 % 2 == 0 ? fraction : 1 - fraction)
            scroll.contentView.scroll(to: NSPoint(x: 0, y: y))
            scroll.reflectScrolledClipView(scroll.contentView)
            if step.isMultiple(of: 3) { model.refresh() }
            hosting.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
            offsets.insert(Int(scroll.contentView.bounds.minY))
            XCTAssertFalse(descendants(of: hosting).contains { $0 is NSPopUpButton })
            XCTAssertTrue(document.frame.height.isFinite)
        }
        XCTAssertGreaterThan(offsets.count, 10, "The test must actually move through the list")
        XCTAssertEqual(model.agents.count, 120)
        if let destination = ProcessInfo.processInfo.environment["TB_MACOS_RENDER_DIR"] {
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
            hosting.layoutSubtreeIfNeeded()
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let output = URL(fileURLWithPath: destination)
            try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: output.appendingPathComponent("agent-list-scrolling.png"))
        }
    }

    @MainActor
    private func descendants(of view: NSView) -> [NSView] {
        view.subviews.flatMap { [$0] + descendants(of: $0) }
    }
}
