import AppKit
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

/// Opt-in native render loop: mounts the same conditional settings pages as the App.
final class SettingsSwitchPerformanceTests: XCTestCase {
    @MainActor func testRepeatedSettingsPageSwitches() async throws {
        guard ProcessInfo.processInfo.environment["TB_SETTINGS_PERF"] == "1" else { throw XCTSkip("Native settings performance probe") }
        _ = NSApplication.shared
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("tb-settings-perf-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let bin = directory.appendingPathComponent("bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        for (name, script) in [("zsh", "#!/bin/sh\nexec /bin/sh -c \"$2\"\n"), ("tb", "#!/bin/sh\necho 0.1.33\n")] {
            let file = bin.appendingPathComponent(name); try Data(script.utf8).write(to: file)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
        }
        let selection = SettingsProbeSelection()
        let model = ControlCenterModel(contextURL: directory.appendingPathComponent("context.json"), profiles: [], startServices: false)
        let installer = MacCLIInstaller(home: directory, sourceEnvironment: ["PATH": bin.path, "SHELL": bin.appendingPathComponent("zsh").path])
        let service = MacLANServices(runtimeURL: nil, storageDirectory: directory)
        let view = NSHostingView(rootView: SettingsSwitchProbe(selection: selection, model: model, installer: installer, service: service))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 710, height: 550), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = view; window.orderFront(nil)
        defer { window.orderOut(nil) }
        try await Task.sleep(for: .milliseconds(100))
        var results: [[String: Double]] = []
        for round in 0..<4 {
            for tab in [5, 1, 2, 3, 6] {
                let start = DispatchTime.now().uptimeNanoseconds
                selection.appeared = false; selection.value = tab
                // Drain deferred SwiftUI work, then force layout/display at the same native boundary.
                while !selection.appeared {
                    await Task.yield(); view.layoutSubtreeIfNeeded(); window.displayIfNeeded()
                    if DispatchTime.now().uptimeNanoseconds - start > 2_000_000_000 { XCTFail("Settings page did not appear"); break }
                }
                view.layoutSubtreeIfNeeded(); window.displayIfNeeded()
                let ms = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000
                results.append(["round": Double(round), "tab": Double(tab), "ms": ms])
                try await Task.sleep(for: .milliseconds(100))
            }
        }
        let data = try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys])
        let output = ProcessInfo.processInfo.environment["TB_SETTINGS_PERF_OUTPUT"] ?? "/tmp/termbridge-settings-lag/render-baseline.json"
        try data.write(to: URL(fileURLWithPath: output))
        print("SETTINGS_SWITCH_MS \(String(decoding: data, as: UTF8.self))")
        XCTAssertLessThan(results.dropFirst(5).map { $0["ms"]! }.max() ?? 0, 100, "Warm settings switches should finish within 100 ms")
    }
}

@MainActor private final class SettingsProbeSelection: ObservableObject {
    @Published var value = -1
    var appeared = false
}
private struct SettingsSwitchProbe: View {
    @ObservedObject var selection: SettingsProbeSelection
    let model: ControlCenterModel
    let installer: MacCLIInstaller
    let service: MacLANServices
    var body: some View {
        Group {
            if ProcessInfo.processInfo.environment["TB_SETTINGS_CACHE"] == "1" {
                SettingsPageHost(selection: selection.value, content: page)
            } else { page(selection.value) }
        }.onChange(of: selection.value) { _ in selection.appeared = true }
            .frame(width: 710, height: 550)
    }
    private func page(_ value: Int) -> AnyView {
        switch value {
        case 5: return AnyView(LANSettingsView(service: service, model: model))
        case 1: return AnyView(CLISettingsView(installer: installer, model: model))
        case 2: return AnyView(Form { AppUpdateSettingsView(updater: .shared) }.formStyle(.grouped))
        case 3: return AnyView(MacPeerSettingsView(service: model.peer, profiles: []))
        case 6: return AnyView(DiagnosticsSettingsView())
        default: return AnyView(Color.clear)
        }
    }
}
