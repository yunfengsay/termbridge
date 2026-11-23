import Foundation

/// The UI and CLI call the same lifecycle owner. No CLI writes App private files.
@MainActor final class MacLANAutomation {
    static let shared = MacLANAutomation(service: .shared)
    let service: MacLANServices
    weak var model: ControlCenterModel?
    private var busy = false
    init(service: MacLANServices) { self.service = service }

    func peer(_ args: [String: MessagePackValue], permission: MacPeerPermission,
              cancellation: MacPeerCancellation) async -> [String: MessagePackValue] {
        guard permission.enabled && permission.execute else {
            return ["ok": .bool(false), "error": .string("请先在目标 Mac 的 Peer 设置中授权此 Host 执行命令。")]
        }
        guard !cancellation.isCancelled else { return MacPeerExecutor.cancelled() }
        guard let action = args["action"]?.stringValue, ["status", "relay.ensure", "sharing.join"].contains(action) else {
            return ["ok": .bool(false), "error": .string("Unsupported LAN configuration action")]
        }
        var request: [String: Any] = ["action": action]
        for key in ["address", "password"] { if let value = args[key]?.stringValue { request[key] = value } }
        if let port = args["port"]?.intValue { request["port"] = port }
        let operation = Task { try await self.handle(request) }
        cancellation.onCancel { operation.cancel() }
        defer { cancellation.onCancel(nil) }
        do {
            let data = try await operation.value
            guard !cancellation.isCancelled else { return MacPeerExecutor.cancelled() }
            let wire = data.mapValues { value -> MessagePackValue in
                if let text = value as? String { return .string(text) }
                if let number = value as? Int { return .int(Int64(number)) }
                if let addresses = value as? [[String: String]] { return .array(addresses.map { .map($0.mapValues(MessagePackValue.string)) }) }
                return .null
            }
            return ["ok": .bool(true), "data": .map(wire)]
        } catch { return ["ok": .bool(false), "error": .string(error.localizedDescription)] }
    }

    func handle(_ request: [String: Any]) async throws -> [String: Any] {
        guard let action = request["action"] as? String else { throw MacPeerFailure("Missing action") }
        if action == "bridge" {
            guard service.sharing.phase == .ready, let socket = service.sharing.bridgeSocket else { throw MacPeerFailure("App 尚未共享本机会话。") }
            return ["socket": socket, "hostId": service.sharing.localHostID ?? ""]
        }
        if action == "status" {
            return ["relay": service.relay.phase.rawValue, "sharing": service.sharing.phase.rawValue,
                    "addresses": LANAddress.available().filter { !$0.address.hasPrefix("127.") }.map { ["address": $0.address, "interface": $0.interface] }]
        }
        if action == "update.check" {
            MacAppUpdater.shared.start()
            guard MacAppUpdater.shared.canCheck else { throw MacPeerFailure("App 更新当前不可用，请稍后重试。") }
            MacAppUpdater.shared.check()
            return ["status": "requested", "message": "已在 App 中检查更新；安装与重启由 App 更新器完成。"]
        }
        guard !busy else { throw MacPeerFailure("正在配置内网服务，请等待当前操作完成。") }
        busy = true; defer { busy = false }
        try Task.checkCancellation()
        switch action {
        case "relay.ensure":
            if service.relay.phase == .ready {
                guard let current = service.configuration.relay,
                      (request["address"] as? String).map({ $0 == current.address }) ?? true,
                      (request["port"] as? Int).map({ $0 == current.port }) ?? true else {
                    throw MacPeerFailure("已有中转使用不同地址或端口，未改动正在运行的服务。")
                }
            } else {
                guard service.relay.phase == .stopped else { throw MacPeerFailure("中转正在启动或停止，请稍后重试。") }
                let addresses = LANAddress.available().filter { !$0.address.hasPrefix("127.") }
                let preferred = addresses.filter { $0.interface == "en0" }
                let address = request["address"] as? String ?? (preferred.count == 1 ? preferred[0].address : addresses.count == 1 ? addresses[0].address : nil)
                guard let address, addresses.contains(where: { $0.address == address }) else {
                    throw MacPeerFailure("无法唯一选择其他设备可达的 IP，请先查询 tb setup status，再使用 --address 指定。")
                }
                let port = request["port"] as? Int ?? 7400
                guard (1024...65535).contains(port) else { throw MacPeerFailure("端口须为 1024–65535。") }
                service.startRelay(.init(address: address, port: port, password: ""))
                let generation = service.relay.generation
                do { try await ready(service.relay, generation: generation) }
                catch {
                    if service.relay.generation == generation { service.stopRelay() }
                    throw error
                }
            }
            guard let endpoint = service.configuration.relay else { throw MacPeerFailure("中转尚未就绪。") }
            // Only the authenticated automation channel sees this credential;
            // CLI human/JSON output must redact it and never put it in argv.
            return ["address": endpoint.address, "port": endpoint.port, "password": endpoint.password]
        case "sharing.join", "connection.add":
            guard let address = request["address"] as? String, let port = request["port"] as? Int,
                  let password = request["password"] as? String, MacLANService.validRelayAddress(address),
                  (1024...65535).contains(port), (1...256).contains(password.count) else { throw MacPeerFailure("中转连接信息无效。") }
            let endpoint = LANEndpointConfiguration(address: address, port: port, password: password)
            if action == "connection.add" {
                guard let model else { throw MacPeerFailure("App 连接管理器尚未就绪。") }
                let profile = ConnectionSettings(relayURL: "ws://\(address):\(port)", hostID: "", secret: password, tlsFingerprint: "")
                try model.saveProfile(profile)
                return ["status": "configured", "address": address, "port": port]
            }
            if service.sharing.phase == .ready {
                guard let current = service.configuration.sharing?.endpoint,
                      current.address == address, current.port == port, current.password == password else {
                    throw MacPeerFailure("本机正在共享到另一个中转，未改动已有服务。请先停止共享。")
                }
            } else {
                guard service.sharing.phase == .stopped else { throw MacPeerFailure("共享正在启动或停止，请稍后重试。") }
                service.startSharing(route: .remote, endpoint: endpoint)
                let generation = service.sharing.generation
                do { try await ready(service.sharing, generation: generation) }
                catch {
                    if service.sharing.generation == generation { service.stopSharing() }
                    throw error
                }
            }
            return ["status": "ready", "hostId": service.sharing.localHostID ?? "", "address": address, "port": port]
        default: throw MacPeerFailure("Unsupported App control action")
        }
    }

    private func ready(_ worker: MacLANService, generation: UUID) async throws {
        for _ in 0..<400 {
            try Task.checkCancellation()
            guard worker.generation == generation else { throw MacPeerFailure("服务已由另一个操作替换，本次配置已取消。") }
            if worker.phase == .ready { return }
            if worker.phase == .stopped { throw MacPeerFailure(worker.message) }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw MacPeerFailure("服务启动超时，请检查地址、密码和端口。")
    }
}
