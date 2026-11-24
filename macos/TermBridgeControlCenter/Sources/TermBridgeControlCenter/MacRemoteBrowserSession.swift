import AppKit
import Combine
import Network
import WebKit

/// Owns one per-window WKWebView whose network traffic is routed exclusively through
/// the target Host's TermBridge Relay via a local loopback SOCKS5 proxy.
@MainActor
final class MacRemoteBrowserSession: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, @preconcurrency TermbridgeClientListener, MacProxyTunnelTransport {
    let profile: ConnectionSettings
    let web: WKWebView

    @Published var urlText: String
    @Published private(set) var status = "正在连接代理通道…"
    @Published private(set) var isError = false
    @Published private(set) var connected = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    @Published private(set) var isLoading = false
    @Published private(set) var progress: Double = 0
    @Published private(set) var supported = true

    private var client: TermbridgeClient?
    private let transportLock = NSLock()
    private nonisolated(unsafe) var liveTransportClient: TermbridgeClient?
    private var proxyServer: MacLocalProxyServer?
    private var pendingURL: URL?
    private(set) var closed = false
    private var observations: [NSKeyValueObservation] = []

    init(profile: ConnectionSettings, initialURL: URL?) {
        self.profile = profile
        let normalized = initialURL.flatMap { MacRemoteBrowserPolicy.normalizeEntryURL($0.absoluteString) }
        self.pendingURL = normalized
        self.urlText = normalized?.absoluteString ?? "http://127.0.0.1:"

        let config = WKWebViewConfiguration()
        let store = WKWebsiteDataStore.nonPersistent()
        config.websiteDataStore = store
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true

        web = WKWebView(frame: .zero, configuration: config)
        super.init()
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.setAccessibilityLabel("代理浏览器：\(profile.displayName)")

        observations = [
            web.observe(\.canGoBack, options: [.new]) { [weak self] w, _ in
                Task { @MainActor [weak self] in self?.canGoBack = w.canGoBack }
            },
            web.observe(\.canGoForward, options: [.new]) { [weak self] w, _ in
                Task { @MainActor [weak self] in self?.canGoForward = w.canGoForward }
            },
            web.observe(\.isLoading, options: [.new]) { [weak self] w, _ in
                Task { @MainActor [weak self] in self?.isLoading = w.isLoading }
            },
            web.observe(\.estimatedProgress, options: [.new]) { [weak self] w, _ in
                Task { @MainActor [weak self] in self?.progress = w.estimatedProgress }
            },
            web.observe(\.url, options: [.new]) { [weak self] w, _ in
                Task { @MainActor [weak self] in
                    if let current = w.url?.absoluteString, !current.isEmpty { self?.urlText = current }
                }
            },
        ]

        if #available(macOS 14.0, *) {
            do {
                let server = try MacLocalProxyServer(transport: self, requireSocksAuth: true)
                proxyServer = server
                if let nwPort = NWEndpoint.Port(rawValue: server.port) {
                    let endpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: nwPort)
                    var proxy = ProxyConfiguration(socksv5Proxy: endpoint)
                    proxy.applyCredential(username: server.authUsername, password: server.authPassword)
                    proxy.allowFailover = false
                    proxy.excludedDomains = []
                    store.proxyConfigurations = [proxy]
                }
                connect()
            } catch {
                supported = false
                isError = true
                status = "无法启动本地代理端口：\(error.localizedDescription)"
            }
        } else {
            supported = false
            isError = true
            status = "内置代理浏览器需要 macOS 14 或更高版本。"
        }
    }

    func connect() {
        guard supported, !closed else { return }
        connected = false
        isError = false
        status = "正在连接 \(profile.displayName) 代理通道…"
        transportLock.withLock { liveTransportClient = nil }
        proxyServer?.resetAllTunnels(reason: "Reconnecting")
        let old = client; client = nil; old?.disconnect()
        let next = TermbridgeClient(settings: profile, listener: self)
        client = next
        next.connect()
    }

    func navigate(to raw: String) {
        guard supported, !closed else { return }
        guard let url = MacRemoteBrowserPolicy.normalizeEntryURL(raw) else {
            isError = true
            status = "请输入有效的 http:// 或 https:// 地址"
            return
        }
        urlText = url.absoluteString
        isError = false
        pendingURL = url
        maybeLoadPending()
    }

    func open(url: URL) {
        navigate(to: url.absoluteString)
    }

    func goBack() { if web.canGoBack { web.goBack() } }
    func goForward() { if web.canGoForward { web.goForward() } }
    func reloadOrStop() {
        if web.isLoading { web.stopLoading() }
        else if !connected { connect() }
        else if web.url != nil { web.reload() }
        else { navigate(to: urlText) }
    }

    func close() {
        guard !closed else { return }
        closed = true
        connected = false
        transportLock.withLock { liveTransportClient = nil }
        observations.removeAll()
        proxyServer?.close(); proxyServer = nil
        let old = client; client = nil; old?.disconnect()
        web.stopLoading()
        web.navigationDelegate = nil
        web.uiDelegate = nil
    }

    private func maybeLoadPending() {
        guard connected, supported, !closed, let target = pendingURL else { return }
        pendingURL = nil
        web.load(URLRequest(url: target))
    }

    // MARK: - TermbridgeClientListener

    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard self.client === client, !closed else { return }
        switch state {
        case .connecting, .authenticating:
            connected = false; isError = false
            status = "正在连接 \(profile.displayName) 代理通道…"
        case .connected:
            break
        case .disconnected:
            connected = false; isError = true
            transportLock.withLock { liveTransportClient = nil }
            proxyServer?.resetAllTunnels(reason: "Relay disconnected")
            status = "代理通道已断开"
        case .failed(let message):
            connected = false; isError = true
            transportLock.withLock { liveTransportClient = nil }
            proxyServer?.resetAllTunnels(reason: message)
            let reason = client.transportError.map(ConnectionFailure.description) ?? ConnectionFailure.description(message)
            status = "代理连接失败：\(reason)"
        }
    }

    func clientIsReady(_ client: TermbridgeClient) {
        guard self.client === client, !closed else { return }
        connected = true; isError = false
        transportLock.withLock { liveTransportClient = client }
        status = "代理 · \(profile.displayName)"
        maybeLoadPending()
    }

    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard self.client === client, !closed, message.type == ProxyTunnelProtocol.type else { return }
        guard let id = message.string("id"), let kind = message.string("kind") else { return }
        switch kind {
        case ProxyTunnelProtocol.kindOpened:
            proxyServer?.onTunnelOpened(id: id)
        case ProxyTunnelProtocol.kindData:
            if let data = message.string("data") { proxyServer?.onTunnelData(id: id, base64Data: data) }
        case ProxyTunnelProtocol.kindClose:
            proxyServer?.onTunnelClosed(id: id, reason: message.string("reason"))
        default:
            break
        }
    }

    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}

    // MARK: - MacProxyTunnelTransport (lock-guarded off-main-thread fast path)

    nonisolated func sendTunnelOpen(id: String, host: String, port: Int) -> Bool {
        guard let active = transportLock.withLock({ liveTransportClient }) else { return false }
        return active.sendControl([
            "t": .string(ProxyTunnelProtocol.type),
            "id": .string(id),
            "kind": .string(ProxyTunnelProtocol.kindOpen),
            "host": .string(host),
            "port": .int(Int64(port)),
        ])
    }

    nonisolated func sendTunnelData(id: String, base64Data: String) -> Bool {
        guard let active = transportLock.withLock({ liveTransportClient }) else { return false }
        return active.sendControl([
            "t": .string(ProxyTunnelProtocol.type),
            "id": .string(id),
            "kind": .string(ProxyTunnelProtocol.kindData),
            "data": .string(base64Data),
        ])
    }

    nonisolated func sendTunnelAck(id: String, bytes: Int) -> Bool {
        guard let active = transportLock.withLock({ liveTransportClient }) else { return false }
        return active.sendControl([
            "t": .string(ProxyTunnelProtocol.type),
            "id": .string(id),
            "kind": .string(ProxyTunnelProtocol.kindAck),
            "bytes": .int(Int64(bytes)),
        ])
    }

    nonisolated func sendTunnelClose(id: String, reason: String?) -> Bool {
        guard let active = transportLock.withLock({ liveTransportClient }) else { return false }
        var fields: [String: MessagePackValue] = [
            "t": .string(ProxyTunnelProtocol.type),
            "id": .string(id),
            "kind": .string(ProxyTunnelProtocol.kindClose),
        ]
        if let reason, !reason.isEmpty { fields["reason"] = .string(String(reason.prefix(512))) }
        return active.sendControl(fields)
    }

    // MARK: - WKNavigationDelegate / WKUIDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let scheme = navigationAction.request.url?.scheme?.lowercased(),
              scheme == "http" || scheme == "https" || scheme == "about" else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        // Keep target="_blank" links inside the same proxied browser window.
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url {
            webView.load(URLRequest(url: url))
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !closed, connected else { return }
        isError = false
        status = "代理 · \(profile.displayName)"
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard !closed else { return }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        isError = true
        status = "加载失败：\(error.localizedDescription)"
    }
}
