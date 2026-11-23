import Combine
import Foundation

/// Read-only Git review over the existing pairing. The client never names a
/// filesystem path: it sends the Session ID and the Host resolves the repository.
@MainActor
final class ReviewViewModel: ObservableObject {
  @Published private(set) var snapshot: ReviewSnapshotInfo?
  @Published private(set) var connectionState: ConnectionState = .disconnected
  @Published private(set) var status: String?
  @Published private(set) var isLoading = true
  @Published private(set) var selectedPath: String?
  @Published private(set) var navigatorOpen = true
  @Published private(set) var collapsedDirectories: Set<String> = []
  @Published private(set) var branchNotice: String?
  @Published private(set) var navigatorMode: ReviewNavigatorMode = .tree
  /// Rows are stored, not computed: a prioritised file can carry 20,000 lines and
  /// SwiftUI re-evaluates `body` far more often than the snapshot changes.
  @Published private(set) var rows: [ReviewRow] = []
  @Published private(set) var navigatorRows: [ReviewNavigatorRow] = []
  @Published var mode: ReviewMode {
    didSet {
      guard mode != oldValue else { return }
      selectedPath = nil
      autoLoadAttempts = 0
      rebuildRows()
      navigatorOpen = true
      requestOrReconnect()
    }
  }

  let highlighter = ReviewSyntaxHighlighter()
  let sessionID: String
  let displayName: String

  private let pinnedSettings: ConnectionSettings
  private var client: TermbridgeClient?
  private var reconnectWork: DispatchWorkItem?
  private var pendingRequestID: String?
  private var baseBranch: String?
  private var pendingPriorityPath: String?
  private var autoLoadAttempts = 0
  private var started = false

  init(route: ReviewRoute, settings: ConnectionSettings = SettingsStore.load()) {
    pinnedSettings = settings
    sessionID = route.sessionID
    displayName = route.displayName
    mode = route.mode
  }

  var isConnected: Bool { connectionState == .connected }
  var files: [ReviewFileInfo] { snapshot?.files ?? [] }
  var compareBranch: String? { baseBranch ?? snapshot?.baseBranch }

  var title: String { snapshot?.repository ?? "Review changes" }

  /// A dropped link must be readable on the review itself; otherwise a stale
  /// snapshot looks live and every file tap silently does nothing.
  var statusLine: String? {
    guard !isConnected else { return status }
    switch connectionState {
    case .connecting: return "Connecting"
    case .authenticating: return "Authenticating"
    case .connected: return status
    case .disconnected: return "Disconnected — reconnecting"
    case .failed(let message): return message
    }
  }

  var subtitle: String {
    guard let snapshot else { return displayName }
    if mode == .files {
      return "\(snapshot.branch) · \(snapshot.changedFileCount) project files"
    }
    return "\(snapshot.branch) · \(snapshot.changedFileCount) files · +\(snapshot.additions) −\(snapshot.deletions)"
  }

  var navigatorTitle: String {
    switch (mode, navigatorMode) {
    case (.files, .tree): return "Project tree"
    case (.files, .flat): return "All project files"
    case (_, .tree): return "Directory tree"
    case (_, .flat): return "All changed files"
    }
  }

  /// Selecting a compare branch is read-only. Moving the repository is a separate,
  /// explicitly confirmed action that the Host only accepts on a clean worktree.
  var canSwitchBranch: Bool { snapshot?.canSwitchBranch == true && !switchableBranches.isEmpty }
  var switchableBranches: [String] {
    guard let snapshot else { return [] }
    return snapshot.branches.filter { $0 != snapshot.branch }
  }

  func start() {
    guard !started else { return }
    started = true
    connectNow()
  }

  func stop() {
    started = false
    reconnectWork?.cancel()
    client?.disconnect()
    client = nil
  }

  func refresh() { requestOrReconnect(priorityPath: selectedPath) }

  /// A dropped link must not swallow the request: reconnecting re-asks for the
  /// same view from `clientIsReady`, which is what the reader is waiting for.
  private func requestOrReconnect(priorityPath: String? = nil) {
    guard isConnected else {
      started = true
      connectNow()
      return
    }
    requestSnapshot(priorityPath: priorityPath)
  }

  func selectCompareBranch(_ branch: String) {
    baseBranch = branch
    selectedPath = nil
    rebuildRows()
    navigatorOpen = true
    requestOrReconnect()
  }

  /// On a wide iPad layout the navigator stays visible next to the file; on a
  /// phone the file replaces it exactly like the Android review.
  func select(path: String, keepNavigator: Bool) {
    selectedPath = path
    autoLoadAttempts = 0
    rebuildRows()
    navigatorOpen = keepNavigator
    // Project browsing only carries content for the prioritised path, so a
    // selection that lands on a dropped link must reconnect instead of leaving
    // a file header with no body.
    requestOrReconnect(priorityPath: path)
  }

  func toggleDirectory(_ path: String) {
    if collapsedDirectories.contains(path) {
      collapsedDirectories.remove(path)
    } else {
      collapsedDirectories.insert(path)
    }
    rebuildRows()
  }

  func toggleNavigator() {
    navigatorOpen.toggle()
  }

  func toggleLayout() {
    navigatorMode = navigatorMode == .tree ? .flat : .tree
    rebuildRows()
    navigatorOpen = true
  }

  func dismissBranchNotice() { branchNotice = nil }

  func switchBranch(_ branch: String) {
    let requestID = UUID().uuidString.lowercased()
    pendingRequestID = requestID
    show(loading: "Switching to \(branch)…")
    let sent = client?.sendControl([
      "t": .string("review_switch_branch"), "requestId": .string(requestID),
      "sessionId": .string(sessionID), "branch": .string(branch),
    ])
    if sent != true { show(error: "Could not switch branch") }
  }

  private func connectNow() {
    reconnectWork?.cancel()
    client?.disconnect()
    client = nil
    let settings = pinnedSettings
    if let error = settings.validationError {
      show(error: error)
      return
    }
    let next = TermbridgeClient(settings: settings, listener: self)
    client = next
    next.connect()
  }

  private func requestSnapshot(priorityPath: String? = nil) {
    guard let client else { return }
    let requestID = UUID().uuidString.lowercased()
    pendingRequestID = requestID
    pendingPriorityPath = priorityPath
    show(loading: mode == .files ? "Loading project files…" : "Loading Git changes…")
    var fields: [String: MessagePackValue] = [
      "t": .string("review_snapshot"), "requestId": .string(requestID),
      "sessionId": .string(sessionID), "mode": .string(mode.rawValue),
    ]
    if mode == .branch, let baseBranch { fields["baseBranch"] = .string(baseBranch) }
    // The Host prioritises this file's full content and keeps the rest as navigation metadata.
    if let priorityPath { fields["path"] = .string(priorityPath) }
    if !client.sendControl(fields) { show(error: "Could not load this review") }
  }

  private func handleSnapshot(_ message: ControlMessage) {
    guard message.string("requestId") == pendingRequestID else { return }
    let answeredPath = pendingPriorityPath
    pendingRequestID = nil
    pendingPriorityPath = nil
    if let error = message.string("error") {
      show(error: error)
      return
    }
    guard let next = message.reviewSnapshot() else {
      show(error: "Could not load this review")
      return
    }
    snapshot = next
    baseBranch = next.baseBranch
    selectedPath = selectedPath.flatMap { path in
      next.files.contains { $0.path == path } ? path : nil
    } ?? next.files.first?.path
    isLoading = false
    status = nil
    rebuildRows()
    loadSelectedFileContent(in: next, answeredPath: answeredPath)
  }

  private func rebuildRows() {
    rows = snapshot.map { ReviewPresentation.rows($0, selectedPath: selectedPath) } ?? []
    navigatorRows = ReviewNavigatorPresentation.rows(
      files: files, mode: navigatorMode, collapsedDirectories: collapsedDirectories,
      selectedPath: selectedPath)
  }

  /// A snapshot spreads one bounded line budget across every file, so the file
  /// the reader is looking at arrives clipped — project browsing sends no body at
  /// all, and a large working-tree diff sends a few dozen lines and marks it
  /// truncated. Naming the file spends the Host's much larger per-file budget on
  /// it. `answeredPath` is what this snapshot was already asked for: once the Host
  /// has answered for this file, what came back is its answer, so asking again
  /// would loop. Any other snapshot — first load, refresh, a reconnect that raced
  /// a selection — still owes the reader this file's full content.
  private func loadSelectedFileContent(
    in snapshot: ReviewSnapshotInfo, answeredPath: String?
  ) {
    // The Host answered for exactly this file, so the round trip worked whatever
    // it returned; anything further is the reader's own doing.
    if let selected = selectedPath, answeredPath == selected { autoLoadAttempts = 0 }
    guard let path = selectedPath, answeredPath != path, isConnected,
      autoLoadAttempts < 3,
      let file = snapshot.files.first(where: { $0.path == path }),
      !file.binary, file.hunks.isEmpty || file.truncated
    else { return }
    autoLoadAttempts += 1
    requestSnapshot(priorityPath: path)
  }

  private func handleBranchSwitch(_ message: ControlMessage) {
    guard message.string("requestId") == pendingRequestID else { return }
    pendingRequestID = nil
    guard message.bool("ok") == true else {
      show(error: message.string("error") ?? "Could not switch branch")
      return
    }
    branchNotice = "Switched to \(message.string("branch") ?? "the selected branch")"
    baseBranch = nil
    requestSnapshot()
  }

  private func show(loading message: String) {
    status = message
    if snapshot == nil { isLoading = true }
  }

  private func show(error message: String) {
    pendingRequestID = nil
    isLoading = false
    status = message
  }

  private func scheduleReconnect(_ message: String) {
    show(error: message)
    guard started else { return }
    let work = DispatchWorkItem { [weak self] in self?.connectNow() }
    reconnectWork?.cancel()
    reconnectWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
  }

}

extension ReviewViewModel: TermbridgeClientListener {
  nonisolated func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
    Task { @MainActor in
      guard self.client === client else { return }
      connectionState = state
      switch state {
      case .connecting: show(loading: "Connecting")
      case .authenticating: show(loading: "Authenticating")
      case .connected: break
      case .disconnected: scheduleReconnect("Disconnected")
      case .failed(let message): scheduleReconnect(message)
      }
    }
  }

  nonisolated func clientIsReady(_ client: TermbridgeClient) {
    Task { @MainActor in
      guard self.client === client else { return }
      requestSnapshot(priorityPath: selectedPath)
    }
  }

  nonisolated func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
    Task { @MainActor in
      guard self.client === client else { return }
      switch message.type {
      case "review_snapshot_result":
        guard message.string("sessionId") == sessionID else { return }
        handleSnapshot(message)
      case "review_switch_branch_result":
        guard message.string("sessionId") == sessionID else { return }
        handleBranchSwitch(message)
      case "error":
        show(error: message.string("message") ?? "Could not load this review")
      case "tool_request":
        guard let id = message.string("id") else { return }
        client.sendControl([
          "t": .string("tool_response"), "id": .string(id), "ok": .bool(false),
          "error": .string("The iOS review does not expose peer tools"),
        ])
      default: break
      }
    }
  }

  nonisolated func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
