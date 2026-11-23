import XCTest
@testable import TermBridgeControlCenter

final class RelayRoutingTests: XCTestCase {
    func testPasswordOnlyLANSurvivesSavingAndHostDiscovery() throws {
        let settings = try PairingCode.parse("termbridge://pair?v=1&relay=ws%3A%2F%2F30.20.30.40%3A7400&secret=2468&mode=direct")
        let restored = try JSONDecoder().decode(MacConnectionStore.Record.self,
            from: JSONEncoder().encode(MacConnectionStore.Record(settings))).settings
        let merged = MacConnectionCatalog.merging(ConnectionProfileState(profiles: [restored], activeID: restored.id),
            base: restored, hosts: [HostInfo(hostID: "mini", name: "Mini")], selectedHostID: "mini")
        let discovered = try XCTUnwrap(merged.active)
        XCTAssertEqual(discovered.relayURL, "ws://30.20.30.40:7400")
        XCTAssertTrue(discovered.tlsFingerprint.isEmpty)
        XCTAssertEqual(discovered.secret, "2468")
        XCTAssertTrue(discovered.isDirectConnection)
        XCTAssertEqual(TermbridgeClient.sessionConfiguration(for: discovered).connectionProxyDictionary?.count, 0)
    }
    func testExistingPublicIPRelayKeepsSystemProxyPolicy() throws {
        // Same address shape as a self-hosted TLS relay; an IP is not proof of LAN transport.
        let data = Data(#"{"middle":"wss://203.0.113.8:8001","secret":"relay-fixture-password","tlsPin":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#.utf8)
        let settings = try MacConnectionStore.decodeCLIProfile(data: data, environment: [:])
        let restored = try JSONDecoder().decode(MacConnectionStore.Record.self,
            from: JSONEncoder().encode(MacConnectionStore.Record(settings))).settings
        let config = TermbridgeClient.sessionConfiguration(for: restored)
        XCTAssertFalse(restored.isDirectConnection, "Opening an old relay in Settings must keep server-address mode")
        XCTAssertNil(config.connectionProxyDictionary, "A saved relay must retain system proxy routing after an update")
    }

    func testExplicitEnterpriseLANModeSurvivesSavingAndHostDiscovery() throws {
        let settings = ConnectionSettings(relayURL: "wss://30.20.30.40:7400", hostID: "", secret: "2468",
            tlsFingerprint: "", mode: .direct)
        let restored = try JSONDecoder().decode(MacConnectionStore.Record.self,
            from: JSONEncoder().encode(MacConnectionStore.Record(settings.normalized()))).settings
        let merged = MacConnectionCatalog.merging(ConnectionProfileState(profiles: [restored], activeID: restored.id),
            base: restored, hosts: [HostInfo(hostID: "mini", name: "Mini")], selectedHostID: "mini")
        let discovered = try XCTUnwrap(merged.active)
        XCTAssertTrue(discovered.isDirectConnection)
        XCTAssertEqual(discovered.secret, "2468")
        XCTAssertEqual(TermbridgeClient.sessionConfiguration(for: discovered).connectionProxyDictionary?.count, 0)
        var relay = discovered; relay.mode = .relay
        XCTAssertFalse(relay.isDirectConnection)
        XCTAssertNil(TermbridgeClient.sessionConfiguration(for: relay).connectionProxyDictionary)
    }

    func testLegacyKeychainRecordKeepsCredentialsAndPublicRelayMode() throws {
        let data = Data(#"{"id":"00000000-0000-0000-0000-000000000001","name":"Mini","relay":"wss://203.0.113.8:8001","host":"mini","secret":"2468","fingerprint":""}"#.utf8)
        let settings = try JSONDecoder().decode(MacConnectionStore.Record.self, from: data).settings
        XCTAssertFalse(settings.isDirectConnection)
        XCTAssertEqual(settings.secret, "2468")
        XCTAssertEqual(settings.relayURL, "wss://203.0.113.8:8001")
    }
}
