import XCTest
@testable import Termbridge

final class LANConnectionTests: XCTestCase {
  func testDirectEndpointsUseWSAndPreserveExplicitLegacyTLS() throws {
    XCTAssertEqual(try LANConnection.endpoint(address: "192.168.1.20", port: "7400"), "ws://192.168.1.20:7400")
    XCTAssertEqual(try LANConnection.endpoint(address: "30.20.30.40", port: "7400"), "ws://30.20.30.40:7400")
    XCTAssertEqual(try LANConnection.endpoint(address: "30.20.30.40", port: "7400", useTLS: true), "wss://30.20.30.40:7400")
    XCTAssertTrue(LANConnection.isDirectEndpoint("ws://30.20.30.40:7400"))
    XCTAssertTrue(LANConnection.isDirectEndpoint("wss://30.20.30.40:7400"))
    XCTAssertFalse(LANConnection.isDirectEndpoint("ws://30.20.30.40:7400/r/room"))
    for value in ["0.0.0.0", "224.0.0.1", "255.255.255.255", "010.0.0.1", "192.168.1.256", "mac.local", "10.1.2.3/path"] {
      XCTAssertThrowsError(try LANConnection.endpoint(address: value, port: "7400"))
    }
    XCTAssertThrowsError(try LANConnection.endpoint(address: "10.1.2.3", port: "80"))
  }
  func testPlainLANDoesNotStartCertificateDiscovery() async {
    do {
      _ = try await LANConnection.probe("ws://127.0.0.1:7400")
      XCTFail("WS must not be probed as HTTPS")
    } catch { XCTAssertEqual((error as? URLError)?.code, .badURL) }
  }
  func testLANAndRemoteConnectionsToSameMacCoexist() {
    let remote = ConnectionSettings(relayURL: "wss://relay.example", hostID: "same-mac", secret: "remote", tlsFingerprint: "")
    let lan = ConnectionSettings(relayURL: "wss://192.168.1.20:7400", hostID: "same-mac", secret: "local", tlsFingerprint: String(repeating: "a", count: 64))
    let state = ConnectionProfileState(profiles: [], activeID: nil).upserting(remote).upserting(lan)
    XCTAssertEqual(state.profiles.count, 2)
    XCTAssertEqual(state.activeID, lan.id)
  }
  func testDesktopPasswordsAreBoundToHostEndpointAndTrustButNotDisplayName() {
    let base = ConnectionSettings(relayURL: "wss://192.168.1.20:7400", hostID: "mac-one", secret: "pairing", tlsFingerprint: String(repeating: "a", count: 64))
    let key = DesktopCredentialStore.account(for: base)
    var renamed = base; renamed.hostName = "New display name"; renamed.profileID = UUID()
    XCTAssertEqual(key, DesktopCredentialStore.account(for: renamed))
    var host = base; host.hostID = "mac-two"
    var endpoint = base; endpoint.relayURL = "wss://relay.example"
    var secret = base; secret.secret = "rotated"
    var certificate = base; certificate.tlsFingerprint = String(repeating: "b", count: 64)
    for changed in [host, endpoint, secret, certificate] {
      XCTAssertNotEqual(key, DesktopCredentialStore.account(for: changed))
    }
  }

  func testCertificateProbeAgainstExplicitLocalFixture() async throws {
    guard let endpoint = ProcessInfo.processInfo.environment["TB_TEST_LAN_ENDPOINT"],
      let expected = ProcessInfo.processInfo.environment["TB_TEST_LAN_PIN"] else { throw XCTSkip("Explicit local TLS fixture only") }
    let pin = try await LANConnection.probe(endpoint)
    XCTAssertEqual(pin, expected)
  }
}
