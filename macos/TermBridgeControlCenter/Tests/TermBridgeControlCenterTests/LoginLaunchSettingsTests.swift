import ServiceManagement
import XCTest
@testable import TermBridgeControlCenter

private actor LoginLaunchFixture: LoginLaunchService {
    var value: SMAppService.Status = .notRegistered
    var enabledResult: SMAppService.Status = .enabled
    var rejects = false
    var requests: [Bool] = []
    var holdNextRead = false
    var held: CheckedContinuation<SMAppService.Status, Never>?
    func status() async -> SMAppService.Status {
        if holdNextRead {
            holdNextRead = false
            return await withCheckedContinuation { held = $0 }
        }
        return value
    }
    func setEnabled(_ enabled: Bool) throws {
        requests.append(enabled)
        if rejects { throw NSError(domain: "LoginFixture", code: 1, userInfo: [NSLocalizedDescriptionKey: "System refused"]) }
        value = enabled ? enabledResult : .notRegistered
    }
    func configure(_ value: SMAppService.Status, rejects: Bool = false, approval: Bool = false) {
        self.value = value; self.rejects = rejects; enabledResult = approval ? .requiresApproval : .enabled
    }
    func pauseRead() { holdNextRead = true }
    func hasHeldRead() -> Bool { held != nil }
    func finishRead(_ snapshot: SMAppService.Status) { held?.resume(returning: snapshot); held = nil }
}

final class LoginLaunchSettingsTests: XCTestCase {
    @MainActor func testEnableDisableUsesSystemResult() async {
        let system = LoginLaunchFixture()
        let model = LoginLaunchSettings(service: system)
        await model.refresh(); XCTAssertFalse(model.requested)
        await model.setEnabled(true); XCTAssertTrue(model.requested); XCTAssertEqual(model.status, .enabled)
        await model.setEnabled(false); XCTAssertFalse(model.requested); XCTAssertNil(model.error)
        let requests = await system.requests
        XCTAssertEqual(requests, [true, false])
    }
    @MainActor func testFirstRegistrationWorksWhenSystemHasNoServiceRecord() async {
        let system = LoginLaunchFixture(); await system.configure(.notFound)
        let model = LoginLaunchSettings(service: system)
        await model.refresh(); XCTAssertFalse(model.requested)
        await model.setEnabled(true)
        XCTAssertEqual(model.status, .enabled); XCTAssertNil(model.error)
    }
    @MainActor func testApprovalIsPendingRatherThanReportedAsEnabled() async {
        let system = LoginLaunchFixture(); await system.configure(.notRegistered, approval: true)
        let model = LoginLaunchSettings(service: system)
        await model.setEnabled(true)
        XCTAssertEqual(model.status, .requiresApproval); XCTAssertTrue(model.requested)
        XCTAssertTrue(model.description.contains("需要"))
        await system.configure(.enabled); await model.refresh()
        XCTAssertEqual(model.status, .enabled)
    }
    @MainActor func testRejectedEnableLeavesToggleOffAndExplainsFailure() async {
        let system = LoginLaunchFixture(); await system.configure(.notRegistered, rejects: true)
        let model = LoginLaunchSettings(service: system)
        await model.setEnabled(true)
        XCTAssertFalse(model.requested); XCTAssertNotNil(model.error); XCTAssertFalse(model.updating)
    }
    @MainActor func testRejectedDisableKeepsActualEnabledState() async {
        let system = LoginLaunchFixture(); await system.configure(.enabled, rejects: true)
        let model = LoginLaunchSettings(service: system)
        await model.setEnabled(false)
        XCTAssertTrue(model.requested); XCTAssertNotNil(model.error)
    }
    @MainActor func testExternalRemovalIsReflectedOnRefresh() async {
        let system = LoginLaunchFixture(); await system.configure(.enabled)
        let model = LoginLaunchSettings(service: system)
        await model.refresh(); XCTAssertTrue(model.requested)
        await system.configure(.notRegistered); await model.refresh()
        XCTAssertFalse(model.requested)
    }
    @MainActor func testSlowRefreshCannotOverwriteNewRegistration() async {
        let system = LoginLaunchFixture()
        let settings = LoginLaunchSettings(service: system)
        await system.pauseRead()
        let refresh = Task { await settings.refresh() }
        while !(await system.hasHeldRead()) { await Task.yield() }
        await settings.setEnabled(true)
        await system.finishRead(.notRegistered); await refresh.value
        XCTAssertEqual(settings.status, .enabled)
    }
}
