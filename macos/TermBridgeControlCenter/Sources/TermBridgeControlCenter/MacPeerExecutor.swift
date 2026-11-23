import Darwin
import Foundation

/// Revocation/disconnect cancels the actual process, not only its UI state.
final class MacPeerCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false
    private var handler: (() -> Void)?
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return stopped }
    func cancel() {
        lock.lock(); stopped = true; let action = handler; lock.unlock()
        action?()
    }
    func onCancel(_ action: (() -> Void)?) {
        lock.lock(); handler = action; let invoke = stopped; lock.unlock()
        if invoke { action?() }
    }
}

enum MacPeerExecutor {
    static let operations = ["info", "fs.read", "fs.write", "fs.ls", "fs.stat", "exec"]
    static func execute(op: String, args: [String: MessagePackValue], permission: MacPeerPermission,
                        cancellation: MacPeerCancellation) -> [String: MessagePackValue] {
        do {
            guard operations.contains(op) else { throw MacPeerFailure("unsupported operation: \(op.prefix(128))") }
            if op == "info" {
                return ["ok": .bool(true), "data": .map(["platform": .string("darwin"),
                    "hostname": .string(ProcessInfo.processInfo.hostName), "exposed": .bool(permission.enabled),
                    "root": .string(permission.enabled ? permission.root : ""),
                    "roots": .array(permission.enabled ? permission.roots.map(MessagePackValue.string) : []),
                    "fs": .string(permission.enabled ? permission.files.rawValue : "off"),
                    "exec": .bool(permission.enabled && permission.execute)])]
            }
            guard permission.enabled else { throw MacPeerFailure("Peer 未授权，请在这台 Mac 的设置 → Peer 中开启。") }
            guard !cancellation.isCancelled else { return cancelled() }
            if op == "exec" {
                // Browser consent is scoped in the Chrome extension; it does not grant arbitrary shell access.
                if args["shell"]?.boolValue != true, let values = args["argv"]?.arrayValue {
                    let words = values.compactMap(\.stringValue)
                    if words.count == values.count, (3...5).contains(words.count), words[0] == "tb", words[1] == "browser",
                       (words[2] == "status" && words.count == 3 || words[2] == "call" && words.count >= 4) {
                        var browserArgs = args
                        browserArgs["argv"] = .array(try MacBrowserConnection.command(Array(words.dropFirst(2))).map(MessagePackValue.string))
                        return try run(browserArgs, permission: permission, cancellation: cancellation)
                    }
                }
                guard permission.execute else { throw MacPeerFailure("命令执行未授权，请在 Mac 设置 → Peer 中单独开启。") }
                return try run(args, permission: permission, cancellation: cancellation)
            }
            let result = try MacPeerFiles.execute(op, args: args, permission: permission)
            if op != "fs.write" && cancellation.isCancelled { return cancelled() }
            return ["ok": .bool(true), "data": result]
        } catch {
            return ["ok": .bool(false), "error": .string((error as? MacPeerFailure)?.errorDescription ?? "Peer 操作失败：文件不存在、无权访问或系统拒绝。")]
        }
    }

    static func cancelled() -> [String: MessagePackValue] {
        ["ok": .bool(false), "error": .string("cancelled: Peer disconnected or permission revoked"), "data": .map(["status": .string("cancelled")])]
    }

    private static func run(_ args: [String: MessagePackValue], permission: MacPeerPermission,
                            cancellation: MacPeerCancellation) throws -> [String: MessagePackValue] {
        guard let values = args["argv"]?.arrayValue, !values.isEmpty, values.count <= 256,
              values.allSatisfy({ $0.stringValue != nil && !$0.stringValue!.contains("\0") }) else { throw MacPeerFailure("exec: invalid argv") }
        let argv = values.compactMap(\.stringValue)
        guard argv.reduce(0, { $0 + $1.utf8.count }) <= 64 * 1024 else { throw MacPeerFailure("exec: command too large") }
        let shell = args["shell"]?.boolValue == true
        let environment = CLIInstallation(home: FileManager.default.homeDirectoryForCurrentUser).environment
        let process = Process()
        if shell {
            process.executableURL = URL(fileURLWithPath: CLIDiscovery.shellPaths(preferred: environment["SHELL"]).first ?? "/bin/zsh")
            process.arguments = ["-lic", argv.joined(separator: " ")]
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["--"] + argv
        }
        let requested = args["cwd"]?.stringValue ?? permission.root
        guard !requested.contains("\0") else { throw MacPeerFailure("exec: invalid cwd") }
        let cwd = requested.hasPrefix("/") ? URL(fileURLWithPath: requested) : URL(fileURLWithPath: permission.root).appendingPathComponent(requested)
        process.currentDirectoryURL = cwd
        process.environment = environment
        process.standardInput = FileHandle.nullDevice
        // Pipes are continuously drained, with bounded retention, even after
        // output reaches the cap; verbose tools cannot block on a full pipe.
        let out = PeerOutput(), err = PeerOutput()
        process.standardOutput = out.pipe; process.standardError = err.pipe
        defer { out.close(); err.close() }
        if cancellation.isCancelled { return cancelled() }
        try process.run()
        let pid = process.processIdentifier
        let grouped = getpgid(pid) == pid || setpgid(pid, pid) == 0
        // App termination cannot wait for a background polling task. Deliver
        // the signal synchronously during disconnect/revocation as well.
        cancellation.onCancel { if process.isRunning { kill(grouped ? -pid : pid, SIGKILL) } }
        defer { cancellation.onCancel(nil) }
        let timeout = min(60_000, max(100, args["timeoutMs"]?.intValue ?? 60_000))
        let deadline = Date().addingTimeInterval(Double(timeout) / 1000)
        var interrupted = false, timedOut = false
        while process.isRunning {
            interrupted = cancellation.isCancelled
            timedOut = Date() >= deadline
            if interrupted || timedOut {
                kill(grouped ? -pid : pid, SIGKILL)
                break
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        process.waitUntilExit()
        // Descendants may still hold a pipe open. Do not wait indefinitely for EOF.
        out.finish(); err.finish()
        if interrupted || cancellation.isCancelled { return cancelled() }
        if timedOut {
            return ["ok": .bool(false), "exit": .int(124), "error": .string("exec timed out"), "stdout": .string(out.text), "stderr": .string(err.text)]
        }
        return ["ok": .bool(true), "exit": .int(Int64(process.terminationStatus)), "stdout": .string(out.text), "stderr": .string(err.text),
                "data": .map(["truncated": .bool(out.truncated || err.truncated)])]
    }
}

private final class PeerOutput: @unchecked Sendable {
    let pipe = Pipe()
    private let queue = DispatchQueue(label: "dev.termbridge.peer.output")
    private var source: DispatchSourceRead?
    private var bytes = Data()
    private var clipped = false
    private let limit = 128 * 1024
    init() {
        let fd = pipe.fileHandleForReading.fileDescriptor
        _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
        let reader = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
        reader.setEventHandler { [weak self] in self?.drain() }
        source = reader; reader.resume()
    }
    private func drain() {
        var buffer = [UInt8](repeating: 0, count: 8192)
        while true {
            let count = Darwin.read(pipe.fileHandleForReading.fileDescriptor, &buffer, buffer.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { return }
            if count > limit - bytes.count { clipped = true }
            bytes.append(contentsOf: buffer.prefix(min(count, max(0, limit - bytes.count))))
        }
    }
    var text: String { queue.sync { String(decoding: bytes, as: UTF8.self) } }
    var truncated: Bool { queue.sync { clipped } }
    func finish() {
        try? pipe.fileHandleForWriting.close()
        // Drain all bytes written before process exit, without waiting for a
        // background descendant to close its inherited descriptor.
        queue.sync { drain(); source?.cancel(); source = nil }
    }
    func close() {
        queue.sync {
            source?.setEventHandler {}; source?.cancel(); source = nil
            try? pipe.fileHandleForReading.close(); try? pipe.fileHandleForWriting.close()
        }
    }
}
