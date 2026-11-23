import Foundation

/// Keeps its own authenticated connection when the user changes the visible tab.
@MainActor
final class MacHostMonitor: @preconcurrency TermbridgeClientListener {
    let profile: ConnectionSettings
    var onSnapshot: (([AgentRecord]) -> Void)?
    var onHosts: (([HostInfo], String) -> Void)?
    private var client: TermbridgeClient?
    private var ready = false
    private var retryAt = Date.distantPast
    private var responseDeadline = Date.distantPast
    private var awaitingSnapshot = false

    init(profile: ConnectionSettings) { self.profile = profile }
    func refresh(now: Date = Date()) {
        if awaitingSnapshot && now > responseDeadline { failed(now: now) }
        if let client, ready {
            if !awaitingSnapshot { requestSnapshot(client, now: now) }
        } else if client == nil && now >= retryAt {
            let connection = TermbridgeClient(settings: profile, listener: self)
            client = connection; awaitingSnapshot = true; responseDeadline = now.addingTimeInterval(15)
            connection.connect()
        }
    }
    func disconnect() {
        client?.disconnect(); client = nil; ready = false; awaitingSnapshot = false
    }
    private func failed(now: Date = Date()) { disconnect(); retryAt = now.addingTimeInterval(6) }
    private func requestSnapshot(_ client: TermbridgeClient, now: Date = Date()) {
        awaitingSnapshot = true; responseDeadline = now.addingTimeInterval(15)
        if !client.sendControl(["t": .string("session_list")]) { failed(now: now) }
    }
    func clientIsReady(_ client: TermbridgeClient) {
        guard client === self.client else { return }
        ready = true; requestSnapshot(client)
    }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard client === self.client else { return }
        if case .failed = state { failed() }
        if state == .disconnected { failed() }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard client === self.client else { return }
        switch message.type {
        case "session_list_result":
            awaitingSnapshot = false
            onSnapshot?(AgentRecord.remoteRecords(message.sessions()))
        case "host_list_result": onHosts?(message.hosts(), message.string("selectedHostId") ?? profile.hostID)
        case "error": failed()
        default: break
        }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
