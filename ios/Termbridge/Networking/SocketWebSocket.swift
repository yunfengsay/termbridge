import CryptoKit
import Darwin
import Foundation
import Security

/// Direct socket failures keep the stage that stopped and any upgrade status in
/// userInfo, so logs and messages can say where the path ended.
enum DirectSocketError {
  enum Stage: String { case resolve, connect, upgrade, open, http }
  static let stageKey = "TermBridgeDirectStage"
  static let httpStatusKey = "TermBridgeDirectHTTPStatus"
  static let resolverDomain = "TermBridge.Resolver"

  static func make(_ code: URLError.Code, _ stage: Stage, underlying: NSError? = nil, httpStatus: Int? = nil) -> URLError {
    var info: [String: Any] = [stageKey: stage.rawValue]
    if let underlying { info[NSUnderlyingErrorKey] = underlying }
    if let httpStatus { info[httpStatusKey] = httpStatus }
    return URLError(code, userInfo: info)
  }
  /// Classify by errno only; the POSIX code itself stays as the underlying error.
  static func posix(_ code: Int32, _ stage: Stage) -> URLError {
    let underlying = NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    switch code {
    case ECONNREFUSED, EHOSTUNREACH, ENETUNREACH, EHOSTDOWN, ENETDOWN, EADDRNOTAVAIL:
      return make(.cannotConnectToHost, stage, underlying: underlying)
    case ETIMEDOUT: return make(.timedOut, stage, underlying: underlying)
    default: return make(.networkConnectionLost, stage, underlying: underlying)
    }
  }
  static func open(_ failure: DirectTCPStream.OpenFailure) -> URLError {
    switch failure {
    case .resolve(let code): return make(.cannotFindHost, .resolve, underlying: NSError(domain: resolverDomain, code: Int(code)))
    case .connect(let code): return posix(code, .connect)
    }
  }
  /// A stream end is EOF (nil) or a POSIX error.
  static func ended(_ error: Error?, _ stage: Stage) -> URLError {
    guard let error = error as NSError?, error.domain == NSPOSIXErrorDomain else { return make(.networkConnectionLost, stage) }
    return posix(Int32(error.code), stage)
  }
  static func stage(of error: Error) -> String? { (error as NSError).userInfo[stageKey] as? String }
  static func httpStatus(of error: Error) -> Int? { (error as NSError).userInfo[httpStatusKey] as? Int }
}

/// Status line and headers of an HTTP/1.x response; header names are case-insensitive.
struct DirectHTTPHead {
  let status: Int
  private let fields: [String: String]

  init?(_ data: Data) {
    // Latin-1 maps every byte, so malformed input fails validation rather than decoding.
    guard let text = String(data: data, encoding: .isoLatin1) else { return nil }
    let lines = text.components(separatedBy: "\r\n")
    let status = lines[0].split(separator: " ", maxSplits: 2)
    guard status.count >= 2, status[0].hasPrefix("HTTP/1."), let code = Int(status[1]), (100...599).contains(code) else { return nil }
    var fields: [String: String] = [:]
    for line in lines.dropFirst() where !line.isEmpty {
      guard let colon = line.firstIndex(of: ":") else { return nil }
      let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
      let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      fields[name] = fields[name].map { "\($0), \(value)" } ?? value
    }
    self.status = code; self.fields = fields
  }
  func header(_ name: String) -> String? { fields[name.lowercased()] }
}

/// One TCP connection on a BSD socket: the same system calls curl makes. It never
/// reads system proxy settings and has no Network.framework protocol stack, so an
/// explicit direct endpoint is either reached directly or fails with its own errno.
/// Every method and callback runs on the owner's serial queue.
final class DirectTCPStream: @unchecked Sendable {
  enum Phase { case idle, resolving, connecting, open, closed }
  enum OpenFailure: Error { case resolve(Int32), connect(Int32) }

  /// Closes the descriptor only after every dispatch source using it is cancelled.
  private final class Descriptor {
    let value: Int32
    init(_ value: Int32) { self.value = value }
    deinit { Darwin.close(value) }
  }

  private let queue: DispatchQueue
  private(set) var phase = Phase.idle
  private var descriptor: Descriptor?
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var reading = false, writing = false
  private var addresses: [Data] = []
  private var lastError = ECONNREFUSED
  private var opened: ((Result<Void, OpenFailure>) -> Void)?
  private var outbound: [UInt8] = [], outboundOffset = 0
  private var queuedBytes = 0, sentBytes = 0
  private var completions: [(end: Int, handler: (Error?) -> Void)] = []
  private var buffer = [UInt8](repeating: 0, count: 64 * 1024)
  var onReceive: ((Data) -> Void)?
  /// EOF (nil) or a POSIX error once open; never called after close().
  var onEnd: ((Error?) -> Void)?

  init(queue: DispatchQueue) { self.queue = queue }
  deinit { detach() }

  func open(host: String, port: UInt16, completion: @escaping (Result<Void, OpenFailure>) -> Void) {
    guard phase == .idle else { return }
    phase = .resolving; opened = completion
    let service = String(port)
    // getaddrinfo can block on DNS; IP literals return immediately.
    DispatchQueue.global(qos: .userInitiated).async { [weak self, queue = self.queue] in
      var hints = addrinfo()
      hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM
      hints.ai_protocol = IPPROTO_TCP; hints.ai_flags = AI_NUMERICSERV
      var list: UnsafeMutablePointer<addrinfo>?
      let status = getaddrinfo(host, service, &hints, &list)
      var addresses: [Data] = []
      var next = list
      while let entry = next?.pointee {
        if let address = entry.ai_addr { addresses.append(Data(bytes: address, count: Int(entry.ai_addrlen))) }
        next = entry.ai_next
      }
      if let list { freeaddrinfo(list) }
      queue.async { self?.resolved(status, addresses) }
    }
  }

  func write(_ data: Data, completion: @escaping (Error?) -> Void) {
    guard phase == .open else { completion(NSError(domain: NSPOSIXErrorDomain, code: Int(ENOTCONN))); return }
    outbound.append(contentsOf: data); queuedBytes += data.count
    completions.append((queuedBytes, completion))
    flush()
  }

  /// Pausing reads lets the kernel apply TCP backpressure to the peer.
  func setReading(_ enabled: Bool) {
    guard phase == .open, let source = readSource, enabled != reading else { return }
    reading = enabled
    if enabled { source.resume() } else { source.suspend() }
  }

  func close() {
    guard phase != .closed else { return }
    phase = .closed; opened = nil; addresses = []
    detach()
    failPendingWrites(NSError(domain: NSPOSIXErrorDomain, code: Int(ECANCELED)))
  }

  private func resolved(_ status: Int32, _ resolved: [Data]) {
    guard phase == .resolving else { return }
    guard status == 0, !resolved.isEmpty else { failOpen(.resolve(status == 0 ? EAI_NONAME : status)); return }
    addresses = resolved; phase = .connecting
    connectNext()
  }

  /// Tries each resolved address in order; LAN endpoints are a single IPv4 literal.
  private func connectNext() {
    detach()
    guard !addresses.isEmpty else { failOpen(.connect(lastError)); return }
    let address = addresses.removeFirst()
    let family = Int32(address[address.startIndex + 1]) // sockaddr: sa_len, then sa_family
    let fd = socket(family, SOCK_STREAM, IPPROTO_TCP)
    guard fd >= 0 else { lastError = errno; connectNext(); return }
    let descriptor = Descriptor(fd)
    var on: Int32 = 1
    let size = socklen_t(MemoryLayout<Int32>.size)
    guard setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, size) == 0,
      fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK) == 0
    else { lastError = errno; connectNext(); return }
    _ = setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, size)
    let (result, code) = address.withUnsafeBytes { raw -> (Int32, Int32) in
      let result = Darwin.connect(fd, raw.baseAddress!.assumingMemoryBound(to: sockaddr.self), socklen_t(raw.count))
      return (result, result == 0 ? 0 : errno)
    }
    guard result == 0 || code == EINPROGRESS else { lastError = code; connectNext(); return }
    attach(descriptor)
    if result == 0 { connected() } else { setWriting(true) } // Writability reports the outcome.
  }

  private func attach(_ descriptor: Descriptor) {
    let fd = descriptor.value
    let read = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    read.setEventHandler { [weak self] in self?.readable(fd) }
    read.setCancelHandler { withExtendedLifetime(descriptor) {} }
    let write = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
    write.setEventHandler { [weak self] in self?.writable(fd) }
    write.setCancelHandler { withExtendedLifetime(descriptor) {} }
    self.descriptor = descriptor; readSource = read; writeSource = write
  }

  /// A source must be resumed before it is cancelled and released.
  private func detach() {
    if let source = readSource { if !reading { source.resume() }; source.cancel() }
    if let source = writeSource { if !writing { source.resume() }; source.cancel() }
    readSource = nil; writeSource = nil; reading = false; writing = false; descriptor = nil
  }

  private func setWriting(_ enabled: Bool) {
    guard let source = writeSource, enabled != writing else { return }
    writing = enabled
    if enabled { source.resume() } else { source.suspend() }
  }

  private func connected() {
    addresses = []; phase = .open
    let completion = opened; opened = nil
    completion?(.success(()))
  }

  private func failOpen(_ failure: OpenFailure) {
    phase = .closed; addresses = []
    detach()
    let completion = opened; opened = nil
    completion?(.failure(failure))
  }

  private func writable(_ fd: Int32) {
    guard descriptor?.value == fd else { return }
    switch phase {
    case .connecting:
      var code: Int32 = 0
      var length = socklen_t(MemoryLayout<Int32>.size)
      if getsockopt(fd, SOL_SOCKET, SO_ERROR, &code, &length) != 0 { code = errno }
      if code == 0 { setWriting(false); connected() } else { lastError = code; connectNext() }
    case .open: flush()
    default: setWriting(false)
    }
  }

  private func readable(_ fd: Int32) {
    guard phase == .open, descriptor?.value == fd else { return }
    let (count, code) = buffer.withUnsafeMutableBytes { raw -> (Int, Int32) in
      let count = Darwin.recv(fd, raw.baseAddress, raw.count, 0)
      return (count, count < 0 ? errno : 0)
    }
    if count > 0 { onReceive?(Data(buffer[0..<count])) }
    else if count == 0 { end(nil) }
    else if code != EAGAIN && code != EWOULDBLOCK && code != EINTR { end(NSError(domain: NSPOSIXErrorDomain, code: Int(code))) }
  }

  private func flush() {
    guard phase == .open, let fd = descriptor?.value else { return }
    while outboundOffset < outbound.count {
      let offset = outboundOffset
      let (count, code) = outbound.withUnsafeBytes { raw -> (Int, Int32) in
        let count = Darwin.send(fd, raw.baseAddress! + offset, raw.count - offset, 0)
        return (count, count < 0 ? errno : 0)
      }
      if count > 0 { outboundOffset += count; sentBytes += count; continue }
      if count < 0 && code == EINTR { continue }
      if count == 0 || code == EAGAIN || code == EWOULDBLOCK { break }
      end(NSError(domain: NSPOSIXErrorDomain, code: Int(code))); return
    }
    if outboundOffset == outbound.count { outbound.removeAll(); outboundOffset = 0 }
    else if outboundOffset >= 64 * 1024 { outbound.removeFirst(outboundOffset); outboundOffset = 0 }
    setWriting(!outbound.isEmpty)
    let done = completions.prefix { $0.end <= sentBytes }
    completions.removeFirst(done.count)
    for item in done { item.handler(nil) }
  }

  private func end(_ error: Error?) {
    guard phase == .open else { return }
    phase = .closed
    detach()
    failPendingWrites(error ?? NSError(domain: NSPOSIXErrorDomain, code: Int(EPIPE)))
    onEnd?(error)
  }

  private func failPendingWrites(_ error: Error) {
    let pending = completions
    completions = []; outbound = []; outboundOffset = 0
    for item in pending { item.handler(error) }
  }
}

/// RFC 6455 client for explicit `ws://` direct endpoints. URLSession and
/// Network.framework may fall back to a configured proxy; a BSD socket cannot.
/// One serial queue owns the stream, framing, the pending read and shutdown.
/// Client callbacks run on main, like DirectWebSocket.
final class SocketWebSocket: DirectRelayWebSocket, @unchecked Sendable {
  typealias Stage = DirectSocketError.Stage
  static let maximumMessageSize = 2 * 1024 * 1024
  private static let headerLimit = 16 * 1024
  private let queue: DispatchQueue
  private let stream: DirectTCPStream
  private let url: URL
  private let timeoutInterval: TimeInterval
  private let stateLock = NSLock()
  private var taskState: URLSessionTask.State = .suspended
  private var stage = Stage.connect
  private var started = DispatchTime.now()
  private var key = ""
  private var inbound: [UInt8] = []
  private var cursor = 0
  private var fragment: (opcode: UInt8, data: Data)?
  private var message: URLSessionWebSocketTask.Message?
  private var pendingRead: (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?
  private var pongs: [UInt64: (Error?) -> Void] = [:]
  private var pings: UInt64 = 0
  private var timeout: DispatchWorkItem?
  private var stopped = false
  private var terminalError: Error = URLError(.cancelled)
  var onOpen: (() -> Void)?
  var onClose: ((URLSessionWebSocketTask.CloseCode) -> Void)?
  var onEvent: ((String, [String: String]) -> Void)?

  var state: URLSessionTask.State {
    stateLock.lock(); defer { stateLock.unlock() }; return taskState
  }
  private func setState(_ value: URLSessionTask.State) {
    stateLock.lock(); taskState = value; stateLock.unlock()
  }

  init(url: URL, timeout: TimeInterval = 10) {
    let queue = DispatchQueue(label: "com.termbridge.socket-websocket")
    self.queue = queue; stream = DirectTCPStream(queue: queue)
    self.url = url; timeoutInterval = timeout
  }
  deinit { timeout?.cancel() }

  func resume() {
    queue.async { [self] in
      guard !stopped, state == .suspended else { return }
      setState(.running); started = .now()
      let timeout = DispatchWorkItem { [weak self] in self?.expire() }
      self.timeout = timeout
      queue.asyncAfter(deadline: .now() + timeoutInterval, execute: timeout)
      guard let host = url.host?.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), !host.isEmpty,
        let port = UInt16(exactly: url.port ?? 80)
      else { stop(DirectSocketError.make(.badURL, .resolve)); return }
      stream.onReceive = { [weak self] in self?.received($0) }
      stream.onEnd = { [weak self] in self?.ended($0) }
      stream.open(host: host, port: port) { [weak self] in self?.opened($0, host: host) }
    }
  }

  func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    queue.async { [self] in
      if stage == .open && !stopped {
        let raw = closeCode.rawValue
        let code = (1000...4999).contains(raw) && ![1004, 1005, 1006, 1015].contains(raw) ? raw : 1000
        stream.write(Self.frame(0x8, Data([UInt8(code >> 8), UInt8(code & 0xFF)]))) { _ in }
      }
      stop(URLError(.cancelled))
    }
  }

  func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
    queue.async { [self] in
      guard !stopped else { Self.deliver(.failure(terminalError), to: completionHandler); return }
      guard pendingRead == nil else { Self.deliver(.failure(URLError(.cannotParseResponse)), to: completionHandler); return }
      pendingRead = completionHandler
      if stage == .open { process() }
    }
  }

  func send(_ message: URLSessionWebSocketTask.Message, completionHandler: @escaping @Sendable (Error?) -> Void) {
    queue.async { [self] in
      guard stage == .open, !stopped else {
        Self.deliver(stopped ? terminalError : URLError(.cannotConnectToHost), to: completionHandler); return
      }
      let frame: Data
      switch message {
      case .data(let value): frame = Self.frame(0x2, value)
      case .string(let value): frame = Self.frame(0x1, Data(value.utf8))
      @unknown default: Self.deliver(URLError(.cannotParseResponse), to: completionHandler); return
      }
      stream.write(frame) { error in
        Self.deliver(error.map { DirectSocketError.ended($0, .open) as Error }, to: completionHandler)
      }
    }
  }

  func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
    queue.async { [self] in
      guard stage == .open, !stopped else {
        Self.deliver(stopped ? terminalError : URLError(.cannotConnectToHost), to: pongReceiveHandler); return
      }
      pings &+= 1
      let id = pings
      var completed = false
      let finish: (Error?) -> Void = { error in
        guard !completed else { return }; completed = true; Self.deliver(error, to: pongReceiveHandler)
      }
      pongs[id] = finish
      let payload = Data((0..<8).reversed().map { UInt8(truncatingIfNeeded: id >> (UInt64($0) * 8)) })
      stream.write(Self.frame(0x9, payload)) { [weak self] error in
        guard let error else { return }
        self?.pongs.removeValue(forKey: id); finish(DirectSocketError.ended(error, .open))
      }
      queue.asyncAfter(deadline: .now() + 10) { [weak self] in
        self?.pongs.removeValue(forKey: id); finish(URLError(.timedOut))
      }
    }
  }

  private func opened(_ result: Result<Void, DirectTCPStream.OpenFailure>, host: String) {
    guard !stopped else { return }
    if case .failure(let failure) = result { stop(DirectSocketError.open(failure)); return }
    stage = .upgrade
    event("direct_tcp_connected", ["durationMs": elapsed])
    var nonce = [UInt8](repeating: 0, count: 16)
    _ = SecRandomCopyBytes(kSecRandomDefault, nonce.count, &nonce)
    key = Data(nonce).base64EncodedString()
    let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
    var target = components?.percentEncodedPath ?? ""
    if target.isEmpty { target = "/" }
    if let query = components?.percentEncodedQuery { target += "?" + query }
    var authority = host.contains(":") ? "[\(host)]" : host
    if let port = url.port, port != 80 { authority += ":\(port)" }
    let request = "GET \(target) HTTP/1.1\r\nHost: \(authority)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
      + "Sec-WebSocket-Key: \(key)\r\nSec-WebSocket-Version: 13\r\n\r\n"
    stream.write(Data(request.utf8)) { _ in } // A failed write also ends the stream.
    stream.setReading(true)
  }

  private func received(_ data: Data) {
    guard !stopped else { return }
    if cursor > 0 { inbound.removeFirst(cursor); cursor = 0 }
    inbound.append(contentsOf: data)
    if stage == .upgrade { upgrade() } else { process() }
  }

  private func upgrade() {
    var end: Int?
    if inbound.count >= 4 {
      for index in 0...(inbound.count - 4)
      where inbound[index] == 13 && inbound[index + 1] == 10 && inbound[index + 2] == 13 && inbound[index + 3] == 10 {
        end = index; break
      }
    }
    guard let end else {
      if inbound.count > Self.headerLimit { stop(DirectSocketError.make(.badServerResponse, .upgrade)) }
      return
    }
    cursor = end + 4
    guard let head = DirectHTTPHead(Data(inbound[0..<end])) else {
      stop(DirectSocketError.make(.badServerResponse, .upgrade)); return
    }
    event("direct_upgrade_response", ["httpStatus": String(head.status), "durationMs": elapsed])
    let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
    let connection = head.header("connection")?.lowercased().split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespaces) } ?? []
    // No extension or subprotocol was requested, so the server may not select one.
    guard head.status == 101, head.header("upgrade")?.lowercased() == "websocket", connection.contains("upgrade"),
      head.header("sec-websocket-accept") == accept,
      head.header("sec-websocket-extensions") == nil, head.header("sec-websocket-protocol") == nil
    else { stop(DirectSocketError.make(.badServerResponse, .upgrade, httpStatus: head.status)); return }
    stage = .open
    timeout?.cancel(); timeout = nil
    // A BSD socket has no proxy route; the flag records that structurally.
    event("transport_metrics", ["proxy": "false", "durationMs": elapsed])
    let callback = onOpen
    DispatchQueue.main.async { callback?() }
    process()
  }

  /// Parses at most one data message ahead of receive(). While it waits, the
  /// socket stops reading, so a slow consumer applies TCP backpressure.
  private func process() {
    while !stopped {
      if let ready = message, let read = pendingRead {
        message = nil; pendingRead = nil
        Self.deliver(.success(ready), to: read)
        continue
      }
      guard message == nil, let frame = nextFrame() else { break }
      handle(frame)
    }
    if !stopped { stream.setReading(message == nil) }
  }

  private func nextFrame() -> (fin: Bool, opcode: UInt8, payload: Data)? {
    let available = inbound.count - cursor
    guard available >= 2 else { return nil }
    let first = inbound[cursor], second = inbound[cursor + 1]
    // No extension was negotiated, and a server must never mask (RFC 6455 5.1).
    guard first & 0x70 == 0, second & 0x80 == 0 else { violate(); return nil }
    let fin = first & 0x80 != 0, opcode = first & 0x0F
    var length = UInt64(second & 0x7F), header = 2
    if length == 126 {
      guard available >= 4 else { return nil }
      length = UInt64(inbound[cursor + 2]) << 8 | UInt64(inbound[cursor + 3]); header = 4
    } else if length == 127 {
      guard available >= 10 else { return nil }
      length = (2..<10).reduce(UInt64(0)) { $0 << 8 | UInt64(inbound[cursor + $1]) }; header = 10
    }
    if opcode >= 0x8 {
      guard fin, length <= 125 else { violate(); return nil }
    } else if length > UInt64(Self.maximumMessageSize - (fragment?.data.count ?? 0)) {
      stop(DirectSocketError.make(.dataLengthExceedsMaximum, .open)); return nil
    }
    guard UInt64(available - header) >= length else { return nil }
    let start = cursor + header, end = start + Int(length)
    cursor = end
    return (fin, opcode, Data(inbound[start..<end]))
  }

  private func handle(_ frame: (fin: Bool, opcode: UInt8, payload: Data)) {
    switch frame.opcode {
    case 0x1, 0x2:
      guard fragment == nil else { violate(); return }
      if frame.fin { complete(frame.opcode, frame.payload) } else { fragment = (frame.opcode, frame.payload) }
    case 0x0:
      guard var current = fragment else { violate(); return }
      current.data.append(frame.payload)
      fragment = frame.fin ? nil : current
      if frame.fin { complete(current.opcode, current.data) }
    case 0x8: peerClosed(frame.payload)
    case 0x9: stream.write(Self.frame(0xA, frame.payload)) { _ in }
    case 0xA:
      let id = frame.payload.reduce(UInt64(0)) { $0 << 8 | UInt64($1) }
      if frame.payload.count == 8, let pong = pongs.removeValue(forKey: id) { pong(nil) }
    default: violate()
    }
  }

  private func complete(_ opcode: UInt8, _ data: Data) {
    if opcode == 0x2 { message = .data(data); return }
    guard let text = String(data: data, encoding: .utf8) else {
      stop(DirectSocketError.make(.cannotDecodeContentData, .open)); return
    }
    message = .string(text)
  }

  private func peerClosed(_ payload: Data) {
    guard payload.count != 1 else { violate(); return }
    let code = payload.count >= 2 ? Int(payload[payload.startIndex]) << 8 | Int(payload[payload.startIndex + 1]) : 1005
    stream.write(Self.frame(0x8, payload.prefix(2))) { _ in } // Echo the status, as RFC 6455 5.5.1 requires.
    let callback = onClose, closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .abnormalClosure
    DispatchQueue.main.async { callback?(closeCode) }
    stop(URLError(.networkConnectionLost))
  }

  private func ended(_ error: Error?) {
    guard !stopped else { return }
    let failure = DirectSocketError.ended(error, stage)
    if stage == .open { process() } // Deliver what arrived before the stream ended.
    stop(failure)
  }

  private func expire() {
    guard !stopped else { return }
    let current = stage == .connect && stream.phase == .resolving ? Stage.resolve : stage
    stop(DirectSocketError.make(.timedOut, current))
  }

  private func violate() { stop(DirectSocketError.make(.cannotParseResponse, stage)) }

  private func stop(_ error: Error) {
    guard !stopped else { return }
    stopped = true; terminalError = error
    setState(.completed)
    timeout?.cancel(); timeout = nil
    stream.close()
    if let read = pendingRead { pendingRead = nil; Self.deliver(.failure(error), to: read) }
    let waiting = Array(pongs.values)
    pongs.removeAll()
    for pong in waiting { pong(error) }
  }

  private var elapsed: String { String((DispatchTime.now().uptimeNanoseconds - started.uptimeNanoseconds) / 1_000_000) }

  private func event(_ name: String, _ fields: [String: String]) {
    let callback = onEvent
    DispatchQueue.main.async { callback?(name, fields) }
  }

  private static func deliver<Value>(_ value: Value, to callback: @escaping (Value) -> Void) {
    DispatchQueue.main.async { callback(value) }
  }

  /// Client frames are always masked (RFC 6455 5.3).
  static func frame(_ opcode: UInt8, _ payload: Data) -> Data {
    var frame = Data([0x80 | opcode])
    let count = payload.count
    if count < 126 {
      frame.append(0x80 | UInt8(count))
    } else if count <= 0xFFFF {
      frame.append(contentsOf: [0x80 | 126, UInt8(count >> 8), UInt8(count & 0xFF)])
    } else {
      frame.append(0x80 | 127)
      frame.append(contentsOf: (0..<8).reversed().map { UInt8(truncatingIfNeeded: UInt64(count) >> (UInt64($0) * 8)) })
    }
    var mask = [UInt8](repeating: 0, count: 4)
    _ = SecRandomCopyBytes(kSecRandomDefault, mask.count, &mask)
    frame.append(contentsOf: mask)
    var masked = [UInt8](payload)
    for index in masked.indices { masked[index] ^= mask[index & 3] }
    frame.append(contentsOf: masked)
    return frame
  }
}
