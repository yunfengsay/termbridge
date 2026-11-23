import Foundation
import Network

// Arguments: <url> <mode> <proxy-port> <socket|network>
@main struct DirectTransportProbe {
  static func main() {
    let args = CommandLine.arguments, mode = args[2], transport = args[4]
    let url = URL(string: args[1])!
    if mode == "replace" { replacementProbe(url: url, transport: transport); RunLoop.main.run(); return }
    let socket: DirectRelayWebSocket
    if transport == "network" {
      let parameters = DirectWebSocket.parameters(fingerprint: "", secure: false)
      if mode == "proxy" || mode == "fallback" {
        if #available(macOS 14, *) {
          // proxy forces the route; fallback keeps preferNoProxies and lets the direct candidate fail first.
          if mode == "proxy" { parameters.preferNoProxies = false }
          let privacy = NWParameters.PrivacyContext(description: "Disposable proxy regression")
          privacy.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(args[3])!))]
          parameters.setPrivacyContext(privacy)
        } else { exit(3) }
      }
      socket = DirectWebSocket(url: url, parameters: parameters)
    } else {
      socket = SocketWebSocket(url: url, timeout: 1.5)
    }
    let started = Date()
    let payload = Data(repeating: 0x61, count: 128 * 1024)
    socket.onEvent = { event, fields in if event == "transport_metrics" { print("PROXY \(fields["proxy"] ?? "missing")") } }
    socket.onOpen = {
      if ["proxy", "cancel", "fallback", "refused", "stall", "reject", "badaccept"].contains(mode) { print("UNEXPECTED_OPEN"); exit(1) }
    }
    socket.onClose = { code in
      if mode == "echo" && code == .normalClosure { print("CLOSE_OK"); exit(0) }
      if mode == "closecode" { print("CLOSE_CODE \(code.rawValue)"); exit(0) }
      print("UNEXPECTED_CLOSE \(code.rawValue)"); exit(1)
    }
    socket.receive { result in
      switch result {
      case .failure(let error):
        let error = error as NSError
        let underlying = (error.userInfo[NSUnderlyingErrorKey] as? NSError)?.code ?? 0
        let stage = DirectSocketError.stage(of: error) ?? "none"
        let elapsed = Int(Date().timeIntervalSince(started) * 1000)
        switch mode {
        case "proxy" where error.domain == DirectWebSocket.errorDomain && error.code == 1:
          print("PROXY_REJECTED_BEFORE_AUTH"); exit(0)
        case "cancel" where error.domain == NSURLErrorDomain && error.code == NSURLErrorCancelled:
          print("CANCEL_OK"); exit(0)
        case "oversize", "fragments": print("OVERSIZE_REJECTED"); exit(0)
        case "fallback", "refused": print("FAILED \(error.domain) \(error.code) \(underlying) \(stage) \(elapsed)"); exit(0)
        case "stall" where error.code == NSURLErrorTimedOut: print("TIMEOUT_STAGE \(stage) \(elapsed)"); exit(0)
        case "reject" where error.code == NSURLErrorBadServerResponse:
          print("UPGRADE_REJECTED \(DirectSocketError.httpStatus(of: error) ?? 0) \(stage)"); exit(0)
        case "badaccept" where error.code == NSURLErrorBadServerResponse: print("ACCEPT_REJECTED \(stage)"); exit(0)
        case "masked" where error.code == NSURLErrorCannotParseResponse: print("MASKED_REJECTED"); exit(0)
        default: print("UNEXPECTED_ERROR \(error.domain) \(error.code) \(underlying) \(stage)"); exit(1)
        }
      case .success(let message):
        switch (mode, message) {
        case ("text", .string(let text)) where text == "hello": print("TEXT_OK"); exit(0)
        case ("limit", .data(let data)) where data.count == SocketWebSocket.maximumMessageSize: print("LIMIT_OK"); exit(0)
        case ("serverping", .data(let data)) where data == Data("pong-ok".utf8): print("SERVER_PING_OK"); exit(0)
        case ("split", .string(let text)) where text == "hi":
          socket.receive { result in
            guard case .success(.data(let data)) = result, data == Data(repeating: 7, count: 256) else { print("SPLIT_FAILED"); exit(1) }
            print("SPLIT_OK"); exit(0)
          }
        case ("closecode", _), ("serverping", _): socket.receive { _ in }
        case ("echo", .data(let data)) where data == Data("welcome".utf8):
          socket.receive { result in
            guard case .success(.data(let data)) = result, data == payload else { print("ECHO_FAILED"); exit(1) }
            print("FRAGMENTED_ECHO_OK")
            // Keep receiving so the transport can process control frames and the peer's close.
            socket.receive { _ in }
            socket.sendPing { error in
              guard error == nil else { print("PING_FAILED"); exit(1) }
              print("PING_OK")
              socket.send(.data(Data("close-now".utf8))) { error in
                if error != nil { print("SEND_FAILED"); exit(1) }
              }
            }
          }
          socket.send(.data(payload)) { error in
            if error != nil { print("SEND_FAILED"); exit(1) }
          }
        default: print("UNEXPECTED_MESSAGE"); exit(1)
        }
      }
    }
    if mode == "cancel" { socket.cancel(with: .normalClosure, reason: nil) }
    socket.resume()
    DispatchQueue.main.asyncAfter(deadline: .now() + 15) { print("TIMEOUT"); exit(2) }
    RunLoop.main.run()
  }
}

// Cancel an open read twice, then replace the transport from its own callback.
// Every delivered callback must share the client/UI lifecycle's main queue.
private var replacementSocket: DirectRelayWebSocket?
private func replacementProbe(url: URL, transport: String, round: Int = 0) {
  let socket: DirectRelayWebSocket = transport == "network"
    ? DirectWebSocket(url: url, parameters: DirectWebSocket.parameters(fingerprint: "", secure: false))
    : SocketWebSocket(url: url)
  replacementSocket = socket
  socket.onOpen = { precondition(Thread.isMainThread) }
  socket.receive { result in
    precondition(Thread.isMainThread)
    guard case .success(.data(let data)) = result, data == Data("welcome".utf8) else { print("REPLACE_READ_FAILED"); exit(1) }
    socket.receive { result in
      precondition(Thread.isMainThread)
      guard case .failure(let error) = result, (error as NSError).code == NSURLErrorCancelled else { print("REPLACE_CANCEL_FAILED"); exit(1) }
      if round == 9 { print("REPLACE_REENTRANT_OK"); exit(0) }
      replacementProbe(url: url, transport: transport, round: round + 1)
    }
    socket.cancel(with: .normalClosure, reason: nil)
    socket.cancel(with: .normalClosure, reason: nil)
  }
  socket.resume()
  if round == 0 { DispatchQueue.main.asyncAfter(deadline: .now() + 15) { print("REPLACE_TIMEOUT"); exit(2) } }
}
