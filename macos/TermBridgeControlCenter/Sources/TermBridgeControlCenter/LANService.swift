import AppKit
import Foundation
import Darwin

/// Legacy configuration / supervisor parameters. The UI composes independent services.
enum LANServiceMode: String, Codable {
    case direct, relay, join
}

struct LANServiceConfiguration: Decodable {
    let address: String
    let port: Int
    let password: String?
    let mode: LANServiceMode?
    let shareLocalHost: Bool?
}

struct LANAddress: Identifiable {
    let interface: String
    let address: String
    var id: String { address }
    static func isUsable(_ address: String) -> Bool {
        LANConnection.isUnicastIPv4(address)
    }
    static func available() -> [LANAddress] {
        var first: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&first) == 0 else { return [] }
        defer { freeifaddrs(first) }
        var result: [LANAddress] = []
        var next = first
        while let item = next {
            defer { next = item.pointee.ifa_next }
            guard let socket = item.pointee.ifa_addr, socket.pointee.sa_family == UInt8(AF_INET),
                  item.pointee.ifa_flags & UInt32(IFF_UP) != 0,
                  item.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var text = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(socket, socklen_t(socket.pointee.sa_len), &text, socklen_t(text.count), nil, 0, NI_NUMERICHOST) == 0 {
                let address = String(cString: text)
                if isUsable(address) { result.append(LANAddress(interface: String(cString: item.pointee.ifa_name), address: address)) }
            }
        }
        return result.sorted { $0.interface < $1.interface }
    }
}

/// One capability owns one supervisor. Closing stdin tears down only its children.
@MainActor final class MacLANService: ObservableObject {
    enum Phase: String { case stopped, starting, ready, reconnecting, stopping }
    @Published private(set) var phase: Phase = .stopped
    @Published private(set) var message = "尚未开启"
    @Published private(set) var profile: ConnectionSettings?
    @Published private(set) var pairing: String?
    @Published private(set) var topology: RelayTopology?
    @Published private(set) var activeMode = LANServiceMode.direct
    @Published private(set) var sharesHost = true
    @Published private(set) var localHostID: String?
    private(set) var bridgeSocket: String?
    private var process: Process?
    private var input: Pipe?
    private var output: Pipe?
    private var buffer = Data()
    private(set) var generation = UUID()
    private var requestedStop = false
    private var hasFailure = false
    var onReady: ((ConnectionSettings) -> Void)?
    static let directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/TermBridge/LAN")
    private let runtimeURL: URL?
    private let storageDirectory: URL
    init(runtimeURL: URL? = Bundle.main.resourceURL?.appendingPathComponent("Runtime"), storageDirectory: URL? = nil) {
        self.runtimeURL = runtimeURL; self.storageDirectory = storageDirectory ?? Self.directory
    }
    var busy: Bool { phase == .starting || phase == .stopping }

    func savedConfiguration() -> LANServiceConfiguration? {
        guard let data = try? Data(contentsOf: storageDirectory.appendingPathComponent("connection.json")) else { return nil }
        return try? JSONDecoder().decode(LANServiceConfiguration.self, from: data)
    }

    func savedAddress() -> (String, Int)? {
        guard let data = try? Data(contentsOf: storageDirectory.appendingPathComponent("connection.json")),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let address = value["address"] as? String, let port = value["port"] as? Int else { return nil }
        return (address, port)
    }
    func savedPassword() -> String? {
        guard let data = try? Data(contentsOf: storageDirectory.appendingPathComponent("connection.json")),
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let password = value["password"] as? String, (1...256).contains(password.count) else { return nil }
        return password
    }
    static func validRelayAddress(_ address: String) -> Bool {
        if LANAddress.isUsable(address) { return true }
        guard address.range(of: #"^[\d.]+$"#, options: .regularExpression) == nil else { return false }
        return address.range(of: #"^(?=.{1,253}$)[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*$"#,
                             options: [.regularExpression, .caseInsensitive]) != nil
    }
    func start(address: String, port: Int, password: String?, mode: LANServiceMode = .direct, shareLocalHost: Bool = true) {
        guard phase == .stopped else { return }
        guard (mode == .join ? Self.validRelayAddress(address) : LANAddress.isUsable(address)), (1024...65535).contains(port)
        else { message = mode == .join ? "请输入中转机 IP 或主机名，端口须为 1024–65535。" : "请选择本机 IP，端口须为 1024–65535。"; return }
        if let password, !(1...256).contains(password.count) { message = "密码须为 1–256 个字符；留空可自动生成。"; return }
        guard let runtime = runtimeURL else { message = "找不到内置服务组件"; return }
        let node = runtime.appendingPathComponent("node")
        let cli = runtime.appendingPathComponent("package/dist/cli.js")
        guard FileManager.default.isExecutableFile(atPath: node.path), FileManager.default.fileExists(atPath: cli.path) else {
            message = "当前 App 缺少内置服务组件，请安装包含内网直连的新版本。"; return
        }
        let token = UUID(); generation = token; requestedStop = false; hasFailure = false; buffer = Data(); profile = nil; pairing = nil; topology = nil
        activeMode = mode; sharesHost = mode != .relay || shareLocalHost; localHostID = nil
        AppDiagnostics.shared.record("lan.start_requested", ["address": address, "port": String(port), "attempt": token.uuidString])
        let child = Process(), incoming = Pipe(), outgoing = Pipe()
        child.executableURL = node; child.arguments = [cli.path, "lan-app"]
        child.standardInput = incoming; child.standardOutput = outgoing; child.standardError = FileHandle.nullDevice
        child.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = runtime.path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        env["TB_LAN_DIR"] = storageDirectory.path
        child.environment = env
        outgoing.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { handle.readabilityHandler = nil; return }
            Task { @MainActor in self?.consume(data, token: token) }
        }
        child.terminationHandler = { [weak self] process in
            let code = process.terminationStatus
            Task { @MainActor in
                AppDiagnostics.shared.record("lan.supervisor_exited", ["attempt": token.uuidString, "code": String(code)])
                self?.ended(token: token)
            }
        }
        process = child; input = incoming; output = outgoing; phase = .starting; message = "正在开启内网服务…"
        do {
            var request: [String: Any] = ["address": address, "port": port, "mode": mode.rawValue, "shareLocalHost": shareLocalHost]
            if let password { request["password"] = password }
            let data = try JSONSerialization.data(withJSONObject: request) + Data([10])
            try child.run(); try incoming.fileHandleForWriting.write(contentsOf: data)
        } catch {
            AppDiagnostics.shared.record("lan.launch_failed", AppDiagnostics.error(error))
            message = "无法启动内置服务，请检查 App 是否完整。"; stop()
        }
    }
    private func consume(_ data: Data, token: UUID) {
        guard generation == token, process != nil, phase == .starting || phase == .ready || phase == .reconnecting else { return }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = buffer.prefix(upTo: newline); buffer.removeSubrange(...newline)
            guard line.count <= 262_144 else { message = "服务响应过大"; stop(); return }
            guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            switch value["event"] as? String {
            case "topology":
                topology = value["topology"].flatMap(RelayTopology.decode(json:))
                if activeMode == .relay, phase == .ready, let topology {
                    let hosts = topology.nodes.filter { $0.role == .host }.count
                    let clients = topology.nodes.filter { $0.role == .client }.count
                    message = "中转运行中 · \(hosts) 台电脑 · \(clients) 个客户端"
                }
            case "connection_state":
                if value["connected"] as? Bool == false {
                    topology = nil
                    if phase == .ready { phase = .reconnecting; message = "中转连接已断开，正在自动重连…" }
                } else if phase == .reconnecting { phase = .ready; message = "已重新连接中转机" }
            case "diagnostic":
                guard let code = value["code"] as? String else { continue }
                var fields = value["fields"] as? [String: String] ?? [:]
                fields["source"] = value["source"] as? String ?? "supervisor"
                AppDiagnostics.shared.record("lan.\(code)", fields)
            case "ready":
                guard let code = value["pairing"] as? String, let settings = try? PairingCode.parse(code) else { message = "配对信息无效"; stop(); return }
                pairing = code; profile = settings; phase = .ready; message = "内网服务已就绪"
                localHostID = value["hostId"] as? String
                bridgeSocket = value["bridgeSocket"] as? String
                if activeMode == .join { message = "已连接中转机，本机会话可被访问" }
                else if activeMode == .relay { message = sharesHost ? "中转已就绪，同时共享本机" : "中转已就绪，等待其他电脑接入" }
                AppDiagnostics.shared.record("lan.ready", AppDiagnostics.connection(settings))
                onReady?(settings)
            case "error":
                hasFailure = true
                message = value["message"] as? String ?? "内网服务启动失败"
                AppDiagnostics.shared.record("lan.start_failed", ["attempt": token.uuidString])
            case "stopped":
                if !hasFailure { message = "内网服务已断开" }
                AppDiagnostics.shared.record("lan.disconnected", ["attempt": token.uuidString])
            default: break
            }
        }
        guard buffer.count <= 262_144 else { message = "服务响应无效"; stop(); return }
    }
    func stop() {
        guard let process else { phase = .stopped; return }
        requestedStop = true; phase = .stopping; profile = nil; pairing = nil; topology = nil
        AppDiagnostics.shared.record("lan.stop_requested", ["attempt": generation.uuidString])
        try? input?.fileHandleForWriting.close()
        if process.isRunning { process.terminate() } else { ended(token: generation) }
    }
    private func ended(token: UUID) {
        guard token == generation else { return }
        let wasRunning = phase == .ready || phase == .reconnecting
        output?.fileHandleForReading.readabilityHandler = nil
        try? input?.fileHandleForWriting.close(); input = nil; output = nil; process = nil
        buffer = Data(); profile = nil; pairing = nil; topology = nil; localHostID = nil; bridgeSocket = nil; phase = .stopped
        if requestedStop { message = "内网服务已关闭" }
        else if !hasFailure && (wasRunning || message == "正在开启内网服务…") { message = "内网服务已退出，请重新开启。" }
    }
}
