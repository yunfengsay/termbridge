import SwiftUI
import UniformTypeIdentifiers

struct ConnectionSettingsView: View {
    @ObservedObject var model: ControlCenterModel
    @State private var category = 0
    @State private var editingID: UUID?
    @State private var name = ""
    @State private var relay = ""
    @State private var direct = true
    @State private var useTLS = false
    @State private var port = "7400"
    @State private var checking = false
    @State private var probeTask: Task<Void, Never>?
    @State private var probeID = UUID()
    @State private var connectionResult: String?
    @State private var connectionFailed = false
    @State private var host = ""
    @State private var secret = ""
    @State private var fingerprint = ""
    @State private var pairing = ""
    @State private var message: String?
    @State private var removeID: UUID?
    @AppStorage("agentNotificationsEnabled") private var notifications = true
    @AppStorage("session.defaultUI") private var sessionUI = "auto"
    @AppStorage(SessionWindowMode.defaultsKey) private var windowMode = SessionWindowMode.standalone.rawValue

    var body: some View {
        VStack(spacing: 0) {
            Picker("设置分类", selection: $category) {
                Text("连接与通知").tag(0)
                Text("内网服务").tag(5)
                Text("命令行与 Host").tag(1)
                Text("软件更新").tag(2)
                Text("Peer").tag(3)
                Text("Chrome").tag(4)
                Text("诊断").tag(6)
            }.pickerStyle(.segmented).labelsHidden().frame(width: 650).padding(16)
            Divider()
            SettingsPageHost(selection: category, content: settingsPage)
        }.frame(width: 710, height: 610)
    }

    private func settingsPage(_ category: Int) -> AnyView {
        switch category {
        case 6: return AnyView(DiagnosticsSettingsView())
        case 5: return AnyView(LANSettingsView(service: .shared, model: model))
        case 4: return AnyView(BrowserSettingsView())
        case 3: return AnyView(MacPeerSettingsView(service: model.peer, profiles: model.profiles))
        case 2: return AnyView(Form { AppUpdateSettingsView(updater: .shared) }.formStyle(.grouped))
        case 1: return AnyView(CLISettingsView(installer: .shared, model: model))
        default: return AnyView(VStack(spacing: 0) {
                if model.loadingConnections {
                    ProgressView("正在读取钥匙串连接…内网服务可独立运行。请解锁 Mac 并处理钥匙串提示。")
                        .padding()
                }
                connectionSettings.disabled(model.loadingConnections)
            })
        }
    }

    private var connectionSettings: some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Text("连接源").font(.headline)
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("本机", systemImage: "desktopcomputer").foregroundStyle(.secondary)
                        ForEach(model.profiles) { profile in
                            Button { edit(profile) } label: {
                                HStack {
                                    Text(MacConnectionCatalog.tabTitle(profile, in: model.profiles)).lineLimit(2)
                                    Spacer()
                                    if editingID == profile.id { Image(systemName: "checkmark") }
                                }.padding(8)
                            }.buttonStyle(.plain)
                                .background(editingID == profile.id ? Color.accentColor.opacity(0.12) : .clear)
                                .cornerRadius(6)
                        }
                    }
                }
                Button("添加连接", systemImage: "plus") { reset() }
                Button("导入 TB 命令行配置") {
                    importCLI()
                }
                Button("选择配置文件…") { chooseCLIFile() }
                if let message {
                    Text(message).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                        .accessibilityIdentifier("connection-settings-message")
                }
                if model.activeProfileID != nil {
                    Text(model.phoneHubStatus).font(.callout)
                        .foregroundStyle(model.phoneHubOnline ? .green : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }.padding(20).frame(width: 210)
            Divider()
            ScrollView {
                Form {
                    if model.activeProfile != nil {
                        Section("当前连接拓扑") { ConnectionTopologyView(model: model) }
                    }
                    Section("\(editingID == nil ? "添加" : "编辑")连接") {
                        TextField("名称", text: $name)
                        Picker("连接方式", selection: Binding(get: { direct }, set: switchMode)) {
                            Text("内网直连").tag(true)
                            Text("服务器地址").tag(false)
                        }
                        TextField(direct ? "内网 IP" : "服务器地址", text: $relay)
                        if direct { TextField("端口", text: $port) }
                        TextField("Host ID", text: $host)
                        Text("Host ID 可留空，连接后自动发现 Mac。").font(.caption).foregroundStyle(.secondary)
                        SecureField("连接密码", text: $secret)
                        if direct {
                            Text("输入 IP、端口和密码即可直连。连接密码可在服务端复制。")
                                .font(.caption).foregroundStyle(.secondary)
                            DisclosureGroup("高级连接选项") {
                                Toggle("兼容旧版 TLS 服务", isOn: $useTLS)
                                if useTLS {
                                    TextField("已记住的 TLS 指纹", text: $fingerprint)
                                    Button("重新识别证书") {
                                        fingerprint = ""; connectionResult = "下次测试或连接时重新识别证书。"; connectionFailed = false
                                    }
                                }
                            }
                        } else { TextField("TLS 指纹（可选）", text: $fingerprint) }
                        HStack {
                            Button("测试连接") { testConnection(saveAfter: false) }.disabled(checking)
                                .accessibilityIdentifier("test-connection")
                            Button("保存") { saveOnly() }.accessibilityIdentifier("save-connection")
                            Button("保存并连接") { testConnection(saveAfter: true) }.disabled(checking).keyboardShortcut(.defaultAction)
                            if let editingID {
                                Button("删除连接", role: .destructive) { removeID = editingID }
                            }
                        }
                        if checking { ProgressView().controlSize(.small) }
                        if let connectionResult {
                            Text(connectionResult).foregroundStyle(connectionFailed ? .red : .secondary)
                                .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                                .accessibilityIdentifier("connection-test-result")
                        }
                        if connectionFailed {
                            Button("查看诊断日志") { category = 6 }
                        }
                    }
                    Section("从手机相同的配对码添加") {
                        SecureField("粘贴 tb1_ 配对码或配对链接", text: $pairing)
                        Button("解析配对码") {
                            do { edit(try PairingCode.parse(pairing)); editingID = nil; pairing = ""; message = "已解析，请保存并连接" }
                            catch { message = error.localizedDescription }
                        }
                    }
                    Section("启动") { LoginLaunchSettingsView() }
                    Section("通用") {
                        SessionWindowModePicker(selection: $windowMode)
                            .onChange(of: windowMode) { _ in model.applySessionWindowMode() }
                        Picker("默认会话界面", selection: $sessionUI) {
                            Text("自动选择").tag("auto")
                            Text("对话优先").tag("chat")
                            Text("终端优先").tag("terminal")
                        }
                        Text("自动选择会为支持的 Agent 打开对话，其它会话打开终端。仅影响这台设备之后打开的会话；已打开的窗口可用「显示」菜单中的「在对话中打开此会话」「在终端中打开此会话」就地切换，草稿和连接都会保留。")
                            .font(.caption).foregroundStyle(.secondary)
                        Toggle("Agent 完成或需要处理时通知", isOn: $notifications)
                            .onChange(of: notifications) { _ in model.refreshNotificationPreferences() }
                        NotificationPermissionView(coordinator: model.notifications)
                        Text("连接密码保存在这台 Mac 的钥匙串中。关闭终端窗口只断开连接，会话继续运行。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = model.settingsError { Text(error).foregroundStyle(.red) }
                }.formStyle(.grouped).disabled(checking)
            }.frame(minWidth: 420)
        }
        .onDisappear { cancelProbe() }
        .onAppear { model.refreshNotificationPreferences() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in model.refreshNotificationPreferences() }
        .background(Color(nsColor: .windowBackgroundColor))
        .confirmationDialog("删除此连接？远端会话会继续运行。", isPresented: Binding(
            get: { removeID != nil }, set: { if !$0 { removeID = nil } })) {
                Button("删除连接", role: .destructive) {
                    if let id = removeID {
                        do { try model.removeProfile(id); reset() } catch { message = error.localizedDescription }
                    }
                    removeID = nil
                }
        }
    }

    private func edit(_ profile: ConnectionSettings) {
        cancelProbe(); connectionResult = nil
        editingID = profile.id; name = profile.hostName; relay = profile.relayURL
        let url = URL(string: profile.relayURL)
        direct = profile.isDirectConnection
        useTLS = url?.scheme?.lowercased() == "wss"
        if direct { relay = url?.host ?? ""; port = String(url?.port ?? 7400) }
        host = profile.hostID; secret = profile.secret; fingerprint = profile.tlsFingerprint; message = nil
    }
    private func switchMode(_ value: Bool) {
        cancelProbe(); connectionResult = nil
        if value, LANConnection.isDirectEndpoint(relay), let url = URL(string: relay) {
            useTLS = url.scheme?.lowercased() == "wss"
            relay = url.host ?? ""; port = String(url.port ?? 7400)
        } else if !value, let endpoint = try? LANConnection.endpoint(address: relay, port: port, useTLS: useTLS) {
            relay = endpoint
        }
        direct = value
    }
    private func importCLI(from file: URL? = nil) {
        do {
            edit(try model.importCLIConnection(from: file))
            message = "已导入并选中连接。可在右侧检查和修改。"
        } catch { message = error.localizedDescription }
    }
    private func chooseCLIFile() {
        let panel = NSOpenPanel()
        panel.title = "选择 TB 命令行配置"
        panel.prompt = "导入"
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        importCLI(from: url)
    }
    private func reset() {
        cancelProbe(); connectionResult = nil
        editingID = nil; name = ""; relay = ""; direct = true; useTLS = false; port = "7400"; host = ""
        secret = ""; fingerprint = ""; pairing = ""; message = nil
    }
    private func cancelProbe() {
        probeID = UUID(); probeTask?.cancel(); probeTask = nil; checking = false
    }
    private func testConnection(saveAfter: Bool) {
        cancelProbe(); connectionFailed = false; connectionResult = nil
        var candidate: ConnectionSettings
        do {
            candidate = try makeCandidate()
            if saveAfter {
                candidate = try model.saveProfile(candidate, connect: false)
                editingID = candidate.id; message = "连接配置已保存，正在尝试连接。"
            }
        }
        catch { connectionFailed = true; connectionResult = error.localizedDescription; return }
        checking = true
        let token = probeID
        probeTask = Task { @MainActor in
            defer { if probeID == token { checking = false; probeTask = nil } }
            do {
                let verified = try await MacConnectionTest.run(candidate, discoverCertificate: direct) { stage in
                    if probeID == token { connectionResult = stage }
                }
                guard !Task.isCancelled, probeID == token else { return }
                fingerprint = verified.tlsFingerprint; host = verified.hostID
                connectionResult = "连接成功：密码验证通过，\(verified.displayName) 已响应。"
                if saveAfter { persist(verified) }
            } catch {
                guard !Task.isCancelled, probeID == token else { return }
                connectionFailed = true
                connectionResult = (saveAfter ? "配置已保存；" : "") + error.localizedDescription
            }
        }
    }
    private func makeCandidate() throws -> ConnectionSettings {
        let endpoint = direct ? try LANConnection.endpoint(address: relay, port: port, useTLS: useTLS) : relay
        let candidate = ConnectionSettings(profileID: editingID ?? UUID(), relayURL: endpoint,
            hostID: host, secret: secret, tlsFingerprint: direct && !useTLS ? "" : fingerprint, hostName: name, mode: direct ? .direct : .relay).normalized()
        let error = candidate.validationError ?? (direct && !(1...256).contains(secret.count) ? "连接密码须为 1–256 个字符，请在服务端复制连接密码。" : nil)
        if let error { throw NSError(domain: "Connection", code: 1, userInfo: [NSLocalizedDescriptionKey: error]) }
        return candidate
    }
    private func saveOnly() {
        cancelProbe()
        do {
            let saved = try model.saveProfile(makeCandidate(), connect: false)
            editingID = saved.id; connectionFailed = false; connectionResult = "连接配置已保存。"; message = nil
        } catch { connectionFailed = true; connectionResult = error.localizedDescription }
    }
    private func persist(_ candidate: ConnectionSettings) {
        do { editingID = try model.saveProfile(candidate).id; fingerprint = candidate.tlsFingerprint; message = "连接已保存" }
        catch { connectionFailed = true; connectionResult = error.localizedDescription }
    }

}

/// The session window switch. Each option's one-line description sits under
/// its own segment and both are always shown, so switching never changes the
/// height of the page; the details are in the tooltips.
struct SessionWindowModePicker: View {
    @Binding var selection: String
    private static let width: CGFloat = 300
    private static let modes = SessionWindowMode.allCases

    var body: some View {
        LabeledContent("会话窗口") {
            VStack(spacing: 4) {
                EqualSegments(labels: Self.modes.map(\.title),
                              tooltips: Self.modes.map { $0.detail + "\n切换时，已打开的会话直接合并或拆回，不会重连。" },
                              selection: Binding(get: { Self.modes.firstIndex { $0.rawValue == selection } ?? 0 },
                                                 set: { selection = Self.modes[$0].rawValue }))
                    .frame(width: Self.width)
                    .accessibilityIdentifier("session-window-mode")
                HStack(spacing: 0) {
                    ForEach(Self.modes) { mode in
                        Text(mode.summary)
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                            .help(mode.detail)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .frame(width: Self.width)
        }
    }
}

/// AppKit's segmented control with equal segments at the width it is given.
/// SwiftUI's segmented picker keeps its natural width, so text placed under
/// it cannot line up with each segment.
private struct EqualSegments: NSViewRepresentable {
    let labels: [String]
    let tooltips: [String]
    @Binding var selection: Int

    func makeNSView(context: Context) -> NSSegmentedControl {
        let control = NSSegmentedControl(labels: labels, trackingMode: .selectOne,
                                         target: context.coordinator, action: #selector(Coordinator.changed(_:)))
        control.segmentDistribution = .fillEqually
        control.setContentHuggingPriority(.defaultLow, for: .horizontal)
        control.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        for (index, tooltip) in tooltips.enumerated() { control.setToolTip(tooltip, forSegment: index) }
        return control
    }

    func updateNSView(_ control: NSSegmentedControl, context: Context) {
        context.coordinator.selection = $selection
        if control.selectedSegment != selection { control.selectedSegment = selection }
    }

    func makeCoordinator() -> Coordinator { Coordinator(selection: $selection) }

    final class Coordinator: NSObject {
        var selection: Binding<Int>
        init(selection: Binding<Int>) { self.selection = selection }
        @objc func changed(_ sender: NSSegmentedControl) { selection.wrappedValue = sender.selectedSegment }
    }
}

private struct NotificationPermissionView: View {
    @ObservedObject var coordinator: MacNotificationCoordinator
    var body: some View {
        Text(coordinator.permissionStatus).font(.caption).foregroundStyle(.secondary)
        if let error = coordinator.deliveryError { Text(error).font(.caption).foregroundStyle(.orange) }
        Button("打开系统设置") {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app"))
        }
    }
}
