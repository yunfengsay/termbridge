import AppKit
import Combine
import Foundation
import UserNotifications

@MainActor
final class ControlCenterModel: ObservableObject, @preconcurrency TermbridgeClientListener {
    enum LoadState: Equatable {
        case loading
        case ready
        case error(String)
    }

    @Published private(set) var agents: [AgentRecord] = []
    @Published private(set) var generatedAt: Date?
    @Published private(set) var state: LoadState = .loading
    @Published private(set) var phoneHubStatus = "Checking Phone / Watch Hub"
    @Published private(set) var phoneHubOnline = false
    @Published private(set) var topology: RelayTopology?

    @Published private(set) var profiles: [ConnectionSettings] = []
    @Published private(set) var activeProfileID: UUID?
    @Published private(set) var settingsError: String?
    @Published private(set) var sessionCreator: MacSessionCreation?
    @Published private(set) var sessionCreationError: String?
    @Published private(set) var loadingConnections = false
    private var connectionLoad: Task<Void, Never>?
    private let connectionStore: MacConnectionStore
    private let cliSettingsURL: URL?
    private var remote: TermbridgeClient?
    private var retryAt = Date.distantPast
    private var remoteReady = false
    var activeProfile: ConnectionSettings? { profiles.first { $0.id == activeProfileID } }
    var sourceName: String { activeProfile?.displayName ?? "本机" }

    private let servicesEnabled: Bool
    private var timer: Timer?
    let notifications: MacNotificationCoordinator
    let peer: MacPeerService
    @Published var notificationError: String?
    private var monitors: [UUID: MacHostMonitor] = [:]
    private var transitions = MacNotificationTransitions()
    private var lastPhoneProbeAt = Date.distantPast
    private let contextURL: URL
    private let loadLocalAgents: (@Sendable () throws -> [AgentRecord])?
    private var localRefresh: Task<Void, Never>?
    private var liveLocalAgents: [AgentRecord] = []
    private var terminals: [String: TerminalWindowController] = [:]
    /// The single window of the navigator mode, created on first use.
    private var navigator: SessionNavigatorController?
    private var desktops: [UUID: MacRemoteDesktopWindow] = [:]
    private var openingSessions: Set<String> = []
    private var terminationObserver: AnyCancellable?

    init(contextURL: URL = ProcessInfo.processInfo.environment["TB_CONTEXT_STATE"].map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/context.json"),
         profiles initialProfiles: [ConnectionSettings]? = nil, startServices: Bool = true,
         connectionStore: MacConnectionStore = MacConnectionStore(), cliSettingsURL: URL? = nil, notifications: MacNotificationCoordinator? = nil,
         loadConnections: (@Sendable () throws -> [ConnectionSettings])? = nil,
         loadLocalAgents: (@Sendable () throws -> [AgentRecord])? = nil) {
        self.notifications = notifications ?? .shared
        self.peer = MacPeerService(file: startServices ? MacPeerService.defaultFile : nil)
        self.contextURL = contextURL
        if let loadLocalAgents { self.loadLocalAgents = loadLocalAgents }
        else if startServices { self.loadLocalAgents = { @Sendable in try HerdrTerminalIdentity.currentAgents() } }
        else { self.loadLocalAgents = nil }
        self.servicesEnabled = startServices
        self.connectionStore = connectionStore
        self.cliSettingsURL = cliSettingsURL
        terminationObserver = NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)
            .sink { [weak self] _ in self?.disconnectTerminals() }
        if let initialProfiles { profiles = initialProfiles }
        else {
            loadingConnections = true
            let fallback = cliConnection()
            // Keychain may wait for an unlock/consent dialog. It must never hold
            // the UI thread or prevent this App's independent LAN server starting.
            let load = Task.detached(priority: .userInitiated) {
                var saved = try loadConnections?() ?? connectionStore.load()
                try Task.checkCancellation()
                if saved.isEmpty, let fallback {
                    try connectionStore.save([fallback]); saved = [fallback]
                }
                return saved
            }
            connectionLoad = Task { [weak self] in
                let result = await withTaskCancellationHandler(operation: { await load.result }, onCancel: { load.cancel() })
                guard !Task.isCancelled, let self else { return }
                self.loadingConnections = false
                switch result {
                case .success(let saved):
                    self.profiles = saved
                    if let value = UserDefaults.standard.string(forKey: "activeMacConnection"), let id = UUID(uuidString: value),
                       saved.contains(where: { $0.id == id }) { self.activeProfileID = id }
                case .failure(let error): self.settingsError = error.localizedDescription
                }
                self.refresh()
            }
        }
        self.notifications.bind(open: { [weak self] in self?.openNotification($0) },
                                error: { [weak self] in self?.showNotificationError($0) })
        refresh()
        guard startServices else { return }
        MacLANAutomation.shared.model = self
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
        self.notifications.refreshPermission(requestIfNeeded: notificationsEnabled)
    }

    deinit { timer?.invalidate(); connectionLoad?.cancel(); localRefresh?.cancel() }

    var attentionCount: Int { agents.count(where: \.needsAttention) }
    var workingCount: Int { agents.count(where: \.isWorking) }
    var menuTitle: String { attentionCount > 0 ? "TB \(attentionCount)" : "TB" }

    func refresh() {
        if servicesEnabled { peer.refresh(profiles: profiles) }
        refreshNotificationMonitoring()
        if let loadLocalAgents { refreshLocalAgents(using: loadLocalAgents) }
        if let profile = activeProfile {
            if let remote, remoteReady { remote.sendControl(["t": .string("session_list")]) }
            else if remote == nil && Date() >= retryAt { connect(profile) }
            return
        }
        if loadLocalAgents == nil { do {
            let data = try Data(contentsOf: contextURL)
            let snapshot = try JSONDecoder().decode(AgentContextSnapshot.self, from: data)
            let nextAgents = AgentRecord.prioritized(snapshot.records)
            agents = nextAgents
            generatedAt = Date(timeIntervalSince1970: snapshot.generatedAt / 1_000)
            state = .ready
        } catch {
            agents = []
            generatedAt = nil
            state = .error("Host context is unavailable")
        } }
        if servicesEnabled && Date().timeIntervalSince(lastPhoneProbeAt) >= 15 {
            lastPhoneProbeAt = Date()
            probePhoneHub()
        }
    }

    private func refreshLocalAgents(using loader: @escaping @Sendable () throws -> [AgentRecord]) {
        guard localRefresh == nil else { return }
        let contextURL = contextURL
        localRefresh = Task { [weak self] in
            guard !Task.isCancelled else { return }
            let result = await Task.detached(priority: .utility) { Result { try loader() } }.value
            guard !Task.isCancelled, let self else { return }
            self.localRefresh = nil
            // Only recent Host-owned PTYs may supplement the live Herdr list.
            // Cached Herdr rows can never make a missing pane selectable.
            let snapshot = (try? Data(contentsOf: contextURL)).flatMap { try? JSONDecoder().decode(AgentContextSnapshot.self, from: $0) }
            let age = snapshot.map { Date().timeIntervalSince1970 - $0.generatedAt / 1000 } ?? .infinity
            let ptys = age >= -5 && age <= 30 ? snapshot?.records.filter { $0.source != "herdr" && $0.present } ?? [] : []
            switch result {
            case .success(let live):
                self.liveLocalAgents = AgentRecord.prioritized(live + ptys)
                if self.activeProfileID == nil {
                    self.agents = self.liveLocalAgents
                    self.generatedAt = Date(); self.state = .ready
                }
                if self.servicesEnabled && self.notificationsEnabled { self.publishTransitions(self.liveLocalAgents, profile: nil) }
            case .failure(let error):
                self.liveLocalAgents = AgentRecord.prioritized(ptys)
                if self.activeProfileID == nil {
                    self.agents = self.liveLocalAgents
                    self.generatedAt = nil; self.state = .error(error.localizedDescription)
                }
            }
        }
    }

    func open(_ agent: AgentRecord) {
        open(agent, profile: activeProfile)
    }

    func openDesktop() {
        do {
            var destination: ConnectionSettings
            if let activeProfile { destination = activeProfile }
            else {
                destination = try MacConnectionStore.loadCLIProfile(from: resolvedCLISettingsURL,
                    environment: ProcessInfo.processInfo.environment)
                destination.hostID = try TerminalLaunch.localHostId()
            }
            if let existing = desktops[destination.id], existing.session.profile == destination {
                existing.present(); return
            }
            desktops[destination.id]?.close()
            let controller = MacRemoteDesktopWindow(profile: destination)
            let id = destination.id
            controller.onClose = { [weak self, weak controller] in
                if self?.desktops[id] === controller { self?.desktops.removeValue(forKey: id) }
            }
            desktops[id] = controller
            controller.present()
        } catch { showNotificationError("无法读取本机 Host 的连接信息，请先选择已配置的 Host，或在设置中开启本机服务。") }
    }

    func prepareNewSession() {
        guard sessionCreator?.phase != .creating else { return }
        sessionCreator?.cancel(); sessionCreator = nil; sessionCreationError = nil
        do {
            let destination: ConnectionSettings
            if let activeProfile { destination = activeProfile }
            else {
                var local = try MacConnectionStore.loadCLIProfile(from: resolvedCLISettingsURL,
                    environment: ProcessInfo.processInfo.environment)
                local.hostID = try TerminalLaunch.localHostId()
                guard !local.hostID.isEmpty else { throw TerminalLaunch.LaunchError.invalidIdentity }
                destination = local
            }
            let creator = MacSessionCreation(profile: destination, sourceName: sourceName)
            // Capture the destination now; changing tabs cannot redirect the result.
            creator.onCreated = { [weak self, weak creator] record in
                guard let self, let session = creator?.takeCreatedSession() else { return }
                if self.activeProfile?.id == destination.id {
                    self.agents = AgentRecord.prioritized(self.agents.filter { $0.id != record.id } + [record])
                }
                let key = MacConnectionCatalog.terminalKey(profileID: destination.id, sessionID: record.sessionId)
                if SessionWindowMode.load() == .navigator {
                    let navigator = self.sessionNavigator()
                    navigator.expect(key: key, profileID: destination.id, agent: record)
                    navigator.insert(session)
                } else { self.present(TerminalWindowController(session: session), key: key) }
                self.refresh()
            }
            sessionCreator = creator
        } catch {
            sessionCreationError = "无法读取本机 Host 的连接信息。请在设置中配置 CLI 与 Host，或选择已连接的 Host 标签后新建。"
        }
    }

    func openNotification(_ route: MacNotificationRoute) {
        do {
            let profile = try route.resolve(in: profiles)
            var target = route.agent
            if profile == nil {
                let records = try loadLocalAgents == nil
                    ? JSONDecoder().decode(AgentContextSnapshot.self, from: Data(contentsOf: contextURL)).records
                    : liveLocalAgents
                guard let record = records.first(where: route.matches) else {
                    throw MacNotificationRoute.Failure("此通知的会话已结束或已更换，请从会话列表打开。")
                }
                target = record
            }
            selectProfile(profile?.id)
            open(target, profile: profile, route: route)
        } catch {
            showNotificationError(error is MacNotificationRoute.Failure ? error.localizedDescription : "无法读取此通知的本机会话，请检查 Host 是否在线。")
        }
    }

    private func showNotificationError(_ message: String) {
        notificationError = message
        guard servicesEnabled else { return }
        // Notifications can be clicked while every app window is closed.
        Task { @MainActor in
            NSApp.activate(ignoringOtherApps: true)
            let alert = NSAlert()
            alert.messageText = "无法打开通知中的会话"
            alert.informativeText = message
            alert.runModal()
        }
    }

    private func open(_ agent: AgentRecord, profile: ConnectionSettings?, route: MacNotificationRoute? = nil) {
        let key = MacConnectionCatalog.terminalKey(profileID: profile?.id, sessionID: agent.sessionId)
        let navigatorMode = SessionWindowMode.load() == .navigator
        if navigatorMode {
            let navigator = sessionNavigator()
            if navigator.reveal(key: key, connection: profile, route: route) { return }
            navigator.expect(key: key, profileID: profile?.id, agent: agent)
        } else {
            if let existing = terminals[key], !existing.usesConnection(profile) {
                existing.close(); terminals.removeValue(forKey: key)
            }
            if let existing = terminals[key] {
                existing.openFromNotification(route)
                existing.present()
                return
            }
        }
        guard openingSessions.insert(key).inserted else { return }
        Task {
            defer { openingSessions.remove(key) }
            do {
                let session = try await makeSession(agent, profile: profile, route: route)
                // The mode may have changed while the session was prepared.
                if SessionWindowMode.load() == .navigator {
                    let navigator = sessionNavigator()
                    if !navigatorMode { navigator.expect(key: key, profileID: profile?.id, agent: agent) }
                    navigator.insert(session)
                } else { present(TerminalWindowController(session: session), key: key) }
            } catch {
                if SessionWindowMode.load() == .navigator, let navigator {
                    navigator.fail(key: key, message: error.localizedDescription)
                    return
                }
                let alert = NSAlert()
                alert.messageText = "Unable to open terminal"
                alert.informativeText = error.localizedDescription
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }

    private func makeSession(_ agent: AgentRecord, profile: ConnectionSettings?,
                             route: MacNotificationRoute?) async throws -> TerminalSessionController {
        let launch: TerminalLaunch? = profile == nil ? try await Task.detached {
            if agent.source == "herdr" {
                let paneId = try HerdrTerminalIdentity.paneId(sessionId: agent.sessionId, recordedPaneId: agent.paneId)
                return try HerdrTerminalIdentity.launch(paneId: paneId)
            }
            let detection = CLIInstallation(home: FileManager.default.homeDirectoryForCurrentUser).inspect()
            guard let cli = detection.cli else { throw CLIInstallationError(message: detection.summary) }
            return try TerminalLaunch(sessionId: agent.sessionId, hostId: TerminalLaunch.localHostId(), cli: cli)
        }.value : nil
        var chatProfile = profile ?? cliConnection()
        if profile == nil { chatProfile?.hostID = (try? TerminalLaunch.localHostId()) ?? "" }
        // A local list must never discover an arbitrary remote Host for chat.
        if profile == nil && chatProfile?.hostID.isEmpty != false { chatProfile = nil }
        return TerminalSessionController(agent: agent, launch: launch, connection: profile, notificationRoute: route,
            chatConnection: chatProfile, preference: SessionUIPreference.load())
    }

    private func present(_ controller: TerminalWindowController, key: String) {
        controller.onClose = { [weak self, weak controller] in
            // A window replaced under the same key must not remove its successor.
            if self?.terminals[key] === controller { self?.terminals.removeValue(forKey: key) }
        }
        terminals[key] = controller
        controller.present()
    }

    private func sessionNavigator() -> SessionNavigatorController {
        if let navigator { return navigator }
        let created = SessionNavigatorController(model: self)
        navigator = created
        return created
    }

    /// The navigator window, for the list's window button in navigator mode.
    func showSessionNavigator() { sessionNavigator().present() }

    /// Applies the session window mode now. Open sessions move between their own
    /// windows and the navigator with their connection, draft and screen; no
    /// Agent restarts and nothing reconnects.
    func applySessionWindowMode() {
        switch SessionWindowMode.load() {
        case .navigator:
            // Back to front, so the window the user was looking at stays on screen.
            let order = NSApp.orderedWindows
            func depth(_ controller: TerminalWindowController) -> Int {
                controller.window.flatMap { order.firstIndex(of: $0) } ?? .max
            }
            let windows = terminals.values.sorted { depth($0) > depth($1) }
            guard !windows.isEmpty else { return }
            let navigator = sessionNavigator()
            navigator.adopt(windows.map { $0.releaseSession() })
            navigator.present()
        case .standalone:
            // Only the session on screen becomes a window; the others were out of
            // sight and only detach, as closing the navigator does.
            guard let session = navigator?.releaseVisible() else { return }
            present(TerminalWindowController(session: session),
                    key: MacConnectionCatalog.terminalKey(profileID: session.connection?.id, sessionID: session.agent.sessionId))
        }
    }

    func selectProfile(_ id: UUID?) {
        guard !loadingConnections else { return }
        guard id == nil || profiles.contains(where: { $0.id == id }) else { return }
        localRefresh?.cancel(); localRefresh = nil
        remote?.disconnect(); remote = nil; remoteReady = false
        topology = nil
        activeProfileID = id
        if servicesEnabled { UserDefaults.standard.set(id?.uuidString ?? "local", forKey: "activeMacConnection") }
        agents = []; generatedAt = nil; state = .loading
        phoneHubOnline = false; phoneHubStatus = id == nil ? "Checking Phone / Watch Hub" : "正在连接"
        retryAt = .distantPast; lastPhoneProbeAt = .distantPast
        refresh()
    }

    @discardableResult func saveProfile(_ profile: ConnectionSettings, connect: Bool = true) throws -> ConnectionSettings {
        try requireLoadedConnections()
        if let error = profile.validationError { throw NSError(domain: "Connection", code: 1, userInfo: [NSLocalizedDescriptionKey: error]) }
        let next = ConnectionProfileState(profiles: profiles, activeID: activeProfileID).upserting(profile)
        do { try connectionStore.save(next.profiles) }
        catch { AppDiagnostics.shared.record("configuration.save_failed", AppDiagnostics.error(error)); throw error }
        profiles = next.profiles; settingsError = nil
        AppDiagnostics.shared.record("configuration.saved", AppDiagnostics.connection(profile))
        if connect { selectProfile(next.activeID) }
        return next.active ?? profile
    }

    func connectTopologyHost(_ hostID: String, using base: ConnectionSettings, topology: RelayTopology?) throws {
        var candidate = base
        candidate.profileID = UUID(); candidate.hostID = hostID
        if let node = topology?.nodes.first(where: { $0.role == .host && $0.hostId == hostID }) { candidate.hostName = node.name }
        try saveProfile(candidate)
    }

    func removeProfile(_ id: UUID) throws {
        try requireLoadedConnections()
        let next = profiles.filter { $0.id != id }
        try connectionStore.save(next)
        profiles = next
        // Disconnect only this app's windows for the removed connection.
        for key in Array(terminals.keys) where key.hasPrefix(id.uuidString + ":") {
            terminals[key]?.close(); terminals.removeValue(forKey: key)
        }
        navigator?.closeSessions(profileID: id)
        if activeProfileID == id { selectProfile(nil) }
        if servicesEnabled { peer.refresh(profiles: profiles) }
        refreshNotificationMonitoring()
        settingsError = nil
    }

    private func requireLoadedConnections() throws {
        if loadingConnections { throw NSError(domain: "Connection", code: 2, userInfo: [NSLocalizedDescriptionKey: "正在等待读取钥匙串中的连接，请解锁 Mac 并处理钥匙串提示。内网服务可独立运行。"]) }
    }

    private func cliConnection() -> ConnectionSettings? {
        try? MacConnectionStore.loadCLIProfile(from: resolvedCLISettingsURL, environment: ProcessInfo.processInfo.environment)
    }

    private var resolvedCLISettingsURL: URL {
        let environment = ProcessInfo.processInfo.environment
        return cliSettingsURL ?? environment["TB_SETTINGS"].flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/settings.json")
    }

    @discardableResult
    func importCLIConnection(from file: URL? = nil) throws -> ConnectionSettings {
        // Explicit file selection must not mix that file's credentials with ambient overrides.
        let candidate = try MacConnectionStore.loadCLIProfile(from: file ?? resolvedCLISettingsURL,
            environment: file == nil ? ProcessInfo.processInfo.environment : [:])
        try saveProfile(candidate)
        return activeProfile ?? candidate
    }

    func createLocalCLIPairing() throws -> String {
        let code: String
        if let relay = ProcessInfo.processInfo.environment["TB_CLOUDFLARE_RELAY"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !relay.isEmpty {
            code = try CLIPairing.createCode(hostedRelay: relay)
        } else if let active = activeProfile, active.relayURL.lowercased().hasPrefix("wss://") {
            code = try CLIPairing.createURI(
                relayURL: active.relayURL,
                hostName: Host.current().localizedName ?? "My Mac",
                tlsPin: active.tlsFingerprint
            )
        } else {
            throw PairingCodeError.hostedRelayNotConfigured
        }
        var profile = try PairingCode.parse(code)
        profile.hostName = Host.current().localizedName ?? "My Mac"
        try saveProfile(profile)
        try MacConnectionStore.saveCLIProfile(profile, to: resolvedCLISettingsURL)
        return code
    }

    func exportCLIConnection() throws {
        guard let activeProfile else { return }
        try MacConnectionStore.saveCLIProfile(activeProfile, to: resolvedCLISettingsURL)
    }

    private func connect(_ settings: ConnectionSettings) {
        topology = nil
        state = .loading; remoteReady = false; phoneHubStatus = "正在连接"
        guard servicesEnabled else { return }
        let client = TermbridgeClient(settings: settings, listener: self)
        remote = client; client.connect()
    }

    func clientIsReady(_ client: TermbridgeClient) {
        guard client === remote else { return }
        remoteReady = true
        client.sendControl(["t": .string("session_list")])
    }

    func client(_ client: TermbridgeClient, changedState value: ConnectionState) {
        guard client === remote else { return }
        switch value {
        case .failed, .disconnected:
            topology = nil
            let reason: String
            if let error = client.transportError { reason = ConnectionFailure.description(error) }
            else if case .failed(let detail) = value { reason = ConnectionFailure.description(detail) }
            else { reason = ConnectionFailure.description("") }
            state = .error(reason + " 将自动重试。")
            agents = []; generatedAt = nil; phoneHubOnline = false; phoneHubStatus = reason
            client.disconnect(); remote = nil; remoteReady = false; retryAt = Date().addingTimeInterval(6)
        default: break
        }
    }

    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard client === remote else { return }
        switch message.type {
        case "relay_topology":
            topology = RelayTopology.decode(message: message)
        case "host_list_result":
            guard let base = activeProfile else { return }
            let selected = message.string("selectedHostId") ?? base.hostID
            // Key discovery by endpoint + Host ID, never by the display name.
            let next = MacConnectionCatalog.merging(
                ConnectionProfileState(profiles: profiles, activeID: activeProfileID),
                base: base, hosts: message.hosts(), selectedHostID: selected)
            if next.profiles != profiles {
                do { try connectionStore.save(next.profiles); profiles = next.profiles; activeProfileID = next.activeID
                    UserDefaults.standard.set(next.activeID?.uuidString, forKey: "activeMacConnection")
                } catch { settingsError = error.localizedDescription }
            }
        case "session_list_result":
            agents = AgentRecord.remoteRecords(message.sessions())
            generatedAt = Date(); state = .ready; phoneHubOnline = true; phoneHubStatus = "已连接 · \(sourceName)"
        case "error":
            topology = nil
            let reason = ConnectionFailure.description(message.string("message") ?? "")
            state = .error(reason)
            agents = []; generatedAt = nil; phoneHubOnline = false; phoneHubStatus = reason
            remoteReady = false; client.disconnect(); remote = nil; retryAt = Date().addingTimeInterval(10)
        default: break
        }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}

    func disconnectTerminals() {
        localRefresh?.cancel(); localRefresh = nil
        connectionLoad?.cancel()
        timer?.invalidate()
        peer.disconnect()
        monitors.values.forEach { $0.disconnect() }; monitors.removeAll()
        remote?.disconnect()
        terminals.values.forEach { $0.disconnect() }
        navigator?.disconnectAll()
        desktops.values.forEach { $0.session.close() }
    }

    func copySessionId(_ agent: AgentRecord) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(agent.sessionId, forType: .string)
    }

    private var notificationsEnabled: Bool {
        UserDefaults.standard.object(forKey: "agentNotificationsEnabled") as? Bool != false
    }

    func refreshNotificationPreferences() {
        guard servicesEnabled else { return }
        self.notifications.refreshPermission(requestIfNeeded: notificationsEnabled)
        refreshNotificationMonitoring()
    }

    private func refreshNotificationMonitoring() {
        guard servicesEnabled else { return }
        for (id, monitor) in Array(monitors) {
            if !notificationsEnabled || !profiles.contains(monitor.profile) {
                monitor.disconnect(); monitors.removeValue(forKey: id)
                transitions.remove(scope: id.uuidString)
            }
        }
        guard notificationsEnabled else { transitions.remove(scope: "local"); return }
        if loadLocalAgents == nil, let data = try? Data(contentsOf: contextURL),
           let snapshot = try? JSONDecoder().decode(AgentContextSnapshot.self, from: data) {
            publishTransitions(AgentRecord.prioritized(snapshot.records), profile: nil)
        }
        for profile in profiles where monitors[profile.id] == nil {
            let monitor = MacHostMonitor(profile: profile)
            monitor.onSnapshot = { [weak self] records in
                guard let self, self.profiles.contains(profile) else { return }
                self.publishTransitions(records, profile: profile)
            }
            monitor.onHosts = { [weak self] hosts, selected in
                guard let self, self.profiles.contains(profile) else { return }
                let next = MacConnectionCatalog.merging(
                    ConnectionProfileState(profiles: self.profiles, activeID: self.activeProfileID),
                    base: profile, hosts: hosts, selectedHostID: selected)
                guard next.profiles != self.profiles else { return }
                do {
                    try self.connectionStore.save(next.profiles)
                    // Background discovery must never select another tab.
                    self.profiles = next.profiles
                } catch { self.settingsError = error.localizedDescription }
            }
            monitors[profile.id] = monitor
        }
        for monitor in Array(monitors.values) { monitor.refresh() }
    }

    private func publishTransitions(_ next: [AgentRecord], profile: ConnectionSettings?) {
        for agent in transitions.changes(next, scope: profile?.id.uuidString ?? "local") {
            notifications.deliver(MacNotificationCoordinator.request(agent: agent, profile: profile))
        }
    }

    private func probePhoneHub() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let result = Self.runAndCapture("/bin/zsh", ["-lc", "tb peer info"], timeout: 4)
            let status = Self.describePhoneHub(exitCode: result.exitCode, output: result.output)
            DispatchQueue.main.async {
                guard self?.activeProfileID == nil else { return }
                self?.phoneHubOnline = result.exitCode == 0
                self?.phoneHubStatus = status
            }
        }
    }

    nonisolated static func describePhoneHub(exitCode: Int32, output: String) -> String {
        if exitCode == 0 { return "Phone / Watch Hub online" }
        let normalized = output.lowercased()
        if normalized.contains("no client attached") || normalized.contains("no app device") {
            return "Phone / Watch Hub offline"
        }
        return "Host bridge unavailable"
    }

    nonisolated private static func runAndCapture(
        _ executable: String,
        _ arguments: [String],
        timeout: TimeInterval
    ) -> (exitCode: Int32, output: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch { return (-1, "") }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return (process.terminationStatus, output)
    }
}

private extension Sequence {
    func count(where predicate: (Element) throws -> Bool) rethrows -> Int {
        try reduce(into: 0) { count, element in
            if try predicate(element) { count += 1 }
        }
    }
}
