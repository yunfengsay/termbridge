import Foundation

enum SessionUIPreference: String, CaseIterable, Identifiable {
  case auto, chat, terminal
  static let defaultsKey = "session.defaultUI"
  var id: String { rawValue }
  var title: String {
    switch self {
    case .auto: return "自动"
    case .chat: return "对话"
    case .terminal: return "终端"
    }
  }
  static func load(from defaults: UserDefaults = .standard) -> Self {
    Self(rawValue: defaults.string(forKey: defaultsKey) ?? "") ?? .auto
  }
  func startsInChat(sessionID: String?, source: String) -> Bool {
    guard let sessionID else { return false }
    return self == .chat || (self == .auto && (source == "herdr" || sessionID.hasPrefix("herdr:")))
  }
}

/// One Host / session owns its draft and one pending send. Receipts never clear
/// the next draft, and losing proof never makes a send safe to retry.
struct AgentChatComposerState: Equatable {
  var draft = "" { didSet { restoredDraft = false } }
  private(set) var requestID: String?
  private(set) var generation = 0
  private(set) var submittedText: String?
  private(set) var state: AgentChatDeliveryState?
  private(set) var detail: String?
  /// The record the Host observed this request as, once it has said which.
  ///
  /// The transcript retires the local copy by this id, so an `observed` that
  /// arrives before the Agent's own record does not make the message vanish,
  /// and one that arrives after does not show it twice.
  private(set) var observedMessageID: String?
  private var restoredDraft = false
  var pending: Bool { state == .accepted || state == .delivered }
  var canRetry: Bool { state == .failed }

  mutating func begin(requestID: String, generation: Int) {
    self.requestID = requestID
    self.generation = generation
    submittedText = draft
    state = .accepted
    detail = nil
    observedMessageID = nil
    draft = ""
  }

  @discardableResult
  mutating func apply(_ receipt: AgentChatDelivery) -> Bool {
    guard receipt.requestID == requestID, receipt.generation == generation,
      state != .observed else { return false }
    if !pending && (receipt.state == .accepted || receipt.state == .delivered) { return false }
    state = receipt.state
    detail = receipt.error
    if let messageID = receipt.messageID { observedMessageID = messageID }
    if receipt.state == .observed {
      if restoredDraft && draft == submittedText { draft = "" }
      submittedText = nil
    } else if receipt.state == .failed || receipt.state == .uncertain { restoreDraft() }
    return true
  }

  mutating func loseConfirmation(_ reason: String) {
    guard pending else { return }
    state = .uncertain
    detail = reason
    restoreDraft()
  }

  private mutating func restoreDraft() {
    guard draft.isEmpty, let submittedText else { return }
    draft = submittedText
    restoredDraft = true
  }
}

struct AgentChatSubscription: Equatable {
  let conversationID: String
  private(set) var generation = 0
  private(set) var active = false
  mutating func begin() { generation += 1; active = true }
  mutating func end() { active = false; generation += 1 }
  func accepts(_ message: ControlMessage) -> Bool {
    active && message.string("conversationId") == conversationID && message.int("generation") == generation
  }
  func earlier(requestID: String, cursor: Int) -> [String: MessagePackValue]? {
    guard active, cursor >= 0 else { return nil }
    return ["t": .string(AgentChatProtocol.earlier), "requestId": .string(requestID),
      "conversationId": .string(conversationID), "generation": .int(Int64(generation)),
      "cursor": .int(Int64(cursor))]
  }
}
