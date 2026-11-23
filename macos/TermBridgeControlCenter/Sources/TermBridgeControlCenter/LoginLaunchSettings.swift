import AppKit
import ServiceManagement
import SwiftUI

protocol LoginLaunchService: Sendable {
    func status() async -> SMAppService.Status
    func setEnabled(_ enabled: Bool) async throws
}

/// System calls run outside the UI actor. macOS owns the registration and its persisted state.
private actor SystemLoginLaunchService: LoginLaunchService {
    func status() -> SMAppService.Status { SMAppService.mainApp.status }
    func setEnabled(_ enabled: Bool) throws {
        let service = SMAppService.mainApp
        if enabled {
            if service.status != .enabled && service.status != .requiresApproval { try service.register() }
        } else if service.status == .enabled || service.status == .requiresApproval {
            try service.unregister()
        }
    }
}

@MainActor final class LoginLaunchSettings: ObservableObject {
    static let shared = LoginLaunchSettings()
    @Published private(set) var status: SMAppService.Status = .notRegistered
    @Published private(set) var loaded = false
    @Published private(set) var updating = false
    @Published private(set) var error: String?
    private let service: any LoginLaunchService
    private var revision = 0

    init(service: any LoginLaunchService = SystemLoginLaunchService()) { self.service = service }
    var requested: Bool { status == .enabled || status == .requiresApproval }
    var description: String {
        if !loaded { return "正在读取系统登录项…" }
        switch status {
        case .enabled: return "已开启，登录 Mac 后自动打开 TermBridge。"
        case .requiresApproval: return "需要在系统设置的「登录项与扩展」中允许 TermBridge。"
        case .notFound: return "尚未登记登录启动，开启后由系统管理。"
        case .notRegistered: return "未开启。"
        @unknown default: return "无法读取登录启动状态，请查看系统设置。"
        }
    }
    func refresh() async {
        guard !updating else { return }
        revision += 1; let current = revision
        let actual = await service.status()
        guard revision == current, !updating else { return }
        if status != actual { error = nil }
        status = actual; loaded = true
    }
    func setEnabled(_ enabled: Bool) async {
        guard !updating else { return }
        revision += 1; updating = true; error = nil
        defer { updating = false }
        do { try await service.setEnabled(enabled) }
        catch { self.error = "无法更改登录启动：\(error.localizedDescription)" }
        status = await service.status(); loaded = true
    }
    func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}

struct LoginLaunchSettingsView: View {
    @ObservedObject var settings: LoginLaunchSettings = .shared
    var body: some View {
        Toggle("登录 Mac 后自动启动", isOn: Binding(
            get: { settings.requested },
            set: { enabled in Task { await settings.setEnabled(enabled) } }
        ))
        .disabled(!settings.loaded || settings.updating)
        .accessibilityIdentifier("launch-at-login")
        .task { await settings.refresh() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await settings.refresh() }
        }
        if settings.updating { ProgressView().controlSize(.small) }
        Text(settings.description).font(.caption).foregroundStyle(.secondary)
            .accessibilityIdentifier("launch-at-login-status")
        if settings.status == .requiresApproval {
            Button("打开系统登录项设置") { settings.openSystemSettings() }
        }
        if let error = settings.error { Text(error).font(.caption).foregroundStyle(.red) }
    }
}
