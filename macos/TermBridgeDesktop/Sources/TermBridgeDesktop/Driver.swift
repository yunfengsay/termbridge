import AppKit
import ApplicationServices
import Foundation

final class DesktopOutput: @unchecked Sendable {
    private let lock = NSLock()
    func write(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value), var data = try? JSONSerialization.data(withJSONObject: value) else { return }
        data.append(10)
        lock.lock(); defer { lock.unlock() }
        try? FileHandle.standardOutput.write(contentsOf: data)
    }
}

@MainActor final class DesktopDriver {
    let capture = DesktopCapture()
    let input = DesktopInput()
    let accessibility = DesktopAccessibility()
    let output: DesktopOutput
    private var closed = false
    init(output: DesktopOutput) { self.output = output }
    func handle(_ message: [String: Any]) async {
        guard !closed else { return }
        let id = String((message["id"] as? String ?? "").prefix(128))
        let op = message["op"] as? String ?? ""
        do {
            var data: [String: Any] = [:]
            let width = try integerNumber(message["maxWidth"] ?? 1920, name: "maxWidth", range: 320...4096)
            let displayID: UInt32? = try message["displayId"].map { UInt32(try integerNumber($0, name: "displayId", range: 1...Double(UInt32.max))) }
            if ["pointer", "key", "text", "scroll", "space", "press"].contains(op),
               let expected = message["generation"] {
                guard try integerNumber(expected, name: "generation", range: 0...Double(Int32.max)) == capture.generation else {
                    throw DesktopFailure("Stale desktop generation")
                }
            }
            switch op {
            case "status":
                data = ["platform": "darwin", "screenRecording": CGPreflightScreenCaptureAccess(),
                        "accessibility": AXIsProcessTrusted(), "displays": capture.displays()]
            case "permissions":
                input.release()
                let kind = message["kind"] as? String ?? ""
                if kind == "screen" { data = ["granted": CGRequestScreenCaptureAccess()] }
                else if kind == "input" {
                    data = ["granted": AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)]
                } else if kind == "sharing" {
                    let opened = NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Sharing-Settings.extension")!)
                    data = ["settingsOpened": opened, "instruction": "开启屏幕共享，仅允许你的账户访问。锁屏连接使用 macOS 系统共享服务。"]
                } else { throw DesktopFailure("Permission kind must be screen, input or sharing") }
            case "displays": data = ["displays": capture.displays()]
            case "capture": data = try await capture.snapshot(displayID: displayID, maxWidth: width)
            case "start":
                input.release()
                let fps = Int(try finiteNumber(message["fps"] ?? 12, name: "fps", range: 1...30))
                data = try await capture.start(displayID: displayID, maxWidth: width, fps: fps, emit: output.write)
            case "ack": capture.acknowledge(message["generation"] as? Int ?? -1)
            case "stop": input.release(); await capture.stop()
            case "release": input.release()
            case "pointer":
                if let expected = message["generation"] as? Int, expected != capture.generation {
                    throw DesktopFailure("Stale desktop generation")
                }
                let display = displayID ?? capture.geometry?.displayID ?? CGMainDisplayID()
                guard capture.displays().contains(where: { ($0["id"] as? UInt32) == display }) else { throw DesktopFailure("Display is no longer available") }
                try input.pointer(message, geometry: DesktopGeometry(displayID: display, bounds: CGDisplayBounds(display)))
                data = ["state": "delivered"]
            case "key": try input.key(message); data = ["state": "delivered"]
            case "text":
                guard let text = message["text"] as? String else { throw DesktopFailure("text is required") }
                try input.text(text); data = ["state": "delivered"]
            case "scroll": try input.scroll(message); data = ["state": "delivered"]
            case "space": try input.space(message["direction"] as? String ?? ""); data = ["state": "delivered"]
            case "inspect":
                let pid = try message["pid"].map { pid_t(try integerNumber($0, name: "pid", range: 1...Double(Int32.max))) }
                data = ["windows": try accessibility.inspect(pid: pid), "expiresInMs": 30_000]
            case "press":
                try input.requirePermission(); try accessibility.press(message["controlId"] as? String ?? "")
                data = ["state": "delivered"]
            default: throw DesktopFailure("Unsupported desktop operation")
            }
            if !closed && !id.isEmpty { output.write(["id": id, "ok": true, "data": data]) }
        } catch {
            if !closed { output.write(["id": id, "ok": false, "error": String(describing: error)]) }
        }
    }
    func close() async { closed = true; input.release(); await capture.stop() }
}

@main struct TermBridgeDesktopMain {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        let output = DesktopOutput()
        let driver = await MainActor.run { () -> DesktopDriver in
            NSApplication.shared.setActivationPolicy(.prohibited)
            return DesktopDriver(output: output)
        }
        let lines = AsyncStream<String>(bufferingPolicy: .bufferingOldest(64)) { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                while let line = readLine() {
                    guard line.utf8.count <= 1_048_576 else { output.write(["ok": false, "error": "Desktop request too large"]); break }
                    if case .dropped = continuation.yield(line) {
                        output.write(["ok": false, "error": "Desktop command queue overflow"]); break
                    }
                }
                // EOF must release input even when the current capture request is suspended.
                Task { await driver.close() }
                continuation.finish()
            }
        }
        for await line in lines {
            guard let data = line.data(using: .utf8),
                  let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                output.write(["ok": false, "error": "Invalid desktop request"]); continue
            }
            await driver.handle(message)
        }
        await driver.close()
    }
}
