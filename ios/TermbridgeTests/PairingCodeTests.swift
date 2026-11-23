import XCTest

@testable import Termbridge

final class PairingCodeTests: XCTestCase {
  func testPasswordOnlyLANPairingRequiresExplicitDirectMode() throws {
    let base = "termbridge://pair?v=1&relay=ws%3A%2F%2F30.20.30.40%3A7400&secret=2468"
    let settings = try PairingCode.parse(base + "&mode=direct")
    XCTAssertEqual(settings.relayURL, "ws://30.20.30.40:7400")
    XCTAssertEqual(settings.secret, "2468")
    XCTAssertTrue(settings.tlsFingerprint.isEmpty)
    XCTAssertTrue(settings.isDirectConnection)
    XCTAssertThrowsError(try PairingCode.parse(base))
    XCTAssertThrowsError(try PairingCode.parse(base + "&mode=relay"))
    XCTAssertThrowsError(try PairingCode.parse(base + "&mode=direct&pin=" + String(repeating: "a", count: 64)))
  }
  func testSelfHostedPairingAcceptsFourCharacterPassword() throws {
    let settings = try PairingCode.parse("termbridge://pair?v=1&relay=wss%3A%2F%2F30.20.30.40%3A7400&secret=2468&mode=direct")
    XCTAssertEqual(settings.secret, "2468")
    XCTAssertTrue(settings.isDirectConnection)
    XCTAssertThrowsError(try PairingCode.parse("tb1_2468"))
    let relay = try PairingCode.parse("termbridge://pair?v=1&relay=wss%3A%2F%2F203.0.113.8%3A8001&secret=2468")
    XCTAssertFalse(relay.isDirectConnection)
    XCTAssertThrowsError(try PairingCode.parse("termbridge://pair?v=1&relay=wss%3A%2F%2F203.0.113.8%3A8001&secret=2468&mode=invalid"))
  }
  func testParsesHostedConnectionCodeWhenRelayConfigured() throws {
    let relay = "wss://relay.example.test"
    XCTAssertThrowsError(
      try PairingCode.parse("tb1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", hostedRelay: nil)
    ) {
      XCTAssertEqual($0 as? PairingCodeError, .hostedRelayNotConfigured)
    }
    let settings = try PairingCode.parse(
      "tb1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      hostedRelay: relay
    )
    XCTAssertTrue(settings.relayURL.hasPrefix(relay + "/r/"))
    XCTAssertEqual(settings.secret, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
    XCTAssertEqual(URL(string: settings.relayURL)?.path.count, 67)
    XCTAssertTrue(settings.hostID.isEmpty)
  }

  func testParsesCloudflareQRWithMacIdentity() throws {
    let pin = String(repeating: "b", count: 64)
    let value = "termbridge://pair?v=1&relay=wss%3A%2F%2Frelay.example.com%2Fr%2F0123456789012345678901234567890123456789012345678901234567890123&secret=1234567890abcdef&host=mac-mini%3Ahome&name=Studio%20Mac&pin=\(pin)"
    let settings = try PairingCode.parse(value)
    XCTAssertEqual(settings.relayURL, "wss://relay.example.com/r/0123456789012345678901234567890123456789012345678901234567890123")
    XCTAssertEqual(settings.hostID, "mac-mini:home")
    XCTAssertEqual(settings.hostName, "Studio Mac")
    XCTAssertEqual(settings.tlsFingerprint, pin)
  }

  func testRejectsInsecurePairingQR() {
    XCTAssertThrowsError(
      try PairingCode.parse("termbridge://pair?v=1&relay=ws%3A%2F%2Flocalhost&secret=1234567890abcdef")) {
        XCTAssertEqual($0 as? PairingCodeError, .invalidRelay)
      }
  }

  func testRejectsMalformedPairingFingerprint() {
    XCTAssertThrowsError(
      try PairingCode.parse(
        "termbridge://pair?v=1&relay=wss%3A%2F%2Frelay.example.com&secret=1234567890abcdef&pin=deadbeef"
      )) {
        XCTAssertEqual($0 as? PairingCodeError, .invalidFingerprint)
      }
  }
}
