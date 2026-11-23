import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class TerminalCompatibilityTests: XCTestCase {
    @MainActor func testPhoneCreatedSessionAppearsAndAcceptsDesktopEnter() async throws {
        guard let url = ProcessInfo.processInfo.environment["TB_MACOS_COMPAT_RELAY"] else { throw XCTSkip("Disposable fixture only") }
        _ = NSApplication.shared
        let connection = ConnectionSettings(relayURL: url, hostID: "compat", secret: "compat-test-secret", tlsFingerprint: "")
        let phone = CompatibilityPhone(connection)
        phone.client.connect()
        defer { phone.client.disconnect() }
        try await until("phone ready") { phone.ready }
        phone.client.sendControl(["t": .string("session_create"), "command": .string("/bin/sh"),
            "args": .array([.string("-c"), .string("while IFS= read -r line; do printf 'SUBMITTED:<%s>\\n' \"$line\"; done")]),
            "cols": .int(80), "rows": .int(24), "clientPlatform": .string("android")])
        try await until("phone created") { phone.sessionID != nil }
        let id = try XCTUnwrap(phone.sessionID)
        defer { phone.client.sendControl(["t": .string("kill"), "sessionId": .string(id)]) }
        let browser = CompatibilityPhone(connection)
        browser.client.connect()
        defer { browser.client.disconnect() }
        try await until("desktop browser ready") { browser.ready }
        browser.client.sendControl(["t": .string("session_list")])
        try await until("desktop list discovers phone session") { browser.records.contains { $0.sessionId == id } }
        let record = try XCTUnwrap(browser.records.first { $0.sessionId == id })
        let desktop = TerminalWindowController(agent: record, launch: nil, connection: connection)
        desktop.present()
        defer { desktop.close() }
        try await until("desktop attached") { desktop.attachments.isConnected() }
        desktop.session.send(source: desktop.terminal, data: Array("DESKTOP_ENTER_OK\r".utf8)[...])
        try await until("Enter submits a line instead of merely echoing it") { phone.output.contains("SUBMITTED:<DESKTOP_ENTER_OK>") }
        desktop.session.send(source: desktop.terminal, data: Array("PREFIX ".utf8)[...])
        let clipboard = NSPasteboard.withUniqueName()
        defer { clipboard.releaseGlobally() }
        clipboard.setData(try TerminalAttachmentTests.picture(type: .tiff), forType: .tiff)
        XCTAssertTrue(desktop.terminal.pasteImages(from: clipboard))
        try await until("image uploaded to the same Host") { desktop.attachments.references != nil }
        let references = try XCTUnwrap(desktop.attachments.references)
        desktop.session.send(source: desktop.terminal, data: [13][...])
        try await until("image inserted at cursor and submitted") { phone.output.contains("SUBMITTED:<PREFIX " + references + ">") }
        XCTAssertTrue(desktop.attachments.items.isEmpty)
    }

    @MainActor func testOccupiedNativeControllerFallsBackWithoutDisconnectingPhone() async throws {
        guard let url = ProcessInfo.processInfo.environment["TB_MACOS_COMPAT_RELAY"] else {
            throw XCTSkip("Run scripts/test-terminal-compatibility.mjs against disposable fixtures")
        }
        _ = NSApplication.shared
        let connection = ConnectionSettings(relayURL: url, hostID: "compat", secret: "compat-test-secret", tlsFingerprint: "")
        let phone = CompatibilityPhone(connection)
        phone.client.connect()
        defer { phone.client.disconnect() }
        try await until("phone ready") { phone.ready }
        phone.client.sendControl(["t": .string("attach"), "sessionId": .string("herdr:wTest:p1"), "cols": .int(80), "rows": .int(24)])
        try await until("phone attached") { phone.sid != nil }
        let agent = AgentRecord(sessionId: "herdr:wTest:p1", source: "herdr", name: "Occupied controller fixture",
            workspace: nil, paneId: "wTest:p1", agent: nil, status: "ready", preview: nil,
            lastSeenAt: 0, statusChangedAt: 0, present: true)
        let desktop = TerminalWindowController(agent: agent, launch: nil, connection: connection)
        desktop.present()
        defer { desktop.close() }
        try await until("desktop attached: \(desktop.connectionStatus.detail.stringValue)") { desktop.attachments.isConnected() && desktop.connectionStatus.isHidden }
        func wheel(_ delta: Int32) throws -> NSEvent {
            let cg = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: .line,
                wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0))
            return try XCTUnwrap(NSEvent(cgEvent: cg))
        }
        func screen() -> String { String(decoding: desktop.terminal.getTerminal().getBufferAsData(), as: UTF8.self) }
        XCTAssertTrue(desktop.terminal.handleRemoteScroll(try wheel(3)))
        try await until("compatible history reaches the Desktop") { screen().contains("HISTORY_ROW_198") }
        let frozen = screen()
        phone.client.sendPTYInput(sid: try XCTUnwrap(phone.sid), data: Data("LIVE_WHILE_READING\r".utf8))
        try await until("phone remains live while Desktop reads history") { phone.output.contains("LIVE_WHILE_READING") }
        XCTAssertEqual(screen(), frozen, "Live output must not snap the history reader back to the bottom")
        XCTAssertTrue(desktop.terminal.handleRemoteScroll(try wheel(-3)))
        try await until("scrolling to bottom restores the current live viewport") { screen().contains("LIVE_WHILE_READING") }
        let marker = "DESKTOP_INPUT_OK"
        desktop.session.send(source: desktop.terminal, data: Array((marker + "\r").utf8)[...])
        try await until("desktop input visible on phone") { phone.output.contains(marker) }
        XCTAssertTrue(phone.client.sendPTYInput(sid: try XCTUnwrap(phone.sid), data: Data("PHONE_STILL_CONNECTED\r".utf8)))
        try await until("phone input visible on desktop") {
            String(decoding: desktop.terminal.getTerminal().getBufferAsData(), as: UTF8.self).contains("PHONE_STILL_CONNECTED")
        }
        XCTAssertTrue(phone.ready)
    }

    @MainActor private func until(_ stage: String, _ predicate: () -> Bool) async throws {
        for _ in 0..<300 { if predicate() { return }; try await Task.sleep(for: .milliseconds(50)) }
        XCTFail("Disposable terminal did not reach expected state: \(stage)")
        throw CocoaError(.coderReadCorrupt)
    }
}

@MainActor private final class CompatibilityPhone: @preconcurrency TermbridgeClientListener {
    var client: TermbridgeClient!
    var ready = false
    var sid: Int?
    var sessionID: String?
    var output = ""
    var records: [AgentRecord] = []
    init(_ connection: ConnectionSettings) { client = TermbridgeClient(settings: connection, listener: self) }
    func clientIsReady(_ client: TermbridgeClient) { ready = true }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        if case .disconnected = state { ready = false }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        if message.type == "session_list_result" { records = AgentRecord.remoteRecords(message.sessions()) }
        if ["attach_ok", "session_created"].contains(message.type) {
            sid = message.int("sid"); sessionID = message.string("sessionId")
        }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {
        output += String(decoding: data, as: UTF8.self)
    }
}
