import CryptoKit
import Foundation

struct MacNotificationRoute: Codable, Equatable {
    let version: Int
    let profileID: UUID?
    let endpoint: String
    let sessionID: String
    let source: String
    let name: String
    let createdAt: TimeInterval?

    init(agent: AgentRecord, profile: ConnectionSettings?) {
        version = 1; profileID = profile?.id; endpoint = Self.endpoint(profile)
        sessionID = agent.sessionId; source = agent.source; name = String(agent.displayName.prefix(128))
        createdAt = agent.createdAt
    }
    static func endpoint(_ profile: ConnectionSettings?) -> String {
        guard let profile else { return "local" }
        // Neither credentials nor a private relay/room URL enter notification data.
        let identity = [profile.relayURL.trimmingCharacters(in: .whitespacesAndNewlines), profile.hostID,
                        profile.normalizedFingerprint].joined(separator: "\n")
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    var key: String { MacConnectionCatalog.terminalKey(profileID: profileID, sessionID: sessionID) }
    var userInfo: [AnyHashable: Any] {
        guard let data = try? JSONEncoder().encode(self), let value = String(data: data, encoding: .utf8) else { return [:] }
        return ["termbridge.route": value]
    }
    init?(userInfo: [AnyHashable: Any]) {
        guard let value = userInfo["termbridge.route"] as? String, value.utf8.count <= 4096,
              let route = try? JSONDecoder().decode(Self.self, from: Data(value.utf8)), route.version == 1,
              route.sessionID.range(of: #"^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$"#, options: .regularExpression) != nil,
              ["herdr", "pty", "direct"].contains(route.source), route.name.count <= 128,
              route.createdAt.map({ $0.isFinite && $0 > 0 }) ?? true,
              route.profileID == nil ? route.endpoint == "local" : route.endpoint.count == 64 else { return nil }
        self = route
    }
    func resolve(in profiles: [ConnectionSettings]) throws -> ConnectionSettings? {
        guard let profileID else { return nil }
        guard let profile = profiles.first(where: { $0.id == profileID }) else {
            throw Failure("此通知的连接源已被删除，请重新添加连接后从会话列表打开。")
        }
        guard Self.endpoint(profile) == endpoint else {
            throw Failure("此通知的连接地址或 Host 已改变，请从当前会话列表重新打开。")
        }
        return profile
    }
    func matches(_ record: AgentRecord) -> Bool {
        record.sessionId == sessionID && record.source == source && record.present
            && (source == "herdr" || (createdAt != nil && record.createdAt == createdAt))
    }
    var agent: AgentRecord {
        AgentRecord(sessionId: sessionID, source: source, name: name, workspace: nil, paneId: nil,
            agent: nil, status: "ready", preview: nil, lastSeenAt: 0, statusChangedAt: 0, present: true, createdAt: createdAt)
    }
    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
}

/// One baseline per connection, independent of which tab is on screen.
struct MacNotificationTransitions {
    private var previous: [String: [String: String]] = [:]
    mutating func changes(_ records: [AgentRecord], scope: String) -> [AgentRecord] {
        let current = Dictionary(records.map { ($0.sessionId, $0.status.lowercased()) }, uniquingKeysWith: { _, last in last })
        let old = previous.updateValue(current, forKey: scope)
        guard let old else { return [] }
        return records.filter { old[$0.sessionId] != $0.status.lowercased() && ($0.needsAttention || $0.status.lowercased() == "done") }
    }
    mutating func remove(scope: String) { previous.removeValue(forKey: scope) }
}
