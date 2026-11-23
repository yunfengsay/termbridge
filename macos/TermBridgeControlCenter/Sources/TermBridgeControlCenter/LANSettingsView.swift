import SwiftUI

struct LANSettingsView: View {
    @ObservedObject var service: MacLANServices
    @ObservedObject var model: ControlCenterModel
    @State private var addresses: [LANAddress] = []
    @State private var route = LANSharingRoute.local
    @State private var localAddress = ""
    @State private var localPort = "7400"
    @State private var localPassword = ""
    @State private var remoteAddress = ""
    @State private var remotePort = "7400"
    @State private var remotePassword = ""
    @State private var loaded = false
    @State private var showRelayConfiguration = true
    @State private var showSharingConfiguration = true
    @State private var pairingCode: String?
    @State private var showPairing = false
    @State private var error: String?
    @AppStorage("lan.startWithApp") private var startWithApp = false

    private var relayInput: LANEndpointConfiguration {
        .init(address: localAddress.trimmingCharacters(in: .whitespacesAndNewlines), port: Int(localPort) ?? 0, password: localPassword)
    }
    private var sharingInput: LANEndpointConfiguration {
        .init(address: remoteAddress.trimmingCharacters(in: .whitespacesAndNewlines), port: Int(remotePort) ?? 0, password: remotePassword)
    }
    private var relayValidation: String? {
        guard service.relay.phase == .stopped else { return nil }
        if !LANAddress.isUsable(relayInput.address) { return "请选择其他设备可以访问的本机 IP。" }
        if !(1024...65535).contains(relayInput.port) { return "端口须为 1024–65535。" }
        if localPassword.count > 256 { return "密码最多 256 个字符。" }
        return nil
    }
    private var sharingValidation: String? {
        guard service.sharing.phase == .stopped else { return nil }
        if route == .local {
            return service.relay.phase == .ready ? nil : "先开启下方的本机中转服务，或选择另一台中转机。"
        }
        if !MacLANService.validRelayAddress(sharingInput.address) { return "填写中转机 IP 或主机名，不含 ws:// 和端口。" }
        if !(1024...65535).contains(sharingInput.port) { return "端口须为 1024–65535。" }
        if !(1...256).contains(remotePassword.count) { return "请输入中转机的连接密码。" }
        return nil
    }

    var body: some View {
        Form {
            Text("共享本机和提供中转可以同时开启。连接并操作其他电脑，仍在主窗口添加连接。")
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            Section("共享本机会话") {
                Toggle("允许其他设备访问这台 Mac", isOn: Binding(
                    get: { service.sharing.phase != .stopped },
                    set: { if $0 { service.startSharing(route: route, endpoint: sharingInput) } else { service.stopSharing() } }
                )).disabled(service.sharing.phase == .stopping || (service.sharing.phase == .stopped && sharingValidation != nil))
                    .accessibilityIdentifier("lan-sharing-enabled")
                Picker("通过哪里访问", selection: $route) {
                    ForEach(LANSharingRoute.allCases, id: \.self) { Text($0.title).tag($0) }
                }.disabled(service.sharing.phase != .stopped).accessibilityIdentifier("lan-sharing-route")
                if route == .remote {
                    DisclosureGroup(service.sharing.profile?.relayURL ?? "中转连接设置", isExpanded: $showSharingConfiguration) {
                        TextField("中转机 IP / 主机名", text: $remoteAddress).accessibilityIdentifier("lan-remote-address")
                            .disabled(service.sharing.phase != .stopped)
                        TextField("中转端口", text: $remotePort).disabled(service.sharing.phase != .stopped)
                        SecureField("中转连接密码", text: $remotePassword).disabled(service.sharing.phase != .stopped)
                        Text("本机主动接入，不需要固定 IP。停止共享后可修改连接设置。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else if service.sharing.phase == .stopped {
                    Text("使用下方的本机中转入口；停止共享后，中转仍可供其他电脑使用。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                status(service.sharing, validation: sharingValidation)
                connectionDetails(service.sharing, title: "访问这台 Mac")
            }
            Section("为其他设备提供中转") {
                Toggle("开启本机中转服务", isOn: Binding(
                    get: { service.relay.phase != .stopped },
                    set: { if $0 { service.startRelay(relayInput) } else { service.stopRelay() } }
                )).disabled(service.relay.phase == .stopping || service.sharingUsesLocalRelay || (service.relay.phase == .stopped && relayValidation != nil))
                    .accessibilityIdentifier("lan-relay-enabled")
                DisclosureGroup(service.relay.profile?.relayURL ?? "中转监听设置", isExpanded: $showRelayConfiguration) {
                    Picker("监听 IP", selection: $localAddress) {
                        Text("请选择").tag("")
                        if !localAddress.isEmpty && !addresses.contains(where: { $0.address == localAddress }) { Text(localAddress).tag(localAddress) }
                        ForEach(addresses) { Text("\($0.address) · \($0.interface)").tag($0.address) }
                    }.disabled(service.relay.phase != .stopped)
                    TextField("监听端口", text: $localPort).disabled(service.relay.phase != .stopped)
                    SecureField("中转密码（留空自动生成）", text: $localPassword).disabled(service.relay.phase != .stopped)
                    if service.relay.phase == .stopped { Button("刷新 IP", action: refreshAddresses) }
                    Text("其他电脑使用这里的地址、端口和密码接入。停止中转后可修改监听设置。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if service.sharingUsesLocalRelay {
                    Text("本机共享正在使用此入口。停止中转前，请先停止共享或改用另一台中转机。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                status(service.relay, validation: relayValidation)
                connectionDetails(service.relay, title: "添加电脑或客户端")
            }
            if let message = service.message { Text(message).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            if let error { Text(error).foregroundStyle(.red) }
            if service.relay.phase != .stopped || service.sharing.phase != .stopped {
                Section("实时连接拓扑") {
                    if let topology = service.relay.topology {
                        topologyGroup("本机提供的中转", topology: topology, worker: service.relay,
                                      localHostID: service.sharingUsesLocalRelay ? service.sharing.localHostID : nil)
                    }
                    if let topology = service.sharing.topology, !service.sharingUsesLocalRelay || service.relay.topology == nil {
                        topologyGroup("本机共享的连接", topology: topology, worker: service.sharing, localHostID: service.sharing.localHostID)
                    }
                    if service.relay.topology == nil && service.sharing.topology == nil {
                        Text("尚未收到实时拓扑；连接恢复后自动刷新。旧版中转可能不提供拓扑。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            Section("自动启动") {
                LoginLaunchSettingsView()
                Toggle("打开 App 时恢复已开启的服务", isOn: $startWithApp).accessibilityIdentifier("lan-start-with-app")
                Text("关闭窗口后继续运行；退出 App 会停止由它开启的共享和中转服务。已有 tb serve 继续独立运行。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.formStyle(.grouped)
            .onAppear(perform: load)
            .onChange(of: service.relay.phase) { phase in
                if phase == .ready { localPassword = service.relay.profile?.secret ?? localPassword }
                if phase == .ready || phase == .stopped { showRelayConfiguration = phase == .stopped }
            }
            .onChange(of: service.sharing.phase) { phase in
                if phase == .ready || phase == .stopped { showSharingConfiguration = phase == .stopped }
            }
            .sheet(isPresented: $showPairing) {
                if let pairingCode { CLIPairingSheet(code: pairingCode, title: "内网连接", detail: "在手机或另一台电脑扫码添加连接。设备需要能访问中转地址。") }
            }
    }

    @ViewBuilder private func status(_ worker: MacLANService, validation: String?) -> some View {
        HStack {
            if worker.busy || worker.phase == .reconnecting { ProgressView().controlSize(.small) }
            Text(worker.message).foregroundStyle(worker.phase == .ready ? Color.primary : Color.secondary)
        }.accessibilityIdentifier(worker === service.relay ? "lan-relay-status" : "lan-sharing-status")
        if let validation { Text(validation).font(.caption).foregroundStyle(.secondary) }
    }

    @ViewBuilder private func connectionDetails(_ worker: MacLANService, title: String) -> some View {
        if let profile = worker.profile {
            DisclosureGroup(title) {
                LabeledContent("地址", value: profile.relayURL).textSelection(.enabled)
                HStack {
                    Button("复制连接密码") { copy(profile.secret) }
                    Button("显示配对二维码") { pairingCode = worker.pairing; showPairing = true }
                    Button("复制配对码") { if let code = worker.pairing { copy(code) } }
                    Button("在此 App 连接") { connect(profile.hostID, worker: worker) }
                }
            }
        }
    }

    private func topologyGroup(_ title: String, topology: RelayTopology, worker: MacLANService, localHostID: String?) -> some View {
        DisclosureGroup(title) {
            RelayTopologyView(topology: topology, localHostID: localHostID) { connect($0, worker: worker) }
                .padding(.vertical, 8)
        }
    }
    private func load() {
        guard !loaded else { return }; loaded = true
        showRelayConfiguration = service.relay.phase == .stopped
        showSharingConfiguration = service.sharing.phase == .stopped
        if let relay = service.configuration.relay { localAddress = relay.address; localPort = String(relay.port); localPassword = relay.password }
        if let host = service.configuration.sharing {
            route = host.route
            if route == .remote { remoteAddress = host.endpoint.address; remotePort = String(host.endpoint.port); remotePassword = host.endpoint.password }
        }
        refreshAddresses()
    }
    private func refreshAddresses() {
        addresses = LANAddress.available()
        if localAddress.isEmpty { localAddress = addresses.first?.address ?? "" }
    }
    private func connect(_ host: String, worker: MacLANService) {
        guard let profile = worker.profile else { return }
        do { try model.connectTopologyHost(host, using: profile, topology: worker.topology); error = nil }
        catch { self.error = "保存连接失败：\(error.localizedDescription)" }
    }
    private func copy(_ value: String) { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(value, forType: .string) }
}
