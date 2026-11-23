import AppKit
import Security
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

final class CLIImportViewTests: XCTestCase {
    @MainActor
    func testImportButtonSelectsAndFillsImportedConnection() throws {
        guard ProcessInfo.processInfo.environment["TB_MACOS_TEST_KEYCHAIN"] == "1" else {
            throw XCTSkip("Enable disposable Mac Keychain acceptance")
        }
        _ = NSApplication.shared
        // SwiftUI creates its accessibility tree lazily; enable it in this isolated test process.
        NSApp.accessibilitySetValue(true, forAttribute: NSAccessibility.Attribute(rawValue: "AXEnhancedUserInterface"))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let settings = directory.appendingPathComponent("settings.json")
        try Data(#"{"middle":"wss://cli-import.example.test","secret":"test-only"}"#.utf8).write(to: settings)
        let service = "dev.termbridge.test.import." + UUID().uuidString
        defer { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary) }
        let model = ControlCenterModel(contextURL: directory.appendingPathComponent("context.json"), profiles: [], startServices: false,
            connectionStore: MacConnectionStore(service: service), cliSettingsURL: settings)
        let view = NSHostingView(rootView: ConnectionSettingsView(model: model))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 710, height: 570),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = view
        window.orderFront(nil)
        defer { window.close() }
        view.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        let nodes = descendants(view)
        let button = try XCTUnwrap(nodes.first { $0.accessibilityLabel() == "导入 TB 命令行配置" || $0.accessibilityTitle() == "导入 TB 命令行配置" })
        XCTAssertTrue(button.accessibilityPerformPress())
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        XCTAssertEqual(model.activeProfile?.relayURL, "wss://cli-import.example.test")
        XCTAssertTrue(descendants(view).contains { ($0.accessibilityValue() as? String) == "wss://cli-import.example.test" }, "Import must populate the visible Relay field")
        XCTAssertTrue(descendants(view).contains { ($0.accessibilityValue() as? String) == "编辑连接" || $0.accessibilityLabel() == "编辑连接" })
        let importedID = model.activeProfileID
        XCTAssertTrue(button.accessibilityPerformPress())
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        XCTAssertEqual(model.activeProfileID, importedID)
        XCTAssertEqual(model.profiles.count, 1)
        XCTAssertEqual(try MacConnectionStore(service: service).load().first?.relayURL, "wss://cli-import.example.test")
        if let output = ProcessInfo.processInfo.environment["TB_MACOS_RENDER_DIR"] {
            let directory = URL(fileURLWithPath: output)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: directory.appendingPathComponent("cli-import.png"))
        }
        // Errors must be visible next to the button and preserve the imported profile.
        try Data("not-json".utf8).write(to: settings)
        XCTAssertTrue(button.accessibilityPerformPress())
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        XCTAssertEqual(model.activeProfileID, importedID)
        XCTAssertTrue(descendants(view).contains { ($0.accessibilityValue() as? String)?.contains("配置文件格式不正确") == true })
        XCTAssertTrue(descendants(view).contains { ($0.accessibilityValue() as? String) == "wss://cli-import.example.test" })
        // An explicitly selected custom file adds its connection without replacing an existing one.
        let custom = directory.appendingPathComponent("custom.json")
        try Data(#"{"middle":"wss://custom.example.test","secret":"another-test-key"}"#.utf8).write(to: custom)
        let selected = try model.importCLIConnection(from: custom)
        XCTAssertEqual(selected.relayURL, "wss://custom.example.test")
        XCTAssertEqual(selected.secret, "another-test-key")
        XCTAssertEqual(model.profiles.count, 2)
        XCTAssertTrue(model.profiles.contains { $0.id == importedID })
    }

    // SwiftUI accessibility nodes expose Objective-C selectors without adopting the full protocol.
    @MainActor
    private func descendants(_ object: Any) -> [AXNode] {
        guard let object = object as? NSObject else { return [] }
        let node = AXNode(object: object)
        return [node] + (node.get("accessibilityChildren") as? [Any] ?? []).flatMap { descendants($0) }
    }

    @MainActor
    private struct AXNode {
        let object: NSObject
        func get(_ name: String) -> Any? {
            let selector = NSSelectorFromString(name)
            guard object.responds(to: selector) else { return nil }
            return object.perform(selector)?.takeUnretainedValue()
        }
        func accessibilityLabel() -> String? { get("accessibilityLabel") as? String }
        func accessibilityTitle() -> String? { get("accessibilityTitle") as? String }
        func accessibilityValue() -> Any? { get("accessibilityValue") }
        func accessibilityPerformPress() -> Bool {
            let selector = NSSelectorFromString("accessibilityPerformPress")
            guard object.responds(to: selector) else { return false }
            typealias Action = @convention(c) (AnyObject, Selector) -> Bool
            return unsafeBitCast(object.method(for: selector), to: Action.self)(object, selector)
        }
    }
}
