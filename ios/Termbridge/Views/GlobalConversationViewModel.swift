import Combine
import Foundation

@MainActor
final class GlobalConversationViewModel: ObservableObject {
  @Published private(set) var messages: [BrainMessageInfo] = []
  @Published private(set) var tasks: [BrainTaskInfo] = []
  @Published private(set) var deliverables: [BrainDeliverableInfo] = []
  @Published private(set) var toolCatalog: [BrainToolDescriptorInfo] = []
  @Published private(set) var executionEvents: [ExecutionForkEventInfo] = []
  @Published private(set) var history: [BrainConversationSummaryInfo] = []
  @Published private(set) var connectionState: ConnectionState = .disconnected
  @Published private(set) var isLoading = true
  @Published private(set) var composerStatus: String?
  @Published var draft = ""

  private var client: TermbridgeClient?
  private var reconnectWork: DispatchWorkItem?
  private var pollWork: DispatchWorkItem?
  private var pendingRequestID: String?
  private var pendingText: String?
  private var started = false

  var isConnected: Bool { connectionState == .connected }
  var canSend: Bool {
    isConnected && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && pendingRequestID == nil
  }
  var connectionLabel: String {
    switch connectionState {
    case .connecting: return "Connecting"
    case .authenticating: return "Authenticating"
    case .connected: return "Connected to \(SettingsStore.load().displayName)"
    case .disconnected: return "Disconnected"
    case .failed(let message): return message
    }
  }

  func start() { guard !started else { return }; started = true; connectNow() }
  func stop() {
    started = false; reconnectWork?.cancel(); pollWork?.cancel(); client?.disconnect(); client = nil
  }

  func refresh() {
    guard let client, isConnected else { connectNow(); return }
    client.sendControl(["t": .string("brain_snapshot")])
  }

  func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard canSend else { return }
    let requestID = UUID().uuidString.lowercased()
    pendingRequestID = requestID
    pendingText = text
    composerStatus = "Sending…"
    draft = ""
    sendRequest(requestID: requestID, text: text)
  }

  func newConversation() {
    guard isConnected, pendingRequestID == nil else { return }
    client?.sendControl(["t": .string("brain_new")])
  }

  func clearConversation() {
    guard isConnected, pendingRequestID == nil else { return }
    client?.sendControl(["t": .string("brain_clear")])
  }

  func restoreHistory(_ conversation: BrainConversationSummaryInfo) {
    guard isConnected else { return }
    client?.sendControl([
      "t": .string("brain_restore"),
      "conversationId": .string(conversation.id),
    ])
  }

  private func connectNow() {
    reconnectWork?.cancel(); pollWork?.cancel(); client?.disconnect(); client = nil
    let settings = SettingsStore.load()
    guard SettingsStore.isConfigured else { connectionState = .disconnected; isLoading = false; return }
    if let error = settings.validationError { connectionState = .failed(error); isLoading = false; return }
    let next = TermbridgeClient(settings: settings, listener: self)
    client = next
    next.connect()
  }

  private func sendRequest(requestID: String, text: String) {
    let fields: [String: MessagePackValue] = [
      "t": .string("brain_send"), "requestId": .string(requestID), "text": .string(text),
      "clientPlatform": .string("ios"),
    ]
    if client?.sendControl(fields) != true {
      pendingRequestID = nil; pendingText = nil; composerStatus = "Send failed"; draft = text
    }
  }

  private func schedulePoll() {
    pollWork?.cancel()
    guard started, isConnected else { return }
    let work = DispatchWorkItem { [weak self] in self?.refresh() }
    pollWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
  }

  private func scheduleReconnect(_ message: String) {
    connectionState = .failed(message)
    guard started else { return }
    let work = DispatchWorkItem { [weak self] in self?.connectNow() }
    reconnectWork?.cancel(); reconnectWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
  }

  private func rejectToolRequest(_ message: ControlMessage) {
    guard let id = message.string("id") else { return }
    client?.sendControl(["t": .string("tool_response"), "id": .string(id), "ok": .bool(false),
      "error": .string("The iOS Global view does not expose peer tools")])
  }
}

extension GlobalConversationViewModel: TermbridgeClientListener {
  nonisolated func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
    Task { @MainActor in
      guard self.client === client else { return }
      connectionState = state
      if case .disconnected = state { scheduleReconnect("Disconnected") }
      if case .failed(let message) = state { scheduleReconnect(message) }
    }
  }

  nonisolated func clientIsReady(_ client: TermbridgeClient) {
    Task { @MainActor in
      guard self.client === client else { return }
      refresh()
      if let pendingRequestID, let pendingText { sendRequest(requestID: pendingRequestID, text: pendingText) }
    }
  }

  nonisolated func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
    Task { @MainActor in
      guard self.client === client else { return }
      switch message.type {
      case "brain_snapshot_result":
        messages = message.brainMessages(); tasks = message.brainTasks()
        deliverables = message.brainDeliverables()
        toolCatalog = message.brainToolCatalog()
        executionEvents = message.brainExecutionEvents()
        history = message.brainHistory(); isLoading = false
        if let pendingRequestID, tasks.contains(where: { $0.requestID == pendingRequestID }) {
          self.pendingRequestID = nil; pendingText = nil; composerStatus = nil
        }
        schedulePoll()
      case "brain_execution_event":
        if let event = message.brainExecutionEvent() {
          executionEvents.removeAll { $0.id == event.id }
          executionEvents.append(event)
          executionEvents = Array(executionEvents.sorted { $0.createdAtMilliseconds < $1.createdAtMilliseconds }.suffix(300))
        }
      case "brain_accepted": if message.string("requestId") == pendingRequestID { composerStatus = "Accepted" }
      case "error":
        composerStatus = message.string("message") ?? "Host rejected the request"
        if let pendingText { draft = pendingText }
        pendingRequestID = nil; pendingText = nil
      case "tool_request": rejectToolRequest(message)
      default: break
      }
    }
  }

  nonisolated func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
