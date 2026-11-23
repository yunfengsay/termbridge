import Foundation

/// Resolve only the requested pane in the selected Herdr server. The server owns its lifecycle.
enum HerdrTerminalIdentity {
    static func launch(paneId: String) throws -> TerminalLaunch {
        let (data, executable) = try snapshot()
        return try launch(paneId: paneId, snapshot: data, executable: executable)
    }

    static func currentAgents() throws -> [AgentRecord] {
        try agents(snapshot: snapshot().0)
    }

    /// Listing and attaching resolve the same executable and explicit server
    /// environment. A Host context file may describe a different or old server.
    private static func snapshot() throws -> (Data, String) {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = ["\(home)/.local/bin/herdr", "/opt/homebrew/bin/herdr", "/usr/local/bin/herdr"]
        guard let executable = candidates.first(where: FileManager.default.isExecutableFile(atPath:)) else {
            throw ResolutionError.unavailable
        }
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = ["api", "snapshot"]
        process.environment = TerminalLaunch.herdrEnvironment()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 5, execute: timeout)
        defer { timeout.cancel() }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw ResolutionError.unavailable }
        return (data, executable)
    }

    static func agents(snapshot data: Data, now: Date = Date()) throws -> [AgentRecord] {
        let snapshot = try snapshotObject(data)
        guard let panes = snapshot["panes"] as? [[String: Any]] else { throw ResolutionError.invalidSnapshot }
        let workspaces = snapshot["workspaces"] as? [[String: Any]] ?? []
        let agents = snapshot["agents"] as? [[String: Any]] ?? []
        var seen = Set<String>()
        return try panes.map { pane in
            guard let id = pane["pane_id"] as? String, !id.isEmpty else { throw ResolutionError.invalidSnapshot }
            guard seen.insert(id).inserted else { throw ResolutionError.ambiguousPane }
            let workspaceID = pane["workspace_id"] as? String
            let workspace = workspaces.first { $0["workspace_id"] as? String == workspaceID }
            let agent = agents.first { $0["pane_id"] as? String == id }
            let title = workspace?["label"] as? String ?? workspaceID
            let kind = pane["display_agent"] as? String ?? pane["agent"] as? String ?? agent?["agent"] as? String
            return AgentRecord(sessionId: "herdr:" + id, source: "herdr",
                name: agent?["name"] as? String ?? pane["title"] as? String ?? pane["label"] as? String ?? kind ?? title,
                workspace: title, paneId: id, agent: kind,
                status: agent?["agent_status"] as? String ?? pane["agent_status"] as? String ?? "unknown",
                preview: nil, lastSeenAt: now.timeIntervalSince1970 * 1000, statusChangedAt: 0, present: true)
        }
    }

    static func launch(paneId: String, snapshot data: Data, executable: String) throws -> TerminalLaunch {
        let pane = try exactPane(paneId, snapshot: data)
        if let terminalId = pane["terminal_id"] as? String, !terminalId.isEmpty {
            return try TerminalLaunch(herdrExecutable: executable, terminalId: terminalId)
        }
        // Older snapshots can expose a live Agent without terminal_id. Delegate resolution
        // to Herdr's public agent-attach command, retaining the exact pane as the target.
        if let agent = pane["agent"] as? String, !agent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return try TerminalLaunch(herdrExecutable: executable, agentPaneId: paneId)
        }
        throw ResolutionError.nativeTerminalUnavailable
    }

    static func terminalId(paneId: String, snapshot data: Data) throws -> String {
        let pane = try exactPane(paneId, snapshot: data)
        guard let terminalId = pane["terminal_id"] as? String, !terminalId.isEmpty else {
            throw ResolutionError.nativeTerminalUnavailable
        }
        return terminalId
    }

    static func paneId(sessionId: String, recordedPaneId: String?) throws -> String {
        guard sessionId.hasPrefix("herdr:") else { throw TerminalLaunch.LaunchError.invalidIdentity }
        let id = String(sessionId.dropFirst("herdr:".count))
        guard !id.isEmpty, recordedPaneId == nil || recordedPaneId == id else {
            throw TerminalLaunch.LaunchError.invalidIdentity
        }
        return id
    }

    private static func exactPane(_ paneId: String, snapshot data: Data) throws -> [String: Any] {
        let snapshot = try snapshotObject(data)
        guard let panes = snapshot["panes"] as? [[String: Any]] else { throw ResolutionError.invalidSnapshot }
        let matches = panes.filter { $0["pane_id"] as? String == paneId }
        guard matches.count == 1 else {
            throw matches.isEmpty ? ResolutionError.missingPane : ResolutionError.ambiguousPane
        }
        return matches[0]
    }

    private static func snapshotObject(_ data: Data) throws -> [String: Any] {
        guard let response = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let result = response["result"] as? [String: Any],
              let snapshot = result["snapshot"] as? [String: Any] else {
            throw ResolutionError.invalidSnapshot
        }
        return snapshot
    }

    enum ResolutionError: LocalizedError, Equatable {
        case unavailable, missingPane, ambiguousPane, invalidSnapshot, nativeTerminalUnavailable
        var errorDescription: String? {
            switch self {
            case .unavailable:
                return "无法连接本机 Herdr。请确认 Herdr 已安装且服务正在运行。"
            case .missingPane:
                return "当前 Herdr 服务中没有这个会话。请刷新列表；如果使用了其他 Herdr session，请确认 App 和 Host 连接的是同一服务。"
            case .ambiguousPane:
                return "Herdr 返回了重复的 Pane ID，无法安全确定目标终端。请检查 Herdr 服务。"
            case .invalidSnapshot:
                return "无法识别 Herdr 的会话数据。请检查 Herdr 版本；这不表示会话已经关闭。"
            case .nativeTerminalUnavailable:
                return "会话仍在，但当前 Herdr 未提供直接接入所需的终端信息。请更新 Herdr，并确认运行中的服务也已更新。"
            }
        }
    }
}
