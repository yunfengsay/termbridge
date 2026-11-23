import Foundation
import UserNotifications

final class NotificationCoordinator: NSObject, UNUserNotificationCenterDelegate {
  static let shared = NotificationCoordinator()
  private var pendingRoute: [AnyHashable: Any]?

  func configure() {
    UNUserNotificationCenter.current().delegate = self
  }

  func requestAuthorization() {
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) {
      _, _ in
    }
  }

  func notifyCompletion(_ session: SessionInfo, profile: ConnectionSettings) {
    let content = UNMutableNotificationContent()
    content.title = "Agent finished"
    content.body = "\(session.displayName) completed on \(profile.displayName)"
    if let preview = session.preview?.trimmingCharacters(in: .whitespacesAndNewlines),
      !preview.isEmpty { content.subtitle = String(preview.prefix(140)) }
    content.sound = .default
    content.threadIdentifier = "termbridge:\(profile.hostID)"
    content.userInfo = [
      NotificationRouteKey.hostID: profile.hostID,
      NotificationRouteKey.sessionID: session.sessionID,
      NotificationRouteKey.displayName: session.displayName,
      NotificationRouteKey.source: session.source,
    ]
    let identifier = "\(profile.hostID):\(session.sessionID):\(Int(session.completedAtMilliseconds ?? 0))"
    UNUserNotificationCenter.current().add(
      UNNotificationRequest(identifier: identifier, content: content, trigger: nil))
  }

  func takePendingRoute() -> [AnyHashable: Any]? {
    defer { pendingRoute = nil }
    return pendingRoute
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .list, .sound]
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    await MainActor.run { self.postRoute(response.notification.request.content.userInfo) }
  }

  @MainActor private func postRoute(_ userInfo: [AnyHashable: Any]) {
    guard let sessionID = userInfo[NotificationRouteKey.sessionID] as? String else { return }
    pendingRoute = userInfo
    NotificationCenter.default.post(
      name: .termbridgeOpenSession,
      object: nil,
      userInfo: [
        NotificationRouteKey.hostID: userInfo[NotificationRouteKey.hostID] as? String ?? "",
        NotificationRouteKey.sessionID: sessionID,
        NotificationRouteKey.displayName: userInfo[NotificationRouteKey.displayName] as? String ?? "Agent",
        NotificationRouteKey.source: userInfo[NotificationRouteKey.source] as? String ?? "herdr",
      ])
  }
}
