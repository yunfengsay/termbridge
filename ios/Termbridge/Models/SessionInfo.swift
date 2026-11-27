import Foundation

/// Relay-authored, bounded online topology. Device labels are display hints, not credentials.
struct RelayTopology: Codable, Equatable {
  struct Node: Codable, Equatable, Identifiable {
    enum Role: String, Codable { case relay, host, client }
    let id: String
    let role: Role
    let name: String
    let hostId: String?
    let connections: Int
  }
  struct Edge: Codable, Equatable { let from: String; let to: String }
  let relayId: String
  let selfNodeId: String
  let selectedHostId: String?
  let generatedAt: Int64
  let nodes: [Node]
  let edges: [Edge]
  let truncated: Bool
  var isValid: Bool {
    let ids = Set(nodes.map(\.id))
    return (1...128).contains(nodes.count) && ids.count == nodes.count && ids.contains(selfNodeId)
      && nodes.filter({ $0.role == .relay }).map(\.id) == [relayId]
      && generatedAt >= 0 && (selectedHostId?.count ?? 0) <= 128
      && nodes.allSatisfy { !$0.id.isEmpty && $0.id.count <= 256 && $0.name.count <= 96
        && ($0.hostId?.count ?? 0) <= 128 && (1...1_000_000).contains($0.connections) }
      && edges.count == nodes.count - 1 && Set(edges.map(\.from)).count == edges.count
      && edges.allSatisfy { $0.to == relayId && $0.from != relayId && ids.contains($0.from) }
  }
  static func decode(json: Any) -> RelayTopology? {
    guard JSONSerialization.isValidJSONObject(json),
      let data = try? JSONSerialization.data(withJSONObject: json), data.count <= 262_144,
      let value = try? JSONDecoder().decode(Self.self, from: data), value.isValid else { return nil }
    return value
  }
  static func decode(message: ControlMessage) -> RelayTopology? {
    guard message.type == "relay_topology" else { return nil }
    func json(_ value: MessagePackValue) -> Any {
      switch value {
      case .string(let s): return s
      case .bool(let b): return b
      case .int(let n): return n
      case .uint(let n): return n
      case .double(let n): return n
      case .array(let values): return values.map(json)
      case .map(let values): return values.mapValues(json)
      default: return NSNull()
      }
    }
    return decode(json: message.fields.mapValues(json))
  }
}

/// Native code forwards authenticated encrypted envelopes; the bundled viewer owns the keys.
enum RemoteDesktopProtocol {
  static let subscribe = "desktop_subscribe"
  static let attention = "desktop_attention"
  static let open = "desktop_open"
  static let ready = "desktop_ready"
  static let data = "desktop_data"
  static let closed = "desktop_closed"
  static let maxPacketBase64 = 87408
}

/// Multiplexed TCP proxy tunnel over Control frames for the built-in remote browser.
enum ProxyTunnelProtocol {
  static let type = "proxy_tunnel"
  static let kindOpen = "open"
  static let kindOpened = "opened"
  static let kindData = "data"
  static let kindAck = "ack"
  static let kindClose = "close"
  static let maxChunkBytes = 48 * 1024
  static let ackBatchBytes = 64 * 1024
}

/// Authenticated user confirmation; model tools cannot approve terminal handoffs.
struct BrainCompletionAction: Encodable {
    let t = "brain_completion_action"
    let requestId: String
    let id: String // completion- followed by 32 lowercase hex characters
    let action: Action
    enum Action: String, Encodable { case approve, dismiss }
}

struct BrainCompletionResult: Decodable {
    let requestId: String
    let ok: Bool
    let error: String?
}

// peer_register also carries CLI/Mac App peers (peer.desktop/peer.exec/peer.fs), not iOS
// capabilities. Generic tool envelopes are unchanged; no shell is exposed here.

// Optional brain_send fields. Omitted workflow preserves the legacy text route.
enum BrainWorkflow: String, Codable { case standard, silent }
enum BrainModelTier: String, Codable { case advanced, deep }
enum DictationProtocol {
  static let silentCallCapability = "silentCall"
  static let callWorkflow = "workflow"
  static let callModelTier = "modelTier"
  static let start = "brain_transcribe_start"
  static let cancel = "brain_transcribe_cancel"
  static let result = "brain_transcribe_result"
  static let finished = "finished"
  static let hints = "hints"
}

enum BrainSilentProtocol {
  static let cancel = "brain_cancel"
  static let cancelResult = "brain_cancel_result"
  static let textResult = "brain_text_result"
  static let textDelta = "brain_text_delta"
}

/// Optional protocol extension; iOS keeps legacy behavior unless explicitly requested.
enum ClientStreamPolicy {
  static let request = "client_stream_policy"
  static let result = "client_stream_policy_result"
  static func message(background: Bool, notifications: Bool) -> [String: Any] {
    ["t": request, "background": background, "notifications": notifications]
  }
}

enum WatchCompanionMessageType: UInt8 {
  case activitySnapshot = 0x30
  case navigationCue = 0x31
  case dailySnapshot = 0x32
  case workSnapshot = 0x33
  case activityCommand = 0x34
  case phoneAction = 0x35
}

struct WatchCompanionRoute: Equatable, Sendable {
  static let activityVersion = 2
  static let actionVersion = 1
  static let elevationOffsetDecimeters = 100_000

  let hostID: String
  let sessionID: String
}

struct WatchActivitySnapshotPayload: Equatable, Sendable {
  let active: Bool
  let paused: Bool
  let elapsedSeconds: UInt32
  let speedCentiKPH: UInt32
  let distanceMeters: UInt32
  let elevationDecimeters: Int32
  let gpsAccuracyDecimeters: UInt32
  let heartRate: UInt16
  let cadence: UInt16
  let label: String
}

struct WatchWorkSnapshotPayload: Equatable, Sendable {
  let route: WatchCompanionRoute
  let title: String
  let summary: String
  let status: String
  let priority: UInt8
  let updatedAtMilliseconds: UInt64
}

struct WatchActionPayload: Equatable, Sendable {
  let action: String
  let route: WatchCompanionRoute?
}

struct WatchNavigationCuePayload: Equatable, Sendable {
  enum Kind: String, Sendable { case navigation, timer }
  let distanceMeters: UInt32
  let instruction: String
  let kind: Kind
}

struct SessionInfo: Identifiable, Hashable {
  let sessionID: String
  let command: String
  let cols: Int
  let rows: Int
  let createdAtMilliseconds: Double
  let viewers: Int
  let source: String
  let name: String?
  let workspace: String?
  let paneID: String?
  let agent: String?
  let status: String?
  let completedAtMilliseconds: Double?
  let preview: String?

  var id: String { sessionID }
  var isActive: Bool { viewers > 0 }
  var isHerdr: Bool { source == "herdr" }
  var isWorking: Bool { status?.lowercased() == "working" }
  var isDone: Bool { status?.lowercased() == "done" }
  var createdAt: Date { Date(timeIntervalSince1970: createdAtMilliseconds / 1_000) }
  var completedAt: Date? { completedAtMilliseconds.map { Date(timeIntervalSince1970: $0 / 1_000) } }
  var displayName: String { name?.nonEmpty ?? workspace?.nonEmpty ?? agent?.nonEmpty ?? command }

  init?(map: [String: MessagePackValue]) {
    guard let sessionID = map["sessionId"]?.stringValue else { return nil }
    self.sessionID = sessionID
    command = map["command"]?.stringValue?.nonEmpty ?? sessionID
    cols = map["cols"]?.intValue ?? 80
    rows = map["rows"]?.intValue ?? 24
    createdAtMilliseconds = map["createdAt"]?.doubleValue ?? 0
    viewers = map["viewers"]?.intValue ?? 0
    source = map["source"]?.stringValue ?? "pty"
    name = map["name"]?.stringValue
    workspace = map["workspace"]?.stringValue
    paneID = map["paneId"]?.stringValue
    agent = map["agent"]?.stringValue
    status = map["status"]?.stringValue
    completedAtMilliseconds = map["completedAt"]?.doubleValue
    preview = map["preview"]?.stringValue
  }

  init(
    sessionID: String, command: String, cols: Int, rows: Int,
    createdAtMilliseconds: Double, viewers: Int, source: String = "pty",
    name: String? = nil, workspace: String? = nil, paneID: String? = nil, agent: String? = nil,
    status: String? = nil, completedAtMilliseconds: Double? = nil,
    preview: String? = nil
  ) {
    self.sessionID = sessionID
    self.command = command
    self.cols = cols
    self.rows = rows
    self.createdAtMilliseconds = createdAtMilliseconds
    self.viewers = viewers
    self.source = source
    self.name = name
    self.workspace = workspace
    self.paneID = paneID
    self.agent = agent
    self.status = status
    self.completedAtMilliseconds = completedAtMilliseconds
    self.preview = preview
  }
}

// MARK: - Graphical Agent conversation (agent_chat_*)
//
// A second VIEW of one already-running Agent, never a second Agent. What follows
// decodes what the Host read out of that session's own structured records; iOS
// never parses a terminal screen and never infers a tool outcome from one.
// The native conversation screen consumes this contract through its own subscription.

enum AgentChatProtocol {
  static let list = "agent_chat_list"
  static let listResult = "agent_chat_list_result"
  static let subscribe = "agent_chat_subscribe"
  static let unsubscribe = "agent_chat_unsubscribe"
  static let snapshot = "agent_chat_snapshot"
  static let append = "agent_chat_append"
  static let earlier = "agent_chat_earlier"
  static let earlierResult = "agent_chat_earlier_result"
  static let send = "agent_chat_send"
  static let delivery = "agent_chat_delivery"
  /// A control key for the conversation's own pane.
  ///
  /// The client names a key from the protocol's closed set and the Host decides
  /// the bytes, so nothing a client sends can become an arbitrary escape
  /// sequence or a chat message. Authorized by the live subscription and its
  /// generation; the result echoes both back. Not yet surfaced in the iOS shell.
  static let key = "agent_chat_key"
  static let keyResult = "agent_chat_key_result"
  /// Carried on subscribe, earlier and every answer to them. The client owns this
  /// counter; the Host echoes it unchanged, so an event produced for a conversation
  /// view the user has left is discarded instead of applied.
  static let generation = "generation"
}

/// One page of older history. `generation` must match the live subscription.
struct AgentChatEarlierPage: Equatable, Sendable {
  let requestID: String
  let conversationID: String
  let generation: Int
  let messages: [AgentChatMessage]
  let cursor: Int?
  let atHead: Bool
  let error: String?

  init?(map: [String: MessagePackValue]) {
    guard let requestID = map["requestId"]?.stringValue,
          let conversationID = map["conversationId"]?.stringValue,
          let generation = map["generation"]?.intValue else { return nil }
    self.requestID = requestID
    self.conversationID = conversationID
    self.generation = generation
    messages = (map["messages"]?.arrayValue ?? []).compactMap {
      $0.mapValue.flatMap(AgentChatMessage.init(map:))
    }
    cursor = map["cursor"]?.intValue
    atHead = map["atHead"]?.boolValue ?? false
    error = map["error"]?.stringValue
  }
}

/// What the bound adapter can really do. A false flag disables its control.
struct AgentChatCapabilities: Equatable, Sendable {
  let history: Bool
  let send: Bool
  let stop: Bool
  let attachments: Bool
  let approvals: Bool
  let questions: Bool
  let terminal: Bool
  let degraded: String?

  init(map: [String: MessagePackValue]?) {
    history = map?["history"]?.boolValue ?? false
    send = map?["send"]?.boolValue ?? false
    stop = map?["stop"]?.boolValue ?? false
    attachments = map?["attachments"]?.boolValue ?? false
    approvals = map?["approvals"]?.boolValue ?? false
    questions = map?["questions"]?.boolValue ?? false
    terminal = map?["terminal"]?.boolValue ?? true
    degraded = map?["degraded"]?.stringValue
  }
}

/// One block of a message. An unknown block type is dropped, never guessed at.
enum AgentChatBlock: Equatable, Sendable {
  case text(String)
  case toolCall(name: String, input: String, callID: String?, truncated: Bool)
  case toolResult(output: String, isError: Bool, callID: String?, truncated: Bool)
  case imageRef(url: String?, name: String?, alt: String?)

  init?(map: [String: MessagePackValue]) {
    switch map["type"]?.stringValue {
    case "text":
      guard let text = map["text"]?.stringValue else { return nil }
      self = .text(text)
    case "tool-call":
      guard let name = map["name"]?.stringValue else { return nil }
      self = .toolCall(
        name: name,
        input: map["input"]?.stringValue ?? "",
        callID: map["callId"]?.stringValue,
        truncated: map["truncated"]?.boolValue ?? false)
    case "tool-result":
      self = .toolResult(
        output: map["output"]?.stringValue ?? "",
        isError: map["isError"]?.boolValue ?? false,
        callID: map["callId"]?.stringValue,
        truncated: map["truncated"]?.boolValue ?? false)
    case "image-ref":
      self = .imageRef(
        url: map["url"]?.stringValue,
        name: map["name"]?.stringValue,
        alt: map["alt"]?.stringValue)
    default:
      return nil
    }
  }
}

struct AgentChatMessage: Identifiable, Equatable, Sendable {
  let id: String
  let role: String
  let blocks: [AgentChatBlock]
  let timestampMilliseconds: Double?
  let source: String
  let seq: Int
  let turnID: String?

  var timestamp: Date? { timestampMilliseconds.map { Date(timeIntervalSince1970: $0 / 1_000) } }

  init?(map: [String: MessagePackValue]) {
    guard let id = map["id"]?.stringValue else { return nil }
    self.id = id
    role = map["role"]?.stringValue ?? "assistant"
    blocks = (map["blocks"]?.arrayValue ?? []).compactMap {
      $0.mapValue.flatMap(AgentChatBlock.init(map:))
    }
    timestampMilliseconds = map["timestamp"]?.doubleValue
    source = map["source"]?.stringValue ?? "transcript"
    seq = map["seq"]?.intValue ?? 0
    turnID = map["turnId"]?.stringValue
  }
}

/// One row of agent_chat_list_result. `chat` false means offer the terminal.
struct AgentChatConversation: Identifiable, Equatable, Sendable {
  let conversationID: String
  let paneID: String
  let provider: String?
  let title: String?
  let workspace: String?
  let status: String
  let chat: Bool
  let reason: String?

  var id: String { conversationID }

  init?(map: [String: MessagePackValue]) {
    guard let conversationID = map["conversationId"]?.stringValue else { return nil }
    self.conversationID = conversationID
    paneID = map["paneId"]?.stringValue ?? ""
    provider = map["provider"]?.stringValue
    title = map["title"]?.stringValue
    workspace = map["workspace"]?.stringValue
    status = map["status"]?.stringValue ?? "unknown"
    chat = map["chat"]?.boolValue ?? false
    reason = map["reason"]?.stringValue
  }
}

/// Send receipts. `delivered` means the Agent's input channel took the bytes;
/// only `observed` means the Agent's own record contains the prompt.
/// `uncertain` is an unknown write outcome — the client must not resend it.
enum AgentChatDeliveryState: String, Sendable {
  case accepted, delivered, observed, uncertain, failed

  /// Only an outright rejection is safe to send again.
  var mayResend: Bool { self == .failed }
}

struct AgentChatDelivery: Equatable, Sendable {
  let requestID: String
  let conversationID: String
  let generation: Int
  let state: AgentChatDeliveryState
  let atMilliseconds: Double
  let messageID: String?
  let error: String?

  init?(map: [String: MessagePackValue]) {
    guard let requestID = map["requestId"]?.stringValue,
          let conversationID = map["conversationId"]?.stringValue,
          let generation = map["generation"]?.intValue, generation >= 0,
          let rawState = map["state"]?.stringValue,
          let state = AgentChatDeliveryState(rawValue: rawState) else { return nil }
    self.requestID = requestID
    self.conversationID = conversationID
    self.generation = generation
    self.state = state
    atMilliseconds = map["at"]?.doubleValue ?? 0
    messageID = map["messageId"]?.stringValue
    error = map["error"]?.stringValue
  }
}

struct HostInfo: Identifiable, Hashable {
  let hostID: String
  let name: String
  var id: String { hostID }

  init?(map: [String: MessagePackValue]) {
    guard let hostID = map["hostId"]?.stringValue else { return nil }
    self.hostID = hostID
    name = map["name"]?.stringValue?.nonEmpty ?? hostID
  }

  init(hostID: String, name: String) { self.hostID = hostID; self.name = name }
}

struct ReviewLineInfo: Hashable {
  let kind: String
  let oldLine: Int?
  let newLine: Int?
  let text: String

  init?(map: [String: MessagePackValue]) {
    guard let kind = map["kind"]?.stringValue,
      ["context", "add", "delete"].contains(kind),
      let text = map["text"]?.stringValue else { return nil }
    self.kind = kind
    oldLine = map["oldLine"]?.intValue
    newLine = map["newLine"]?.intValue
    self.text = String(text.prefix(1_000))
  }
}

struct ReviewHunkInfo: Hashable {
  let header: String
  let oldStart: Int
  let oldLines: Int
  let newStart: Int
  let newLines: Int
  let lines: [ReviewLineInfo]

  init?(map: [String: MessagePackValue]) {
    guard let header = map["header"]?.stringValue else { return nil }
    self.header = String(header.prefix(500))
    oldStart = max(0, map["oldStart"]?.intValue ?? 0)
    oldLines = max(0, map["oldLines"]?.intValue ?? 0)
    newStart = max(0, map["newStart"]?.intValue ?? 0)
    newLines = max(0, map["newLines"]?.intValue ?? 0)
    lines = map["lines"]?.arrayValue?.prefix(20_000).compactMap { value in
      value.mapValue.flatMap(ReviewLineInfo.init(map:))
    } ?? []
  }
}

struct ReviewFileInfo: Hashable {
  let path: String
  let oldPath: String?
  let status: String
  let additions: Int
  let deletions: Int
  let binary: Bool
  let truncated: Bool
  /// An environment file, key or credential: listed, its contents withheld by the Host.
  let isPrivate: Bool
  let hunks: [ReviewHunkInfo]

  init?(map: [String: MessagePackValue]) {
    guard let path = map["path"]?.stringValue?.bounded(1_024),
      let status = map["status"]?.stringValue,
      ["added", "deleted", "modified", "renamed", "untracked", "unchanged"].contains(status)
    else { return nil }
    self.path = path
    oldPath = map["oldPath"]?.stringValue?.bounded(1_024)
    self.status = status
    additions = max(0, map["additions"]?.intValue ?? 0)
    deletions = max(0, map["deletions"]?.intValue ?? 0)
    binary = map["binary"]?.boolValue ?? false
    truncated = map["truncated"]?.boolValue ?? false
    isPrivate = map["private"]?.boolValue ?? false
    hunks = map["hunks"]?.arrayValue?.prefix(800).compactMap { value in
      value.mapValue.flatMap(ReviewHunkInfo.init(map:))
    } ?? []
  }
}

struct ReviewSnapshotInfo: Hashable {
  let repository: String
  let repositoryPath: String
  let branch: String
  let detached: Bool
  let mode: String
  let baseBranch: String?
  let dirty: Bool
  let canSwitchBranch: Bool
  let branches: [String]
  let files: [ReviewFileInfo]
  let changedFileCount: Int
  let additions: Int
  let deletions: Int
  let truncated: Bool

  init?(map: [String: MessagePackValue]) {
    guard let repository = map["repository"]?.stringValue?.bounded(256),
      let repositoryPath = map["repositoryPath"]?.stringValue?.bounded(2_048),
      let branch = map["branch"]?.stringValue?.bounded(256),
      let mode = map["mode"]?.stringValue,
      ["working", "branch", "files"].contains(mode)
    else { return nil }
    self.repository = repository
    self.repositoryPath = repositoryPath
    self.branch = branch
    detached = map["detached"]?.boolValue ?? false
    self.mode = mode
    baseBranch = map["baseBranch"]?.stringValue?.bounded(256)
    dirty = map["dirty"]?.boolValue ?? false
    canSwitchBranch = map["canSwitchBranch"]?.boolValue ?? false
    branches = map["branches"]?.arrayValue?.prefix(100).compactMap { $0.stringValue?.bounded(256) } ?? []
    let fileLimit = mode == "files" ? 20_000 : 80
    files = map["files"]?.arrayValue?.prefix(fileLimit).compactMap { value in
      value.mapValue.flatMap(ReviewFileInfo.init(map:))
    } ?? []
    changedFileCount = max(0, map["changedFileCount"]?.intValue ?? files.count)
    additions = max(0, map["additions"]?.intValue ?? 0)
    deletions = max(0, map["deletions"]?.intValue ?? 0)
    truncated = map["truncated"]?.boolValue ?? false
  }
}

enum ReviewProtocol {
  static let repositories = "review_repositories"
  static let repositoriesResult = "review_repositories_result"
  /// `revision` for `session_file_read`: the committed file instead of the working copy.
  static let headRevision = "HEAD"
}

/// One repository a conversation is associated with, from `review_repositories_result`:
/// the session's own (`current`), or one holding a file its Agent changed according to
/// the Agent's own record (`touched`, repository-relative). `files` are the repository's
/// current uncommitted changes, listed without hunks.
struct ReviewRepositoryInfo: Hashable, Identifiable {
  let repository: String
  let repositoryPath: String
  let branch: String
  let detached: Bool
  let current: Bool
  let files: [ReviewFileInfo]
  let changedFileCount: Int
  let additions: Int
  let deletions: Int
  let truncated: Bool
  let touched: [String]
  let touchedTruncated: Bool
  let error: String?
  var id: String { repositoryPath }

  init?(map: [String: MessagePackValue]) {
    guard let repository = map["repository"]?.stringValue?.bounded(256),
      let repositoryPath = map["repositoryPath"]?.stringValue?.bounded(2_048),
      let branch = map["branch"]?.stringValue?.bounded(256)
    else { return nil }
    self.repository = repository
    self.repositoryPath = repositoryPath
    self.branch = branch
    detached = map["detached"]?.boolValue ?? false
    current = map["current"]?.boolValue ?? false
    files = map["files"]?.arrayValue?.prefix(200).compactMap { value in
      value.mapValue.flatMap(ReviewFileInfo.init(map:))
    } ?? []
    changedFileCount = max(0, map["changedFileCount"]?.intValue ?? files.count)
    additions = max(0, map["additions"]?.intValue ?? 0)
    deletions = max(0, map["deletions"]?.intValue ?? 0)
    truncated = map["truncated"]?.boolValue ?? false
    touched = map["touched"]?.arrayValue?.prefix(500).compactMap { value in
      value.stringValue.flatMap { $0.isEmpty || $0.utf8.count > 1_024 ? nil : $0 }
    } ?? []
    touchedTruncated = map["touchedTruncated"]?.boolValue ?? false
    error = map["error"]?.stringValue?.bounded(1_000)
  }

  /// Every valid repository in a `review_repositories_result`, current first as sent.
  static func list(_ fields: [String: MessagePackValue]) -> [ReviewRepositoryInfo] {
    fields["repositories"]?.arrayValue?.prefix(12).compactMap { value in
      value.mapValue.flatMap(ReviewRepositoryInfo.init(map:))
    } ?? []
  }
}

// Memberwise construction for tests and previews. Declaring `init?(map:)` above
// suppresses the implicit memberwise initializer; the wire decoder stays the only
// path that validates Host input.
extension ReviewRepositoryInfo {
  init(
    repository: String, repositoryPath: String, branch: String, detached: Bool = false, current: Bool,
    files: [ReviewFileInfo], changedFileCount: Int, additions: Int, deletions: Int, truncated: Bool = false,
    touched: [String] = [], touchedTruncated: Bool = false, error: String? = nil
  ) {
    self.repository = repository
    self.repositoryPath = repositoryPath
    self.branch = branch
    self.detached = detached
    self.current = current
    self.files = files
    self.changedFileCount = changedFileCount
    self.additions = additions
    self.deletions = deletions
    self.truncated = truncated
    self.touched = touched
    self.touchedTruncated = touchedTruncated
    self.error = error
  }
}

extension ReviewLineInfo {
  init(kind: String, oldLine: Int? = nil, newLine: Int? = nil, text: String) {
    self.kind = kind
    self.oldLine = oldLine
    self.newLine = newLine
    self.text = text
  }
}

extension ReviewHunkInfo {
  init(
    header: String, oldStart: Int = 0, oldLines: Int = 0, newStart: Int = 0, newLines: Int = 0,
    lines: [ReviewLineInfo] = []
  ) {
    self.header = header
    self.oldStart = oldStart
    self.oldLines = oldLines
    self.newStart = newStart
    self.newLines = newLines
    self.lines = lines
  }
}

extension ReviewFileInfo {
  init(
    path: String, oldPath: String? = nil, status: String = "modified", additions: Int = 0,
    deletions: Int = 0, binary: Bool = false, truncated: Bool = false, isPrivate: Bool = false,
    hunks: [ReviewHunkInfo] = []
  ) {
    self.path = path
    self.oldPath = oldPath
    self.status = status
    self.additions = additions
    self.deletions = deletions
    self.binary = binary
    self.truncated = truncated
    self.isPrivate = isPrivate
    self.hunks = hunks
  }
}

extension ReviewSnapshotInfo {
  init(
    repository: String, repositoryPath: String, branch: String, detached: Bool = false,
    mode: String = "working", baseBranch: String? = nil, dirty: Bool = false,
    canSwitchBranch: Bool = false, branches: [String] = [], files: [ReviewFileInfo] = [],
    changedFileCount: Int = 0, additions: Int = 0, deletions: Int = 0, truncated: Bool = false
  ) {
    self.repository = repository
    self.repositoryPath = repositoryPath
    self.branch = branch
    self.detached = detached
    self.mode = mode
    self.baseBranch = baseBranch
    self.dirty = dirty
    self.canSwitchBranch = canSwitchBranch
    self.branches = branches
    self.files = files
    self.changedFileCount = changedFileCount
    self.additions = additions
    self.deletions = deletions
    self.truncated = truncated
  }
}

struct BrainMessageInfo: Identifiable, Hashable {
  // `systemReminders` is separate model-context history, not a chat row.
  // Android publishes brain_voice_presentation {requestId, presentation: foreground|overlay}.
  // phone_action screen.capture requires an Android Peer; iOS does not capture implicitly.
  let id: String
  let role: String
  let text: String
  let createdAtMilliseconds: Double
  let taskID: String?
  let voiceStatus: String?

  init(
    id: String,
    role: String,
    text: String,
    createdAtMilliseconds: Double,
    taskID: String? = nil,
    voiceStatus: String? = nil
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.createdAtMilliseconds = createdAtMilliseconds
    self.taskID = taskID
    self.voiceStatus = voiceStatus
  }

  init?(map: [String: MessagePackValue]) {
    guard let id = map["id"]?.stringValue, let role = map["role"]?.stringValue,
      let text = map["text"]?.stringValue else { return nil }
    self.id = id
    self.role = role
    self.text = text
    createdAtMilliseconds = map["createdAt"]?.doubleValue ?? 0
    taskID = map["taskId"]?.stringValue
    voiceStatus = map["voiceStatus"]?.stringValue
  }
}

struct BrainTaskInfo: Identifiable, Hashable {
  let taskID: String
  let requestID: String
  let text: String
  let agent: String
  let status: String
  let createdAtMilliseconds: Double
  let updatedAtMilliseconds: Double
  let sessionID: String?
  let error: String?

  var id: String { taskID }
  var updatedAt: Date { Date(timeIntervalSince1970: updatedAtMilliseconds / 1_000) }

  init?(map: [String: MessagePackValue]) {
    guard let taskID = map["taskId"]?.stringValue,
      let requestID = map["requestId"]?.stringValue,
      let text = map["text"]?.stringValue,
      let agent = map["agent"]?.stringValue,
      let status = map["status"]?.stringValue else { return nil }
    self.taskID = taskID
    self.requestID = requestID
    self.text = text
    self.agent = agent
    self.status = status
    createdAtMilliseconds = map["createdAt"]?.doubleValue ?? 0
    updatedAtMilliseconds = map["updatedAt"]?.doubleValue ?? 0
    sessionID = map["sessionId"]?.stringValue
    error = map["error"]?.stringValue
  }
}

struct AgentDescriptorInfo: Identifiable, Hashable {
  let agentID: String
  let name: String
  let runtime: String
  let purpose: String
  let capabilities: [String]
  let defaultWorkspace: String?

  var id: String { agentID }

  init?(map: [String: MessagePackValue]) {
    guard let agentID = map["agentId"]?.stringValue?.bounded(128),
      let name = map["name"]?.stringValue?.bounded(160),
      let runtime = map["runtime"]?.stringValue,
      ["codex", "claude", "shell", "custom"].contains(runtime),
      let purpose = map["purpose"]?.stringValue?.bounded(500)
    else { return nil }
    self.agentID = agentID
    self.name = name
    self.runtime = runtime
    self.purpose = purpose
    capabilities = Array((map["capabilities"]?.arrayValue?.compactMap(\.stringValue) ?? []).prefix(8))
    defaultWorkspace = map["defaultWorkspace"]?.stringValue?.bounded(1_024)
  }
}

struct BrainRouteDecisionInfo: Identifiable, Hashable {
  let id: String
  let requestID: String
  let action: String
  let outcome: String
  let createdAtMilliseconds: Double
  let targetAgentID: String?
  let targetSessionID: String?
  let reason: String?
  let confidence: Double?

  init?(map: [String: MessagePackValue]) {
    guard let id = map["id"]?.stringValue?.bounded(128),
      let requestID = map["requestId"]?.stringValue?.bounded(128),
      let action = map["action"]?.stringValue,
      ["answer", "continue_agent", "dispatch_agent"].contains(action),
      let outcome = map["outcome"]?.stringValue,
      ["accepted", "rejected"].contains(outcome)
    else { return nil }
    self.id = id
    self.requestID = requestID
    self.action = action
    self.outcome = outcome
    createdAtMilliseconds = max(0, map["createdAt"]?.doubleValue ?? 0)
    targetAgentID = map["targetAgentId"]?.stringValue?.bounded(128)
    targetSessionID = map["targetSessionId"]?.stringValue?.bounded(256)
    reason = map["reason"]?.stringValue?.bounded(500)
    let rawConfidence = map["confidence"]?.doubleValue
    confidence = rawConfidence.flatMap { (0...1).contains($0) ? $0 : nil }
  }
}

struct BrainRunEventInfo: Identifiable, Hashable {
  let eventID: String
  let runID: String
  let requestID: String
  let type: String
  let createdAtMilliseconds: Double
  let agentID: String
  let sessionID: String?
  let summary: String?

  var id: String { eventID }

  init?(map: [String: MessagePackValue]) {
    guard let eventID = map["eventId"]?.stringValue?.bounded(160),
      let runID = map["runId"]?.stringValue?.bounded(128),
      let requestID = map["requestId"]?.stringValue?.bounded(128),
      let type = map["type"]?.stringValue,
      ["queued", "dispatched", "completed", "failed"].contains(type),
      let agentID = map["agentId"]?.stringValue?.bounded(128)
    else { return nil }
    self.eventID = eventID
    self.runID = runID
    self.requestID = requestID
    self.type = type
    createdAtMilliseconds = max(0, map["createdAt"]?.doubleValue ?? 0)
    self.agentID = agentID
    sessionID = map["sessionId"]?.stringValue?.bounded(256)
    summary = map["summary"]?.stringValue?.bounded(1_000)
  }
}

struct BrainToolDescriptorInfo: Identifiable, Hashable {
  let name: String
  let label: String
  let description: String
  let category: String
  let execution: String
  let approval: String

  var id: String { name }

  init?(map: [String: MessagePackValue]) {
    guard let name = map["name"]?.stringValue?.bounded(128),
      let label = map["label"]?.stringValue?.bounded(160),
      let description = map["description"]?.stringValue?.bounded(1_000),
      let category = map["category"]?.stringValue,
      ["context", "web", "files", "device", "agent"].contains(category),
      let execution = map["execution"]?.stringValue,
      ["direct", "worker"].contains(execution),
      let approval = map["approval"]?.stringValue,
      ["none", "device"].contains(approval)
    else { return nil }
    self.name = name; self.label = label; self.description = description
    self.category = category; self.execution = execution; self.approval = approval
  }
}

struct ExecutionForkEventInfo: Identifiable, Hashable {
  let eventID: String
  let forkID: String
  let requestID: String
  let phase: String
  let createdAtMilliseconds: Double
  let model: String?
  let workflow: String?
  let turn: Int?
  let callID: String?
  let toolName: String?
  let summary: String?

  var id: String { eventID }

  init?(map: [String: MessagePackValue]) {
    guard let eventID = map["eventId"]?.stringValue?.bounded(160),
      let forkID = map["forkId"]?.stringValue?.bounded(128),
      let requestID = map["requestId"]?.stringValue?.bounded(128),
      let phase = map["phase"]?.stringValue,
      ["fork_started", "model_started", "model_completed", "tool_started",
       "tool_completed", "tool_failed", "fork_completed", "fork_failed", "fork_cancelled"].contains(phase)
    else { return nil }
    self.eventID = eventID; self.forkID = forkID; self.requestID = requestID; self.phase = phase
    createdAtMilliseconds = max(0, map["createdAt"]?.doubleValue ?? 0)
    model = map["model"]?.stringValue?.bounded(128)
    workflow = map["workflow"]?.stringValue.flatMap { ["standard", "silent"].contains($0) ? $0 : nil }
    turn = map["turn"]?.intValue
    callID = map["callId"]?.stringValue?.bounded(128)
    toolName = map["toolName"]?.stringValue?.bounded(128)
    summary = map["summary"]?.stringValue?.bounded(512)
  }
}

struct BrainDeliverableInfo: Identifiable, Hashable {
  let id: String
  let runID: String
  let kind: String
  let title: String
  let createdAtMilliseconds: Double
  let sessionID: String?
  let url: URL?
  let path: String?

  init?(map: [String: MessagePackValue]) {
    guard let id = map["id"]?.stringValue?.bounded(160),
      let runID = map["runId"]?.stringValue?.bounded(128),
      let kind = map["kind"]?.stringValue,
      ["preview", "report", "canvas", "diff", "file", "link"].contains(kind),
      let title = map["title"]?.stringValue?.bounded(200)
    else { return nil }
    let url = map["url"]?.stringValue.flatMap(URL.init(string:))
    let safeURL = url?.scheme == "https" ? url : nil
    let path = map["path"]?.stringValue?.bounded(1_024)
    guard safeURL != nil || path != nil else { return nil }
    self.id = id
    self.runID = runID
    self.kind = kind
    self.title = title
    createdAtMilliseconds = max(0, map["createdAt"]?.doubleValue ?? 0)
    sessionID = map["sessionId"]?.stringValue?.bounded(256)
    self.url = safeURL
    self.path = path
  }
}

struct BrainConversationSummaryInfo: Identifiable, Hashable {
  let id: String
  let title: String
  let createdAtMilliseconds: Double
  let updatedAtMilliseconds: Double
  let messageCount: Int

  var updatedAt: Date { Date(timeIntervalSince1970: updatedAtMilliseconds / 1_000) }

  init?(map: [String: MessagePackValue]) {
    guard let id = map["id"]?.stringValue?.bounded(128),
      let title = map["title"]?.stringValue?.bounded(160)
    else { return nil }
    self.id = id
    self.title = title
    createdAtMilliseconds = max(0, map["createdAt"]?.doubleValue ?? 0)
    updatedAtMilliseconds = max(0, map["updatedAt"]?.doubleValue ?? 0)
    messageCount = max(0, map["messageCount"]?.intValue ?? 0)
  }
}

struct BrainConversationHistoryInfo: Identifiable, Hashable {
  let summary: BrainConversationSummaryInfo
  let messages: [BrainMessageInfo]
  let tasks: [BrainTaskInfo]
  let routeDecisions: [BrainRouteDecisionInfo]
  let runEvents: [BrainRunEventInfo]
  let deliverables: [BrainDeliverableInfo]
  let executionEvents: [ExecutionForkEventInfo]

  var id: String { summary.id }

  init?(map: [String: MessagePackValue]) {
    guard let summary = BrainConversationSummaryInfo(map: map) else { return nil }
    self.summary = summary
    messages = map["messages"]?.arrayValue?.suffix(200).compactMap {
      $0.mapValue.flatMap(BrainMessageInfo.init(map:))
    } ?? []
    tasks = map["tasks"]?.arrayValue?.suffix(100).compactMap {
      $0.mapValue.flatMap(BrainTaskInfo.init(map:))
    } ?? []
    routeDecisions = map["routeDecisions"]?.arrayValue?.suffix(100).compactMap {
      $0.mapValue.flatMap(BrainRouteDecisionInfo.init(map:))
    } ?? []
    runEvents = map["runEvents"]?.arrayValue?.suffix(300).compactMap {
      $0.mapValue.flatMap(BrainRunEventInfo.init(map:))
    } ?? []
    deliverables = map["deliverables"]?.arrayValue?.suffix(100).compactMap {
      $0.mapValue.flatMap(BrainDeliverableInfo.init(map:))
    } ?? []
    executionEvents = map["executionEvents"]?.arrayValue?.suffix(300).compactMap {
      $0.mapValue.flatMap(ExecutionForkEventInfo.init(map:))
    } ?? []
  }
}

struct BrainImageAssetInfo: Equatable {
  let assetID: String
  let name: String
  let mime: String
  let size: Int
  let sha256: String
}

struct BrainImageAttachmentInfo: Equatable {
  let actionID: String
  let deviceID: String
  let assets: [BrainImageAssetInfo]
}

extension String {
  fileprivate var nonEmpty: String? { isEmpty ? nil : self }
  fileprivate func bounded(_ maxLength: Int) -> String? {
    guard !isEmpty, count <= maxLength else { return nil }
    return self
  }
}

struct VoiceLearningReceipt {
  let requestId: String
  let revision: Int
  let status: String
  let model: [String: MessagePackValue]?
  let assist: [String: MessagePackValue]?
}

enum VoiceTurnControl: String { case provider, adaptive }
enum VoiceTurnWaitReason: String { case incomplete, unavailable }

// hello.replaceExisting is Host-only. False preserves an existing registration;
// hostInstanceId is a process UUID allowing the same Host to recover its stale socket.
// Omitted policy retains legacy replacement. Clients omit both; generic values preserve them.
struct ControlMessage {
  // A peer_call_result is a receipt, never a phone-side execution request.
  func peerCallResult() -> [String: MessagePackValue]? {
    guard type == "peer_call_result", let id = string("id"), !id.isEmpty, bool("ok") != nil else { return nil }
    return fields
  }
  /// Negotiated on attach_ok; older Hosts cannot scroll compatible snapshots.
  var historyScroll: Bool { bool("historyScroll") == true }
    // session_upload: optional fileName (<=255 chars), with image MIME or
    // application/octet-stream. The generic fields retain this additive wire
    // extension; existing iOS image uploads need no behavioral change.
    // capabilities.fileAttachments is optional; absence means unsupported.
  let fields: [String: MessagePackValue]

  // attach/attach_ok negotiate this flag for desktop terminal streams.
  // Mobile clients leave it unset and retain the mobile presentation contract.
  var nativeTerminal: Bool { bool("nativeTerminal") == true }
  // iOS advertises no UI yet; these additive control frames must be safely readable.
  var supportsVoiceLearning: Bool { (int("voiceLearning") ?? 0) >= 1 }
  var voiceTurnWaitReason: VoiceTurnWaitReason? { string("turnWaitReason").flatMap(VoiceTurnWaitReason.init(rawValue:)) }
  func voiceLearningResult() -> VoiceLearningReceipt? {
    guard type == "voice_learning_result", let requestId = string("requestId"),
      let revision = int("revision"), revision >= 0, revision <= 9_007_199_254_740_991,
      let status = string("status"), ["completed", "revoked", "stale", "failed"].contains(status)
    else { return nil }
    let model = fields["model"]?.mapValue
    if let model {
      guard model["schema"]?.intValue == 1, model["mode"]?.stringValue == "shadow",
        let count = model["samples"]?.intValue, (0...500).contains(count),
        model["version"]?.stringValue?.isEmpty == false else { return nil }
      for key in ["addressed", "finished"] {
        guard let weights = model[key]?.arrayValue, weights.count == 7,
          weights.allSatisfy({ value in
            guard let x = value.doubleValue else { return false }
            return x.isFinite && (-4...4).contains(x)
          }) else { return nil }
      }
    }
    let assist = fields["assist"]?.mapValue
    if let assist {
      guard assist["schema"]?.intValue == 2,
        ["context-assist", "off"].contains(assist["mode"]?.stringValue ?? ""),
        let count = assist["examples"]?.intValue, (0...500).contains(count) else { return nil }
    }
    return VoiceLearningReceipt(requestId: requestId, revision: revision, status: status, model: model, assist: assist)
  }

  var type: String { fields["t"]?.stringValue ?? "" }
  func string(_ name: String) -> String? { fields[name]?.stringValue }
  func int(_ name: String) -> Int? { fields[name]?.intValue }
  func bool(_ name: String) -> Bool? { fields[name]?.boolValue }
  func data(_ name: String) -> Data? {
    guard let field = fields[name], case .binary(let value) = field else { return nil }
    return value
  }
  func strings(_ name: String) -> [String] {
    fields[name]?.arrayValue?.compactMap(\.stringValue) ?? []
  }
  func hostNetworkPolicy() -> HostNetworkPolicyInfo? {
    guard type == "network_policy_result",
      let raw = string("policy"), let policy = HostNetworkPolicy(rawValue: raw)
    else { return nil }
    return HostNetworkPolicyInfo(
      policy: policy, changed: bool("changed") ?? false,
      proxyDetected: bool("proxyDetected") ?? false)
  }
  func sessions() -> [SessionInfo] { mappedArray("sessions", SessionInfo.init(map:)) }
  func hosts() -> [HostInfo] { mappedArray("hosts", HostInfo.init(map:)) }
  func brainMessages() -> [BrainMessageInfo] {
    mappedArray("messages", BrainMessageInfo.init(map:))
  }
  func brainTasks() -> [BrainTaskInfo] { mappedArray("tasks", BrainTaskInfo.init(map:)) }
  func agentRegistry() -> [AgentDescriptorInfo] {
    mappedArray("agentRegistry", AgentDescriptorInfo.init(map:))
  }
  func brainRouteDecisions() -> [BrainRouteDecisionInfo] {
    mappedArray("routeDecisions", BrainRouteDecisionInfo.init(map:))
  }
  func brainRunEvents() -> [BrainRunEventInfo] {
    mappedArray("runEvents", BrainRunEventInfo.init(map:))
  }
  func brainDeliverables() -> [BrainDeliverableInfo] {
    mappedArray("deliverables", BrainDeliverableInfo.init(map:))
  }
  func brainToolCatalog() -> [BrainToolDescriptorInfo] {
    Array(mappedArray("toolCatalog", BrainToolDescriptorInfo.init(map:)).prefix(32))
  }
  func brainExecutionEvents() -> [ExecutionForkEventInfo] {
    Array(mappedArray("executionEvents", ExecutionForkEventInfo.init(map:)).suffix(300))
  }
  func brainExecutionEvent() -> ExecutionForkEventInfo? {
    fields["event"]?.mapValue.flatMap(ExecutionForkEventInfo.init(map:))
  }
  func brainHistory() -> [BrainConversationSummaryInfo] {
    mappedArray("history", BrainConversationSummaryInfo.init(map:))
  }
  func brainHistoryConversation() -> BrainConversationHistoryInfo? {
    fields["conversation"]?.mapValue.flatMap(BrainConversationHistoryInfo.init(map:))
  }
  func reviewSnapshot() -> ReviewSnapshotInfo? {
    fields["snapshot"]?.mapValue.flatMap(ReviewSnapshotInfo.init(map:))
  }

  private func mappedArray<T>(
    _ name: String, _ transform: ([String: MessagePackValue]) -> T?
  ) -> [T] {
    fields[name]?.arrayValue?.compactMap { value in
      guard let map = value.mapValue else { return nil }
      return transform(map)
    } ?? []
  }
}

enum HostNetworkPolicy: String, Equatable {
  case system
  case direct
}

struct HostNetworkPolicyInfo: Equatable {
  let policy: HostNetworkPolicy
  let changed: Bool
  let proxyDetected: Bool
}

/// Bounded sequential file chunks shared with the macOS preview client.
struct SessionFileChunk {
    /// Reserved read-only Global preview scope: the Host's configured projects root.
    static let globalSessionID = "@global"
  let path: String?
  let rootPath: String?
  let name: String
  let size: Int
  let version: String
  let offset: Int
  let data: Data
  let eof: Bool
  init?(message: ControlMessage) {
    guard message.type == "session_file_result", let name = message.string("name"),
      !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
      !name.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains),
      let size = message.int("size"), (0...20 * 1024 * 1024).contains(size),
      let version = message.string("version"), !version.isEmpty, version.utf8.count <= 256,
      let offset = message.int("offset"), (0...size).contains(offset),
      let data = message.data("data"), data.count <= 128 * 1024, data.count <= size - offset,
      let eof = message.bool("eof"), eof == (offset + data.count == size), eof || !data.isEmpty
    else { return nil }
    self.path = message.string("path"); self.rootPath = message.string("rootPath")
    self.name = name; self.size = size; self.version = version
    self.offset = offset; self.data = data; self.eof = eof
  }
}

struct SessionDirectoryEntry {
  let name: String
  let directory: Bool
}

enum NativeTerminalScroll {
  static func fields(sid: Int, lines: Int) -> [String: MessagePackValue]? {
    guard (0...65535).contains(sid), lines != 0, (-100...100).contains(lines) else { return nil }
    return ["t": .string("session_scroll"), "sid": .int(Int64(sid)),
      "direction": .string(lines > 0 ? "up" : "down"), "lines": .int(Int64(abs(lines)))]
  }
}
