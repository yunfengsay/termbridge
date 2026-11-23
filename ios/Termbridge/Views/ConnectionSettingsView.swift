import SwiftUI

struct ConnectionSettingsView: View {
  @Environment(\.dismiss) private var dismiss
  @AppStorage(SessionUIPreference.defaultsKey) private var sessionUI = SessionUIPreference.auto.rawValue
  @State private var profileID: UUID
  @State private var relayURL: String
  @State private var hostID: String
  @State private var hostName: String
  @State private var secret: String
  @State private var fingerprint: String
  @State private var profiles: [ConnectionSettings]
  @State private var error: String?
  @State private var showingPairing = false
  @State private var direct = false
  @State private var useTLS = false
  @State private var port = "7400"
  @State private var checking = false
  @State private var pendingTrust: ConnectionSettings?
  @State private var probeTask: Task<Void, Never>?

  let canCancel: Bool
  let onSave: () -> Void

  init(canCancel: Bool, settings: ConnectionSettings? = nil, onSave: @escaping () -> Void) {
    let settings = settings ?? SettingsStore.load()
    _profileID = State(
      initialValue: settings.profileID == ConnectionSettings.defaults.profileID
        ? UUID() : settings.profileID)
    let url = URL(string: settings.relayURL)
    let lan = SettingsStore.profiles().isEmpty || settings.isDirectConnection
    _direct = State(initialValue: lan)
    _useTLS = State(initialValue: !SettingsStore.profiles().isEmpty && url?.scheme?.lowercased() == "wss")
    _port = State(initialValue: String(url?.port ?? 7400))
    _relayURL = State(initialValue: lan ? (SettingsStore.profiles().isEmpty ? "" : url?.host ?? "") : settings.relayURL)
    _hostID = State(initialValue: settings.hostID)
    _hostName = State(initialValue: settings.hostName)
    _secret = State(initialValue: settings.secret)
    _fingerprint = State(initialValue: settings.tlsFingerprint)
    _profiles = State(initialValue: SettingsStore.profiles())
    self.canCancel = canCancel
    self.onSave = onSave
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("默认会话视图", selection: $sessionUI) {
            ForEach(SessionUIPreference.allCases) { preference in
              Text(preference.title).tag(preference.rawValue)
            }
          }
          .accessibilityIdentifier("default-session-ui")
        } header: { Text("界面") } footer: {
          Text("自动：支持的 Agent 使用对话视图，其余使用终端。会话内可随时切换，不会重启 Agent。")
        }

        if !profiles.isEmpty {
          Section("Mac profiles") {
            ForEach(profiles) { profile in
              Button { select(profile) } label: {
                HStack {
                  VStack(alignment: .leading, spacing: 3) {
                    Text(profile.displayName).foregroundStyle(.primary)
                    Text(profile.hostID.isEmpty ? "Discover host after connecting" : profile.hostID)
                      .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                  }
                  Spacer()
                  if profile.profileID == profileID {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                  }
                }
              }
              .swipeActions {
                Button("Delete", systemImage: "trash", role: .destructive) {
                  delete(profile)
                }
              }
            }
          }
        }

        Section {
          Button("扫码或导入配对码", systemImage: "qrcode.viewfinder") {
            showingPairing = true
          }
          Button("新增连接", systemImage: "plus") { clearEditor() }
        } footer: {
          Text("配对码包含连接所需的信息。新增连接不会覆盖其他 Mac。")
        }

        Section("Profile") {
          TextField("Mac name", text: $hostName)
          Picker("连接方式", selection: Binding(get: { direct }, set: switchMode)) {
            Text("内网直连").tag(true)
            Text("服务器地址").tag(false)
          }
          TextField(direct ? "内网 IP，例如 192.168.1.20" : "wss://服务器地址", text: $relayURL)
            .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
          if direct { TextField("端口", text: $port).keyboardType(.numberPad) }
          TextField("Host ID (optional while pairing)", text: $hostID)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
        }

        Section {
          SecureField("Shared secret", text: $secret)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          if direct {
            DisclosureGroup("高级连接选项") {
              Toggle("兼容旧版 TLS 服务", isOn: $useTLS)
              if useTLS { fingerprintField }
            }
          } else { fingerprintField }
        } header: { Text("Security") } footer: {
          Text("Secrets are stored per profile in this device’s Keychain.")
        }

        if relayURL.lowercased().hasPrefix("ws://") {
          Section {
            Label("Plain ws:// exposes terminal traffic. Use it only on a trusted LAN.",
              systemImage: "exclamationmark.shield.fill").foregroundStyle(.orange)
          }
        }
        if let error {
          Section { Label(error, systemImage: "exclamationmark.circle.fill").foregroundStyle(.red) }
        }
      }
      .disabled(checking || pendingTrust != nil)
      .onDisappear { probeTask?.cancel() }
      .alert("确认内网 Mac 的证书", isPresented: Binding(get: { pendingTrust != nil }, set: { if !$0 { pendingTrust = nil } })) {
        Button("核对一致，连接") { if let candidate = pendingTrust { persist(candidate) }; pendingTrust = nil }
        Button("取消", role: .cancel) { pendingTrust = nil }
      } message: {
        Text("请与 Mac 内网服务页面的 SHA-256 指纹核对：\n\n\(pendingTrust?.relayURL ?? "")\n\(pendingTrust?.tlsFingerprint ?? "")")
      }
      .navigationTitle("设置")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if canCancel {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(checking ? "读取证书…" : "保存并连接", action: save).fontWeight(.semibold).disabled(checking)
        }
      }
      .interactiveDismissDisabled(!canCancel)
      .sheet(isPresented: $showingPairing) {
        PairingImportView {
          profiles = SettingsStore.profiles()
          loadActive()
          onSave()
          showingPairing = false
          DispatchQueue.main.async { dismiss() }
        }
      }
    }
  }

  private func select(_ profile: ConnectionSettings) {
    guard SettingsStore.select(profile.profileID) else { return }
    populate(profile)
    onSave()
  }

  private func delete(_ profile: ConnectionSettings) {
    let selected = SettingsStore.remove(profile.profileID)
    profiles = SettingsStore.profiles()
    if let selected { populate(selected) } else { clearEditor() }
    onSave()
  }

  private func clearEditor() {
    profileID = UUID()
    relayURL = ""; direct = true; useTLS = false; port = "7400"
    hostID = ""
    hostName = ""
    secret = ""
    fingerprint = ""
    error = nil
  }

  private func loadActive() {
    let active = SettingsStore.load()
    populate(active)
  }

  private func populate(_ settings: ConnectionSettings) {
    profileID = settings.profileID
    let url = URL(string: settings.relayURL)
    direct = settings.isDirectConnection
    useTLS = url?.scheme?.lowercased() == "wss"
    relayURL = direct ? url?.host ?? "" : settings.relayURL
    port = String(url?.port ?? 7400)
    hostID = settings.hostID
    hostName = settings.hostName
    secret = settings.secret
    fingerprint = settings.tlsFingerprint
    error = nil
  }

  private func save() {
    let endpoint: String
    do { endpoint = direct ? try LANConnection.endpoint(address: relayURL, port: port, useTLS: useTLS) : relayURL }
    catch { self.error = error.localizedDescription; return }
    let settings = ConnectionSettings(
      profileID: profileID, relayURL: endpoint, hostID: hostID, secret: secret,
      tlsFingerprint: direct && !useTLS ? "" : fingerprint, hostName: hostName, mode: direct ? .direct : .relay)
    if let validation = settings.validationError { error = validation; return }
    if direct && !(1...256).contains(secret.count) { error = "连接密码须为 1–256 个字符。"; return }
    guard direct && useTLS && settings.normalizedFingerprint.isEmpty else { persist(settings); return }
    checking = true
    probeTask = Task { @MainActor in
      defer { checking = false }
      do {
        let pin = try await LANConnection.probe(endpoint)
        guard !Task.isCancelled else { return }
        var trusted = settings; trusted.tlsFingerprint = pin; pendingTrust = trusted
      } catch { if !Task.isCancelled { self.error = "无法读取证书，请确认 IP、端口和 Mac 内网服务已开启。" } }
    }
  }
  private func switchMode(_ value: Bool) {
    if value, LANConnection.isDirectEndpoint(relayURL), let url = URL(string: relayURL) {
      useTLS = url.scheme?.lowercased() == "wss"
      relayURL = url.host ?? ""; port = String(url.port ?? 7400)
    } else if !value, let endpoint = try? LANConnection.endpoint(address: relayURL, port: port, useTLS: useTLS) {
      relayURL = endpoint
    }
    direct = value
  }
  private var fingerprintField: some View {
    TextField("TLS SHA-256 fingerprint", text: $fingerprint, axis: .vertical)
      .font(.system(.footnote, design: .monospaced))
      .textInputAutocapitalization(.never).autocorrectionDisabled()
  }
  private func persist(_ settings: ConnectionSettings) {
    SettingsStore.save(settings)
    profiles = SettingsStore.profiles()
    error = nil
    onSave()
    dismiss()
  }
}
