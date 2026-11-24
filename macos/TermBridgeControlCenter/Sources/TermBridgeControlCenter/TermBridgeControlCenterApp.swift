import AppKit
import SwiftUI

@main
struct TermBridgeControlCenterApp: App {
    @NSApplicationDelegateAdaptor(MacNotificationAppDelegate.self) private var appDelegate
    @StateObject private var model = ControlCenterModel()

    init() {
        TermbridgeClient.setDiagnosticHandler { AppDiagnostics.shared.record($0, $1) }
        AppDiagnostics.shared.record("app.started", [
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "development",
            "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "development"])
    }

    var body: some Scene {
        WindowGroup("TermBridge", id: "sessions") {
            ControlCenterView(model: model)
        }
        .windowResizability(.contentSize)
        .commands {
            NewSessionCommands(model: model)
            CommandGroup(after: .appInfo) { CheckAppUpdateButton(updater: .shared) }
            // The secondary way back to a session's own terminal. Which view a
            // session opens in belongs in settings; this is here for the case
            // where the conversation cannot be shown and the user needs the
            // terminal for *this* session rather than whichever Host is current.
            CommandGroup(after: .toolbar) {
                Button("打开当前 Host 的远程桌面", action: model.openDesktop)
                    .keyboardShortcut("r", modifiers: [.command, .shift])
                Button("打开当前 Host 的代理浏览器", action: model.openProxyBrowser)
                    .keyboardShortcut("b", modifiers: [.command, .shift])
                Button("在终端中打开此会话") {
                    NSApp.sendAction(#selector(TerminalWindowController.showTerminalForSession(_:)), to: nil, from: nil)
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])
                // The way back, in the same window: switching views must not
                // cost the draft or reopen the session.
                Button("在对话中打开此会话") {
                    NSApp.sendAction(#selector(TerminalWindowController.showChatForSession(_:)), to: nil, from: nil)
                }
                .keyboardShortcut("d", modifiers: [.command, .shift])
                Button("查看此会话的改动") {
                    NSApp.sendAction(#selector(TerminalWindowController.showChangesForSession(_:)), to: nil, from: nil)
                }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                // Moving through the navigator's list without leaving the session.
                Divider()
                Button("下一个会话") {
                    NSApp.sendAction(#selector(SessionNavigatorController.selectNextSession(_:)), to: nil, from: nil)
                }
                .keyboardShortcut(.downArrow, modifiers: [.command, .option])
                Button("上一个会话") {
                    NSApp.sendAction(#selector(SessionNavigatorController.selectPreviousSession(_:)), to: nil, from: nil)
                }
                .keyboardShortcut(.upArrow, modifiers: [.command, .option])
            }
        }
        Window("新建对话", id: "new-session") {
            if let creator = model.sessionCreator {
                NewSessionView(creator: creator).id(ObjectIdentifier(creator))
            } else {
                Text(model.sessionCreationError ?? "请先从会话列表选择一个 Host。")
                    .padding(24).frame(width: 440)
            }
        }.windowResizability(.contentSize)
        Window("设置", id: "connection-settings") {
            ConnectionSettingsView(model: model)
        }.windowResizability(.contentSize)
        Settings {
            ConnectionSettingsView(model: model)
        }
        MenuBarExtra {
            ControlCenterView(model: model)
        } label: {
            Label(model.menuTitle, systemImage: model.attentionCount > 0 ? "exclamationmark.circle.fill" : "point.3.connected.trianglepath.dotted")
        }
        .menuBarExtraStyle(.window)
    }
}
