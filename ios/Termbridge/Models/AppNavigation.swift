import Foundation

/// The sidebar is the Mac switcher. A paired Mac is a destination in its own
/// right — selecting one shows that Mac's sessions — so there is no separate
/// "Sessions" entry to disagree with which Mac is active.
enum SidebarItem: Hashable {
  case global
  case mac(UUID)

  var macProfileID: UUID? {
    guard case .mac(let profileID) = self else { return nil }
    return profileID
  }
}

struct TerminalRoute: Hashable, Identifiable {
  let sessionID: String?
  let agent: String
  let displayName: String
  let source: String

  var id: String { sessionID ?? "new:\(agent)" }
  var isHerdr: Bool { source == "herdr" }

  static func attach(_ session: SessionInfo) -> TerminalRoute {
    TerminalRoute(
      sessionID: session.sessionID, agent: session.agent ?? "shell",
      displayName: session.displayName, source: session.source)
  }

  static func attach(
    sessionID: String, displayName: String, source: String = "pty"
  ) -> TerminalRoute {
    TerminalRoute(sessionID: sessionID, agent: "shell", displayName: displayName, source: source)
  }

  static func create(agent: String) -> TerminalRoute {
    TerminalRoute(
      sessionID: nil, agent: agent, displayName: agent == "shell" ? "Shell" : agent,
      source: "pty")
  }
}

/// Read-only Git review for one attached Session. The Host owns repository
/// discovery, so the route carries the Session ID and nothing filesystem shaped.
struct ReviewRoute: Hashable, Identifiable {
  let sessionID: String
  let displayName: String
  let mode: ReviewMode

  var id: String { "review:\(sessionID):\(mode.rawValue)" }

  static func open(sessionID: String, displayName: String, mode: String?) -> ReviewRoute {
    ReviewRoute(
      sessionID: sessionID, displayName: displayName, mode: ReviewMode.named(mode) ?? .files)
  }
}

extension Notification.Name {
  static let termbridgeOpenSession = Notification.Name("termbridge.open.session")
}

enum NotificationRouteKey {
  static let hostID = "hostId"
  static let sessionID = "sessionId"
  static let displayName = "displayName"
  static let source = "source"
}

/// `termbridge://review?host=…&id=…&name=…&mode=working` opens the read-only Git
/// review for one Session, the same route the terminal's own entry point pushes.
struct ReviewDeepLink: Equatable {
  let hostID: String
  let sessionID: String
  let displayName: String
  let mode: ReviewMode

  init?(url: URL) {
    guard url.scheme?.lowercased() == "termbridge", url.host?.lowercased() == "review",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let sessionID = components.queryItems?.first(where: { $0.name == "id" })?.value,
      !sessionID.isEmpty else { return nil }
    let value: (String) -> String? = { name in
      components.queryItems?.first(where: { $0.name == name })?.value
    }
    hostID = value("host") ?? ""
    self.sessionID = sessionID
    displayName = value("name") ?? "Agent"
    mode = ReviewMode.named(value("mode")) ?? .working
  }

  var route: ReviewRoute {
    ReviewRoute(sessionID: sessionID, displayName: displayName, mode: mode)
  }
}

struct SessionDeepLink: Equatable {
  let hostID: String
  let sessionID: String
  let displayName: String
  let source: String

  init?(url: URL) {
    guard url.scheme?.lowercased() == "termbridge", url.host?.lowercased() == "session",
      let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
      let sessionID = components.queryItems?.first(where: { $0.name == "id" })?.value,
      !sessionID.isEmpty else { return nil }
    let value: (String) -> String? = { name in
      components.queryItems?.first(where: { $0.name == name })?.value
    }
    self.hostID = value("host") ?? ""
    self.sessionID = sessionID
    displayName = value("name") ?? "Agent"
    source = value("source") ?? "herdr"
  }

  init?(userInfo: [AnyHashable: Any]) {
    guard let sessionID = userInfo[NotificationRouteKey.sessionID] as? String,
      !sessionID.isEmpty else { return nil }
    hostID = userInfo[NotificationRouteKey.hostID] as? String ?? ""
    self.sessionID = sessionID
    displayName = userInfo[NotificationRouteKey.displayName] as? String ?? "Agent"
    source = userInfo[NotificationRouteKey.source] as? String ?? "herdr"
  }
}
