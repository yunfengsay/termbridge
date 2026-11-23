import Foundation

/// A separate read-only connection: a successful socket send is not proof of
/// authentication. Wait for the selected Host to return its session list.
@MainActor enum MacConnectionTest {
    static func run(_ settings: ConnectionSettings, discoverCertificate: Bool,
                    progress: @escaping (String) -> Void = { _ in }) async throws -> ConnectionSettings {
        var candidate = settings.normalized()
        let attempt = UUID().uuidString
        var stage = "读取证书"
        var httpObservation: MacHTTPConnectionProbe.Observation?
        AppDiagnostics.shared.record("connection_test.started", AppDiagnostics.connection(candidate).merging(["attempt": attempt]) { _, new in new })
        do {
            if discoverCertificate && candidate.relayURL.lowercased().hasPrefix("wss://") && candidate.tlsFingerprint.isEmpty {
                progress("正在连接服务器并识别证书…")
                candidate.tlsFingerprint = try await LANConnection.probe(candidate.relayURL)
            }
            try Task.checkCancellation()
            if candidate.isDirectConnection && candidate.relayURL.lowercased().hasPrefix("ws://") {
                stage = "HTTP 连通性检测"
                progress("正在检测 HTTP 服务…")
                AppDiagnostics.shared.record("connection_test.http_started", ["attempt": attempt])
                let observation = try await MacHTTPConnectionProbe.run(candidate)
                httpObservation = observation
                AppDiagnostics.shared.record("connection_test.http_result", observation.fields.merging(["attempt": attempt]) { _, new in new })
                progress(observation.summary)
            }
            try Task.checkCancellation()
            stage = "建立 WebSocket 连接"
            progress("正在建立连接…")
            let verified = try await ConnectionHandshakeProbe(settings: candidate, attempt: attempt, progress: { message in
                stage = message; progress(message)
            }).run()
            AppDiagnostics.shared.record("connection_test.succeeded", ["attempt": attempt])
            return verified
        } catch is CancellationError {
            AppDiagnostics.shared.record("connection_test.cancelled", ["attempt": attempt])
            throw CancellationError()
        } catch {
            AppDiagnostics.shared.record("connection_test.failed", AppDiagnostics.error(error).merging(["attempt": attempt, "stage": stage]) { _, new in new })
            let detail = (error as? ConnectionTestFailure)?.errorDescription ?? ConnectionFailure.description(error)
            let http = httpObservation.map { "\($0.summary)。\n" } ?? ""
            throw ConnectionTestFailure("\(http)\(stage)失败：\(detail)\n诊断编号：\(attempt.prefix(8))，可在设置 → 诊断导出日志。")
        }
    }
}

private struct ConnectionTestFailure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

@MainActor private final class ConnectionHandshakeProbe: @preconcurrency TermbridgeClientListener {
    private var settings: ConnectionSettings
    private var client: TermbridgeClient?
    private var continuation: CheckedContinuation<ConnectionSettings, Error>?
    private var timeout: Task<Void, Never>?
    private var receivedHost = false
    private var stage = "建立 WebSocket 连接"
    private let attempt: String
    private let progress: (String) -> Void

    init(settings: ConnectionSettings, attempt: String, progress: @escaping (String) -> Void) {
        self.settings = settings; self.attempt = attempt; self.progress = progress
    }

    func run() async throws -> ConnectionSettings {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                let attempt = self.attempt
                let client = TermbridgeClient(settings: settings, listener: self, diagnostics: { event, fields in
                    AppDiagnostics.shared.record(event, fields.merging(["attempt": attempt]) { _, new in new })
                })
                self.client = client
                timeout = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(12)) } catch { return }
                    self?.finish(.failure(ConnectionTestFailure("连接超时，请检查服务器是否已开启、IP、端口和防火墙。")))
                }
                client.connect()
            }
        } onCancel: {
            Task { @MainActor in self.finish(.failure(CancellationError())) }
        }
    }

    private func finish(_ result: Result<ConnectionSettings, Error>) {
        guard let pending = continuation else { return }
        continuation = nil
        timeout?.cancel(); timeout = nil
        let old = client; client = nil; old?.disconnect()
        if case .failure(let error) = result, !(error is CancellationError) {
            let detail = (error as? ConnectionTestFailure)?.errorDescription ?? ConnectionFailure.description(error)
            pending.resume(throwing: ConnectionTestFailure("\(stage)：\(detail)"))
        } else { pending.resume(with: result) }
    }

    func clientIsReady(_ client: TermbridgeClient) { /* hello sent, not yet accepted */ }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard client === self.client else { return }
        if state == .authenticating { stage = "等待服务端密码验证请求"; progress(stage + "…") }
        if state == .connected { stage = "等待密码和 Host 验证结果"; progress(stage + "…") }
        if case .failed(let detail) = state {
            if let error = client.transportError { finish(.failure(error)) }
            else { finish(.failure(ConnectionTestFailure(ConnectionFailure.description(detail)))) }
        } else if state == .disconnected {
            finish(.failure(ConnectionTestFailure("服务器断开了连接，请检查内网服务状态。")))
        }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard client === self.client else { return }
        switch message.type {
        case "host_list_result":
            guard !receivedHost else { return }
            let selectedID = message.string("selectedHostId") ?? settings.hostID
            guard let host = message.hosts().first(where: { $0.hostID == selectedID }) else {
                finish(.failure(ConnectionTestFailure("服务器已连接，但目标 Host 不在线。请确认服务已就绪，或清空 Host ID 后重试。")))
                return
            }
            receivedHost = true; settings.hostID = host.hostID
            stage = "读取 Host 会话列表"; progress(stage + "…")
            if settings.hostName.isEmpty { settings.hostName = host.name }
            client.sendControl(["t": .string("session_list")])
        case "session_list_result":
            if receivedHost { finish(.success(settings)) }
        case "error":
            finish(.failure(ConnectionTestFailure(ConnectionFailure.description(message.string("message") ?? ""))))
        default: break
        }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
