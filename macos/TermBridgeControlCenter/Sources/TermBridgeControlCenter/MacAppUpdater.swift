import AppKit
import Combine
import Sparkle
import SwiftUI

/// One updater for the application, shared by Settings and the application menu.
/// Sparkle owns version comparison, scheduling, archive verification and replacement.
@MainActor
final class MacAppUpdater: NSObject, ObservableObject, SPUUpdaterDelegate {
    static let shared = MacAppUpdater()
    static let downloadURL = URL(string: "https://termbridge-a0k.pages.dev/#downloads")!
    @Published private(set) var canCheck = false
    @Published private(set) var automaticChecks = false
    @Published private(set) var automaticInstallation = false
    @Published private(set) var lastChecked: Date?
    @Published private(set) var status = "尚未检查更新"
    @Published private(set) var failed = false
    let version: String
    private var controller: SPUStandardUpdaterController?

    override init() {
        let info = Bundle.main.infoDictionary ?? [:]
        version = "\(info["CFBundleShortVersionString"] as? String ?? "开发版") (\(info["CFBundleVersion"] as? String ?? "—"))"
        super.init()
    }

    func start() {
        guard controller == nil else { return }
        // SwiftPM tests and unpackaged development executables have no update feed.
        guard Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") != nil else {
            status = "请安装正式版以使用应用内更新"; return
        }
        let controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        let updater = controller.updater
        updater.publisher(for: \.canCheckForUpdates).assign(to: &$canCheck)
        updater.publisher(for: \.automaticallyChecksForUpdates).assign(to: &$automaticChecks)
        updater.publisher(for: \.automaticallyDownloadsUpdates).assign(to: &$automaticInstallation)
        updater.publisher(for: \.lastUpdateCheckDate).assign(to: &$lastChecked)
        do { try updater.start() }
        catch { failed = true; status = "更新服务启动失败：\(error.localizedDescription)" }
    }

    func check() {
        guard canCheck, let controller else { return }
        failed = false; status = "正在检查更新…"
        controller.checkForUpdates(nil)
    }
    func setAutomaticChecks(_ enabled: Bool) {
        // Turning off checks also turns off unattended installation, so the two
        // switches never promise conflicting behavior. Sparkle persists both.
        if !enabled { controller?.updater.automaticallyDownloadsUpdates = false }
        controller?.updater.automaticallyChecksForUpdates = enabled
    }
    func setAutomaticInstallation(_ enabled: Bool) {
        if enabled { controller?.updater.automaticallyChecksForUpdates = true }
        controller?.updater.automaticallyDownloadsUpdates = enabled
    }
    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        failed = false; status = "发现新版本 \(item.displayVersionString)"
    }
    func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        failed = false; status = "当前已是最新版本"
    }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        // A no-update result is handled above; Sparkle also reports it as an error.
        if (error as NSError).domain == SUSparkleErrorDomain,
           (error as NSError).code == SUError.noUpdateError.rawValue { return }
        failed = true; status = "更新未完成：\(error.localizedDescription)"
    }
}

struct AppUpdateSettingsView: View {
    @ObservedObject var updater: MacAppUpdater
    var body: some View {
        Section("软件更新") {
            LabeledContent("当前版本", value: updater.version)
            Text(updater.status).foregroundStyle(updater.failed ? .orange : .secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("app-update-status")
            if let date = updater.lastChecked {
                Text("上次检查：\(date.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button("检查更新…") { updater.check() }.disabled(!updater.canCheck)
                    .accessibilityIdentifier("check-app-update")
                Link("打开下载页", destination: MacAppUpdater.downloadURL)
            }
            Toggle("自动检查更新", isOn: Binding(get: { updater.automaticChecks }, set: updater.setAutomaticChecks))
            Toggle("自动下载并在退出时安装", isOn: Binding(get: { updater.automaticInstallation }, set: updater.setAutomaticInstallation))
                .disabled(!updater.automaticChecks)
            Text("手动更新可立即安装并重启 App；自动安装默认关闭。更新只影响此 App，Host 和远端会话继续运行。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct CheckAppUpdateButton: View {
    @ObservedObject var updater: MacAppUpdater
    var body: some View {
        Button("检查更新…") { updater.check() }.disabled(!updater.canCheck)
    }
}
