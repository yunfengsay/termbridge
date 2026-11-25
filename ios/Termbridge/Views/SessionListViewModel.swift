import Combine
import Foundation
import UIKit

@MainActor
final class SessionListViewModel: ObservableObject {
  @Published private(set) var sessions: [SessionInfo] = []
  @Published private(set) var agents: [String] = []
  @Published private(set) var hosts: [HostInfo] = []
  @Published private(set) var connectionState: ConnectionState = .disconnected
  @Published private(set) var isLoading = false
  @Published private(set) var activeProfile = SettingsStore.load()
  /// Cloudflare discovery can expand one room into a profile per Mac, so the
  /// sidebar reads this instead of re-reading storage during a view update.
  @Published private(set) var profiles = SettingsStore.profiles()

  private var client: TermbridgeClient?
  private var reconnectWork: DispatchWorkItem?
  private var pollWork: DispatchWorkItem?
  private var started = false
  private var loaded = false
  private var fatal = false
  private var completionTracker = AgentCompletionTracker()

  var connectionLabel: String {
    switch connectionState {
    case .connecting: return "Connecting"
    case .authenticating: return "Authenticating"
    case .connected: return "Connected to \(activeProfile.displayName)"
    case .disconnected: return "Disconnected"
    case .failed(let message): return message
    }
  }

  var isConnected: Bool { connectionState == .connected }
  var activeCount: Int { sessions.filter { $0.isWorking || $0.isActive }.count }

  func start() {
    guard !started else { return }
    started = true
    connectNow()
  }

  func stop() {
    started = false
    reconnectWork?.cancel()
    pollWork?.cancel()
    reconnectWork = nil
    pollWork = nil
    client?.disconnect()
    client = nil
  }

  func refresh() {
    guard let client, isConnected else { connectNow(); return }
    if !loaded { isLoading = true }
    client.sendControl(["t": .string("session_list")])
    client.sendControl(["t": .string("agents")])
  }

  func settingsDidChange() {
    loaded = false
    sessions = []
    agents = []
    hosts = []
    activeProfile = SettingsStore.load()
    profiles = SettingsStore.profiles()
    completionTracker.reset()
    connectNow()
  }

  func selectProfile(_ profileID: UUID) {
    guard SettingsStore.select(profileID) else { return }
    settingsDidChange()
  }

  func kill(_ session: SessionInfo) {
    guard !session.isHerdr else { return }
    client?.sendControl(["t": .string("kill"), "sessionId": .string(session.sessionID)])
    sessions.removeAll { $0.sessionID == session.sessionID }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.refresh() }
  }

  private func connectNow() {
    reconnectWork?.cancel()
    pollWork?.cancel()
    reconnectWork = nil
    pollWork = nil
    client?.disconnect()
    client = nil
    isLoading = !loaded
    fatal = false
    completionTracker.reset()
    activeProfile = SettingsStore.load()

    guard SettingsStore.isConfigured else {
      connectionState = .disconnected
      isLoading = false
      return
    }
    if let error = activeProfile.validationError {
      connectionState = .failed(error)
      isLoading = false
      return
    }
    let next = TermbridgeClient(settings: activeProfile, listener: self)
    client = next
    next.connect()
  }

  private func schedulePoll() {
    pollWork?.cancel()
    guard started, isConnected else { return }
    let work = DispatchWorkItem { [weak self] in self?.refresh() }
    pollWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
  }

  private func scheduleReconnect(for message: String) {
    connectionState = .failed(message)
    isLoading = false
    fatal = !shouldRetry(message)
    guard started, !fatal else { return }
    let work = DispatchWorkItem { [weak self] in self?.connectNow() }
    reconnectWork?.cancel()
    reconnectWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
  }

  private func shouldRetry(_ message: String) -> Bool {
    let fatalWords = ["password", "fingerprint", "authentication", "host not found", "invalid"]
    return !fatalWords.contains { message.localizedCaseInsensitiveContains($0) }
  }

  private func rejectToolRequest(_ message: ControlMessage) {
    guard let id = message.string("id") else { return }
    client?.sendControl([
      "t": .string("tool_response"), "id": .string(id), "ok": .bool(false),
      "error": .string("The iOS viewer does not expose peer tools"),
    ])
  }
}

extension SessionListViewModel: TermbridgeClientListener {
  nonisolated func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
    Task { @MainActor in
      guard self.client === client else { return }
      connectionState = state
      switch state {
      case .disconnected: if !fatal { scheduleReconnect(for: "Disconnected") }
      case .failed(let message): scheduleReconnect(for: message)
      default: break
      }
    }
  }

  nonisolated func clientIsReady(_ client: TermbridgeClient) {
    Task { @MainActor in
      guard self.client === client else { return }
      client.sendControl(["t": .string("session_list")])
      client.sendControl(["t": .string(RemoteDesktopProtocol.subscribe), "deviceId": .string(UIDevice.current.identifierForVendor?.uuidString ?? activeProfile.profileID.uuidString), "foreground": .bool(true)])
      client.sendControl(["t": .string("agents")])
    }
  }

  nonisolated func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
    Task { @MainActor in
      guard self.client === client else { return }
      switch message.type {
      case RemoteDesktopProtocol.attention:
        NotificationCenter.default.post(name: Notification.Name("termbridgeOpenDesktop"), object: nil)
      case "host_list_result":
        hosts = message.hosts()
        let selected = message.string("selectedHostId")
        SettingsStore.mergeDiscoveredHosts(
          base: activeProfile, hosts: hosts, selectedHostID: selected)
        profiles = SettingsStore.profiles()
        if let selected, let resolved = profiles.first(where: { $0.hostID == selected }) {
          activeProfile = resolved
        }
      case "session_list_result":
        loaded = true
        isLoading = false
        let next = message.sessions()
        for completed in completionTracker.update(next) {
          NotificationCoordinator.shared.notifyCompletion(completed, profile: activeProfile)
        }
        sessions = next.sorted { lhs, rhs in
          let lhsBlank = lhs.workspace?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
          let rhsBlank = rhs.workspace?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true
          if lhsBlank != rhsBlank { return !lhsBlank }
          let wsCmp = (lhs.workspace ?? "").localizedStandardCompare(rhs.workspace ?? "")
          if wsCmp != .orderedSame { return wsCmp == .orderedAscending }
          if lhs.isHerdr != rhs.isHerdr { return lhs.isHerdr }
          if lhsBlank && lhs.createdAtMilliseconds != rhs.createdAtMilliseconds {
            return lhs.createdAtMilliseconds < rhs.createdAtMilliseconds
          }
          return lhs.sessionID.localizedStandardCompare(rhs.sessionID) == .orderedAscending
        }
        schedulePoll()
      case "agents_result": agents = Array(Set(message.strings("names"))).sorted()
      case "error":
        let detail = message.string("message") ?? "Host rejected the request"
        scheduleReconnect(for: detail)
        if fatal { client.disconnect() }
      case "tool_request": rejectToolRequest(message)
      default: break
      }
    }
  }

  nonisolated func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
