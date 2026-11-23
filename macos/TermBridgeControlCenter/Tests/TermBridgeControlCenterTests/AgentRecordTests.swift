import XCTest
@testable import TermBridgeControlCenter

final class AgentRecordTests: XCTestCase {
    func testPhoneHubStatusDistinguishesOfflineFromUnavailableBridge() {
        XCTAssertEqual(
            ControlCenterModel.describePhoneHub(exitCode: 0, output: "android"),
            "Phone / Watch Hub online"
        )
        XCTAssertEqual(
            ControlCenterModel.describePhoneHub(exitCode: 1, output: "no client attached"),
            "Phone / Watch Hub offline"
        )
        XCTAssertEqual(
            ControlCenterModel.describePhoneHub(exitCode: 1, output: "connect ECONNREFUSED"),
            "Host bridge unavailable"
        )
    }

    func testPrioritizationKeepsAttentionAheadOfNewerCompletions() throws {
        let data = Data("""
        {
          "generatedAt": 1700000000000,
          "records": [
            {"sessionId":"done","source":"herdr","name":"build","status":"done","lastSeenAt":30,"statusChangedAt":30,"present":true},
            {"sessionId":"blocked","source":"herdr","name":"watch","status":"blocked","lastSeenAt":20,"statusChangedAt":20,"present":true},
            {"sessionId":"working","source":"herdr","name":"voice","status":"working","lastSeenAt":25,"statusChangedAt":25,"present":true},
            {"sessionId":"gone","source":"herdr","name":"old","status":"failed","lastSeenAt":40,"statusChangedAt":40,"present":false}
          ]
        }
        """.utf8)
        let snapshot = try JSONDecoder().decode(AgentContextSnapshot.self, from: data)
        let records = AgentRecord.prioritized(snapshot.records)

        XCTAssertEqual(records.map(\.sessionId), ["blocked", "working", "done"])
        XCTAssertEqual(records.first?.displayName, "watch")
        XCTAssertEqual(records.first?.needsAttention, true)
    }
}
