import XCTest

@testable import Termbridge

final class ConnectionSettingsTests: XCTestCase {
  func testAcceptsWebSocketURLAndColonSeparatedFingerprint() {
    let settings = ConnectionSettings(
      relayURL: "wss://relay.example.com:8001",
      hostID: "host",
      secret: "secret",
      tlsFingerprint: Array(repeating: "AB", count: 32).joined(separator: ":")
    )
    XCTAssertNil(settings.validationError)
    XCTAssertEqual(settings.normalizedFingerprint, String(repeating: "ab", count: 32))
  }

  func testRejectsHTTPAndShortPins() {
    XCTAssertEqual(
      ConnectionSettings(
        relayURL: "https://example.com", hostID: "", secret: "", tlsFingerprint: ""
      ).validationError,
      "Relay URL must start with ws:// or wss://"
    )
    XCTAssertEqual(
      ConnectionSettings(
        relayURL: "ws://localhost:7400", hostID: "", secret: "", tlsFingerprint: "abcd"
      ).validationError,
      "TLS fingerprint must contain 64 hexadecimal characters"
    )
  }

  func testRejectsNonHexFingerprint() {
    let invalid = String(repeating: "a", count: 63) + "g"
    XCTAssertEqual(
      ConnectionSettings(
        relayURL: "wss://example.com", hostID: "", secret: "", tlsFingerprint: invalid
      ).validationError,
      "TLS fingerprint is not hexadecimal"
    )
  }
}
