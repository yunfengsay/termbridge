import Combine
import Foundation

final class AgentChatViewModel: ObservableObject {
  @Published private(set) var status = "正在连接…"
  @Published private(set) var unavailable: String?
  @Published private(set) var capabilities = AgentChatCapabilities(map: nil)
  @Published private(set) var connected = false
  @Published var composer: AgentChatComposerState {
    didSet { Self.composers[cacheKey] = composer }
  }
  let web = AgentChatWebController()
  let conversationID: String
  var onUnavailable: ((String) -> Void)?
  private static var composers: [String: AgentChatComposerState] = [:]
  private let settings: ConnectionSettings
  private let cacheKey: String
  private var subscription: AgentChatSubscription
  private var client: TermbridgeClient?
  private var started = false
  private var listRequestID: String?
  /// Held for the life of the subscription. A transcript rewind replays the
  /// snapshot under the same request, so this cannot be cleared on first use.
  private var subscribeRequestID: String?
  private var awaitingSnapshot = false
  private var earlierRequestID: String?
  private var connectionTimeout: DispatchWorkItem?
  private var receiptTimeout: DispatchWorkItem?
  private var earlierTimeout: DispatchWorkItem?
  private var reconnectWork: DispatchWorkItem?
  private var snapshot: ControlMessage?
  private var pendingSurface: [ControlMessage] = []
  @Published private var surfaceReady = false
  private var surfaceHasLoaded = false

  init(sessionID: String, settings: ConnectionSettings) {
    conversationID = sessionID
    self.settings = settings
    cacheKey = settings.profileID.uuidString + ":" + settings.hostID + ":" + sessionID
    subscription = AgentChatSubscription(conversationID: sessionID)
    composer = Self.composers[cacheKey] ?? AgentChatComposerState()
    web.onReady = { [weak self] in self?.surfaceDidBecomeReady() }
    web.onEarlier = { [weak self] generation, cursor in self?.loadEarlier(generation: generation, cursor: cursor) }
    web.onFailure = { [weak self] reason in self?.setUnavailable(reason) }
    web.onReset = { [weak self] in self?.surfaceWasReset() }
  }

  var canSend: Bool {
    connected && subscription.active && surfaceReady && snapshot != nil
      && unavailable == nil && capabilities.send && !composer.pending
      && !composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && composer.draft.utf16.count <= 16_000
  }
  var receiptLabel: String? {
    switch composer.state {
    case .accepted: return "正在发送…"
    case .delivered: return "已送达，等待 Agent 确认"
    case .observed: return "Agent 已收到"
    case .uncertain: return "结果未知，请在终端确认后再决定是否发送"
    case .failed: return "发送失败，可以重试"
    case nil: return nil
    }
  }

  func start() {
    guard !started else { return }
    started = true
    connect()
  }
  func stop() {
    guard started else { return }
    started = false
    disconnect()
  }
  func reconnect() { guard started else { return }; disconnect(); connect() }

  private func disconnect() {
    connectionTimeout?.cancel(); reconnectWork?.cancel(); receiptTimeout?.cancel(); earlierTimeout?.cancel()
    composer.loseConfirmation("连接或视图已关闭，无法继续确认；请检查终端")
    if subscription.active {
      client?.sendControl(["t": .string(AgentChatProtocol.unsubscribe), "conversationId": .string(conversationID)])
    }
    subscription.end()
    client?.disconnect(); client = nil
    connected = false
    listRequestID = nil; subscribeRequestID = nil; earlierRequestID = nil
    awaitingSnapshot = false
    snapshot = nil; pendingSurface.removeAll()
    web.receive(["op": "clear"])
  }

  /// The WebView threw away its page. Anything the Host produced for the
  /// subscription that page was showing must not land in the new one, so the
  /// subscription ends here and a fresh one starts once the page is ready.
  private func surfaceWasReset() {
    surfaceReady = false
    snapshot = nil
    pendingSurface.removeAll()
    earlierRequestID = nil; earlierTimeout?.cancel()
    capabilities = AgentChatCapabilities(map: nil)
    awaitingSnapshot = false
    guard subscription.active else { return }
    client?.sendControl(["t": .string(AgentChatProtocol.unsubscribe), "conversationId": .string(conversationID)])
    subscription.end()
  }

  private func connect() {
    guard started else { return }
    unavailable = nil
    status = "正在连接…"
    capabilities = AgentChatCapabilities(map: nil)
    if let error = settings.validationError { setUnavailable(error); return }
    let next = TermbridgeClient(settings: settings, listener: self)
    client = next
    next.connect()
    armConnectionTimeout()
  }

  private func armConnectionTimeout() {
    connectionTimeout?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.started else { return }
      self.setUnavailable("Host 尚未提供对话视图，请检查连接或更新 Host 后重试")
    }
    connectionTimeout = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
  }

  private func setUnavailable(_ reason: String) {
    guard started else { return }
    connectionTimeout?.cancel()
    unavailable = reason
    status = "对话模式不可用"
    capabilities = AgentChatCapabilities(map: nil)
    composer.loseConfirmation("对话已不可用，请检查终端中的发送结果")
    onUnavailable?(reason)
  }

  private func subscribe() {
    snapshot = nil
    pendingSurface.removeAll()
    earlierRequestID = nil; earlierTimeout?.cancel()
    capabilities = AgentChatCapabilities(map: nil)
    subscription.begin()
    let requestID = UUID().uuidString
    subscribeRequestID = requestID
    awaitingSnapshot = true
    client?.sendControl(["t": .string(AgentChatProtocol.subscribe),
      "requestId": .string(requestID), "conversationId": .string(conversationID),
      "generation": .int(Int64(subscription.generation))])
    status = "正在读取对话…"
    armConnectionTimeout()
  }

  func send() {
    guard canSend, let client else { return }
    let requestID = UUID().uuidString
    composer.begin(requestID: requestID, generation: subscription.generation)
    let sent = client.sendControl(["t": .string(AgentChatProtocol.send),
      "requestId": .string(requestID), "conversationId": .string(conversationID),
      "text": .string(composer.submittedText ?? "")])
    if !sent {
      let receipt = AgentChatDelivery(map: ["requestId": .string(requestID),
        "conversationId": .string(conversationID), "generation": .int(Int64(subscription.generation)),
        "state": .string("failed"), "error": .string("消息未写入连接，请重连后重试")])!
      composer.apply(receipt)
      return
    }
    receiptTimeout?.cancel()
    let generation = subscription.generation
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.composer.requestID == requestID,
        self.composer.generation == generation else { return }
      self.composer.loseConfirmation("等待确认超时，请在终端检查；不会自动重发")
    }
    receiptTimeout = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: work)
  }

  private func loadEarlier(generation: Int, cursor: Int) {
    guard started, connected, surfaceReady, snapshot != nil, capabilities.history,
      subscription.generation == generation, earlierRequestID == nil else { return }
    let requestID = UUID().uuidString
    guard let fields = subscription.earlier(requestID: requestID, cursor: cursor) else { return }
    guard client?.sendControl(fields) == true else {
      status = "历史请求未写入连接，请重连后重试"
      return
    }
    earlierRequestID = requestID
    // Without a deadline an unanswered page request disables the renderer's
    // "earlier" button for the rest of the subscription.
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.earlierRequestID == requestID,
        self.subscription.generation == generation else { return }
      self.earlierRequestID = nil
      self.status = "加载更早记录超时，请重试"
    }
    earlierTimeout = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: work)
  }

  private func surfaceDidBecomeReady() {
    let reloaded = surfaceHasLoaded
    surfaceHasLoaded = true
    surfaceReady = true
    web.receive(["op": "theme", "theme": "dark"])
    if reloaded {
      // A reloaded page has no transcript and the old one cannot be replayed
      // faithfully, so the Host sends a fresh bounded snapshot instead.
      composer.loseConfirmation("对话页面重新加载，请检查之前的发送结果")
      receiptTimeout?.cancel()
      guard started, connected else { return }
      subscribe()
      return
    }
    guard let snapshot else { return }
    web.receive(agentChatSurfaceMessage(snapshot, op: "snapshot"))
    for message in pendingSurface { web.receive(agentChatSurfaceMessage(message, op: "append")) }
    pendingSurface.removeAll()
  }

  private func handle(_ message: ControlMessage) {
    switch message.type {
    case AgentChatProtocol.listResult:
      guard message.string("requestId") == listRequestID else { return }
      listRequestID = nil
      let item = message.fields["conversations"]?.arrayValue?.compactMap {
        $0.mapValue.flatMap(AgentChatConversation.init(map:))
      }.first { $0.conversationID == conversationID }
      guard let item, item.chat else {
        setUnavailable(item?.reason ?? "此会话没有可读取的 Agent 对话记录，请使用终端")
        return
      }
      subscribe()
    case AgentChatProtocol.snapshot, AgentChatProtocol.append:
      guard subscription.accepts(message) else { return }
      if message.type == AgentChatProtocol.snapshot {
        guard let subscribeRequestID, message.string("requestId") == subscribeRequestID else { return }
        connectionTimeout?.cancel()
        awaitingSnapshot = false
        snapshot = message
        pendingSurface.removeAll()
        // A rewind replaces the transcript; a cursor into the old one is dead.
        earlierRequestID = nil; earlierTimeout?.cancel()
      } else if snapshot == nil { return }
      capabilities = AgentChatCapabilities(map: message.fields["capabilities"]?.mapValue)
      status = message.string("status") == "working" ? "Agent 正在处理" : "可以继续对话"
      if message.string("status") == "unavailable" {
        setUnavailable(message.string("error") ?? capabilities.degraded ?? "对话模式不可用")
      }
      if surfaceReady {
        web.receive(agentChatSurfaceMessage(message, op: message.type == AgentChatProtocol.snapshot ? "snapshot" : "append"))
      } else if message.type == AgentChatProtocol.append {
        // Keep the pre-ready queue bounded. A reload obtains a fresh snapshot.
        pendingSurface.append(message)
        if pendingSurface.count > 32 { reconnect() }
      }
    case AgentChatProtocol.earlierResult:
      guard subscription.accepts(message), let earlierRequestID,
        message.string("requestId") == earlierRequestID else { return }
      self.earlierRequestID = nil
      earlierTimeout?.cancel()
      // A failed page must not hide the renderer's earlier-page button.
      if let error = message.string("error") { status = error; return }
      web.receive(agentChatSurfaceMessage(message, op: "earlier"))
    case AgentChatProtocol.delivery:
      guard subscription.accepts(message), let receipt = AgentChatDelivery(map: message.fields),
        composer.apply(receipt) else { return }
      if !composer.pending { receiptTimeout?.cancel() }
    case "error":
      let requestID = message.string("requestId")
      if let requestID, requestID == earlierRequestID {
        earlierRequestID = nil; earlierTimeout?.cancel()
        status = message.string("message") ?? "无法加载更早记录，请重试"
      } else if (requestID != nil && (requestID == listRequestID || requestID == subscribeRequestID))
        || (requestID == nil && (listRequestID != nil || awaitingSnapshot)) {
        // An untagged error is only fatal while the open handshake is still
        // outstanding; the retained subscription ID is for rewinds.
        setUnavailable(message.string("message") ?? "Host 无法打开对话，请更新 Host 后重试")
      }
    default: break
    }
  }
}

extension AgentChatViewModel: TermbridgeClientListener {
  func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
    guard self.client === client, started else { return }
    switch state {
    case .connecting: status = "正在连接…"
    case .authenticating: status = "正在验证连接…"
    case .connected: break
    case .disconnected, .failed:
      connected = false
      composer.loseConfirmation("连接中断，无法继续确认；请检查终端")
      connectionTimeout?.cancel()
      subscription.end()
      status = "连接中断，正在重连…"
      let fatal: Bool
      if case .failed(let error) = state {
        fatal = ["password", "authentication", "fingerprint", "invalid"].contains {
          error.localizedCaseInsensitiveContains($0)
        }
        if fatal { setUnavailable(error) }
      } else { fatal = false }
      guard !fatal else { return }
      reconnectWork?.cancel()
      let work = DispatchWorkItem { [weak self] in self?.reconnect() }
      reconnectWork = work
      DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }
  }
  func clientIsReady(_ client: TermbridgeClient) {
    guard self.client === client, started else { return }
    connected = true
    let requestID = UUID().uuidString
    listRequestID = requestID
    client.sendControl(["t": .string(AgentChatProtocol.list), "requestId": .string(requestID)])
  }
  func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
    guard self.client === client, started else { return }
    handle(message)
  }
  func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
