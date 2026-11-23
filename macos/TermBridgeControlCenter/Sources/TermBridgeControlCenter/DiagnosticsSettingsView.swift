import SwiftUI
import UniformTypeIdentifiers

struct DiagnosticsSettingsView: View {
    @State private var result: String?
    @State private var exporting = false
    var body: some View {
        Form {
            Section("诊断日志") {
                Text("自动记录连接阶段、网络错误、配置保存和内网服务状态。保留今天及前两天的日志，过期自动删除；每天最多 8 MB，写满后覆盖最早的日志。")
                Text("不记录密码、配对码、终端内容或聊天内容。日志包含连接地址，方便定位网络问题。")
                    .font(.caption).foregroundStyle(.secondary)
                LabeledContent("日志目录") { Text(AppDiagnostics.directory.path).textSelection(.enabled) }
                HStack {
                    Button("打开日志文件夹") { NSWorkspace.shared.open(AppDiagnostics.directory) }
                    Button("导出日志…") { export() }.disabled(exporting)
                    if exporting { ProgressView().controlSize(.small) }
                }
                if let result { Text(result).textSelection(.enabled) }
                Text("重现一次问题后导出日志；客户端和作为内网服务的 Mac 都可分别导出。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
    }
    private func export() {
        let panel = NSSavePanel(); panel.title = "导出诊断日志"; panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "TermBridge-diagnostics.log"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        exporting = true
        Task { @MainActor in
            defer { exporting = false }
            do { try await AppDiagnostics.shared.export(to: url); result = "日志已导出。" }
            catch { result = "无法写入日志文件，请检查目录权限和磁盘空间。" }
        }
    }
}
