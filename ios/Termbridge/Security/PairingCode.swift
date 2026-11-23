import CryptoKit
import Foundation

enum PairingCodeError: Error, LocalizedError, Equatable {
  case unsupported, invalidRelay, invalidSecret, invalidHost, hostNameTooLong, invalidFingerprint, hostedRelayNotConfigured

  var errorDescription: String? {
    switch self {
    case .unsupported: return "Expected a Termbridge pairing QR or termbridge://pair URI"
    case .invalidRelay: return "Pairing requires a wss:// server or explicit ws:// LAN direct mode"
    case .invalidSecret: return "The pairing key is invalid"
    case .invalidHost: return "The pairing host ID is invalid"
    case .hostNameTooLong: return "The pairing host name is too long"
    case .invalidFingerprint: return "The pairing TLS fingerprint is invalid"
    case .hostedRelayNotConfigured: return "Compact tb1_ codes require TB_CLOUDFLARE_RELAY; scan or paste a full termbridge://pair URI from your relay"
    }
  }
}

enum PairingCode {
  static let prefix = "tb1_"

  static func parse(
    _ rawValue: String,
    hostedRelay: String? = ProcessInfo.processInfo.environment["TB_CLOUDFLARE_RELAY"]
  ) throws -> ConnectionSettings {
    let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.hasPrefix(prefix) {
      let secret = String(value.dropFirst(prefix.count))
      guard validOfficialSecret(secret) else { throw PairingCodeError.invalidSecret }
      let base = (hostedRelay ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
      guard !base.isEmpty,
        let baseURL = URL(string: base),
        baseURL.scheme?.lowercased() == "wss",
        baseURL.host?.isEmpty == false
      else { throw PairingCodeError.hostedRelayNotConfigured }
      let digest = SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined()
      return ConnectionSettings(
        relayURL: "\(base)/r/\(digest)", hostID: "", secret: secret,
        tlsFingerprint: "")
    }

    guard let components = URLComponents(string: value),
      components.scheme?.lowercased() == "termbridge",
      components.host?.lowercased() == "pair",
      components.queryItems?.first(where: { $0.name == "v" })?.value == "1"
    else { throw PairingCodeError.unsupported }
    let field: (String) -> String = { name in
      components.queryItems?.first(where: { $0.name == name })?.value ?? ""
    }
    let relay = field("relay")
    let secret = field("secret")
    let hostID = field("host")
    let hostName = field("name")
    let tlsFingerprint = field("pin")
    let modeValue = field("mode")
    let mode = ConnectionMode(rawValue: modeValue)
    guard modeValue.isEmpty || mode != nil else { throw PairingCodeError.unsupported }
    guard let relayURL = URL(string: relay),
      relayURL.scheme?.lowercased() == "wss" || (relayURL.scheme?.lowercased() == "ws" && mode == .direct),
      relayURL.host?.isEmpty == false else { throw PairingCodeError.invalidRelay }
    if relayURL.scheme?.lowercased() == "ws" && !tlsFingerprint.isEmpty { throw PairingCodeError.invalidFingerprint }
    guard (1...256).contains(secret.count) else { throw PairingCodeError.invalidSecret }
    if !hostID.isEmpty,
      hostID.range(of: #"^[a-zA-Z0-9._:-]{1,128}$"#, options: .regularExpression) == nil
    { throw PairingCodeError.invalidHost }
    if hostName.count > 128 { throw PairingCodeError.hostNameTooLong }
    if !tlsFingerprint.isEmpty,
      tlsFingerprint.range(of: #"^[a-fA-F0-9]{64}$"#, options: .regularExpression) == nil
    { throw PairingCodeError.invalidFingerprint }
    return ConnectionSettings(
      relayURL: relay, hostID: hostID, secret: secret,
      tlsFingerprint: tlsFingerprint.lowercased(),
      hostName: hostName, mode: mode)
  }

  static func isPairingURL(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "termbridge" && url.host?.lowercased() == "pair"
  }

  private static func validOfficialSecret(_ secret: String) -> Bool {
    guard secret.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
    else { return false }
    var base64 = secret.replacingOccurrences(of: "-", with: "+")
      .replacingOccurrences(of: "_", with: "/")
    base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
    return Data(base64Encoded: base64)?.count == 32
  }
}
