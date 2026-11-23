import AppKit
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

final class ViewLayoutTests: XCTestCase {
    @MainActor
    func testRenderConnectionTabsAndSettings() throws {
        guard let destination = ProcessInfo.processInfo.environment["TB_MACOS_RENDER_DIR"] else {
            throw XCTSkip("Set TB_MACOS_RENDER_DIR for AppKit layout snapshots")
        }
        _ = NSApplication.shared
        let directory = URL(fileURLWithPath: destination)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let context = directory.appendingPathComponent("context.json")
        try Data(#"{"generatedAt":1700000000000,"records":[]}"#.utf8).write(to: context)
        let profiles = [
            ConnectionSettings(relayURL: "ws://127.0.0.1:7400", hostID: "mini", secret: "", tlsFingerprint: "", hostName: "Mac mini · 局域网"),
            ConnectionSettings(relayURL: "wss://example.test", hostID: "mini", secret: "", tlsFingerprint: "", hostName: "Mac mini · 云端")
        ]
        let model = ControlCenterModel(contextURL: context, profiles: profiles, startServices: false)
        try capture(ControlCenterView(model: model), size: NSSize(width: 390, height: 520), to: directory.appendingPathComponent("tabs.png"))
        try capture(NewSessionView(creator: MacSessionCreation(profile: profiles[0], sourceName: "Mac mini")), size: NSSize(width: 460, height: 320), to: directory.appendingPathComponent("new-session.png"))
        try capture(ConnectionSettingsView(model: model), size: NSSize(width: 710, height: 610), to: directory.appendingPathComponent("settings.png"))
        try capture(MacPeerSettingsView(service: model.peer, profiles: profiles), size: NSSize(width: 710, height: 540), to: directory.appendingPathComponent("peer.png"))
        let extraRoot = directory.appendingPathComponent("多个开放目录 with spaces")
        try FileManager.default.createDirectory(at: extraRoot, withIntermediateDirectories: true)
        var grant = MacPeerPermission(enabled: true, root: directory.path, files: .ro)
        grant.roots.append(extraRoot.path)
        model.peer.setPermission(grant, for: profiles[0])
        try capture(MacPeerSettingsView(service: model.peer, profiles: profiles), size: NSSize(width: 710, height: 760), to: directory.appendingPathComponent("peer-multiple-roots.png"))
        try capture(CLISettingsView(installer: MacCLIInstaller(home: directory), model: model), size: NSSize(width: 710, height: 550), to: directory.appendingPathComponent("cli.png"))
        try capture(Form { AppUpdateSettingsView(updater: MacAppUpdater()) }.formStyle(.grouped), size: NSSize(width: 710, height: 510), to: directory.appendingPathComponent("updates.png"))
    }

    @MainActor
    private func capture<V: View>(_ view: V, size: NSSize, to url: URL) throws {
        let hosting = NSHostingView(rootView: view)
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = hosting
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: url)
    }
}
