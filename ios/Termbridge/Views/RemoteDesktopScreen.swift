import SwiftUI
import WebKit

private final class DesktopControls: ObservableObject {
  struct Display: Identifiable { let id: Int; let name: String }
  @Published var displays: [Display] = []
  @Published var displayID = 0
  @Published var connected = false
  @Published var retry = false
  @Published var fps = 10
  @Published var zoom = 100
  @Published var drag = false
  @Published var scroll = true
  @Published var backend = "auto"
  @Published var needsLogin = false
  @Published var needsUsername = true
  @Published var loginNotice: String?
  @Published var status = "正在连接桌面…"
  var send: ((String, Any?) -> Void)?
  func update(_ value: [String: Any]) {
    displays = (value["displays"] as? [[String: Any]] ?? []).compactMap { d in
      guard let id = d["id"] as? Int, let name = d["name"] as? String else { return nil }
      return Display(id: id, name: name)
    }
    backend = value["backend"] as? String ?? "auto"
    displayID = value["displayId"] as? Int ?? 0
    connected = value["connected"] as? Bool ?? false
    retry = value["retry"] as? Bool ?? false
    if retry { needsLogin = false }
    fps = value["fps"] as? Int ?? 10
    zoom = value["zoom"] as? Int ?? 100
    drag = value["drag"] as? Bool ?? false
    scroll = value["scroll"] as? Bool ?? true
    status = value["status"] as? String ?? ""
  }
}

struct RemoteDesktopScreen: View {
  let settings: ConnectionSettings
  @StateObject private var controls = DesktopControls()
  @State private var showKeyboard = false
  @State private var text = ""
  @State private var username = ""
  @State private var password = ""
  @State private var rememberPassword = true
  @FocusState private var typing: Bool
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  var body: some View {
    RemoteDesktopWebView(settings: settings, active: scenePhase == .active, controls: controls)
      .background(Color(uiColor: .systemBackground))
      .safeAreaInset(edge: .top, spacing: 0) {
        HStack(spacing: 20) {
          Menu {
            Picker("显示器", selection: Binding(get: { controls.displayID }, set: { controls.send?("display", $0) })) {
              ForEach(controls.displays) { display in Text(display.name).tag(display.id) }
            }
          } label: {
            Label(controls.displays.first { $0.id == controls.displayID }?.name ?? "显示器", systemImage: "display")
              .lineLimit(1)
          }
          .disabled(!controls.connected || controls.displays.isEmpty)
          Spacer(minLength: 8)
          Button("上一个桌面", systemImage: "chevron.left") { controls.send?("previous", nil) }.labelStyle(.iconOnly)
          Button("所有桌面", systemImage: "rectangle.3.group") { controls.send?("overview", nil) }.labelStyle(.iconOnly)
          Button("下一个桌面", systemImage: "chevron.right") { controls.send?("next", nil) }.labelStyle(.iconOnly)
        }
        .disabled(!controls.connected)
        .padding(.horizontal, 20).frame(minHeight: 48).background(.bar)
      }
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(spacing: 12) {
          if showKeyboard {
            HStack {
              TextField("输入文字，支持中文", text: $text).textFieldStyle(.roundedBorder)
                .focused($typing).submitLabel(.send).onSubmit(submit)
              Button("发送", systemImage: "arrow.up.circle.fill", action: submit).labelStyle(.iconOnly)
                .disabled(text.isEmpty || !controls.connected)
            }
          }
          HStack(spacing: 24) {
            Button { controls.send?("drag", nil) } label: {
              Label("拖动", systemImage: controls.drag ? "hand.draw.fill" : "hand.draw")
            }.disabled(!controls.connected).accessibilityValue(controls.drag ? "开启" : "关闭")
            Button("\(controls.zoom)%") { controls.send?("fit", nil) }.disabled(!controls.connected)
              .accessibilityLabel("适合屏幕，当前 \(controls.zoom)%")
            Spacer(minLength: 0)
            if controls.retry {
              Button("重新连接", systemImage: "arrow.clockwise") { controls.send?("reconnect", nil) }.labelStyle(.iconOnly)
            }
            Button("键盘", systemImage: showKeyboard ? "keyboard.chevron.compact.down" : "keyboard") {
              showKeyboard.toggle(); typing = showKeyboard
            }.labelStyle(.iconOnly).disabled(!controls.connected)
            Menu {
              Picker("刷新率", selection: Binding(get: { controls.fps }, set: { controls.send?("fps", $0) })) {
                Text("10 FPS · 省流（默认）").tag(10)
                Text("20 FPS · 均衡").tag(20)
                Text("30 FPS · 流畅").tag(30)
              }
              Divider()
              Picker("连接方式", selection: Binding(get: { controls.backend }, set: { controls.send?("backend", $0) })) {
                Text("自动连接").tag("auto")
                Text("直接桌面 · 区域高亮").tag("native")
                Text("系统共享 · 锁屏控制").tag("system")
              }
              Button("忘记桌面密码", systemImage: "key.slash") { controls.send?("forgetCredentials", nil) }
              Divider()
              Toggle("双指滚动", isOn: Binding(get: { controls.scroll }, set: { _ in controls.send?("scrollMode", nil) }))
              Divider()
              Button("Esc") { controls.send?("key", 53) }
              Button("Tab") { controls.send?("key", 48) }
              Button("删除") { controls.send?("key", 51) }
              Button("Enter") { controls.send?("key", 36) }
            } label: { Label("更多操作", systemImage: "ellipsis") }.labelStyle(.iconOnly)
          }.frame(minHeight: 32)
          if controls.connected { Text(controls.status).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
        }.padding(.horizontal, 20).padding(.vertical, 12).background(.bar)
      }
      .sheet(isPresented: $controls.needsLogin) {
        NavigationStack {
          Form {
            Section {
              if controls.needsUsername { TextField("Mac 用户名", text: $username).textInputAutocapitalization(.never).autocorrectionDisabled() }
              SecureField("密码", text: $password)
              Toggle("记住密码", isOn: $rememberPassword)
            } footer: { Text("验证成功后保存在此 iPad 的钥匙串中，仅用于这台 Mac 的当前连接。") }
          }
          .navigationTitle("登录 Mac").navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("取消") { controls.needsLogin = false; password = ""; username = ""; controls.send?("cancelLogin", nil) }
            }
            ToolbarItem(placement: .confirmationAction) {
              Button("登录") {
                controls.send?("credentials", ["username": username.trimmingCharacters(in: .whitespacesAndNewlines), "password": password, "remember": rememberPassword])
                controls.needsLogin = false; password = ""; username = ""
              }.disabled(password.isEmpty)
            }
          }
        }.presentationDetents([.medium]).interactiveDismissDisabled()
      }
      .alert("桌面密码", isPresented: Binding(get: { controls.loginNotice != nil }, set: { if !$0 { controls.loginNotice = nil } })) {
        Button("好") { controls.loginNotice = nil }
      } message: { Text(controls.loginNotice ?? "") }
      .onDisappear { password = ""; username = "" }
      .onChange(of: scenePhase) { _, phase in if phase != .active { controls.needsLogin = false; password = ""; username = "" } }
      .navigationTitle("查看桌面")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .topBarLeading) { Button("完成") { dismiss() } } }
      .onChange(of: controls.connected) { _, connected in if !connected { showKeyboard = false; typing = false; text = ""; password = ""; username = "" } }
      .tint(Color(uiColor: .systemBlue))
  }
  private func submit() {
    guard controls.connected, !text.isEmpty else { return }
    controls.send?("text", text); text = ""
  }
}

private struct RemoteDesktopWebView: UIViewRepresentable {
  let settings: ConnectionSettings
  let active: Bool
  @ObservedObject var controls: DesktopControls
  func makeCoordinator() -> Coordinator { Coordinator(settings: settings, controls: controls) }
  func makeUIView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    config.userContentController.add(context.coordinator, name: "desktop")
    let web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = context.coordinator
    web.scrollView.isScrollEnabled = false
    web.isOpaque = false
    web.backgroundColor = .systemBackground
    web.scrollView.backgroundColor = .systemBackground
    context.coordinator.web = web
    web.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [weak coordinator = context.coordinator] (_: WKWebView, _: UITraitCollection) in
      coordinator?.configureAppearance()
    }
    if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "Desktop") {
      context.coordinator.baseURL = url.deletingLastPathComponent()
      web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }
    return web
  }
  func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.setActive(active); context.coordinator.configureAppearance() }
  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    coordinator.setActive(false)
    view.configuration.userContentController.removeScriptMessageHandler(forName: "desktop")
    view.navigationDelegate = nil
  }

  final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler, TermbridgeClientListener {
    weak var web: WKWebView?
    var baseURL: URL?
    private let controls: DesktopControls
    private var settings: ConnectionSettings
    private var client: TermbridgeClient?
    private var active = false
    private var loaded = false
    private var ready = false
    private var started = false
    private var loginRequestID: String?
    private var pendingCredentials: DesktopLoginCredentials?
    private var rememberLogin = false
    private var usedSavedLogin = false
    private var credentialStore: DesktopCredentialStore { DesktopCredentialStore(settings: settings) }
    private func clearLoginAttempt() {
      loginRequestID = nil; pendingCredentials = nil; rememberLogin = false; usedSavedLogin = false
    }
    private func submitLogin(_ credentials: DesktopLoginCredentials, remember: Bool) {
      guard let requestID = loginRequestID, active else { return }
      pendingCredentials = credentials; rememberLogin = remember
      if !remember { credentialStore.clear() }
      evaluate("ui", ["action": "credentials", "requestId": requestID,
        "value": ["username": credentials.username, "password": credentials.password]])
    }
    init(settings: ConnectionSettings, controls: DesktopControls) {
      self.settings = settings; self.controls = controls
      super.init()
      controls.send = { [weak self] action, value in
        guard let self else { return }
        if action == "credentials", let fields = value as? [String: Any],
          let username = fields["username"] as? String, let password = fields["password"] as? String {
          self.submitLogin(DesktopLoginCredentials(username: username, password: password), remember: fields["remember"] as? Bool ?? true)
          return
        }
        if action == "forgetCredentials" {
          self.credentialStore.clear(); self.pendingCredentials = nil; self.rememberLogin = false
          self.controls.loginNotice = "已忘记此连接的桌面密码，下次连接时重新输入。"
          return
        }
        if action == "fps", let fps = value as? Int, [10, 20, 30].contains(fps) {
          UserDefaults.standard.set(fps, forKey: "desktopFrameRate")
        }
        var message: [String: Any] = ["action": action]
        if let value { message["value"] = value }
        self.evaluate("ui", message)
      }
    }
    private var appearance: String?
    func configureAppearance() {
      guard loaded, let web else { return }
      let dark = web.traitCollection.userInterfaceStyle == .dark
      let key = dark ? "dark" : "light"
      guard appearance != key else { return }; appearance = key
      func hex(_ color: UIColor) -> String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: web.traitCollection).getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "#%02X%02X%02X", Int(r * 255), Int(g * 255), Int(b * 255))
      }
      evaluate("configure", ["fps": UserDefaults.standard.integer(forKey: "desktopFrameRate"), "nativeControls": true, "appearance": key, "background": hex(.systemBackground),
        "foreground": hex(.label), "muted": hex(.secondaryLabel), "accent": hex(.systemBlue)])
    }
    func setActive(_ value: Bool) {
      guard value != active else { return }
      active = value
      if value { connect() }
      else {
        clearLoginAttempt()
        client?.disconnect(); client = nil; ready = false; started = false
        web?.evaluateJavaScript("window.Desktop?.disconnected()")
      }
    }
    private func connect() {
      guard active else { return }
      clearLoginAttempt()
      client?.disconnect(); ready = false; started = false
      let next = TermbridgeClient(settings: settings, listener: self)
      client = next; next.connect()
    }
    private func startViewer() {
      guard active, loaded, ready, !started, !settings.hostID.isEmpty else { return }
      started = true
      evaluate("start", ["hostId": settings.hostID, "secret": settings.secret, "deviceId": UIDevice.current.identifierForVendor?.uuidString ?? settings.profileID.uuidString])
    }
    private func evaluate(_ method: String, _ value: [String: Any]) {
      guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
      web?.evaluateJavaScript("window.Desktop?.\(method)(\(json))")
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
      guard message.frameInfo.isMainFrame, let fields = message.body as? [String: Any], let type = fields["t"] as? String else { return }
      if type == "desktop_loaded" { loaded = true; appearance = nil; configureAppearance(); startViewer(); return }
      if type == "desktop_state" { controls.update(fields); return }
      if type == "desktop_credentials", active {
        guard let requestID = fields["requestId"] as? String, !requestID.isEmpty, requestID != loginRequestID else { return }
        clearLoginAttempt(); loginRequestID = requestID
        if let saved = credentialStore.load() { usedSavedLogin = true; submitLogin(saved, remember: true) }
        else { controls.needsUsername = fields["username"] as? Bool ?? true; controls.needsLogin = true }
        return
      }
      if type == "desktop_auth" {
        guard fields["requestId"] as? String == loginRequestID else { return }
        switch fields["state"] as? String {
        case "authenticated":
          if rememberLogin, let credentials = pendingCredentials {
            do { try credentialStore.save(credentials) }
            catch { controls.loginNotice = "连接已成功，但密码未能保存到钥匙串。" }
          }
          clearLoginAttempt()
        case "rejected": if usedSavedLogin { credentialStore.clear() }; clearLoginAttempt()
        case "closed": clearLoginAttempt()
        default: break
        }
        return
      }
      if type == "desktop_reconnect" { connect(); return }
      guard active, ready, [RemoteDesktopProtocol.open, RemoteDesktopProtocol.data].contains(type),
            let bytes = try? JSONSerialization.data(withJSONObject: fields), bytes.count < 90_000 else { return }
      var wire: [String: MessagePackValue] = [:]
      for (key, value) in fields {
        if let string = value as? String { wire[key] = .string(string) }
        else if let number = value as? NSNumber { wire[key] = .int(number.int64Value) }
      }
      if client?.sendControl(wire) != true { web?.evaluateJavaScript("window.Desktop?.disconnected()") }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
      guard let url = navigationAction.request.url, url.isFileURL, let baseURL,
            url.deletingLastPathComponent().standardizedFileURL == baseURL.standardizedFileURL,
            url.lastPathComponent == "index.html" else { decisionHandler(.cancel); return }
      decisionHandler(.allow)
    }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
      guard self.client === client else { return }
      switch state {
      case .failed, .disconnected: ready = false; started = false; web?.evaluateJavaScript("window.Desktop?.disconnected()")
      default: break
      }
    }
    func clientIsReady(_ client: TermbridgeClient) { guard self.client === client, active else { return }; ready = true; startViewer() }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
      guard self.client === client, active else { return }
      if message.type == "host_list_result", settings.hostID.isEmpty, let id = message.string("selectedHostId") { settings.hostID = id; startViewer() }
      guard [RemoteDesktopProtocol.ready, RemoteDesktopProtocol.data, RemoteDesktopProtocol.closed].contains(message.type) else { return }
      var fields: [String: Any] = [:]
      for (key, value) in message.fields {
        if let string = value.stringValue { fields[key] = string }
        else if let number = value.intValue { fields[key] = number }
      }
      evaluate("receive", fields)
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
  }
}
