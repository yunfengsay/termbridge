import Foundation

struct AgentContextSnapshot: Decodable {
    let generatedAt: TimeInterval
    let records: [AgentRecord]
}

struct AgentRecord: Decodable, Identifiable, Equatable {
    let sessionId: String
    let source: String
    let name: String?
    let workspace: String?
    let paneId: String?
    let agent: String?
    let status: String
    let preview: String?
    let lastSeenAt: TimeInterval
    let statusChangedAt: TimeInterval
    let present: Bool
    var createdAt: TimeInterval? = nil

    static func remoteRecords(_ sessions: [SessionInfo]) -> [AgentRecord] {
        let now = Date().timeIntervalSince1970 * 1000
        return prioritized(sessions.map { session in
            AgentRecord(sessionId: session.sessionID, source: session.source, name: session.name ?? session.command,
                workspace: session.workspace, paneId: session.paneID, agent: session.agent, status: session.status ?? "ready",
                preview: session.preview, lastSeenAt: now, statusChangedAt: session.completedAtMilliseconds ?? 0,
                present: true, createdAt: session.createdAtMilliseconds > 0 ? session.createdAtMilliseconds : nil)
        })
    }

    var id: String { sessionId }
    var displayName: String {
        nonempty(name) ?? nonempty(workspace) ?? nonempty(agent) ?? sessionId
    }
    var summary: String { nonempty(preview) ?? "No recent summary" }
    var needsAttention: Bool { Self.attentionStatuses.contains(status.lowercased()) }
    var isWorking: Bool { Self.workingStatuses.contains(status.lowercased()) }

    static func prioritized(_ records: [AgentRecord]) -> [AgentRecord] {
        records.filter(\.present).sorted { left, right in
            let leftPriority = priority(left.status)
            let rightPriority = priority(right.status)
            if leftPriority != rightPriority { return leftPriority < rightPriority }
            if left.statusChangedAt != right.statusChangedAt { return left.statusChangedAt > right.statusChangedAt }
            return left.displayName.localizedCaseInsensitiveCompare(right.displayName) == .orderedAscending
        }
    }

    private static func priority(_ status: String) -> Int {
        if attentionStatuses.contains(status.lowercased()) { return 0 }
        if workingStatuses.contains(status.lowercased()) { return 1 }
        if status.lowercased() == "done" { return 2 }
        return 3
    }

    private static let attentionStatuses: Set<String> = ["waiting", "approval", "blocked", "failed", "error"]
    private static let workingStatuses: Set<String> = ["working", "running", "active"]
}

private func nonempty(_ value: String?) -> String? {
    value?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
