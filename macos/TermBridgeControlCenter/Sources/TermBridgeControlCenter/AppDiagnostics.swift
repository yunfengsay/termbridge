import Foundation

/// One writer owns rotation and cleanup. Network callbacks never wait for disk I/O.
final class AppDiagnostics: @unchecked Sendable {
    static let shared = AppDiagnostics()
    static let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/TermBridge")
    let directory: URL
    private let queue = DispatchQueue(label: "dev.termbridge.diagnostics", qos: .utility)
    private let clock: @Sendable () -> Date
    private let maxBytes: Int
    private let segments: Int
    private var timer: DispatchSourceTimer?
    private var failure: Error?
    private let formatter: ISO8601DateFormatter = {
        let value = ISO8601DateFormatter(); value.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return value
    }()

    init(directory: URL = AppDiagnostics.directory, maxBytes: Int = 2 * 1024 * 1024, segments: Int = 4,
         clock: @escaping @Sendable () -> Date = { Date() }, maintenance: Bool = true) {
        self.directory = directory; self.maxBytes = max(1024, maxBytes); self.segments = max(1, segments); self.clock = clock
        if maintenance {
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now(), repeating: 60)
            timer.setEventHandler { [weak self] in
                guard let self else { return }
                do { try self.prepare(at: self.clock()) } catch { self.failure = error }
            }
            self.timer = timer; timer.resume()
        }
    }
    deinit { timer?.cancel() }

    func record(_ event: String, _ fields: [String: String] = [:]) {
        // Deliberate allowlist: never accept transcripts, payloads, passwords, pairing codes or raw stderr.
        let allowed: Set<String> = ["attempt", "endpoint", "mode", "stage", "domain", "code", "closeCode", "cause",
            "underlyingDomain", "underlyingCode", "hostConfigured", "passwordConfigured", "tlsPinConfigured", "count",
            "durationMs", "pid", "port", "address", "source", "signal", "status", "version", "build", "protocol", "step",
            "httpStatus", "serviceIdentified", "proxy", "transport"]
        guard event.range(of: #"^[a-zA-Z0-9_.-]{1,80}$"#, options: .regularExpression) != nil else { return }
        var safe = fields.filter { allowed.contains($0.key) }.mapValues { String($0.prefix(256)) }
        if let endpoint = fields["endpoint"] {
            let url = URLComponents(string: endpoint)
            safe["endpoint"] = "\(url?.scheme ?? "invalid")://\(url?.host ?? "invalid"):\(url?.port ?? (url?.scheme == "wss" ? 443 : 80))"
        }
        queue.async { [self] in
            do {
                let now = clock(); try prepare(at: now)
                var record: [String: Any] = ["time": formatter.string(from: now), "event": event, "pid": ProcessInfo.processInfo.processIdentifier]
                record["fields"] = safe.mapValues { $0.replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ") }
                let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) + Data([10])
                let file = directory.appendingPathComponent("termbridge-\(day(now)).log")
                let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                if size + data.count > maxBytes { try rotate(file) }
                if !FileManager.default.fileExists(atPath: file.path) {
                    guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                        throw CocoaError(.fileWriteUnknown)
                    }
                }
                let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }
                try handle.seekToEnd(); try handle.write(contentsOf: data)
                failure = nil
            } catch { failure = error }
        }
    }

    func contents() async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { [self] in
                do {
                    try prepare(at: clock())
                    if let failure { throw failure }
                    var data = Data()
                    for file in try files().sorted(by: { $0.lastPathComponent > $1.lastPathComponent }) {
                        data.append(Data("\n--- \(file.lastPathComponent) ---\n".utf8)); data.append(try Data(contentsOf: file))
                    }
                    continuation.resume(returning: data)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    func export(to url: URL) async throws {
        let data = try await contents()
        try await Task.detached(priority: .utility) {
            try data.write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        }.value
    }
    func finishPendingWrites() { queue.sync {} }

    private func day(_ date: Date) -> String { String(formatter.string(from: date).prefix(10)) }
    private func files() throws -> [URL] {
        try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey]).filter {
            let values = try? $0.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values?.isRegularFile == true, values?.isSymbolicLink == false else { return false }
            return
            $0.lastPathComponent.range(of: #"^termbridge-\d{4}-\d{2}-\d{2}\.log(?:\.[1-9]\d*)?$"#, options: .regularExpression) != nil
        }
    }
    private func prepare(at now: Date) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        // Today plus the previous two UTC dates: no retained day can exceed 72 hours.
        let oldest = day(now.addingTimeInterval(-2 * 86_400)), newest = day(now)
        for file in try files() {
            let stamp = String(file.lastPathComponent.dropFirst("termbridge-".count).prefix(10))
            if stamp < oldest || stamp > newest { try fm.removeItem(at: file) }
        }
    }
    private func rotate(_ file: URL) throws {
        let fm = FileManager.default
        if segments > 1 {
            for index in stride(from: segments - 1, through: 1, by: -1) {
                let destination = file.appendingPathExtension(String(index))
                if fm.fileExists(atPath: destination.path) { try fm.removeItem(at: destination) }
                let source = index == 1 ? file : file.appendingPathExtension(String(index - 1))
                if fm.fileExists(atPath: source.path) { try fm.moveItem(at: source, to: destination) }
            }
        } else if fm.fileExists(atPath: file.path) { try fm.removeItem(at: file) }
    }

    static func connection(_ settings: ConnectionSettings) -> [String: String] {
        let url = URLComponents(string: settings.relayURL)
        return ["endpoint": "\(url?.scheme ?? "invalid")://\(url?.host ?? "invalid"):\(url?.port ?? (url?.scheme == "wss" ? 443 : 80))",
                "mode": settings.isDirectConnection ? "direct" : "relay", "hostConfigured": String(!settings.hostID.isEmpty),
                "passwordConfigured": String(!settings.secret.isEmpty), "tlsPinConfigured": String(!settings.tlsFingerprint.isEmpty)]
    }
    static func error(_ error: Error) -> [String: String] {
        let error = error as NSError
        var result = ["domain": error.domain, "code": String(error.code)]
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            result["underlyingDomain"] = underlying.domain; result["underlyingCode"] = String(underlying.code)
        }
        return result
    }
}
