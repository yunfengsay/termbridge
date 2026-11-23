import Combine
import Foundation

struct LANEndpointConfiguration: Codable, Equatable {
    var address: String
    var port: Int
    var password: String
    var enabled = false
}

enum LANSharingRoute: String, Codable, CaseIterable {
    case local, remote
    var title: String { self == .local ? "本机中转" : "另一台中转机" }
}

struct LANSharingConfiguration: Codable, Equatable {
    var route: LANSharingRoute
    var endpoint: LANEndpointConfiguration
}

/// The app-owned capabilities have independent lifetimes. Host state stays in the
/// original LAN scope; the relay owns only its new child scope. External CLI
/// processes are never stopped or adopted.
struct LANServicesConfiguration: Codable, Equatable {
    var version = 1
    var relay: LANEndpointConfiguration?
    var sharing: LANSharingConfiguration?

    static func migrate(_ old: LANServiceConfiguration) -> Self {
        let endpoint = LANEndpointConfiguration(address: old.address, port: old.port,
                                                password: old.password ?? "", enabled: true)
        switch old.mode ?? .direct {
        case .direct: return Self(relay: endpoint, sharing: .init(route: .local, endpoint: endpoint))
        case .relay: return Self(relay: endpoint, sharing: old.shareLocalHost == false ? nil : .init(route: .local, endpoint: endpoint))
        case .join: return Self(sharing: .init(route: .remote, endpoint: endpoint))
        }
    }
}

@MainActor final class MacLANServices: ObservableObject {
    static let shared = MacLANServices()
    let relay: MacLANService
    let sharing: MacLANService
    @Published private(set) var configuration = LANServicesConfiguration()
    @Published private(set) var message: String?
    private let file: URL
    private var observations = Set<AnyCancellable>()
    private var pendingRelay: LANEndpointConfiguration?
    private var pendingSharing: LANSharingConfiguration?
    private var resumeLocalSharing = false
    private var configurationReadable = true

    init(runtimeURL: URL? = Bundle.main.resourceURL?.appendingPathComponent("Runtime"), storageDirectory: URL? = nil) {
        let storageDirectory = storageDirectory ?? MacLANService.directory
        relay = MacLANService(runtimeURL: runtimeURL, storageDirectory: storageDirectory.appendingPathComponent("relay"))
        sharing = MacLANService(runtimeURL: runtimeURL, storageDirectory: storageDirectory)
        file = storageDirectory.appendingPathComponent("services.json")
        if FileManager.default.fileExists(atPath: file.path) {
            do {
                configuration = try JSONDecoder().decode(LANServicesConfiguration.self, from: Data(contentsOf: file))
                guard configuration.version == 1 else { throw CocoaError(.fileReadUnknown) }
            } catch {
                configurationReadable = false
                message = "无法读取内网服务配置，已保留原文件并停止自动启动。"
            }
        } else if let legacy = sharing.savedConfiguration() {
            configuration = .migrate(legacy)
        }
        for service in [relay, sharing] {
            service.objectWillChange.sink { [weak self] in self?.objectWillChange.send() }.store(in: &observations)
        }
        relay.onReady = { [weak self] profile in self?.relayReady(profile) }
        sharing.onReady = { [weak self] profile in self?.sharingReady(profile) }
    }

    var sharingUsesLocalRelay: Bool {
        guard sharing.phase != .stopped else { return false }
        if (pendingSharing ?? configuration.sharing)?.route == .local { return true }
        let hostEndpoint = (pendingSharing ?? configuration.sharing)?.endpoint
        if let local = configuration.relay, let hostEndpoint, local.port == hostEndpoint.port {
            if local.address == hostEndpoint.address { return true }
            if let a = relay.topology?.relayId, a == sharing.topology?.relayId { return true }
        }
        return relay.profile?.relayURL == sharing.profile?.relayURL && relay.profile != nil
    }

    func startRelay(_ endpoint: LANEndpointConfiguration) {
        guard configurationReadable, relay.phase == .stopped else { return }
        message = nil; pendingRelay = endpoint
        relay.start(address: endpoint.address, port: endpoint.port, password: endpoint.password.isEmpty ? nil : endpoint.password,
                    mode: .relay, shareLocalHost: false)
    }

    func startSharing(route: LANSharingRoute, endpoint: LANEndpointConfiguration) {
        guard configurationReadable, sharing.phase == .stopped else { return }
        message = nil
        var selected = endpoint
        if route == .local {
            guard relay.phase == .ready, let local = configuration.relay else {
                message = "请先开启本机中转服务，再通过它共享本机。"; return
            }
            selected = local
        }
        pendingSharing = .init(route: route, endpoint: selected)
        sharing.start(address: selected.address, port: selected.port, password: selected.password.isEmpty ? nil : selected.password, mode: .join)
    }

    func stopSharing() {
        if configurationReadable { message = nil }
        resumeLocalSharing = false; pendingSharing = nil
        sharing.stop()
        configuration.sharing?.endpoint.enabled = false
        save()
    }

    func stopRelay() {
        guard !sharingUsesLocalRelay else {
            message = "本机共享正在使用此中转。请先停止共享，或改用另一台中转机。"; return
        }
        if configurationReadable { message = nil }
        resumeLocalSharing = false; pendingRelay = nil
        relay.stop()
        configuration.relay?.enabled = false
        save()
    }

    func resume() {
        guard UserDefaults.standard.bool(forKey: "lan.startWithApp") else { return }
        resumeSavedServices()
    }

    func resumeSavedServices() {
        guard configurationReadable, relay.phase == .stopped, sharing.phase == .stopped else { return }
        let saved = configuration
        resumeLocalSharing = saved.sharing?.endpoint.enabled == true && saved.sharing?.route == .local
        if let endpoint = saved.relay, endpoint.enabled { startRelay(endpoint) }
        if let host = saved.sharing, host.endpoint.enabled, host.route == .remote {
            startSharing(route: host.route, endpoint: host.endpoint)
        } else if resumeLocalSharing && saved.relay?.enabled != true {
            resumeLocalSharing = false; message = "本机共享依赖的中转未开启，尚未自动恢复共享。"
        }
    }

    /// Application exit preserves the user's enabled capabilities for next launch.
    func stop() {
        resumeLocalSharing = false; pendingRelay = nil; pendingSharing = nil
        sharing.stop(); relay.stop()
    }

    private func relayReady(_ profile: ConnectionSettings) {
        guard var endpoint = pendingRelay else { return }
        endpoint.password = profile.secret; endpoint.enabled = true
        configuration.relay = endpoint; pendingRelay = nil; save()
        if resumeLocalSharing {
            resumeLocalSharing = false
            startSharing(route: .local, endpoint: endpoint)
        }
    }

    private func sharingReady(_ profile: ConnectionSettings) {
        guard var host = pendingSharing else { return }
        host.endpoint.password = profile.secret; host.endpoint.enabled = true
        configuration.sharing = host; pendingSharing = nil; save()
    }

    private func save() {
        guard configurationReadable else { return }
        do {
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true,
                                                  attributes: [.posixPermissions: 0o700])
            let data = try JSONEncoder().encode(configuration)
            // Connection secrets stay in the app-owned private scope.
            try data.write(to: file, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        } catch { message = "服务状态已改变，但保存配置失败；下次启动可能无法恢复。" }
    }
}
