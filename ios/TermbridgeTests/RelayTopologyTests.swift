import XCTest
@testable import Termbridge

final class RelayTopologyTests: XCTestCase {
    func testTopologyRequiresAnExistingSelfAndCompleteRelayEdges() throws {
        var data: [String: Any] = ["relayId": "relay:r", "selfNodeId": "client:c", "selectedHostId": "h", "generatedAt": 1234,
            "nodes": [["id": "relay:r", "role": "relay", "name": "Mini", "connections": 1],
                      ["id": "client:c", "role": "client", "name": "Mac", "connections": 2],
                      ["id": "host:h", "role": "host", "name": "Office", "hostId": "h", "connections": 1]],
            "edges": [["from": "client:c", "to": "relay:r"], ["from": "host:h", "to": "relay:r"]], "truncated": false]
        let topology = try XCTUnwrap(RelayTopology.decode(json: data))
        XCTAssertEqual(topology.nodes.first { $0.id == topology.selfNodeId }?.connections, 2)
        XCTAssertEqual(topology.selectedHostId, "h")
        data["selfNodeId"] = "client:missing"; XCTAssertNil(RelayTopology.decode(json: data))
        data["selfNodeId"] = "client:c"
        data["edges"] = [["from": "client:c", "to": "host:h"], ["from": "host:h", "to": "relay:r"]]
        XCTAssertNil(RelayTopology.decode(json: data))
        data["edges"] = [["from": "client:c", "to": "relay:r"]]
        XCTAssertNil(RelayTopology.decode(json: data))
    }
    func testWireDecodeIgnoresUnrelatedMessages() {
        XCTAssertNil(RelayTopology.decode(message: ControlMessage(fields: ["t": .string("host_list_result")])))
    }
}
