import AppKit
import XCTest
@testable import TermBridgeControlCenter

/// A notification target that failed validation must stay rejected in both
/// views. These drive the real window, not a description of it.
final class TerminalWindowRouteTests: XCTestCase {
    private static let marker = "TB-ROUTE-FIXTURE-ATTACHED"

    private func agent(_ session: String) -> AgentRecord {
        AgentRecord(sessionId: session, source: "herdr", name: "Route fixture", workspace: "TermBridge",
            paneId: nil, agent: "codex", status: "ready", preview: nil, lastSeenAt: 0,
            statusChangedAt: 0, present: true, createdAt: nil)
    }

    private func chatSettings() -> ConnectionSettings {
        ConnectionSettings(relayURL: "ws://127.0.0.1:7400", hostID: "fixture-host", secret: "", tlsFingerprint: "")
    }

    /// Prints a marker the moment it runs, so "did the cached local launch
    /// start?" is answered by the terminal buffer rather than by a flag.
    private func fixtureLaunch() throws -> (TerminalLaunch, URL) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let executable = directory.appendingPathComponent("herdr-route-fixture")
        try "#!/bin/sh\nprintf '\(Self.marker)\\r\\n'\nwhile IFS= read -r line; do printf '%s\\r\\n' \"$line\"; done\n"
            .write(to: executable, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
        return (try TerminalLaunch(herdrExecutable: executable.path, agentPaneId: "route:p1"), directory)
    }

    @MainActor private func screen(_ controller: TerminalWindowController) -> String {
        String(decoding: controller.terminal.getTerminal().getBufferAsData(), as: UTF8.self)
            .replacingOccurrences(of: "\0", with: "")
    }

    @MainActor private func until(_ condition: () -> Bool) async throws {
        for _ in 0..<150 { if condition() { return }; try await Task.sleep(nanoseconds: 50_000_000) }
        throw NSError(domain: "TerminalWindowRoute.timeout", code: 1)
    }

    /// Chat rejects the target; the terminal fallback must not then attach the
    /// replacement session that reused the same ID.
    @MainActor
    func testRejectedChatTargetBlocksTheLocalTerminalFallbackUntilANewTargetArrives() async throws {
        _ = NSApplication.shared
        let (launch, directory) = try fixtureLaunch()
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = agent("herdr:route:p1")
        // The notification names a conversation this window does not show.
        let stale = MacNotificationRoute(agent: agent("herdr:route:p9"), profile: nil)
        let controller = TerminalWindowController(agent: session, launch: launch, connection: nil,
            notificationRoute: stale, chatConnection: chatSettings(), preference: .chat)
        defer { controller.close() }
        XCTAssertTrue(controller.showingChat)

        controller.present()
        XCTAssertNotNil(controller.routeRejection, "the chat view proved the target wrong")
        XCTAssertNotNil(controller.chatSession?.routeRejection)

        // The manual fallback must not reach the session behind the reused ID.
        controller.selectChat(false)
        XCTAssertFalse(controller.showingChat)
        XCTAssertFalse(controller.terminal.process.running)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertFalse(screen(controller).contains(Self.marker), "a rejected target must not start the cached launch")
        XCTAssertNotNil(controller.routeRejection)

        // Switching back to chat is refused for the same reason.
        controller.selectChat(true)
        XCTAssertFalse(controller.chatSession?.connected ?? false)
        controller.selectChat(false)
        XCTAssertFalse(controller.terminal.process.running)

        // A fresh notification for this window's own session clears the claim.
        controller.openFromNotification(MacNotificationRoute(agent: session, profile: nil))
        XCTAssertNil(controller.routeRejection)
        XCTAssertNil(controller.chatSession?.routeRejection)
        controller.selectChat(false)
        try await until { self.screen(controller).contains(Self.marker) }
        XCTAssertTrue(controller.terminal.process.running)
        controller.disconnect()
    }

    /// The view that is off screen carries the same constraint, otherwise a
    /// later manual switch reaches a target nothing validated.
    @MainActor
    func testNotificationConstrainsTheHiddenViewAsWellAsTheVisibleOne() async throws {
        _ = NSApplication.shared
        let (launch, directory) = try fixtureLaunch()
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = agent("herdr:route:p2")
        let controller = TerminalWindowController(agent: session, launch: launch, connection: nil,
            notificationRoute: nil, chatConnection: chatSettings(), preference: .terminal)
        defer { controller.close() }
        XCTAssertFalse(controller.showingChat)
        XCTAssertNil(controller.chatSession?.notificationRoute)

        let route = MacNotificationRoute(agent: session, profile: nil)
        controller.openFromNotification(route)
        XCTAssertEqual(controller.chatSession?.notificationRoute, route,
                       "a terminal window must hand the same target to its chat view")

        // Opening the same session from the live list drops the stale claim.
        controller.openFromNotification(nil)
        XCTAssertNil(controller.chatSession?.notificationRoute)
        XCTAssertNil(controller.routeRejection)

        // A notification aimed at another session never becomes this window's target.
        controller.openFromNotification(MacNotificationRoute(agent: agent("herdr:route:p8"), profile: nil))
        XCTAssertNotNil(controller.routeRejection)
        XCTAssertNil(controller.chatSession?.notificationRoute, "a foreign target is refused, not adopted")
        controller.selectChat(true)
        XCTAssertFalse(controller.chatSession?.connected ?? false)
        controller.selectChat(false)
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(screen(controller).contains(Self.marker))
        controller.disconnect()
    }
}
