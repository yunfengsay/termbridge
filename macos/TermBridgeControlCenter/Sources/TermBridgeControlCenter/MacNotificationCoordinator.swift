import AppKit
import Combine
import UserNotifications

@MainActor
final class MacNotificationCoordinator: NSObject, ObservableObject, @preconcurrency UNUserNotificationCenterDelegate {
    static let shared = MacNotificationCoordinator()
    @Published private(set) var permissionStatus = "正在检查系统通知权限"
    @Published private(set) var deliveryError: String?
    private var pending: [MacNotificationRoute] = []
    private var routeHandler: ((MacNotificationRoute) -> Void)?
    private var errorHandler: ((String) -> Void)?
    private var pendingError: String?
    // Lazy access permits isolated routing tests without requesting OS permission.
    private var center: UNUserNotificationCenter { .current() }

    func configure() { center.delegate = self }
    func bind(open: @escaping (MacNotificationRoute) -> Void, error: @escaping (String) -> Void) {
        routeHandler = open; errorHandler = error
        let routes = pending; pending = []
        for route in routes { open(route) }
        if let pendingError { error(pendingError); self.pendingError = nil }
    }
    func receive(action: String, userInfo: [AnyHashable: Any]) {
        guard action == UNNotificationDefaultActionIdentifier else { return }
        guard let route = MacNotificationRoute(userInfo: userInfo) else {
            let message = "这条通知来自旧版本或已失效，请从会话列表打开。"
            if let errorHandler { errorHandler(message) } else { pendingError = message }
            return
        }
        if let routeHandler { routeHandler(route) }
        else {
            pending.removeAll { $0.key == route.key }
            pending.append(route)
            if pending.count > 16 { pending.removeFirst() }
        }
    }
    static func request(agent: AgentRecord, profile: ConnectionSettings?) -> UNNotificationRequest {
        let route = MacNotificationRoute(agent: agent, profile: profile)
        let content = UNMutableNotificationContent()
        content.title = agent.needsAttention ? "Agent 需要处理" : "Agent 已完成"
        content.subtitle = "\(profile?.displayName ?? "本机") · \(agent.displayName)"
        content.body = String(agent.summary.prefix(180))
        content.sound = agent.needsAttention ? .default : nil
        content.userInfo = route.userInfo
        content.threadIdentifier = profile?.id.uuidString ?? "local"
        return UNNotificationRequest(identifier: "tb:\(route.key):\(route.endpoint)", content: content, trigger: nil)
    }
    func deliver(_ request: UNNotificationRequest) {
        center.add(request) { [weak self] error in
            Task { @MainActor in
                self?.deliveryError = error == nil ? nil : "通知发送失败，请检查系统通知权限。"
            }
        }
    }
    func refreshPermission(requestIfNeeded: Bool = false) {
        Task {
            var settings = await center.notificationSettings()
            if requestIfNeeded && settings.authorizationStatus == .notDetermined {
                do { _ = try await center.requestAuthorization(options: [.alert, .sound]) }
                catch { deliveryError = "无法请求通知权限，请在系统设置中检查。" }
                settings = await center.notificationSettings()
            }
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                permissionStatus = settings.alertSetting == .enabled ? "系统通知已允许" : "已允许通知，横幅提醒已关闭；可在系统设置中开启。"
            case .denied: permissionStatus = "系统通知已关闭，请到系统设置 → 通知 → TermBridge 开启。"
            case .notDetermined: permissionStatus = "尚未授权系统通知"
            default: permissionStatus = "请检查系统通知设置"
            }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        receive(action: response.actionIdentifier, userInfo: response.notification.request.content.userInfo)
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        UserDefaults.standard.object(forKey: "agentNotificationsEnabled") as? Bool == false ? [] : [.banner, .list, .sound]
    }
}

final class MacNotificationAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        MacAppUpdater.shared.start()
        MacLANServices.shared.resume()
        MacCLIInstaller.shared.start()
        MacAppControl.shared.handler = { request in try await MacLANAutomation.shared.handle(request) }
        do { try MacAppControl.shared.start() }
        catch { AppDiagnostics.shared.record("app.control_unavailable") }
    }
    func applicationWillTerminate(_ notification: Notification) {
        AppDiagnostics.shared.record("app.stopping")
        MacAppControl.shared.stop()
        MacLANServices.shared.stop()
        AppDiagnostics.shared.finishPendingWrites()
    }
    func applicationWillFinishLaunching(_ notification: Notification) {
        MacNotificationCoordinator.shared.configure()
    }
}
