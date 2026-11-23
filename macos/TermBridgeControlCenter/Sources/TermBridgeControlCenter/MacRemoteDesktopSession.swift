import AppKit
import Combine
import WebKit

/// Owns one viewer and one connection. Changing the selected Host cannot retarget it.
@MainActor
final class MacRemoteDesktopSession: NSObject, ObservableObject, WKNavigationDelegate, @preconcurrency TermbridgeClientListener {
    struct Display: Identifiable { let id: Int; let name: String }
    let profile: ConnectionSettings
    let web: WKWebView
    @Published private(set) var status = "正在连接桌面…"
    @Published private(set) var connected = false
    @Published private(set) var retry = false
    @Published private(set) var displays: [Display] = []
    @Published private(set) var displayID = 0
    @Published private(set) var fps = 10
    @Published private(set) var zoom = 100
    @Published private(set) var backend = "auto"
    @Published var needsLogin = false
    @Published private(set) var needsUsername = true
    @Published var notice: String?
    private var settings: ConnectionSettings
    private var client: TermbridgeClient?
    private var loaded = false
    private var ready = false
    private var started = false
    private(set) var closed = false
    private var generation = 0
    private var loginRequestID: String?
    private var pendingCredentials: DesktopLoginCredentials?
    private var rememberLogin = false
    private var usedSavedLogin = false
    // Preserve save/forget order while keeping Keychain waits off the UI thread.
    private let credentialQueue = DispatchQueue(label: "dev.termbridge.desktop-credentials")
    private let handler = MacDesktopScriptHandler()

    static var resourceURL: URL? {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("TermBridgeControlCenter_TermBridgeControlCenter.bundle")
        let bundle = packaged.flatMap(Bundle.init(url:)) ?? Bundle.module
        return bundle.url(forResource: "index", withExtension: "html", subdirectory: "Desktop")
    }

    init(profile: ConnectionSettings) {
        self.profile = profile; settings = profile
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
        handler.session = self
        config.userContentController.add(handler, name: "desktop")
        web.navigationDelegate = self
        web.setAccessibilityLabel("远程桌面：\(profile.displayName)")
        if let url = Self.resourceURL { web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
        else { status = "桌面组件缺失，请重新安装 TermBridge。" }
    }

    func configureAppearance(dark: Bool) {
        guard loaded, !closed else { return }
        evaluate("configure", ["nativeControls": true, "fps": UserDefaults.standard.integer(forKey: "desktopFrameRate"),
            "appearance": dark ? "dark" : "light", "background": dark ? "#111111" : "#F5F5F5",
            "foreground": dark ? "#EEEEEE" : "#1D1D1F", "muted": dark ? "#AAAAAA" : "#686868", "accent": "#007AFF"])
    }

    func connect() {
        guard loaded, !closed else { return }
        generation += 1; clearLoginAttempt()
        let old = client; client = nil; old?.disconnect()
        ready = false; started = false; connected = false; retry = false
        web.evaluateJavaScript("window.Desktop?.disconnected()")
        status = "正在连接桌面…"
        let next = TermbridgeClient(settings: settings, listener: self)
        client = next; next.connect()
    }

    func close() {
        guard !closed else { return }
        closed = true; generation += 1; clearLoginAttempt()
        let old = client; client = nil; old?.disconnect()
        ready = false; started = false; connected = false
        web.evaluateJavaScript("window.Desktop?.disconnected()")
        web.stopLoading(); web.navigationDelegate = nil
        web.configuration.userContentController.removeScriptMessageHandler(forName: "desktop")
        handler.session = nil
    }

    func send(_ action: String, _ value: Any? = nil) {
        guard !closed else { return }
        if action == "reconnect" { connect(); return }
        if action == "fps", let value = value as? Int, [10, 20, 30].contains(value) {
            UserDefaults.standard.set(value, forKey: "desktopFrameRate")
        }
        var message: [String: Any] = ["action": action]
        if let value { message["value"] = value }
        evaluate("ui", message)
    }

    func submitLogin(username: String, password: String, remember: Bool) {
        guard !closed, let request = loginRequestID else { return }
        pendingCredentials = DesktopLoginCredentials(username: username, password: password)
        rememberLogin = remember; needsLogin = false
        evaluate("ui", ["action": "credentials", "requestId": request, "value": ["username": username, "password": password]])
        if !remember { forgetPassword(showNotice: false) }
    }

    func forgetPassword(showNotice: Bool = true) {
        let store = DesktopCredentialStore(settings: settings)
        credentialQueue.async { store.clear() }
        if showNotice { notice = "已忘记此连接的桌面密码。" }
    }

    private func clearLoginAttempt() {
        loginRequestID = nil; pendingCredentials = nil; rememberLogin = false; usedSavedLogin = false; needsLogin = false
    }

    private func startViewer() {
        guard !closed, ready, loaded, !started, !settings.hostID.isEmpty else { return }
        started = true
        evaluate("start", ["hostId": settings.hostID, "secret": settings.secret, "deviceId": "mac-desktop-\(settings.profileID.uuidString)"])
    }

    private func evaluate(_ method: String, _ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.Desktop?.\(method)(\(json))")
    }

    func receiveScript(_ fields: [String: Any]) {
        guard !closed, let type = fields["t"] as? String else { return }
        if type == "desktop_loaded" {
            loaded = true
            configureAppearance(dark: web.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua)
            connect(); return
        }
        if type == "desktop_state" {
            connected = fields["connected"] as? Bool ?? false
            retry = fields["retry"] as? Bool ?? false
            status = fields["status"] as? String ?? ""
            backend = fields["backend"] as? String ?? "auto"
            fps = fields["fps"] as? Int ?? 10; zoom = fields["zoom"] as? Int ?? 100
            displayID = fields["displayId"] as? Int ?? 0
            displays = (fields["displays"] as? [[String: Any]] ?? []).compactMap {
                guard let id = $0["id"] as? Int, let name = $0["name"] as? String else { return nil }
                return Display(id: id, name: name)
            }
            if retry { needsLogin = false }
            return
        }
        if type == "desktop_credentials" {
            guard let request = fields["requestId"] as? String, !request.isEmpty, request != loginRequestID else { return }
            clearLoginAttempt(); loginRequestID = request
            needsUsername = fields["username"] as? Bool ?? true
            let store = DesktopCredentialStore(settings: settings), current = generation
            // A locked Keychain must not block the window's event loop.
            credentialQueue.async { [weak self] in
                let saved = store.load()
                Task { @MainActor [weak self] in
                    guard let self, !self.closed, self.generation == current, self.loginRequestID == request else { return }
                    if let saved { self.usedSavedLogin = true; self.submitLogin(username: saved.username, password: saved.password, remember: true) }
                    else { self.needsLogin = true }
                }
            }
            return
        }
        if type == "desktop_auth" {
            guard fields["requestId"] as? String == loginRequestID else { return }
            let store = DesktopCredentialStore(settings: settings)
            if fields["state"] as? String == "authenticated", rememberLogin, let value = pendingCredentials {
                let current = generation
                credentialQueue.async { [weak self] in
                    let saved = (try? store.save(value)) != nil
                    Task { @MainActor [weak self] in
                        guard let self, !self.closed, self.generation == current else { return }
                        if !saved { self.notice = "连接成功，但密码未能保存到钥匙串。" }
                    }
                }
            } else if fields["state"] as? String == "rejected", usedSavedLogin { credentialQueue.async { store.clear() } }
            clearLoginAttempt(); return
        }
        if type == "desktop_reconnect" { connect(); return }
        guard ready, [RemoteDesktopProtocol.open, RemoteDesktopProtocol.data].contains(type),
              let bytes = try? JSONSerialization.data(withJSONObject: fields), bytes.count < 90_000 else { return }
        var wire: [String: MessagePackValue] = [:]
        for (key, value) in fields {
            if let string = value as? String { wire[key] = .string(string) }
            else if let number = value as? NSNumber { wire[key] = .int(number.int64Value) }
        }
        if client?.sendControl(wire) != true { web.evaluateJavaScript("window.Desktop?.disconnected()") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url?.standardizedFileURL == Self.resourceURL?.standardizedFileURL ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard !closed else { return }; status = "桌面组件加载失败，请重新打开窗口。"
    }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard self.client === client, !closed else { return }
        switch state {
        case .failed(let message):
            ready = false; started = false; connected = false; retry = true; clearLoginAttempt()
            let reason = client.transportError.map(ConnectionFailure.description) ?? ConnectionFailure.description(message)
            web.callAsyncJavaScript("window.Desktop?.disconnected(reason)", arguments: ["reason": reason], in: nil, in: .page)
            status = reason
        case .disconnected:
            ready = false; started = false; connected = false; retry = true; clearLoginAttempt()
            web.evaluateJavaScript("window.Desktop?.disconnected()")
        default: break
        }
    }
    func clientIsReady(_ client: TermbridgeClient) { guard self.client === client, !closed else { return }; ready = true; startViewer() }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard self.client === client, !closed else { return }
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

@MainActor
private final class MacDesktopScriptHandler: NSObject, WKScriptMessageHandler {
    weak var session: MacRemoteDesktopSession?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let session, message.webView === session.web, message.frameInfo.isMainFrame,
              let fields = message.body as? [String: Any] else { return }
        session.receiveScript(fields)
    }
}
