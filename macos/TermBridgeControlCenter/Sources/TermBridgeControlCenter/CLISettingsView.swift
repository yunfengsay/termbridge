import SwiftUI

@MainActor
final class MacCLIInstaller: ObservableObject {
    static let shared = MacCLIInstaller()
    @Published private(set) var available: CLIInstallation.Available?
    @Published private(set) var runtime: CLIDiscovery.Runtime?
    @Published private(set) var busy = false
    @Published private(set) var status = "尚未检测"
    @Published private(set) var failed = false
    @Published private(set) var hostStatus = "尚未检测"
    @Published private(set) var commandExported = false
    private let installation: CLIInstallation
    private let appExtension: CLIAppExtension
    var embeddedVersion: String? { appExtension.version }
    var canRunHost: Bool { embeddedVersion != nil || available != nil }
    private var started = false
    private var checked = false
    init(home: URL = FileManager.default.homeDirectoryForCurrentUser, sourceEnvironment: [String: String]? = nil,
         bundle: URL = Bundle.main.bundleURL) {
        installation = CLIInstallation(home: home, sourceEnvironment: sourceEnvironment)
        appExtension = CLIAppExtension(installation: installation, bundle: bundle)
    }

    func start() {
        guard !started, Bundle.main.bundleURL.pathExtension == "app",
              Bundle.main.bundleIdentifier == "dev.termbridge.controlcenter" else { return }
        started = true
        // App startup never installs a command into the user's shell.
        commandExported = appExtension.isExported
        status = embeddedVersion == nil ? "App 内置运行环境不可用，请重新安装正式 App。" : "App 已内置 TB；添加命令行入口是可选操作。"
    }
    func checkIfNeeded() { if !checked { check() } }
    func check() {
        guard !busy else { return }; busy = true; checked = true; failed = false; status = "正在检测 TB CLI…"
        let installation = installation
        Task {
            let result = await Task.detached(priority: .utility) { installation.inspect() }.value
            available = result.cli; runtime = result.runtime
            commandExported = appExtension.isExported
            if result.runtime != nil { await MacBrowserConnection.prepare() }
            status = embeddedVersion != nil && result.cli == nil ? "App 内置 TB 已就绪，尚未添加终端命令入口。" : result.summary
            failed = embeddedVersion == nil && result.cli == nil && !result.problems.isEmpty
            busy = false
            refreshHostStatus()
        }
    }
    func exportCommand() {
        guard !busy else { return }; busy = true; failed = false
        status = "正在添加 App 内置命令…"
        let extensionCommand = appExtension
        Task {
            do {
                available = try await Task.detached(priority: .utility) { try extensionCommand.export() }.value
                commandExported = true
                status = "已添加。新开终端即可使用 tb；退出 App 后命令仍可运行。"
            } catch { failed = true; status = error.localizedDescription }
            busy = false
        }
    }
    func removeCommand() {
        guard !busy else { return }
        do { try appExtension.remove(); commandExported = false; available = nil; status = "已移除 App 命令入口，App 功能不受影响。" }
        catch { failed = true; status = error.localizedDescription }
    }
    func install(force: Bool = false) {
        guard !busy else { return }; busy = true; failed = false; status = "正在准备安装…"
        let installation = installation
        Task {
            do {
                available = try await Task.detached(priority: .utility) {
                    try installation.install(force: force) { progress in
                        Task { @MainActor in self.status = progress }
                    }
                }.value
                await MacBrowserConnection.prepare()
                status = "安装成功。新开一个终端即可使用 tb；已验证版本和终端组件。"
            } catch {
                failed = true
                status = (error as? CLIInstallationError)?.message ?? "安装未完成，请检查网络及用户目录权限后重试。"
            }
            busy = false; refreshHostStatus()
        }
    }
    func refreshHostStatus() {
        let env = installation.environment
        Task {
            let output = await Task.detached(priority: .utility) {
                try? CLICommand.run("/bin/launchctl", ["print", "gui/\(getuid())/com.termbridge.host"], environment: env, timeout: 5)
            }.value
            hostStatus = output?.contains("state = running") == true ? "本机 Host 正在运行" : "本机 Host 未运行"
        }
    }
    func installHost(restart: Bool = false) {
        guard !busy, canRunHost else { return }; busy = true; failed = false
        status = restart ? "正在重启本机 Host…" : "正在安装并启动本机 Host…"
        let executable: String
        var env = installation.environment
        var arguments = restart ? ["host", "restart"] : ["host", "start", "--login"]
        if embeddedVersion != nil {
            executable = appExtension.node.path
            arguments.insert(appExtension.entry.path, at: 0)
            env["TB_APP_BUNDLE"] = appExtension.bundle.path
        } else if let available {
            executable = available.path; env = installation.environment(for: available)
        } else { busy = false; return }
        Task {
            do {
                _ = try await Task.detached(priority: .utility) {
                    try CLICommand.run(executable, arguments, environment: env, timeout: 60)
                }.value
                status = restart ? "Host 重启命令已完成。" : "本机 Host 安装命令已完成。"
            } catch { failed = true; status = "Host 操作未完成，请先配置连接并检查 CLI 是否可用。" }
            busy = false; refreshHostStatus()
        }
    }
}

struct CLISettingsView: View {
    @ObservedObject var installer: MacCLIInstaller
    @ObservedObject var model: ControlCenterModel
    @State private var message: String?
    @State private var pairingCode: String?
    @State private var showPairing = false
    var body: some View {
        Form {
            Section("TB 命令行") {
                if let version = installer.embeddedVersion {
                    LabeledContent("App 内置版本", value: version)
                    Text("App 已包含完整运行环境，无需单独安装 TB、Node 或 npm。可选择将 tb 添加到终端 PATH；命令独立于 App 窗口运行，并随 App 更新。")
                        .font(.callout).foregroundStyle(.secondary)
                    HStack {
                        Button(installer.commandExported ? "修复命令行入口" : "添加到命令行") { installer.exportCommand() }
                            .accessibilityIdentifier("export-bundled-cli")
                        if installer.commandExported { Button("移除命令行入口") { installer.removeCommand() } }
                    }.disabled(installer.busy)
                }
                if let cli = installer.available {
                    LabeledContent("终端命令版本", value: cli.version)
                    Text(cli.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if let runtime = installer.runtime {
                    LabeledContent("Node", value: runtime.node.version)
                    Text(runtime.node.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if installer.busy { ProgressView().controlSize(.small) }
                Text(installer.status).foregroundStyle(installer.failed ? .orange : .secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("cli-install-status")
                HStack {
                    Button("检测 CLI") { installer.check() }
                    if installer.embeddedVersion == nil {
                        Button("安装独立 CLI") { installer.install(force: true) }.accessibilityIdentifier("install-cli")
                    }
                }.disabled(installer.busy)
                Text("检测不会更改现有命令或安装软件。App 的共享与中转服务不需要添加命令行入口。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("连接与配对") {
                if let profile = model.activeProfile {
                    LabeledContent("App 当前连接", value: profile.displayName)
                    Button("将当前连接用于 CLI") {
                        do {
                            try model.exportCLIConnection()
                            message = "CLI 已使用相同 Relay 和配对信息。多 Host 时使用 tb --host <Host ID> 选择目标。"
                        } catch { message = error.localizedDescription }
                    }.disabled(installer.busy)
                } else { Text("先在「连接与通知」添加连接或粘贴配对码，再同步给 CLI。") }
                Text("同步会更新 CLI 的默认 Relay 与配对信息，并备份原配置。已有 Host 在下次重启后使用新配置。")
                    .font(.caption).foregroundStyle(.secondary)
                if let message { Text(message).font(.callout).fixedSize(horizontal: false, vertical: true) }
            }
            Section("本机 Host") {
                Button("创建新配对并配置本机…") {
                    do { pairingCode = try model.createLocalCLIPairing(); showPairing = true; message = "新配对已写入 CLI 配置。" }
                    catch { message = "配对配置未完成，请检查连接存储与 CLI 配置文件权限。" }
                }.disabled(installer.busy)
                Text("创建手机可扫描的配对码，保存到 App 和 CLI，并备份原 CLI 配置。已有 Host 需重启后生效。")
                    .font(.caption).foregroundStyle(.secondary)
                Text(installer.hostStatus)
                Button("安装并启动本机 Host") { installer.installHost() }
                    .disabled(installer.busy || !installer.canRunHost)
                Button("重启 Host 并应用配置") { installer.installHost(restart: true) }
                    .disabled(installer.busy || !installer.canRunHost)
                Text("需要从手机或其他电脑访问这台 Mac 时启用。仅连接远端 Mac 时无需启动本机 Host。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).onAppear { installer.checkIfNeeded() }
        .sheet(isPresented: $showPairing, onDismiss: { pairingCode = nil }) {
            if let pairingCode { CLIPairingSheet(code: pairingCode) }
        }
    }
}
