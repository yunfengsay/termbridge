import CryptoKit
import Foundation
import Network
import Security

/// Keeps authentication and framing shared while making direct routing explicit.
protocol RelayWebSocket: AnyObject {
  var state: URLSessionTask.State { get }
  func resume()
  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?)
  func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
  func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping @Sendable (Error?) -> Void)
  func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void)
}

extension URLSessionWebSocketTask: RelayWebSocket {}

/// A direct transport reports its own establishment, the peer's close frame and
/// bounded diagnostic stages; URLSession reports these through its delegate.
protocol DirectRelayWebSocket: RelayWebSocket {
  var onOpen: (() -> Void)? { get set }
  var onClose: ((URLSessionWebSocketTask.CloseCode) -> Void)? { get set }
  var onEvent: ((String, [String: String]) -> Void)? { get set }
}

/// Legacy `wss://` direct endpoints only: certificate pinning needs Network.framework
/// TLS. Plain `ws://` uses SocketWebSocket, which cannot fall back to a proxy.
/// One serial queue owns the connection, pending read, and shutdown. The lock is
/// only for the synchronous task-state snapshot. Client callbacks run on main,
/// alongside connect/disconnect, and never while holding the lock.
final class DirectWebSocket: DirectRelayWebSocket, @unchecked Sendable {
  static let errorDomain = "TermBridge.DirectConnection"
  private let queue = DispatchQueue(label: "com.termbridge.direct-websocket")
  private let connection: NWConnection
  private let stateLock = NSLock()
  private var taskState: URLSessionTask.State = .suspended
  private var ready = false
  private var stopped = false
  private var terminalError: Error = URLError(.cancelled)
  private var pendingRead: (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?
  private var timeout: DispatchWorkItem?
  var onOpen: (() -> Void)?
  var onClose: ((URLSessionWebSocketTask.CloseCode) -> Void)?
  var onEvent: ((String, [String: String]) -> Void)?

  var state: URLSessionTask.State {
    stateLock.lock(); defer { stateLock.unlock() }; return taskState
  }
  private func setState(_ value: URLSessionTask.State) {
    stateLock.lock(); taskState = value; stateLock.unlock()
  }

  static func parameters(fingerprint: String, secure: Bool) -> NWParameters {
    let tls = secure ? NWProtocolTLS.Options() : nil
    if let tls, !fingerprint.isEmpty {
      sec_protocol_options_set_verify_block(tls.securityProtocolOptions, { _, trust, complete in
        let trust = sec_trust_copy_ref(trust).takeRetainedValue()
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
          complete(false); return
        }
        let actual = SHA256.hash(data: SecCertificateCopyData(leaf) as Data)
          .map { String(format: "%02x", $0) }.joined()
        complete(actual == fingerprint)
      }, DispatchQueue.global(qos: .utility))
    }
    let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
    parameters.preferNoProxies = true
    let websocket = NWProtocolWebSocket.Options()
    websocket.autoReplyPing = true
    websocket.maximumMessageSize = 2 * 1024 * 1024
    parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
    return parameters
  }

  init(url: URL, parameters: NWParameters) {
    connection = NWConnection(to: .url(url), using: parameters)
  }
  deinit { timeout?.cancel(); connection.cancel() }

  func resume() {
    queue.async { [self] in
      guard !stopped, state == .suspended else { return }
      setState(.running)
      connection.stateUpdateHandler = { [weak self] state in
        guard let self, !self.stopped else { return }
        switch state {
        case .ready:
          // preferNoProxies permits fallback. Never authenticate or deliver
          // application messages until the actual route has been verified.
          self.connection.requestEstablishmentReport(queue: self.queue) { [weak self] report in
            guard let self, !self.stopped else { return }
            guard let report else {
              self.stop(Self.routeError(2, "Could not verify the direct connection route")); return
            }
            let eventCallback = self.onEvent, usedProxy = report.usedProxy
            DispatchQueue.main.async { eventCallback?("transport_metrics", ["proxy": String(usedProxy)]) }
            guard !report.usedProxy else {
              self.stop(Self.routeError(1, "Direct connection refused a system proxy route")); return
            }
            self.timeout?.cancel(); self.timeout = nil
            self.ready = true
            let openCallback = self.onOpen
            DispatchQueue.main.async { openCallback?() }
            self.readMessage()
          }
        case .failed(let error): self.stop(Self.networkError(error))
        case .waiting(let error): self.stop(Self.networkError(error)) // Match waitsForConnectivity=false.
        default: break
        }
      }
      let timeout = DispatchWorkItem { [weak self] in self?.stop(URLError(.timedOut)) }
      self.timeout = timeout
      queue.asyncAfter(deadline: .now() + 10, execute: timeout)
      connection.start(queue: queue)
    }
  }

  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    queue.async { [self] in stop(URLError(.cancelled)) }
  }

  func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
    queue.async { [self] in
      guard !stopped else { deliver(.failure(terminalError), to: completionHandler); return }
      guard pendingRead == nil else { deliver(.failure(URLError(.cannotParseResponse)), to: completionHandler); return }
      pendingRead = completionHandler
      if ready { readMessage() }
    }
  }

  private func readMessage() {
    guard !stopped, ready, pendingRead != nil else { return }
    connection.receiveMessage { [weak self] data, context, _, error in
      guard let self, !self.stopped else { return }
      if let error { self.stop(Self.networkError(error)); return }
      guard let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata else {
        self.stop(URLError(.cannotParseResponse)); return
      }
      let message: URLSessionWebSocketTask.Message
      switch metadata.opcode {
      case .binary: message = .data(data ?? Data())
      case .text:
        guard let text = String(data: data ?? Data(), encoding: .utf8) else {
          self.stop(URLError(.cannotDecodeContentData)); return
        }
        message = .string(text)
      case .ping, .pong: self.readMessage(); return
      case .close:
        let code: Int
        switch metadata.closeCode {
        case .protocolCode(let value): code = Int(value.rawValue)
        case .applicationCode(let value), .privateCode(let value): code = Int(value)
        @unknown default: code = 1006
        }
        let closeCallback = self.onClose, closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .abnormalClosure
        DispatchQueue.main.async { closeCallback?(closeCode) }
        self.stop(URLError(.networkConnectionLost)); return
      default: self.stop(URLError(.cannotParseResponse)); return
      }
      let callback = self.pendingRead; self.pendingRead = nil
      if let callback { self.deliver(.success(message), to: callback) }
    }
  }

  func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping @Sendable (Error?) -> Void) {
    queue.async { [self] in
      guard ready, !stopped else { deliver(stopped ? terminalError : URLError(.cannotConnectToHost), to: completionHandler); return }
      let data: Data, opcode: NWProtocolWebSocket.Opcode
      switch message {
      case .data(let value): data = value; opcode = .binary
      case .string(let value): data = Data(value.utf8); opcode = .text
      @unknown default: deliver(URLError(.cannotParseResponse), to: completionHandler); return
      }
      let context = NWConnection.ContentContext(identifier: "termbridge", metadata: [NWProtocolWebSocket.Metadata(opcode: opcode)])
      connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
        self.deliver(error.map(Self.networkError), to: completionHandler)
      })
    }
  }

  func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
    queue.async { [self] in
      guard ready, !stopped else { deliver(stopped ? terminalError : URLError(.cannotConnectToHost), to: pongReceiveHandler); return }
      var completed = false
      let finish: (Error?) -> Void = { error in
        guard !completed else { return }; completed = true; self.deliver(error, to: pongReceiveHandler)
      }
      let metadata = NWProtocolWebSocket.Metadata(opcode: .ping)
      metadata.setPongHandler(queue) { error in finish(error.map(Self.networkError)) }
      let context = NWConnection.ContentContext(identifier: "ping", metadata: [metadata])
      connection.send(content: nil, contentContext: context, isComplete: true, completion: .contentProcessed { error in
        if let error { finish(Self.networkError(error)) }
      })
      queue.asyncAfter(deadline: .now() + 10) { finish(URLError(.timedOut)) }
    }
  }

  private func stop(_ error: Error) {
    guard !stopped else { return }
    stopped = true; ready = false; terminalError = error
    setState(.completed)
    timeout?.cancel(); timeout = nil
    connection.stateUpdateHandler = nil
    connection.cancel()
    let callback = pendingRead; pendingRead = nil
    if let callback { deliver(.failure(error), to: callback) }
  }
  private func deliver<Value>(_ value: Value, to callback: @escaping (Value) -> Void) {
    DispatchQueue.main.async { callback(value) }
  }

  private static func routeError(_ code: Int, _ description: String) -> NSError {
    NSError(domain: errorDomain, code: code, userInfo: [NSLocalizedDescriptionKey: description])
  }
  private static func networkError(_ error: NWError) -> Error {
    switch error {
    case .posix(let code):
      let underlying = NSError(domain: NSPOSIXErrorDomain, code: Int(code.rawValue))
      if code == .ECONNREFUSED {
        return URLError(.cannotConnectToHost, userInfo: [NSUnderlyingErrorKey: underlying])
      }
      return underlying
    case .tls: return URLError(.secureConnectionFailed)
    default: return error
    }
  }
}
