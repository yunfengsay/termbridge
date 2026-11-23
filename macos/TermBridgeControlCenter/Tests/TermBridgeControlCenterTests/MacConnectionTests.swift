import XCTest
import Security
@testable import TermBridgeControlCenter

final class MacConnectionTests: XCTestCase {
    @MainActor func testSavingAnOfflineProfileDoesNotDependOnHandshakeOrChangeActiveConnection() async throws {
        guard ProcessInfo.processInfo.environment["TB_MACOS_TEST_KEYCHAIN"] == "1" else { throw XCTSkip("Explicit test Keychain") }
        let service = "dev.termbridge.test.offline." + UUID().uuidString, store = MacConnectionStore(service: service)
        defer { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ControlCenterModel(contextURL: root, profiles: [], startServices: false, connectionStore: store)
        defer { model.disconnectTerminals() }
        let profile = ConnectionSettings(relayURL: "ws://127.0.0.1:1", hostID: "", secret: "2468", tlsFingerprint: "", mode: .direct)
        let saved = try model.saveProfile(profile, connect: false)
        XCTAssertEqual(saved, profile); XCTAssertNil(model.activeProfileID)
        do { _ = try await MacConnectionTest.run(saved, discoverCertificate: false); XCTFail("Closed port must fail") }
        catch { XCTAssertTrue(error.localizedDescription.contains("建立 WebSocket 连接")) }
        XCTAssertEqual(try store.load(), [profile]); XCTAssertEqual(model.profiles, [profile])
    }
    func testCLIImportMatchesCLIDefaultAndAddressNormalization() throws {
        XCTAssertEqual(MacConnectionStore.cliProfile(data: Data("{}".utf8), environment: [:])?.relayURL, "ws://localhost:7400")
        let cli = Data(#"{"middle":"  WSS://example.test/room  ","secret":"test-only"}"#.utf8)
        XCTAssertEqual(MacConnectionStore.cliProfile(data: cli, environment: [:])?.relayURL, "WSS://example.test/room")
        XCTAssertEqual(MacConnectionStore.cliProfile(data: cli, environment: ["RELAY_URL": "", "TB_SECRET": ""])?.secret, "test-only")
    }

    func testCLIImportReportsMissingMalformedAndInvalidFilesSeparately() throws {
        let missing = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        XCTAssertThrowsError(try MacConnectionStore.loadCLIProfile(from: missing, environment: [:])) {
            guard case MacConnectionStore.CLIImportError.missingFile = $0 else { return XCTFail("Expected missing file") }
        }
        XCTAssertThrowsError(try MacConnectionStore.decodeCLIProfile(data: Data("not json".utf8), environment: [:])) {
            guard case MacConnectionStore.CLIImportError.malformedFile = $0 else { return XCTFail("Expected malformed file") }
        }
        XCTAssertThrowsError(try MacConnectionStore.decodeCLIProfile(data: Data(#"{"middle":"invalid address"}"#.utf8), environment: [:])) {
            guard case MacConnectionStore.CLIImportError.invalidConnection = $0 else { return XCTFail("Expected invalid connection") }
        }
        let env = ["RELAY_URL": "wss://override.example.test", "TB_SECRET": "test-only"]
        XCTAssertEqual(try MacConnectionStore.loadCLIProfile(from: missing, environment: env).secret, "test-only")
    }

    private func profile(_ host: String = "", relay: String = "ws://localhost:7400") -> ConnectionSettings {
        ConnectionSettings(relayURL: relay, hostID: host, secret: "test-only", tlsFingerprint: "", hostName: "")
    }

    func testDiscoveryResolvesSelectedHostWithoutLosingEarlierRosterItems() {
        let base = profile()
        let state = ConnectionProfileState(profiles: [base], activeID: base.id)
        let hosts = [HostInfo(hostID: "first", name: "Mac mini"), HostInfo(hostID: "second", name: "Mac mini")]
        let result = MacConnectionCatalog.merging(state, base: base, hosts: hosts, selectedHostID: "second")
        XCTAssertEqual(Set(result.profiles.map(\.hostID)), Set(["first", "second"]))
        XCTAssertEqual(result.active?.hostID, "second")
        XCTAssertEqual(result.activeID, base.id)
        let repeated = MacConnectionCatalog.merging(result, base: result.active!, hosts: hosts.reversed(), selectedHostID: "second")
        XCTAssertEqual(repeated, result)
    }

    func testSameHostAcrossDifferentSourcesRemainsSeparate() {
        let first = profile("mini", relay: "ws://localhost:7400")
        let second = profile("mini", relay: "wss://example.test/room")
        let state = ConnectionProfileState(profiles: [first, second], activeID: second.id)
        let result = MacConnectionCatalog.merging(state, base: second,
            hosts: [HostInfo(hostID: "mini", name: "Mac mini")], selectedHostID: "mini")
        XCTAssertEqual(result.profiles.count, 2)
        XCTAssertEqual(result.activeID, second.id)
        XCTAssertNotEqual(MacConnectionCatalog.terminalKey(profileID: first.id, sessionID: "herdr:w1:p1"),
                          MacConnectionCatalog.terminalKey(profileID: second.id, sessionID: "herdr:w1:p1"))
    }

    func testKeychainPersistsEditsWithoutTouchingOtherConnections() throws {
        guard ProcessInfo.processInfo.environment["TB_MACOS_TEST_KEYCHAIN"] == "1" else {
            throw XCTSkip("Enable explicit Mac Keychain acceptance")
        }
        let service = "dev.termbridge.test.connections." + UUID().uuidString
        let store = MacConnectionStore(service: service)
        defer { SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary) }
        let first = profile("first"), second = profile("second")
        try store.save([first, second])
        XCTAssertEqual(try store.load(), [first, second])
        var edited = second; edited.hostName = "Office Mac"
        try store.save([first, edited])
        XCTAssertEqual(try store.load(), [first, edited])
        try store.save([edited])
        XCTAssertEqual(try store.load(), [edited])
    }

    func testRecordRoundTripAndCLIImportOnlyUsesTransportSettings() throws {
        let original = profile("mini")
        let data = try JSONEncoder().encode([MacConnectionStore.Record(original)])
        XCTAssertEqual(try JSONDecoder().decode([MacConnectionStore.Record].self, from: data).first?.settings, original)
        let cli = Data(#"{"middle":"example.test:9000","secret":"test-only","voice":{"unexpected":"ignored"}}"#.utf8)
        let imported = MacConnectionStore.cliProfile(data: cli, environment: [:])
        XCTAssertEqual(imported?.relayURL, "ws://example.test:9000")
        XCTAssertEqual(imported?.secret, "test-only")
        XCTAssertEqual(MacConnectionStore.cliProfile(data: cli, environment: ["RELAY_URL": "wss://override.test"])?.relayURL, "wss://override.test")
        XCTAssertNil(MacConnectionStore.cliProfile(data: Data(#"{"middle":"invalid address"}"#.utf8), environment: [:]))
    }
}
