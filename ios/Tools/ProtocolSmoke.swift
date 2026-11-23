import Darwin
import Foundation

final class SmokeListener: NSObject, TermbridgeClientListener {
  private(set) var finished = false
  private(set) var succeeded = false
  private let ptyMode: Bool
  private var sid: Int?
  private var sessionID: String?
  private var output = ""
  private var sentExit = false

  init(ptyMode: Bool) {
    self.ptyMode = ptyMode
  }

  func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
    switch state {
    case .connected:
      print("transport=connected")
    case .failed(let message):
      print("transport=failed detail=\(message)")
      finished = true
    default:
      break
    }
  }

  func clientIsReady(_ client: TermbridgeClient) {
    if ptyMode {
      client.sendControl([
        "t": .string("session_create"),
        "command": .string("/bin/sh"),
        "cols": .int(80),
        "rows": .int(24),
        "clientPlatform": .string("ios-smoke"),
      ])
    } else {
      client.sendControl(["t": .string("session_list")])
    }
  }

  func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
    switch message.type {
    case "session_list_result":
      let sessions = message.sessions()
      print("protocol=ready sessions=\(sessions.count) active=\(sessions.filter(\.isActive).count)")
      succeeded = true
      finished = true
      client.disconnect()
    case "session_created":
      guard ptyMode, let sid = message.int("sid"), let sessionID = message.string("sessionId")
      else { return }
      self.sid = sid
      self.sessionID = sessionID
      let command = "printf '\\111\\117\\123\\137\\111\\116\\120\\125\\124\\137\\117\\113\\n'\r"
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
        client.sendPTYInput(sid: sid, data: Data(command.utf8))
      }
    case "session_exit":
      guard ptyMode, message.string("sessionId") == sessionID else { return }
      succeeded = output.contains("IOS_INPUT_OK")
      print("pty=\(succeeded ? "ready" : "failed") input=true output=\(succeeded)")
      finished = true
      client.disconnect()
    case "error":
      print("protocol=failed detail=\(message.string("message") ?? "unknown")")
      finished = true
    default:
      break
    }
  }

  func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {
    guard ptyMode, self.sid == sid else { return }
    output += String(decoding: data, as: UTF8.self)
    if output.contains("IOS_INPUT_OK"), !sentExit {
      sentExit = true
      client.sendPTYInput(sid: sid, data: Data("exit\r".utf8))
    }
  }
}

@main
enum ProtocolSmoke {
  static func main() {
    let environment = ProcessInfo.processInfo.environment
    guard let relay = environment["TB_RELAY_URL"], !relay.isEmpty else {
      fputs("TB_RELAY_URL is required\n", stderr)
      exit(2)
    }
    let settings = ConnectionSettings(
      relayURL: relay,
      hostID: environment["TB_HOST_ID"] ?? "",
      secret: environment["TB_SECRET"] ?? "",
      tlsFingerprint: environment["TB_TLS_FINGERPRINT"] ?? ""
    )
    if let error = settings.validationError {
      fputs("Invalid settings: \(error)\n", stderr)
      exit(2)
    }

    let listener = SmokeListener(ptyMode: environment["TB_SMOKE_PTY"] == "1")
    let client = TermbridgeClient(settings: settings, listener: listener)
    client.connect()
    let deadline = Date().addingTimeInterval(15)
    while !listener.finished
      && RunLoop.main.run(mode: .default, before: min(deadline, Date().addingTimeInterval(0.1)))
      && Date() < deadline
    {}
    client.disconnect()
    exit(listener.succeeded ? 0 : 1)
  }
}
