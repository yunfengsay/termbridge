import XCTest

@testable import Termbridge

final class FrameCodecTests: XCTestCase {
  func testContextLearningV2ReceiptAndCapability() {
    let message = ControlMessage(fields: ["t": .string("voice_learning_result"), "requestId": .string("fixture"),
      "revision": .int(2), "status": .string("completed"), "voiceLearning": .int(2),
      "assist": .map(["schema": .int(2), "mode": .string("context-assist"), "examples": .int(3)])])
    XCTAssertTrue(message.supportsVoiceLearning)
    XCTAssertEqual(message.voiceLearningResult()?.assist?["examples"]?.intValue, 3)
  }
  func testVoiceLearningReceiptRejectsInvalidModelAndKeepsWaitSeparateFromCompletion() {
    let status = ControlMessage(fields: ["t": .string("brain_voice_status"), "turnWaitReason": .string("incomplete")])
    XCTAssertEqual(status.voiceTurnWaitReason, .incomplete)
    let fields: [String: MessagePackValue] = ["t": .string("voice_learning_result"),
      "requestId": .string("fixture"), "revision": .int(1), "status": .string("revoked")]
    XCTAssertEqual(ControlMessage(fields: fields).voiceLearningResult()?.status, "revoked")
    var invalid = fields
    invalid["model"] = .map(["schema": .int(1), "mode": .string("active")])
    XCTAssertNil(ControlMessage(fields: invalid).voiceLearningResult())
  }
  func testDecodesMsgpackrAuthChallenge() throws {
    guard case .control(let message) = try FrameCodec.decode(Data(hex: Self.authChallengeFixture))
    else {
      return XCTFail("Expected control frame")
    }
    XCTAssertEqual(message.type, "auth_challenge")
    XCTAssertEqual(message.string("nonce"), "abc123")
    XCTAssertEqual(message.bool("required"), true)
  }

  func testDecodesMsgpackrSessionListWithFloatingPointTimestamp() throws {
    guard case .control(let message) = try FrameCodec.decode(Data(hex: Self.sessionListFixture))
    else {
      return XCTFail("Expected control frame")
    }
    let session = try XCTUnwrap(message.sessions().first)
    XCTAssertEqual(session.sessionID, "sess-7")
    XCTAssertEqual(session.command, "shell")
    XCTAssertEqual(session.cols, 92)
    XCTAssertEqual(session.rows, 31)
    XCTAssertEqual(session.createdAtMilliseconds, 1_712_345_678_901)
    XCTAssertEqual(session.viewers, 2)
    XCTAssertTrue(session.isActive)
  }

  func testDecodesMsgpackrUndefinedAsNull() throws {
    guard case .control(let message) = try FrameCodec.decode(Data(hex: Self.undefinedFixture))
    else {
      return XCTFail("Expected control frame")
    }
    XCTAssertEqual(message.type, "host_list_result")
    XCTAssertEqual(message.hosts(), [])
    XCTAssertNil(message.string("selectedHostId"))
  }

  func testEncodesPTYAndResizeInNetworkByteOrder() {
    XCTAssertEqual(FrameCodec.resize(sid: 0x1234, cols: 80, rows: 24), Data(hex: "03123400500018"))
    XCTAssertEqual(
      FrameCodec.ptyInput(sid: 0x1234, data: Data("中".utf8)), Data(hex: "021234e4b8ad"))
  }

  func testControlRoundTripsNestedValues() throws {
    let encoded = try FrameCodec.control([
      "t": .string("session_create"),
      "agent": .string("shell"),
      "cols": .int(80),
      "rows": .int(24),
      "args": .array([.string("-l"), .string("-i")]),
    ])
    guard case .control(let message) = try FrameCodec.decode(encoded) else {
      return XCTFail("Expected control frame")
    }
    XCTAssertEqual(message.type, "session_create")
    XCTAssertEqual(message.string("agent"), "shell")
    XCTAssertEqual(message.int("cols"), 80)
    XCTAssertEqual(message.strings("args"), ["-l", "-i"])
  }

  func testDecodesConfirmedHostNetworkPolicy() throws {
    let encoded = try FrameCodec.control([
      "t": .string("network_policy_result"),
      "requestId": .string("route-1"),
      "policy": .string("direct"),
      "changed": .bool(true),
      "proxyDetected": .bool(true),
    ])
    guard case .control(let message) = try FrameCodec.decode(encoded) else {
      return XCTFail("Expected control frame")
    }
    XCTAssertEqual(
      message.hostNetworkPolicy(),
      HostNetworkPolicyInfo(policy: .direct, changed: true, proxyDetected: true))
  }

  func testDecodesHostRosterAndAgentCompletionMetadata() throws {
    let encoded = try FrameCodec.control([
      "t": .string("host_list_result"),
      "selectedHostId": .string("mac-a"),
      "hosts": .array([.map(["hostId": .string("mac-a"), "name": .string("Studio")])]),
    ])
    guard case .control(let message) = try FrameCodec.decode(encoded) else {
      return XCTFail("Expected control frame")
    }
    XCTAssertEqual(message.hosts(), [HostInfo(hostID: "mac-a", name: "Studio")])
    XCTAssertEqual(message.string("selectedHostId"), "mac-a")

    let session = SessionInfo(map: [
      "sessionId": .string("herdr:wA:p1"), "command": .string("codex"),
      "source": .string("herdr"), "status": .string("done"),
      "completedAt": .double(1_700_000_000_000), "preview": .string("Finished tests"),
    ])
    XCTAssertEqual(session?.completedAtMilliseconds, 1_700_000_000_000)
    XCTAssertEqual(session?.preview, "Finished tests")
  }

  func testDecodesProjectFileSnapshot() throws {
    let line: MessagePackValue = .map([
      "kind": .string("context"), "oldLine": .int(1), "newLine": .int(1),
      "text": .string("export const answer = 42;"),
    ])
    let hunk: MessagePackValue = .map([
      "header": .string(""), "oldStart": .int(1), "oldLines": .int(1),
      "newStart": .int(1), "newLines": .int(1), "lines": .array([line]),
    ])
    let file: MessagePackValue = .map([
      "path": .string("src/main.ts"), "status": .string("unchanged"),
      "additions": .int(0), "deletions": .int(0), "binary": .bool(false),
      "truncated": .bool(false), "hunks": .array([hunk]),
    ])
    let message = ControlMessage(fields: [
      "t": .string("review_snapshot_result"),
      "snapshot": .map([
        "repository": .string("termbridge"), "repositoryPath": .string("/code/termbridge"),
        "branch": .string("main"), "detached": .bool(false), "mode": .string("files"),
        "dirty": .bool(false), "canSwitchBranch": .bool(true),
        "branches": .array([.string("main")]), "files": .array([file]),
        "changedFileCount": .int(1), "additions": .int(0), "deletions": .int(0),
        "truncated": .bool(false),
      ]),
    ])

    let snapshot = try XCTUnwrap(message.reviewSnapshot())
    XCTAssertEqual(snapshot.mode, "files")
    XCTAssertEqual(snapshot.files.first?.status, "unchanged")
    XCTAssertEqual(snapshot.files.first?.hunks.first?.lines.first?.text, "export const answer = 42;")
  }

  private static let authChallengeFixture =
    "00de0003a174ae617574685f6368616c6c656e6765a56e6f6e6365a6616263313233a87265717569726564c3"
  private static let sessionListFixture =
    "00de0002a174b373657373696f6e5f6c6973745f726573756c74a873657373696f6e7391de0006a973657373696f6e4964a6736573732d37a7636f6d6d616e64a57368656c6ca4636f6c735ca4726f77731fa9637265617465644174cb4278eafc18435000a77669657765727302"
  private static let undefinedFixture =
    "00de0003a174b0686f73745f6c6973745f726573756c74a5686f73747390ae73656c6563746564486f73744964d40000"
}

extension Data {
  fileprivate init(hex: String) {
    self.init()
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      append(UInt8(hex[index..<next], radix: 16)!)
      index = next
    }
  }
}
