import XCTest

@testable import Termbridge

final class AgentCompletionTrackerTests: XCTestCase {
  func testOnlyNotifiesForObservedWorkingToDoneTransition() {
    var tracker = AgentCompletionTracker()
    XCTAssertTrue(tracker.update([session(status: "done")]).isEmpty)
    XCTAssertTrue(tracker.update([session(status: "working")]).isEmpty)
    XCTAssertEqual(tracker.update([session(status: "done")]).map(\.sessionID), ["herdr:wA:p1"])
    XCTAssertTrue(tracker.update([session(status: "done")]).isEmpty)
  }

  private func session(status: String) -> SessionInfo {
    SessionInfo(
      sessionID: "herdr:wA:p1", command: "codex", cols: 100, rows: 30,
      createdAtMilliseconds: 1, viewers: 0, source: "herdr", workspace: "termbridge",
      paneID: "wA:p1", agent: "codex", status: status,
      completedAtMilliseconds: status == "done" ? 2 : nil)
  }
}
