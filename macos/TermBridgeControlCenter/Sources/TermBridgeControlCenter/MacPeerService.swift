import Combine
import Foundation

@MainActor
final class MacPeerService: ObservableObject {
    @Published private(set) var configuration: MacPeerConfiguration
    @Published private(set) var statuses: [String: String] = [:]
    @Published private(set) var error: String?
    private let file: URL?
    private var valid = true
    private var links: [String: MacPeerLink] = [:]

    init(file: URL? = nil) {
        self.file = file
        do { configuration = try MacPeerConfiguration.load(from: file) }
        catch {
            configuration = MacPeerConfiguration(); valid = false
            self.error = "Peer 配置读取失败，已停止开放；请检查 mac-peer.json，不会重置现有授权。"
        }
    }
    static var defaultFile: URL { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/mac-peer.json") }
    func permission(for profile: ConnectionSettings) -> MacPeerPermission {
        valid ? configuration.permissions[MacPeerConfiguration.scope(profile)] ?? MacPeerPermission() : MacPeerPermission()
    }
    func setPermission(_ permission: MacPeerPermission, for profile: ConnectionSettings) {
        guard valid else { return }
        do {
            let key = MacPeerConfiguration.scope(profile)
            var next = configuration; next.permissions[key] = try permission.validated()
            try next.save(to: file)
            links[key]?.cancelRequests()
            configuration = next; error = nil
        } catch { self.error = error.localizedDescription }
    }
    func refresh(profiles: [ConnectionSettings]) {
        guard valid else { return }
        // Auto-discovery profiles do not inherit grants. One independent link
        // per explicit Host/credential boundary survives visible tab changes.
        let targets = Dictionary(profiles.filter { !$0.hostID.isEmpty }.map { (MacPeerConfiguration.scope($0), $0) }, uniquingKeysWith: { first, _ in first })
        for key in Array(links.keys) where targets[key] == nil {
            links.removeValue(forKey: key)?.disconnect(); statuses.removeValue(forKey: key)
            if configuration.permissions[key] != nil {
                var next = configuration; next.permissions.removeValue(forKey: key)
                do { try next.save(to: file); configuration = next }
                catch {
                    valid = false; disconnect()
                    self.error = "连接已移除，但无法持久化撤销授权。Peer 已停止，请检查 mac-peer.json。"
                    return
                }
            }
        }
        for (key, profile) in targets {
            if links[key] == nil {
                let link = MacPeerLink(profile: profile, registration: configuration.registration,
                    permission: { [weak self] in self?.permission(for: profile) ?? MacPeerPermission() })
                link.onStatus = { [weak self] value in
                    if self?.statuses[key] != value { self?.statuses[key] = value }
                }
                links[key] = link
            }
            links[key]?.refresh()
        }
    }
    func disconnect() { links.values.forEach { $0.disconnect() }; links.removeAll(); statuses.removeAll() }
}

/// No session_list polling and no PTY attachment. The manager owns only RPCs.
@MainActor
final class MacPeerLink: @preconcurrency TermbridgeClientListener {
    let profile: ConnectionSettings
    var onStatus: ((String) -> Void)?
    private let registration: [String: MessagePackValue]
    private let permission: () -> MacPeerPermission
    private var client: TermbridgeClient?
    private var retryAt = Date.distantPast
    private var deadline = Date.distantFuture
    private var ready = false
    private var running: [String: MacPeerCancellation] = [:]
    private var completed: [String: [String: MessagePackValue]] = [:]
    private var order: [String] = []

    init(profile: ConnectionSettings, registration: [String: MessagePackValue], permission: @escaping () -> MacPeerPermission) {
        self.profile = profile; self.registration = registration; self.permission = permission
    }
    func refresh(now: Date = Date()) {
        if !ready && client != nil && now >= deadline { failed() }
        guard client == nil, now >= retryAt else { return }
        let next = TermbridgeClient(settings: profile, listener: self, acceptsPeerTools: true)
        client = next; deadline = now.addingTimeInterval(15)
        onStatus?("正在连接"); next.connect()
    }
    func cancelRequests() {
        running.values.forEach { $0.cancel() }
        completed.removeAll(); order.removeAll()
    }
    func disconnect() {
        cancelRequests(); running.removeAll(); completed.removeAll(); order.removeAll()
        client?.disconnect(); client = nil; ready = false; onStatus?("已断开")
    }
    private func failed() { disconnect(); retryAt = Date().addingTimeInterval(5); onStatus?("连接中断，正在重试") }
    func clientIsReady(_ client: TermbridgeClient) {
        guard client === self.client else { return }
        // The transport's hello alone does not prove that a Host is available.
        client.sendControl(["t": .string("agents")])
    }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard client === self.client else { return }
        switch state { case .disconnected, .failed: failed(); default: break }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard client === self.client else { return }
        if message.type == "agents_result" {
            guard client.sendControl(registration) else { failed(); return }
            ready = true; onStatus?("已连接 · 权限由本机控制"); return
        }
        if message.type == "error" { failed(); return }
        guard message.type == "tool_request", let id = message.string("id"), id.utf8.count <= 256 else { return }
        if let result = completed[id] { reply(result, id: id, to: client); return }
        guard running[id] == nil else { return }
        guard ready else { reply(["ok": .bool(false), "error": .string("Peer not ready")], id: id, to: client); return }
        guard running.count < 4 else { reply(["ok": .bool(false), "error": .string("Peer busy: maximum 4 concurrent requests")], id: id, to: client); return }
        let cancellation = MacPeerCancellation(); running[id] = cancellation
        let grant = permission(), op = message.string("op") ?? "", args = message.fields["args"]?.mapValue ?? [:]
        Task {
            let result: [String: MessagePackValue]
            if op == "termbridge.lan" {
                result = await MacLANAutomation.shared.peer(args, permission: grant, cancellation: cancellation)
            } else {
                result = await Task.detached(priority: .utility) {
                    MacPeerExecutor.execute(op: op, args: args, permission: grant, cancellation: cancellation)
                }.value
            }
            // Responses must never cross into a new connection after reconnect.
            guard self.client === client else { return }
            running.removeValue(forKey: id)
            completed[id] = result; order.append(id)
            // A small byte-independent bound prevents retaining many file bodies.
            while order.count > 4 { completed.removeValue(forKey: order.removeFirst()) }
            reply(result, id: id, to: client)
        }
    }
    private func reply(_ result: [String: MessagePackValue], id: String, to client: TermbridgeClient) {
        var fields = result; fields["t"] = .string("tool_response"); fields["id"] = .string(id)
        client.sendControl(fields)
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
