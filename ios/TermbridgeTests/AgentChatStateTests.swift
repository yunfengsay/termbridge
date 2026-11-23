import XCTest
@testable import Termbridge

final class AgentChatStateTests: XCTestCase {
  private func receipt(_ state: String, request: String = "one", generation: Int = 1) -> AgentChatDelivery {
    AgentChatDelivery(map: ["requestId": .string(request), "conversationId": .string("herdr:synthetic"),
      "generation": .int(Int64(generation)), "state": .string(state)])!
  }
  func testMalformedReceiptCannotCreateAnAcceptedSend() {
    let base: [String: MessagePackValue] = ["requestId": .string("one"), "conversationId": .string("herdr:synthetic")]
    XCTAssertNil(AgentChatDelivery(map: base))
    var unknown = base
    unknown["generation"] = .int(1)
    unknown["state"] = .string("unknown")
    XCTAssertNil(AgentChatDelivery(map: unknown))
  }
  func testPreferencesAndSessionCreationNeverStartChatWithoutAnExistingSession() {
    let defaults = UserDefaults(suiteName: "test-agent-chat-\(UUID())")!
    XCTAssertEqual(SessionUIPreference.load(from: defaults), .auto)
    defaults.set("terminal", forKey: SessionUIPreference.defaultsKey)
    XCTAssertEqual(SessionUIPreference.load(from: defaults), .terminal)
    defaults.set("unrecognised", forKey: SessionUIPreference.defaultsKey)
    XCTAssertEqual(SessionUIPreference.load(from: defaults), .auto)
    XCTAssertFalse(SessionUIPreference.chat.startsInChat(sessionID: nil, source: "herdr"))
    XCTAssertTrue(SessionUIPreference.auto.startsInChat(sessionID: "herdr:synthetic", source: "pty"))
    XCTAssertFalse(SessionUIPreference.auto.startsInChat(sessionID: "shell", source: "pty"))
    XCTAssertFalse(SessionUIPreference.terminal.startsInChat(sessionID: "herdr:synthetic", source: "herdr"))
  }
  func testOldGenerationCannotMutateCurrentSubscriptionAndEarlierCarriesGeneration() throws {
    var subscription = AgentChatSubscription(conversationID: "herdr:synthetic")
    XCTAssertNil(subscription.earlier(requestID: "before", cursor: 3))
    subscription.begin()
    let first = subscription.generation
    subscription.end()
    subscription.begin()
    let old = ControlMessage(fields: ["conversationId": .string("herdr:synthetic"), "generation": .int(Int64(first))])
    XCTAssertFalse(subscription.accepts(old))
    let earlier = try XCTUnwrap(subscription.earlier(requestID: "page", cursor: 123))
    XCTAssertEqual(earlier["generation"]?.intValue, subscription.generation)
    XCTAssertEqual(earlier["cursor"]?.intValue, 123)
    let frame = try FrameCodec.control(earlier)
    guard case .control(let decoded) = try FrameCodec.decode(frame) else { return XCTFail("Control frame expected") }
    XCTAssertTrue(subscription.accepts(decoded))
    var foreign = earlier
    foreign["conversationId"] = .string("another-host-session")
    XCTAssertFalse(subscription.accepts(ControlMessage(fields: foreign)))
    subscription.end()
    XCTAssertFalse(subscription.accepts(decoded))
  }
  func testObservedDoesNotEraseTheNextDraftAndOldReceiptsCannotRestartPending() {
    var state = AgentChatComposerState()
    state.draft = "第一条中文"
    state.begin(requestID: "one", generation: 1)
    XCTAssertEqual(state.submittedText, "第一条中文")
    XCTAssertEqual(state.draft, "")
    state.draft = "下一条"
    XCTAssertFalse(state.apply(receipt("observed", generation: 0)))
    XCTAssertTrue(state.pending)
    XCTAssertTrue(state.apply(receipt("observed")))
    XCTAssertEqual(state.draft, "下一条")
    XCTAssertFalse(state.apply(receipt("accepted")))
    XCTAssertFalse(state.pending)
  }
  func testUnknownWriteRestoresDraftButIsNeverRetryableAndLateObservationClearsOnlyRestoredText() {
    var state = AgentChatComposerState()
    state.draft = "重复文本"
    state.begin(requestID: "one", generation: 1)
    state.loseConfirmation("connection lost")
    XCTAssertEqual(state.draft, "重复文本")
    XCTAssertEqual(state.state, .uncertain)
    XCTAssertFalse(state.canRetry)
    XCTAssertFalse(state.apply(receipt("delivered")))
    XCTAssertTrue(state.apply(receipt("observed")))
    XCTAssertEqual(state.draft, "")
    state.draft = "重复文本"
    state.begin(requestID: "two", generation: 1)
    XCTAssertFalse(state.apply(receipt("observed")))
    state.loseConfirmation("timeout")
    state.draft = "edited after timeout"
    XCTAssertTrue(state.apply(receipt("observed", request: "two")))
    XCTAssertEqual(state.draft, "edited after timeout")
  }
  func testOnlyDefinitePrewriteFailureIsRetryableAndSeparateSessionDraftsStayIndependent() {
    var first = AgentChatComposerState()
    var second = AgentChatComposerState()
    first.draft = "session A"
    second.draft = "session B"
    first.begin(requestID: "one", generation: 1)
    XCTAssertTrue(first.apply(receipt("failed")))
    XCTAssertTrue(first.canRetry)
    XCTAssertEqual(first.draft, "session A")
    XCTAssertFalse(second.pending)
    XCTAssertEqual(second.draft, "session B")
  }
}
