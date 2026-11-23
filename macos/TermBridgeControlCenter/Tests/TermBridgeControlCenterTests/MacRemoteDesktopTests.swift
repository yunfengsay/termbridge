import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class MacRemoteDesktopTests: XCTestCase {
    @MainActor
    func testEncryptedViewerPaintsPixelsAndRoutesInputToItsCapturedHost() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let relay = env["TB_MACOS_DESKTOP_RELAY"], let audit = env["TB_MACOS_DESKTOP_AUDIT"] else {
            throw XCTSkip("Run scripts/test-remote-desktop.ts for a synthetic desktop Host")
        }
        _ = NSApplication.shared
        let previousFPS = UserDefaults.standard.object(forKey: "desktopFrameRate")
        defer {
            if let previousFPS { UserDefaults.standard.set(previousFPS, forKey: "desktopFrameRate") }
            else { UserDefaults.standard.removeObject(forKey: "desktopFrameRate") }
        }
        let profile = ConnectionSettings(relayURL: relay, hostID: "desktop-a", secret: "mac-desktop-fixture-secret", tlsFingerprint: "")
        let window = MacRemoteDesktopWindow(profile: profile), session = window.session
        window.present()
        defer { window.close() }
        do { try await until { session.connected } }
        catch {
            let page = try? await session.web.evaluateJavaScript("JSON.stringify({url:location.href,viewer:typeof window.Desktop,text:document.body.innerText})")
            print("Desktop fixture state: \(session.status); page: \(String(describing: page))")
            throw error
        }
        XCTAssertEqual(session.displays.first?.name, "Fixture display")
        XCTAssertEqual(session.profile.hostID, "desktop-a")
        let pixel = try await session.web.evaluateJavaScript("Array.from(document.querySelector('#screen canvas').getContext('2d').getImageData(640,360,1,1).data)") as? [Int]
        XCTAssertEqual(pixel?.count, 4)
        XCTAssertEqual(pixel?.last, 255, "Authentication alone cannot stand in for painted desktop pixels")
        XCTAssertGreaterThan(pixel?[2] ?? 0, 150)
        session.send("zoom", 200); session.send("fps", 30)
        try await until { session.zoom == 200 && session.fps == 30 }
        session.send("text", "桌面输入 fixture")
        session.send("key", 53)
        func records() -> [[String: Any]] {
            (try? String(contentsOfFile: audit, encoding: .utf8))?.split(separator: "\n").compactMap {
                (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any]
            } ?? []
        }
        try await until {
            records().contains { ($0["args"] as? [String: Any])?["text"] as? String == "桌面输入 fixture" }
        }
        XCTAssertTrue(records().allSatisfy { $0["hostId"] as? String == "desktop-a" })
        let other = MacRemoteDesktopWindow(profile: ConnectionSettings(relayURL: relay, hostID: "desktop-b", secret: "mac-desktop-fixture-secret", tlsFingerprint: ""))
        other.present()
        defer { other.close() }
        try await until { other.session.connected }
        other.session.send("text", "second host")
        session.send("text", "first host still selected")
        try await until {
            records().contains { ($0["args"] as? [String: Any])?["text"] as? String == "first host still selected" } &&
            records().contains { ($0["args"] as? [String: Any])?["text"] as? String == "second host" }
        }
        XCTAssertTrue(records().filter { ($0["args"] as? [String: Any])?["text"] as? String == "second host" }.allSatisfy { $0["hostId"] as? String == "desktop-b" })
        XCTAssertTrue(records().filter { ($0["args"] as? [String: Any])?["text"] as? String == "first host still selected" }.allSatisfy { $0["hostId"] as? String == "desktop-a" })
        other.close()
        try await until { records().contains { $0["hostId"] as? String == "desktop-b" && $0["op"] as? String == "stop" } }
        window.close(); session.close() // Repeated retirement must be safe.
        try await until { records().contains { $0["hostId"] as? String == "desktop-a" && $0["op"] as? String == "stop" } }
        let count = records().count
        session.send("text", "must not arrive")
        session.receiveScript(["t": "desktop_state", "connected": true])
        XCTAssertFalse(session.connected)
        XCTAssertTrue(session.closed)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(records().count, count)
        XCTAssertFalse(records().contains { $0["op"] as? String == "lock" })
    }

    @MainActor
    func testDesktopBundleIncludesViewerAndCorrespondingSource() throws {
        let folder = try XCTUnwrap(MacRemoteDesktopSession.resourceURL).deletingLastPathComponent()
        for file in ["desktop.js", "desktop.css", "THIRD_PARTY_LICENSES.txt", "novnc-source/LICENSE.txt"] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent(file).path), file)
        }
    }

    @MainActor
    private func until(_ predicate: () -> Bool) async throws {
        for _ in 0..<400 {
            if predicate() { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTFail("Timed out waiting for desktop viewer")
        throw NSError(domain: "MacRemoteDesktopTests", code: 1)
    }
}
