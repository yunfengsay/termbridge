import XCTest
@testable import TermBridgeControlCenter

final class HerdrTerminalIdentityTests: XCTestCase {
    private let snapshot = Data(#"{"result":{"snapshot":{"panes":[{"pane_id":"wA:p1","terminal_id":"term_first","focused":true},{"pane_id":"wA:p2","terminal_id":"term_exact","focused":false}]}}}"#.utf8)

    func testResolvesExactPaneInsteadOfFocusedTerminal() throws {
        XCTAssertEqual(try HerdrTerminalIdentity.terminalId(paneId: "wA:p2", snapshot: snapshot), "term_exact")
    }

    func testLocalRowsAndAttachUseTheSameLivePaneIdentity() throws {
        let data = Data(#"{"result":{"snapshot":{"workspaces":[{"workspace_id":"wB","label":"Live project"}],"agents":[{"pane_id":"wB:p7","name":"live-worker","agent_status":"working"}],"panes":[{"pane_id":"wB:p7","workspace_id":"wB","terminal_id":"term_live","agent":"codex"}]}}}"#.utf8)
        let row = try XCTUnwrap(HerdrTerminalIdentity.agents(snapshot: data).first)
        XCTAssertEqual(row.sessionId, "herdr:wB:p7")
        XCTAssertEqual(row.displayName, "live-worker")
        XCTAssertEqual(row.workspace, "Live project")
        XCTAssertEqual(row.status, "working")
        let pane = try HerdrTerminalIdentity.paneId(sessionId: row.sessionId, recordedPaneId: row.paneId)
        XCTAssertEqual(try HerdrTerminalIdentity.launch(paneId: pane, snapshot: data, executable: "/fixture/herdr").arguments,
                       ["terminal", "attach", "term_live"])
        XCTAssertThrowsError(try HerdrTerminalIdentity.agents(snapshot: Data(#"{"result":{"snapshot":{}}}"#.utf8)))
    }

    func testMissingPaneDoesNotFallBackToAnotherTerminal() {
        XCTAssertThrowsError(try HerdrTerminalIdentity.terminalId(paneId: "wA:p3", snapshot: snapshot))
    }

    func testExistingAgentWithoutTerminalIDStillOpensExactPane() throws {
        let legacy = Data(#"{"result":{"snapshot":{"panes":[{"pane_id":"wA:p2","agent":"codex"}]}}}"#.utf8)
        let launch = try HerdrTerminalIdentity.launch(paneId: "wA:p2", snapshot: legacy, executable: "/test/herdr")
        XCTAssertEqual(launch.arguments, ["agent", "attach", "wA:p2"])
        XCTAssertFalse(launch.arguments.contains("--takeover"))
    }

    func testExistingNonAgentWithoutTerminalIDReportsCompatibilityInsteadOfMissingPane() {
        let legacy = Data(#"{"result":{"snapshot":{"panes":[{"pane_id":"wA:p2","agent":null}]}}}"#.utf8)
        XCTAssertThrowsError(try HerdrTerminalIdentity.launch(paneId: "wA:p2", snapshot: legacy, executable: "/test/herdr")) { error in
            XCTAssertEqual(error as? HerdrTerminalIdentity.ResolutionError, .nativeTerminalUnavailable)
        }
    }

    func testMalformedSnapshotDoesNotReportAClosedTerminal() {
        let response = Data(#"{"result":{"type":"something_else"}}"#.utf8)
        XCTAssertThrowsError(try HerdrTerminalIdentity.terminalId(paneId: "wA:p2", snapshot: response)) { error in
            XCTAssertEqual(error as? HerdrTerminalIdentity.ResolutionError, .invalidSnapshot)
        }
    }

    func testNeverFallsBackWhenRequestedPaneIsMissingOrAmbiguous() {
        for json in [
            #"{"result":{"snapshot":{"panes":[{"pane_id":"wA:p9","agent":"codex"}]}}}"#,
            #"{"result":{"snapshot":{"panes":[{"pane_id":"wA:p2","agent":"codex"},{"pane_id":"wA:p2","agent":"codex"}]}}}"#
        ] {
            XCTAssertThrowsError(try HerdrTerminalIdentity.launch(paneId: "wA:p2", snapshot: Data(json.utf8), executable: "/test/herdr"))
        }
    }

    func testMissingOptionalPaneFieldUsesTheStableSessionIdentifier() throws {
        XCTAssertEqual(try HerdrTerminalIdentity.paneId(sessionId: "herdr:wA:p2", recordedPaneId: nil), "wA:p2")
        XCTAssertThrowsError(try HerdrTerminalIdentity.paneId(sessionId: "herdr:wA:p2", recordedPaneId: "wA:p9"))
        XCTAssertThrowsError(try HerdrTerminalIdentity.paneId(sessionId: "sess-1", recordedPaneId: nil))
    }

    func testNativeAttachDoesNotTakeOverAnotherClient() throws {
        let launch = try TerminalLaunch(herdrExecutable: "/path/herdr", terminalId: "term_exact")
        XCTAssertEqual(launch.arguments, ["terminal", "attach", "term_exact"])
        XCTAssertEqual(launch.executable, "/path/herdr")
        XCTAssertThrowsError(try TerminalLaunch(herdrExecutable: "/path/herdr", terminalId: "--takeover"))
    }
}
