import XCTest

@testable import Termbridge

final class ConnectionProfileStateTests: XCTestCase {
  func testDiscoveredHostsBecomeSwitchableProfiles() {
    let base = ConnectionSettings(
      relayURL: "wss://relay.example.com/r/room", hostID: "", secret: "1234567890abcdef",
      tlsFingerprint: "")
    let state = ConnectionProfileState(profiles: [base], activeID: base.profileID)
      .mergingHosts(
        base: base,
        hosts: [HostInfo(hostID: "mac-a", name: "Desk"), HostInfo(hostID: "mac-b", name: "Laptop")],
        selectedHostID: "mac-a")

    XCTAssertEqual(Set(state.profiles.map(\.hostID)), ["mac-a", "mac-b"])
    XCTAssertEqual(state.active?.hostID, "mac-a")
    XCTAssertEqual(state.active?.profileID, base.profileID)
    XCTAssertTrue(state.profiles.allSatisfy { $0.secret == base.secret })
  }

  func testRemovingActiveProfileSelectsNeighbor() {
    let first = ConnectionSettings(
      relayURL: "wss://one.example", hostID: "one", secret: "secret", tlsFingerprint: "")
    let second = ConnectionSettings(
      relayURL: "wss://two.example", hostID: "two", secret: "secret", tlsFingerprint: "")
    let result = ConnectionProfileState(profiles: [first, second], activeID: first.profileID)
      .removing(first.profileID)
    XCTAssertEqual(result.active, second)
  }
}
