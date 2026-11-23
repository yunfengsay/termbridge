import SwiftUI
import AppKit

enum MacBrowserConnection {
    static func command(_ arguments: [String]) throws -> [String] {
        let installation = CLIInstallation(home: FileManager.default.homeDirectoryForCurrentUser)
        guard let node = installation.inspect().runtime?.node else { throw CLIInstallationError(message: "请先在命令行设置中安装 TB 运行环境。") }
        guard let entry = Bundle.main.resourceURL?.appendingPathComponent("Browser/bridge.mjs"), FileManager.default.fileExists(atPath: entry.path) else { throw CLIInstallationError(message: "此 App 缺少 Chrome 连接组件，请安装新版本。") }
        return [node.path, entry.path] + arguments
    }
    static func run(_ arguments: [String]) throws -> [String: Any] {
        let command = try command(arguments)
        let installation = CLIInstallation(home: FileManager.default.homeDirectoryForCurrentUser)
        let output = try CLICommand.run(command[0], Array(command.dropFirst()), environment: installation.environment, timeout: 25)
        guard let data = output.data(using: .utf8), let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CLIInstallationError(message: "Chrome 连接状态无法读取。") }
        return result
    }
    static func prepare() async {
        _ = await Task.detached(priority: .utility) { try? run(["install"]) }.value
    }
}

struct BrowserSettingsView: View {
    @State private var status = "正在检测…"
    @State private var busy = false
    @State private var checked = false
    private var extensionDirectory: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/browser/extension") }
    var body: some View {
        Form {
            Section("Chrome 插件") {
                Text(status).textSelection(.enabled)
                HStack {
                    Button("安装连接组件") { perform(install: true) }
                    Button("检测连接") { perform() }
                }.disabled(busy)
                HStack {
                    Button("打开插件目录") { NSWorkspace.shared.open(extensionDirectory) }
                    Button("打开 Chrome 扩展管理", action: openChrome)
                }
                Text("插件尚未上架商店：打开扩展管理，开启开发者模式，加载插件目录，然后在插件中开启浏览器协助。").font(.caption).foregroundStyle(.secondary)
                Text("开启后，已连接的 TB Agent 可以读取网页、输入、点击和管理标签页；在插件中关闭即可停止后续操作。").font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped).task { if !checked { perform() } }
    }
    private func openChrome() {
        guard let chrome = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome"), let url = URL(string: "chrome://extensions/") else { status = "请先安装 Chrome。"; return }
        NSWorkspace.shared.open([url], withApplicationAt: chrome, configuration: NSWorkspace.OpenConfiguration(), completionHandler: nil)
    }
    private func perform(install: Bool = false) {
        guard !busy else { return }; busy = true; checked = true
        Task {
            do {
                let result = try await Task.detached(priority: .utility) {
                    if install { _ = try MacBrowserConnection.run(["install"]) }
                    return try MacBrowserConnection.run(["status"])
                }.value
                status = result["connected"] as? Bool == true ? (result["enabled"] as? Bool == true ? "已连接 · 浏览器协助已开启" : "已连接 · 请在插件中开启协助") : (result["installed"] as? Bool == true ? "连接组件已安装 · 等待 Chrome 插件连接" : "尚未安装 Chrome 连接组件")
            } catch { status = error.localizedDescription }
            busy = false
        }
    }
}
