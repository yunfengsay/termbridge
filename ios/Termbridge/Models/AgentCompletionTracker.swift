import Foundation

struct AgentCompletionTracker {
  private var initialized = false
  private var previous: [String: String] = [:]

  mutating func update(_ sessions: [SessionInfo]) -> [SessionInfo] {
    let completed = initialized ? sessions.filter {
      $0.isHerdr && $0.isDone && previous[$0.sessionID]?.lowercased() == "working"
    } : []
    previous = Dictionary(uniqueKeysWithValues: sessions.map { ($0.sessionID, $0.status ?? "") })
    initialized = true
    return completed
  }

  mutating func reset() { initialized = false; previous = [:] }
}
