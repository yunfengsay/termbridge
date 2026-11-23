import Foundation

/// How sessions open on this Mac: each in a window of its own, or all in one
/// navigator window listed by workspace the way Herdr shows them.
enum SessionWindowMode: String, CaseIterable, Identifiable {
    case standalone, navigator
    static let defaultsKey = "session.windowMode"
    var id: String { rawValue }

    static func load(from defaults: UserDefaults = .standard) -> Self {
        Self(rawValue: defaults.string(forKey: defaultsKey) ?? "") ?? .standalone
    }

    var title: String {
        switch self {
        case .standalone: return "独立窗口"
        case .navigator: return "按目录导航"
        }
    }

    /// One line under the option in settings. Both are always shown, so
    /// switching never changes the height of the page.
    var summary: String {
        switch self {
        case .standalone: return "每个会话一个窗口"
        case .navigator: return "一个窗口按工作区切换"
        }
    }

    /// The rest, for the tooltip.
    var detail: String {
        switch self {
        case .standalone:
            return "每个会话单独一个窗口。关闭窗口只断开连接，Agent 继续运行。"
        case .navigator:
            return "与 Herdr 相同：所有会话在一个窗口里，左侧按工作区（项目目录）列出 Agent 和状态，点选即切换。"
                + "最近查看的 \(SessionNavigatorController.liveLimit) 个会话保持连接，切回即时；更早的只断开查看，Agent 继续运行。"
        }
    }
}

/// The navigator's list: every Agent under the Herdr workspace it runs in,
/// which is normally one project directory. Sessions without a workspace (TB
/// PTYs) share a final group.
///
/// Groups and rows keep their places when an Agent changes status, so the list
/// never moves under the pointer; the status is shown on the row instead.
enum SessionDirectory {
    struct Group: Identifiable, Equatable {
        /// The workspace label, or "" for sessions without one.
        let id: String
        let title: String
        let rows: [Row]
        var attention: Int { rows.filter { $0.agent.needsAttention }.count }
        var working: Int { rows.filter { $0.agent.isWorking }.count }
    }

    struct Row: Identifiable, Equatable {
        let agent: AgentRecord
        let title: String
        var id: String { agent.sessionId }
        /// The status, then the Agent's latest summary on the same line.
        var detail: String {
            let status = SessionDirectory.statusLabel(agent.status)
            guard let preview = clean(agent.preview?.replacingOccurrences(of: "\n", with: " ")) else { return status }
            return status + " · " + String(preview.prefix(160))
        }
    }

    static let otherGroupTitle = "其他会话"

    static func groups(_ agents: [AgentRecord]) -> [Group] {
        Dictionary(grouping: agents) { clean($0.workspace) ?? "" }
            .map { workspace, members -> Group in
                let ordered = members.sorted { $0.sessionId.localizedStandardCompare($1.sessionId) == .orderedAscending }
                let titles = ordered.map { baseTitle($0, workspace: workspace.isEmpty ? nil : workspace) }
                let rows = zip(ordered, titles).map { agent, title in
                    // Two Claudes in one directory are told apart by their pane.
                    Row(agent: agent, title: titles.filter { $0 == title }.count > 1 ? "\(title) · \(shortID(agent))" : title)
                }
                return Group(id: workspace, title: workspace.isEmpty ? otherGroupTitle : workspace, rows: rows)
            }
            .sorted { left, right in
                if left.id.isEmpty != right.id.isEmpty { return right.id.isEmpty }
                switch left.title.localizedStandardCompare(right.title) {
                case .orderedAscending: return true
                case .orderedDescending: return false
                case .orderedSame: return left.id < right.id
                }
            }
    }

    /// The row's name for one session, outside any list.
    static func title(_ agent: AgentRecord) -> String {
        baseTitle(agent, workspace: clean(agent.workspace))
    }

    static func baseTitle(_ agent: AgentRecord, workspace: String?) -> String {
        let name = clean(agent.name)
        // Herdr falls back to the workspace label when an Agent has no name of
        // its own; repeating the group's title on every row would say nothing.
        if let name, name != workspace { return name }
        if let kind = clean(agent.agent) {
            return kind == kind.lowercased() ? kind.prefix(1).uppercased() + kind.dropFirst() : kind
        }
        return workspace == nil ? name ?? agent.sessionId : "终端"
    }

    /// Herdr's pane within its workspace (`p2`), or the start of a TB session ID.
    static func shortID(_ agent: AgentRecord) -> String {
        let herdr = agent.sessionId.hasPrefix("herdr:") ? String(agent.sessionId.dropFirst("herdr:".count)) : nil
        if let pane = clean(agent.paneId) ?? herdr {
            return pane.split(separator: ":").last.map(String.init) ?? pane
        }
        return String(agent.sessionId.prefix(8))
    }

    static func statusLabel(_ status: String) -> String {
        switch status.lowercased() {
        case "working", "running", "active": return "工作中"
        case "waiting", "blocked": return "等待处理"
        case "approval": return "等待批准"
        case "failed", "error": return "出错"
        case "done": return "已完成"
        case "idle": return "空闲"
        case "ready": return "就绪"
        case "unknown", "": return "状态未知"
        default: return status
        }
    }
}

private func clean(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    return trimmed
}
