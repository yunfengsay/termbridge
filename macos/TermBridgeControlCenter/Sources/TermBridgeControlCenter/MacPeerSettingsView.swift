import SwiftUI

struct MacPeerSettingsView: View {
    @ObservedObject var service: MacPeerService
    let profiles: [ConnectionSettings]
    @State private var selection: UUID?
    private var profile: ConnectionSettings? { profiles.first { $0.id == selection } ?? profiles.first { !$0.hostID.isEmpty } }

    var body: some View {
        Form {
            Section("让远端 Agent 使用这台 Mac") {
                Text("App 保持运行即可，不需要打开终端，也不依赖 CLI。关闭窗口仍可用；退出 App 会断开 Peer 并停止它执行中的命令。")
                    .font(.callout).foregroundStyle(.secondary)
                Text(service.configuration.deviceID).font(.caption).textSelection(.enabled)
                Text("App 与 CLI 独立授权。多个 App 窗口和重连共用此 ID；使用 tb peer list 查询，使用 --device 精确选择。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("选择授权的 Host") {
                ForEach(profiles.filter { !$0.hostID.isEmpty }) { item in
                    Button { selection = item.id } label: {
                        HStack { Text(item.displayName); Spacer(); if profile?.id == item.id { Image(systemName: "checkmark") } }
                    }.buttonStyle(.plain)
                }
                if let profile {
                    Text(service.statuses[MacPeerConfiguration.scope(profile)] ?? "等待连接").font(.caption).foregroundStyle(.secondary)
                } else { Text("请先添加连接，并等待发现具体 Host。") }
            }
            if let profile {
                Section("本机权限 · 仅限此 Host") {
                    Toggle("允许此 Host 使用本机工具", isOn: binding(\.enabled, profile))
                    MacPeerRootsEditor(service: service, profile: profile)
                        .id(MacPeerConfiguration.scope(profile))
                    Picker("文件权限", selection: binding(\.files, profile)) {
                        Text("关闭").tag(MacPeerPermission.FileAccess.off)
                        Text("只读").tag(MacPeerPermission.FileAccess.ro)
                        Text("读写").tag(MacPeerPermission.FileAccess.rw)
                    }.pickerStyle(.segmented)
                    Toggle("允许执行命令（完整的当前用户权限）", isOn: binding(\.execute, profile))
                    Text("目录限制只约束文件工具，不限制命令执行。开启命令权限后，远端 Agent 可以访问当前用户能访问的其他目录与资源。系统隐私权限仍需由你在 macOS 中授权。")
                        .font(.caption).foregroundStyle(.orange)
                    Button("撤销此 Host 的全部授权", role: .destructive) { service.setPermission(MacPeerPermission(), for: profile) }
                    Text("授权关闭时仍可发现设备，但不能读写文件或执行命令。撤销会停止正在执行的命令；已经写入的文件不会自动撤回。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = service.error { Text(error).foregroundStyle(.orange).textSelection(.enabled) }
        }.formStyle(.grouped)
    }
    private func binding<Value>(_ key: WritableKeyPath<MacPeerPermission, Value>, _ profile: ConnectionSettings) -> Binding<Value> {
        Binding(get: { service.permission(for: profile)[keyPath: key] }, set: { value in
            var next = service.permission(for: profile); next[keyPath: key] = value
            service.setPermission(next, for: profile)
        })
    }
}

private struct MacPeerRootsEditor: View {
    @ObservedObject var service: MacPeerService
    let profile: ConnectionSettings
    @State private var input = ""
    @State private var error: String?
    private var permission: MacPeerPermission { service.permission(for: profile) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("开放目录 · \(permission.roots.count)/32")
                Spacer()
                Button("选择多个目录…", systemImage: "folder.badge.plus") { chooseRoots() }
            }
            HStack {
                TextField("开放目录路径", text: $input, prompt: Text("例如 ~/Projects（无需引号）"))
                    .labelsHidden().accessibilityLabel("开放目录路径")
                    .textFieldStyle(.roundedBorder).onSubmit { add([input]) }
                Button("添加", systemImage: "plus") { add([input]) }.disabled(input.isEmpty)
            }
            ForEach(permission.roots, id: \.self) { path in
                HStack(alignment: .top) {
                    Image(systemName: "folder").foregroundStyle(.secondary)
                    Text(path).font(.caption).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if path == permission.root {
                        Text("默认").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Button("设为默认") {
                            var next = permission
                            next.roots = [path] + next.roots.filter { $0 != path }
                            service.setPermission(next, for: profile)
                        }.font(.caption)
                    }
                    Button(role: .destructive) { remove(path) } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.plain).help("移除该目录的授权")
                        .accessibilityLabel("移除 \(path)")
                }
            }
            if permission.roots.isEmpty { Text("尚未开放目录").font(.caption).foregroundStyle(.secondary) }
            Text("支持手输完整路径、空格与中文，或在选择器中多选。相对路径和命令默认使用第一项；其他目录使用绝对路径。移除最后一项会关闭文件和命令权限。")
                .font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).font(.caption).foregroundStyle(.orange) }
        }
    }

    private func add(_ paths: [String]) {
        var next = permission
        next.roots.append(contentsOf: paths)
        do {
            next = try next.validated()
            service.setPermission(next, for: profile)
            if service.permission(for: profile) == next { input = ""; error = nil }
        } catch { self.error = error.localizedDescription }
    }
    private func remove(_ path: String) {
        var next = permission
        next.roots.removeAll { $0 == path }
        if next.roots.isEmpty { next.files = .off; next.execute = false }
        service.setPermission(next, for: profile)
        error = nil
    }
    private func chooseRoots() {
        let panel = NSOpenPanel(); panel.title = "选择允许 Peer 文件工具访问的目录"
        panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        add(panel.urls.map(\.path))
    }
}
