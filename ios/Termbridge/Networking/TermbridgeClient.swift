import CryptoKit
import Foundation
import Security

#if canImport(UIKit)
  import UIKit
#endif

enum ConnectionState: Equatable {
  case connecting
  case authenticating
  case connected
  case disconnected
  case failed(String)
}

protocol TermbridgeClientListener: AnyObject {
  func client(_ client: TermbridgeClient, changedState state: ConnectionState)
  func clientIsReady(_ client: TermbridgeClient)
  func client(_ client: TermbridgeClient, receivedControl message: ControlMessage)
  func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int)
}

final class TermbridgeClient: NSObject {
  // Groups this running App's sockets without claiming a persistent device identity.
  private static let clientInstanceId = UUID().uuidString.lowercased()
  typealias DiagnosticHandler = (String, [String: String]) -> Void
  private final class DiagnosticSink: @unchecked Sendable {
    private let lock = NSLock()
    private var handler: DiagnosticHandler?
    func set(_ handler: DiagnosticHandler?) { lock.lock(); self.handler = handler; lock.unlock() }
    func get() -> DiagnosticHandler? { lock.lock(); defer { lock.unlock() }; return handler }
  }
  private static let diagnostics = DiagnosticSink()
  static func setDiagnosticHandler(_ handler: DiagnosticHandler?) { diagnostics.set(handler) }
  private let diagnosticHandler: DiagnosticHandler?
  private let diagnosticID = UUID().uuidString
  private let settings: ConnectionSettings
  private weak var listener: TermbridgeClientListener?
  private var urlSession: URLSession?
  private var socket: RelayWebSocket?
  private var pingTimer: DispatchSourceTimer?
  private let transportQueue = DispatchQueue(label: "com.termbridge.ios.websocket")
  private var closedByClient = false
  private var failureReported = false
  private(set) var transportError: NSError?
  private let acceptsPeerTools: Bool

  init(settings: ConnectionSettings, listener: TermbridgeClientListener, acceptsPeerTools: Bool = false,
       diagnostics: DiagnosticHandler? = nil) {
    self.settings = settings
    self.listener = listener
    self.acceptsPeerTools = acceptsPeerTools
    self.diagnosticHandler = diagnostics ?? Self.diagnostics.get()
    super.init()
  }

  /// Transfer an already authenticated transport without dropping queued frames.
  /// Delivery resolves the current listener on the main queue, so the owner
  /// must change on that same queue (for example creation -> terminal).
  @MainActor
  func transferListener(to listener: TermbridgeClientListener) {
    self.listener = listener
  }

  func connect() {
    guard socket == nil else { return }
    closedByClient = false
    failureReported = false
    transportError = nil
    diagnose("connect")
    emitState(.connecting)

    guard let url = URL(string: settings.relayURL.trimmingCharacters(in: .whitespacesAndNewlines))
    else {
      fail("Invalid relay URL")
      return
    }
    if settings.isDirectConnection {
      let scheme = url.scheme?.lowercased() ?? ""
      guard ["ws", "wss"].contains(scheme), url.host != nil else {
        fail("Invalid direct URL"); return
      }
      // Plain WS opens a BSD socket, as curl does: no system proxy is consulted or
      // used as a fallback. Legacy WSS keeps Network.framework for its pinned TLS.
      let task: DirectRelayWebSocket = scheme == "ws" ? SocketWebSocket(url: url)
        : DirectWebSocket(url: url, parameters: DirectWebSocket.parameters(
          fingerprint: settings.normalizedFingerprint, secure: true))
      task.onOpen = { [weak self, weak task] in
        guard let self, let task, self.socket === task else { return }
        self.diagnose("websocket_open"); self.emitState(.authenticating)
      }
      task.onEvent = { [weak self, weak task] event, fields in
        guard let self, let task, self.socket === task else { return }
        self.diagnose(event, fields)
      }
      task.onClose = { [weak self, weak task] code in
        guard let self, let task else { return }
        self.didClose(task, code: code, reason: nil)
      }
      socket = task
      task.resume(); receiveNext(from: task); startPingTimer(for: task)
      return
    }
    let configuration = Self.sessionConfiguration(for: settings)
    let queue = OperationQueue()
    queue.name = "com.termbridge.ios.urlsession"
    queue.maxConcurrentOperationCount = 1
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
    var request = URLRequest(url: url)
    if url.scheme?.lowercased() == "wss",
      settings.isHostedRoom,
      !settings.secret.isEmpty
    {
      request.setValue(settings.secret, forHTTPHeaderField: "X-Termbridge-Room-Key")
    }
    let task = session.webSocketTask(with: request)
    task.maximumMessageSize = 2 * 1024 * 1024
    urlSession = session
    socket = task
    task.resume()
    receiveNext(from: task)
    startPingTimer(for: task)
  }

  static func sessionConfiguration(for settings: ConnectionSettings) -> URLSessionConfiguration {
    let url = URL(string: settings.relayURL)
    let configuration = URLSessionConfiguration.ephemeral
    if LANConnection.isPrivate(url?.host ?? "") || settings.isDirectConnection {
      configuration.connectionProxyDictionary = [:]
    }
    configuration.timeoutIntervalForRequest = 12
    configuration.waitsForConnectivity = false
    return configuration
  }

  func disconnect() {
    if socket != nil { diagnose("disconnect_requested") }
    closedByClient = true
    pingTimer?.cancel()
    pingTimer = nil
    let task = socket
    socket = nil
    task?.cancel(with: .normalClosure, reason: nil)
    urlSession?.invalidateAndCancel()
    urlSession = nil
  }

  @discardableResult
  func sendControl(_ fields: [String: MessagePackValue]) -> Bool {
    guard let data = try? FrameCodec.control(fields) else { return false }
    return send(data)
  }

  @discardableResult
  func sendPTYInput(sid: Int, data: Data) -> Bool {
    guard !data.isEmpty else { return false }
    return send(FrameCodec.ptyInput(sid: sid, data: data))
  }

  @discardableResult
  func sendResize(sid: Int, cols: Int, rows: Int) -> Bool {
    send(FrameCodec.resize(sid: sid, cols: max(2, cols), rows: max(2, rows)))
  }

  private func receiveNext(from task: RelayWebSocket) {
    task.receive { [weak self, weak task] result in
      guard let self, let task, self.socket === task else { return }
      switch result {
      case .success(let message):
        switch message {
        case .data(let data): self.handle(data, from: task)
        case .string: self.fail("Relay sent a text frame")
        @unknown default: self.fail("Relay sent an unknown WebSocket message")
        }
        if self.socket === task { self.receiveNext(from: task) }
      case .failure(let error):
        self.fail(error)
      }
    }
  }

  private func handle(_ data: Data, from task: RelayWebSocket) {
    let frame: IncomingFrame
    do {
      frame = try FrameCodec.decode(data)
    } catch {
      fail("Protocol error: \(error.localizedDescription)")
      return
    }
    switch frame {
    case .control(let message):
      if message.type == "auth_challenge" {
        diagnose("auth_challenge")
        handleAuthentication(message, task: task)
      } else if message.type == "tool_request" && !acceptsPeerTools {
        // A viewer must reject immediately, even when an older Host routes it
        // as a legacy CLI. Only an explicit app-level executor opts in.
        if let id = message.string("id") {
          sendControl(["t": .string("tool_response"), "id": .string(id), "ok": .bool(false),
            "error": .string("This viewer does not expose Peer tools; use a registered Mac App or CLI executor")])
        }
      } else {
        if ["host_list_result", "session_list_result"].contains(message.type) { diagnose(message.type) }
        if message.type == "error" { diagnose("server_rejected", ["cause": Self.failureCategory(message.string("message") ?? "")]) }
        emit { $0.client(self, receivedControl: message) }
      }
    case .ptyOutput(let sid, let payload):
      emit { $0.client(self, receivedPTYOutput: payload, sid: sid) }
    case .ptyInput, .resize:
      break
    }
  }

  private func handleAuthentication(_ message: ControlMessage, task: RelayWebSocket) {
    if message.bool("required") == true && settings.secret.isEmpty {
      fail("This relay requires its shared password")
      return
    }
    guard let nonce = message.string("nonce"), !nonce.isEmpty else {
      fail("Relay sent an invalid authentication challenge")
      return
    }
    let response: Data
    let hello: Data
    do {
      response = try FrameCodec.control([
        "t": .string("auth_response"),
        "mac": .string(HMACHelper.sha256Hex(secret: settings.secret, nonce: nonce)),
      ])
      hello = try FrameCodec.control([
        "t": .string("hello"),
        "role": .string("client"),
        "hostId": .string(settings.hostID.trimmingCharacters(in: .whitespacesAndNewlines)),
        "name": .string(clientName),
        "wantsHosts": .bool(true),
        "wantsTopology": .bool(true),
        "clientInstanceId": .string(Self.clientInstanceId),
      ])
    } catch {
      fail("Could not encode authentication")
      return
    }
    task.send(.data(response)) { [weak self, weak task] error in
      guard let self, let task, self.socket === task else { return }
      if let error {
        self.fail(error)
        return
      }
      self.diagnose("auth_response_sent")
      task.send(.data(hello)) { [weak self, weak task] error in
        guard let self, let task, self.socket === task else { return }
        if let error {
          self.fail(error)
          return
        }
        self.diagnose("hello_sent")
        self.emitState(.connected)
        self.emit { $0.clientIsReady(self) }
      }
    }
  }

  @discardableResult
  private func send(_ data: Data) -> Bool {
    guard let task = socket, task.state == .running else { return false }
    task.send(.data(data)) { [weak self, weak task] error in
      guard let self, let task, self.socket === task, let error else { return }
      self.fail(error)
    }
    return true
  }

  private func startPingTimer(for task: RelayWebSocket) {
    let timer = DispatchSource.makeTimerSource(queue: settings.isDirectConnection ? .main : transportQueue)
    timer.schedule(deadline: .now() + 30, repeating: 30)
    timer.setEventHandler { [weak self, weak task] in
      guard let self, let task, self.socket === task else { return }
      task.sendPing { [weak self, weak task] error in
        guard let self, let task, self.socket === task, let error else { return }
        self.fail(error)
      }
    }
    pingTimer = timer
    timer.resume()
  }

  private func fail(_ error: Error) {
    guard !closedByClient, !failureReported else { return }
    transportError = error as NSError
    var fields = ["domain": (error as NSError).domain, "code": String((error as NSError).code)]
    if let response = (socket as? URLSessionWebSocketTask)?.response as? HTTPURLResponse { fields["httpStatus"] = String(response.statusCode) }
    else if let status = DirectSocketError.httpStatus(of: error) { fields["httpStatus"] = String(status) }
    if let stage = DirectSocketError.stage(of: error) { fields["stage"] = stage }
    if let underlying = (error as NSError).userInfo[NSUnderlyingErrorKey] as? NSError {
      fields["underlyingDomain"] = underlying.domain; fields["underlyingCode"] = String(underlying.code)
    }
    diagnose("transport_failed", fields)
    fail(error.localizedDescription)
  }

  private func fail(_ message: String) {
    guard !closedByClient, !failureReported else { return }
    failureReported = true
    diagnose("failed", ["cause": Self.failureCategory(message)])
    pingTimer?.cancel()
    pingTimer = nil
    socket?.cancel(with: .protocolError, reason: Data(message.utf8.prefix(100)))
    socket = nil
    urlSession?.invalidateAndCancel()
    urlSession = nil
    emitState(.failed(message))
  }

  private func emitState(_ state: ConnectionState) {
    emit { $0.client(self, changedState: state) }
  }

  private func emit(_ action: @escaping (TermbridgeClientListener) -> Void) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let listener = self.listener else { return }
      action(listener)
    }
  }

  private func diagnose(_ event: String, _ extra: [String: String] = [:]) {
    guard let diagnosticHandler else { return }
    let url = URLComponents(string: settings.relayURL)
    var fields = ["attempt": diagnosticID,
      "endpoint": "\(url?.scheme ?? "invalid")://\(url?.host ?? "invalid"):\(url?.port ?? (url?.scheme == "wss" ? 443 : 80))",
      "mode": settings.isDirectConnection ? "direct" : "relay",
      "transport": !settings.isDirectConnection ? "urlsession" : url?.scheme?.lowercased() == "ws" ? "socket" : "network",
      "passwordConfigured": String(!settings.secret.isEmpty), "hostConfigured": String(!settings.hostID.isEmpty),
      "tlsPinConfigured": String(!settings.tlsFingerprint.isEmpty)]
    fields.merge(extra) { _, new in new }
    diagnosticHandler("connection.\(event)", fields)
  }
  private static func failureCategory(_ message: String) -> String {
    let text = message.lowercased()
    if text.contains("password") || text.contains("authentication") { return "authentication" }
    if text.contains("fingerprint") { return "tls_pin" }
    if text.contains("host") { return "host" }
    if text.contains("protocol") || text.contains("frame") { return "protocol" }
    return "transport"
  }
}

extension TermbridgeClient: URLSessionWebSocketDelegate {
  func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
    guard session === urlSession, let task = task as? URLSessionWebSocketTask, task === socket,
      let transaction = metrics.transactionMetrics.last else { return }
    var fields = ["proxy": String(transaction.isProxyConnection),
      "durationMs": String(Int(metrics.taskInterval.duration * 1000))]
    if let name = transaction.networkProtocolName { fields["protocol"] = name }
    if let response = transaction.response as? HTTPURLResponse { fields["httpStatus"] = String(response.statusCode) }
    diagnose("transport_metrics", fields)
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    guard socket === webSocketTask else { return }
    diagnose("websocket_open")
    emitState(.authenticating)
  }

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
    reason: Data?
  ) {
    didClose(webSocketTask, code: closeCode, reason: reason)
  }

  private func didClose(_ task: RelayWebSocket, code closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    guard socket === task else { return }
    diagnose("websocket_closed", ["closeCode": String(closeCode.rawValue),
      "cause": Self.failureCategory(reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")])
    socket = nil
    pingTimer?.cancel()
    pingTimer = nil
    if !closedByClient && !failureReported { emitState(.disconnected) }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard let webSocketTask = task as? URLSessionWebSocketTask, socket === webSocketTask else {
      return
    }
    if let error, !closedByClient { fail(error) }
  }

  func urlSession(
    _ session: URLSession,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let fingerprint = settings.normalizedFingerprint
    guard !fingerprint.isEmpty,
      settings.relayURL.lowercased().hasPrefix("wss://"),
      challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
      let certificate = chain.first
    else {
      completionHandler(.performDefaultHandling, nil)
      return
    }
    let certificateData = SecCertificateCopyData(certificate) as Data
    let actual = Data(SHA256.hash(data: certificateData))
    guard let expected = Data(hex: fingerprint), constantTimeEqual(actual, expected) else {
      fail("TLS fingerprint mismatch")
      completionHandler(.cancelAuthenticationChallenge, nil)
      return
    }
    completionHandler(.useCredential, URLCredential(trust: trust))
  }

  private func constantTimeEqual(_ lhs: Data, _ rhs: Data) -> Bool {
    guard lhs.count == rhs.count else { return false }
    return zip(lhs, rhs).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
  }

  private var clientName: String {
    #if canImport(UIKit)
      return "iOS \(UIDevice.current.name)"
    #else
      return "Darwin \(Host.current().localizedName ?? "client")"
    #endif
  }
}

extension Data {
  fileprivate init?(hex: String) {
    guard hex.count.isMultiple(of: 2) else { return nil }
    var result = Data(capacity: hex.count / 2)
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      guard let byte = UInt8(hex[index..<next], radix: 16) else { return nil }
      result.append(byte)
      index = next
    }
    self = result
  }
}
