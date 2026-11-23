import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class TerminalScrollTransportTests: XCTestCase {
    @MainActor func testWheelAndDownKeyReachNativeAndOlderCompatiblePeers() async throws {
        _ = NSApplication.shared
        let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first { FileManager.default.isExecutableFile(atPath: $0) }
        guard let node else { throw XCTSkip("Node is needed for the disposable WebSocket peer") }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let portFile = directory.appendingPathComponent("port")
        let peer = Process()
        peer.executableURL = URL(fileURLWithPath: node)
        peer.arguments = [repo.appendingPathComponent("scripts/fixtures/terminal-scroll.mjs").path, portFile.path]
        try peer.run()
        defer { if peer.isRunning { peer.terminate() } }
        try await until { FileManager.default.fileExists(atPath: portFile.path) }
        let port = try String(contentsOf: portFile, encoding: .utf8)
        let connection = ConnectionSettings(relayURL: "ws://127.0.0.1:\(port)", hostID: "scroll-fixture", secret: "", tlsFingerprint: "")
        for mode in ["native", "native-history", "compatible", "codex-history"] {
            let agent = AgentRecord(sessionId: "herdr:scroll:\(mode)", source: "herdr", name: "Scroll fixture",
                workspace: nil, paneId: nil, agent: mode == "codex-history" ? "codex" : nil, status: "ready", preview: nil,
                lastSeenAt: 0, statusChangedAt: 0, present: true)
            let controller = TerminalWindowController(agent: agent, launch: nil, connection: connection)
            controller.present()
            defer { controller.close() }
            let terminal = controller.terminal
            func screen() -> String { String(decoding: terminal.getTerminal().getBufferAsData(), as: UTF8.self) }
            try await until { screen().contains("NEW_ACTIVITY") }
            let window = try XCTUnwrap(controller.window)
            XCTAssertTrue(window.makeFirstResponder(terminal))
            if mode == "codex-history" {
                let model = terminal.getTerminal()
                XCTAssertEqual(model.getCursorLocation().x, 7, "Cursor belongs inside INPUT, not after the footer")
                XCTAssertEqual(model.getCursorLocation().y, model.rows - 4)
                window.setContentSize(NSSize(width: 600, height: 420))
                try await until { screen().contains("SIZE:\(model.cols)x\(model.rows)") }
                XCTAssertEqual(model.getCursorLocation().x, 7)
                XCTAssertEqual(model.getCursorLocation().y, model.rows - 4, "Remote input follows the resized viewport")
                for page in 1...10 {
                    try dispatchWheel(100, over: terminal, in: window)
                    try await until { screen().contains("HISTORY_OFFSET:\(page * 100)") }
                }
                for page in (0..<10).reversed() {
                    try dispatchWheel(-100, over: terminal, in: window)
                    try await until { screen().contains("HISTORY_OFFSET:\(page * 100)") }
                }
                XCTAssertEqual(model.getCursorLocation().x, 7)
                XCTAssertEqual(model.getCursorLocation().y, model.rows - 4)
                controller.close()
                continue
            }
            let chars = String(Unicode.Scalar(NSDownArrowFunctionKey)!)
            let key = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: [.numericPad, .function], timestamp: 0, windowNumber: window.windowNumber,
                context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: 125))
            window.sendEvent(key)
            try await until { screen().contains("KEY_AT_BOTTOM") }
            if mode == "native" {
                try dispatchWheel(-2, over: terminal, in: window)
                try await until { screen().contains("WHEEL_AT_BOTTOM") }
            } else {
                try dispatchWheel(3, over: terminal, in: window)
                try await until { screen().contains("HISTORY_TOP") }
                try dispatchWheel(-3, over: terminal, in: window)
                try await until { screen().contains("HISTORY_BOTTOM") }
            }
            controller.close()
        }
    }

    /// Route through the application event queue, local monitors and window hit
    /// testing. Calling handleRemoteScroll directly cannot detect a lost wheel.
    @MainActor private func dispatchWheel(_ delta: Int32, over view: NSView, in window: NSWindow) throws {
        let point = view.convert(NSPoint(x: view.bounds.midX, y: view.bounds.midY), to: nil)
        let mouse = try XCTUnwrap(NSEvent.mouseEvent(with: .mouseMoved, location: point,
            modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0))
        let cg = try XCTUnwrap(mouse.cgEvent?.copy())
        cg.type = .scrollWheel
        cg.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: Int64(delta))
        cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Double(delta))
        cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: Double(delta))
        let event = try XCTUnwrap(NSEvent(cgEvent: cg))
        XCTAssertTrue(event.window === window, "The wheel must belong to the real session window")
        NSApp.postEvent(event, atStart: true)
        if let delivered = NSApp.nextEvent(matching: .scrollWheel, until: Date().addingTimeInterval(0.05), inMode: .default, dequeue: true) {
            NSApp.sendEvent(delivered)
        }
    }

    @MainActor private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<150 { if predicate() { return }; try await Task.sleep(for: .milliseconds(20)) }
        XCTFail("Disposable terminal did not reach the expected input/scroll state")
        throw CocoaError(.coderReadCorrupt)
    }
}
