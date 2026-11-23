import Combine
import Foundation

/// A dedicated connection pins a creation request to the Host chosen at opening.
/// Never retry session_create: losing its acknowledgement is an uncertain outcome.
@MainActor
final class MacSessionCreation: ObservableObject, @preconcurrency TermbridgeClientListener {
    enum Phase: Equatable { case idle, connecting, choosing, creating, finished, failed }
    @Published private(set) var phase: Phase = .idle
    @Published private(set) var agents: [String] = []
    @Published private(set) var error: String?
    @Published var agent = ""
    @Published var directory = ""
    let profile: ConnectionSettings
    let sourceName: String
    var onCreated: ((AgentRecord) -> Void)?
    private var createdSession: TerminalSessionController?
    private var client: TermbridgeClient?
    private var timeout: Task<Void, Never>?

    init(profile: ConnectionSettings, sourceName: String) {
        self.profile = profile
        self.sourceName = sourceName
    }

    func connect() {
        guard phase == .idle else { return }
        guard !profile.hostID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            fail("请先在列表中选择具体的 Host 标签，再新建对话。"); return
        }
        phase = .connecting
        let client = TermbridgeClient(settings: profile, listener: self)
        self.client = client
        armTimeout(seconds: 20)
        client.connect()
    }

    func create() {
        guard phase == .choosing else { return }
        guard agent.isEmpty || agents.contains(agent) else { error = "请选择此 Host 已配置的 Agent。"; return }
        let cwd = directory.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cwd.utf8.count <= 4096, !cwd.contains("\0") else { error = "工作目录无效或过长。"; return }
        error = nil
        phase = .creating
        armTimeout(seconds: 30)
        var fields: [String: MessagePackValue] = [
            "t": .string("session_create"), "cols": .int(100), "rows": .int(28),
            "clientPlatform": .string("macos"), "clientName": .string(Host.current().localizedName ?? "Mac")
        ]
        if !agent.isEmpty { fields["agent"] = .string(agent) }
        if !cwd.isEmpty { fields["cwd"] = .string(cwd) }
        client?.sendControl(fields)
    }

    func cancel() {
        // Window dismissal cannot discard an in-flight creation acknowledgement.
        guard phase != .creating else { return }
        closeConnection()
        createdSession?.disconnect(); createdSession = nil
    }

    /// The window/container takes sole ownership; dismissing the creation sheet
    /// must then leave the terminal's original connection running.
    func takeCreatedSession() -> TerminalSessionController? {
        let session = createdSession
        createdSession = nil
        return session
    }

    private func armTimeout(seconds: UInt64) {
        timeout?.cancel()
        timeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) } catch { return }
            guard let self else { return }
            self.fail(self.phase == .creating
                ? "未收到创建结果。会话可能已创建，请刷新此 Host 的列表后确认，避免重复创建。"
                : "连接 Host 超时，请检查连接设置后重新打开新建对话。")
        }
    }

    private func fail(_ message: String) {
        guard phase != .finished, phase != .failed else { return }
        error = message; phase = .failed
        closeConnection()
    }

    private func closeConnection() {
        timeout?.cancel(); timeout = nil
        let previous = client; client = nil; previous?.disconnect()
    }

    func clientIsReady(_ client: TermbridgeClient) {
        guard client === self.client, phase == .connecting else { return }
        client.sendControl(["t": .string("config_get")])
    }

    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard client === self.client else { return }
        switch state {
        case .failed, .disconnected:
            fail(phase == .creating
                ? "创建时连接中断。请刷新此 Host 的列表确认结果，不要直接重复创建。"
                : "无法连接此 Host，请检查连接设置后重新打开新建对话。")
        default: break
        }
    }

    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard client === self.client else { return }
        switch message.type {
        case "config_info" where phase == .connecting:
            if case .map(let configured) = message.fields["agents"] {
                agents = configured.keys.sorted()
            }
            agent = agents.contains("codex") ? "codex" : agents.contains("claude") ? "claude" : agents.first ?? ""
            timeout?.cancel(); timeout = nil; phase = .choosing
        case "session_created" where phase == .creating:
            guard let id = message.string("sessionId"), !id.isEmpty,
                  let sid = message.int("sid"), sid > 0 else {
                fail("Host 返回的会话标识无效，请刷新列表确认创建结果。"); return
            }
            let now = Date().timeIntervalSince1970 * 1000
            let record = AgentRecord(sessionId: id, source: "pty", name: agent.isEmpty ? "Terminal" : agent,
                workspace: nil, paneId: nil, agent: agent.isEmpty ? nil : agent, status: "ready",
                preview: nil, lastSeenAt: now, statusChangedAt: now, present: true)
            // The Host has already attached this client. Start its emulator
            // immediately so startup queries are answered even before a window
            // appears. A disconnect/reattach here loses output and can make a
            // TUI time out and exit before the second connection is ready.
            let session = TerminalSessionController(agent: record, launch: nil, connection: profile)
            session.adoptCreatedConnection(client, sid: sid)
            createdSession = session
            timeout?.cancel(); timeout = nil
            self.client = nil
            phase = .finished
            onCreated?(record)
        case "error":
            // Host errors may contain commands or paths; do not log remote details.
            fail(phase == .creating
                ? "Host 无法创建会话，请检查 Agent 命令和 Host 上的工作目录，再刷新列表确认。"
                : "Host 拒绝了连接，请检查 Host ID 和配对设置。")
        default: break
        }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
