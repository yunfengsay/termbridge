import SwiftUI

@main
struct TermbridgeApp: App {
  init() {
    _ = SettingsStore.applyDebugEnvironment()
    NotificationCoordinator.shared.configure()
  }

  var body: some Scene {
    WindowGroup {
      SessionListView()
        .tint(Color(red: 0.34, green: 0.76, blue: 0.46))
    }
  }
}
