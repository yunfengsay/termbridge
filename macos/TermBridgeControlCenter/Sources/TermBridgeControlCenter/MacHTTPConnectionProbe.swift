import Foundation

/// Password-free diagnostic only. An HTTP response never authenticates a Host,
/// and older WebSocket servers may reject HEAD while still accepting upgrades.
/// It opens the same BSD socket path as the direct WebSocket, so its result
/// describes the route authentication will take, never a system proxy.
final class MacHTTPConnectionProbe: @unchecked Sendable {
    struct Observation {
        let status: Int?
        let serviceIdentified: Bool
        let error: NSError?
        var summary: String {
            if let status {
                if serviceIdentified { return "HTTP \(status)，已识别 TermBridge 服务" }
                if status == 426 { return "HTTP 426，端口响应了 WebSocket 升级要求" }
                return "HTTP \(status)，端口可达，但尚未确认是 TermBridge 服务"
            }
            return "HTTP 检测未取得响应：\(ConnectionFailure.description(error ?? URLError(.unknown) as NSError))"
        }
        var fields: [String: String] {
            var fields = ["serviceIdentified": String(serviceIdentified)]
            if let status { fields["httpStatus"] = String(status) }
            if let error { fields.merge(AppDiagnostics.error(error)) { _, new in new } }
            return fields
        }
    }

    private let queue: DispatchQueue
    private let stream: DirectTCPStream
    private var continuation: CheckedContinuation<Observation, Error>?
    private var response = Data()
    private var completed = false

    private init() {
        let queue = DispatchQueue(label: "dev.termbridge.http-probe")
        self.queue = queue; stream = DirectTCPStream(queue: queue)
    }

    static func run(_ settings: ConnectionSettings) async throws -> Observation {
        guard settings.isDirectConnection,
              let parts = URLComponents(string: settings.relayURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.scheme?.lowercased() == "ws", parts.user == nil, parts.password == nil,
              let host = parts.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), !host.isEmpty,
              let port = UInt16(exactly: parts.port ?? 80) else { throw URLError(.badURL) }
        let probe = MacHTTPConnectionProbe()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { probe.start(host: host, port: port, continuation: $0) }
        } onCancel: { probe.queue.async { probe.finish(.failure(CancellationError())) } }
    }

    private func start(host: String, port: UInt16, continuation: CheckedContinuation<Observation, Error>) {
        queue.async { [self] in
            guard !completed else { continuation.resume(throwing: CancellationError()); return }
            self.continuation = continuation
            queue.asyncAfter(deadline: .now() + 3) { [weak self] in self?.observe(DirectSocketError.make(.timedOut, .http)) }
            stream.onReceive = { [weak self] in self?.received($0) }
            stream.onEnd = { [weak self] in self?.observe(DirectSocketError.ended($0, .http)) }
            stream.open(host: host, port: port) { [weak self] result in
                guard let self else { return }
                if case .failure(let failure) = result { observe(DirectSocketError.open(failure)); return }
                // Never follow a redirect or send credentials: one HEAD, then read the status.
                let authority = host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
                stream.write(Data("HEAD /.well-known/termbridge HTTP/1.1\r\nHost: \(authority)\r\nConnection: close\r\n\r\n".utf8)) { _ in }
                stream.setReading(true)
            }
        }
    }

    private func received(_ data: Data) {
        response.append(data)
        guard let end = response.range(of: Data("\r\n\r\n".utf8)) else {
            if response.count > 16 * 1024 { observe(DirectSocketError.make(.badServerResponse, .http)) }
            return
        }
        guard let head = DirectHTTPHead(response[response.startIndex..<end.lowerBound]) else {
            observe(DirectSocketError.make(.badServerResponse, .http)); return
        }
        finish(.success(Observation(status: head.status,
                                    serviceIdentified: head.status == 200 && head.header("X-TermBridge-Service") == "relay-v1",
                                    error: nil)))
    }

    private func observe(_ error: Error) {
        finish(.success(Observation(status: nil, serviceIdentified: false, error: error as NSError)))
    }

    private func finish(_ result: Result<Observation, Error>) {
        guard !completed else { return }
        completed = true
        stream.close()
        let pending = continuation; continuation = nil
        pending?.resume(with: result)
    }
}
