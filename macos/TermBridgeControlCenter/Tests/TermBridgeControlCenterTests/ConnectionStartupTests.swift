import XCTest
@testable import TermBridgeControlCenter

@MainActor final class ConnectionStartupTests: XCTestCase {
    func testBlockedKeychainDoesNotBlockMainActorOrOverwriteConnections() async throws {
        let started = expectation(description: "Keychain request started off the UI thread")
        let release = DispatchSemaphore(value: 0)
        let context = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ControlCenterModel(contextURL: context, startServices: false, cliSettingsURL: context, loadConnections: {
            XCTAssertFalse(Thread.isMainThread)
            started.fulfill(); release.wait(); return []
        })
        defer { release.signal(); model.disconnectTerminals() }
        XCTAssertTrue(model.loadingConnections)
        await fulfillment(of: [started], timeout: 2)
        // Executing here proves the UI can launch the independent LAN controller
        // while Keychain remains blocked. Mutations cannot overwrite unloaded data.
        XCTAssertThrowsError(try model.removeProfile(UUID()))
        release.signal()
        for _ in 0..<100 where model.loadingConnections { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertFalse(model.loadingConnections)
        XCTAssertNil(model.settingsError)
    }

    func testShutdownDiscardsLateKeychainResult() async throws {
        let started = expectation(description: "Keychain pending")
        let release = DispatchSemaphore(value: 0)
        let context = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let model = ControlCenterModel(contextURL: context, startServices: false, cliSettingsURL: context, loadConnections: {
            started.fulfill(); release.wait(); throw NSError(domain: "late", code: 1)
        })
        await fulfillment(of: [started], timeout: 2)
        model.disconnectTerminals(); release.signal()
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(model.settingsError, "Retired startup cannot mutate the model")
    }
}
