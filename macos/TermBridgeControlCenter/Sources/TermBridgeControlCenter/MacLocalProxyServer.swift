import Foundation
import Network

protocol MacProxyTunnelTransport: AnyObject, Sendable {
    func sendTunnelOpen(id: String, host: String, port: Int) -> Bool
    func sendTunnelData(id: String, base64Data: String) -> Bool
    func sendTunnelAck(id: String, bytes: Int) -> Bool
    func sendTunnelClose(id: String, reason: String?) -> Bool
}

/// Local loopback SOCKS5 + HTTP/CONNECT proxy server bound strictly to 127.0.0.1.
/// Multiplexes browser TCP streams through TermBridge `proxy_tunnel` control frames.
final class MacLocalProxyServer: @unchecked Sendable {
    private enum Phase {
        case detecting
        case socks5Methods
        case socks5Auth
        case socks5Request
        case httpHeaders
        case opening(mode: OpenMode, trailing: Data)
        case streaming
        case closed
    }

    private enum OpenMode {
        case socks5
        case httpConnect
        case httpForward(rewrittenHeader: Data)
    }

    private final class ClientSession {
        let id: String
        let connection: NWConnection
        var phase: Phase = .detecting
        var buffer = Data()
        var unackedBytes = 0
        var timeoutWork: DispatchWorkItem?
        init(id: String, connection: NWConnection) {
            self.id = id
            self.connection = connection
        }
    }

    let authUsername: String
    let authPassword: String
    private(set) var port: UInt16 = 0
    private let queue = DispatchQueue(label: "dev.termbridge.local-proxy", qos: .userInitiated)
    private weak var transport: MacProxyTunnelTransport?
    private var listener: NWListener?
    private var sessions: [String: ClientSession] = [:]
    private var closed = false
    private let readySemaphore = DispatchSemaphore(value: 0)
    private var startError: Error?

    init(transport: MacProxyTunnelTransport, requireSocksAuth: Bool = true) throws {
        self.transport = transport
        self.authUsername = requireSocksAuth ? "tb" : ""
        self.authPassword = requireSocksAuth ? UUID().uuidString.replacingOccurrences(of: "-", with: "") : ""

        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: params)
        self.listener = listener

        listener.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .ready:
                self.port = listener.port?.rawValue ?? 0
                self.readySemaphore.signal()
            case .failed(let error):
                self.startError = error
                self.readySemaphore.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)

        if readySemaphore.wait(timeout: .now() + 5) == .timedOut {
            close()
            throw NSError(domain: "MacLocalProxyServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timed out starting local proxy"])
        }
        if let startError {
            close()
            throw startError
        }
        guard port > 0 else {
            close()
            throw NSError(domain: "MacLocalProxyServer", code: 2, userInfo: [NSLocalizedDescriptionKey: "Local proxy did not bind a port"])
        }
    }

    func onTunnelOpened(id: String) {
        queue.async { [weak self] in
            guard let self, let session = self.sessions[id] else { return }
            guard case .opening(let mode, let trailing) = session.phase else { return }
            session.timeoutWork?.cancel(); session.timeoutWork = nil
            session.phase = .streaming
            switch mode {
            case .socks5:
                let reply = Data([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                session.connection.send(content: reply, completion: .contentProcessed { _ in })
                if !trailing.isEmpty { self.sendUpstream(id: id, data: trailing) }
            case .httpConnect:
                let reply = Data("HTTP/1.1 200 Connection Established\r\n\r\n".utf8)
                session.connection.send(content: reply, completion: .contentProcessed { _ in })
                if !trailing.isEmpty { self.sendUpstream(id: id, data: trailing) }
            case .httpForward(let header):
                self.sendUpstream(id: id, data: header)
                if !trailing.isEmpty { self.sendUpstream(id: id, data: trailing) }
            }
        }
    }

    func onTunnelData(id: String, base64Data: String) {
        guard let bytes = Data(base64Encoded: base64Data), !bytes.isEmpty else { return }
        queue.async { [weak self] in
            guard let self, let session = self.sessions[id] else { return }
            if case .closed = session.phase { return }
            session.connection.send(content: bytes, completion: .contentProcessed { [weak self] error in
                guard let self else { return }
                if error != nil {
                    self.closeSession(id: id, notifyRemote: true, reason: "Local browser closed")
                    return
                }
                guard let active = self.sessions[id] else { return }
                active.unackedBytes += bytes.count
                if active.unackedBytes >= ProxyTunnelProtocol.ackBatchBytes {
                    let ack = active.unackedBytes
                    active.unackedBytes = 0
                    _ = self.transport?.sendTunnelAck(id: id, bytes: ack)
                }
            })
        }
    }

    func onTunnelClosed(id: String, reason: String?) {
        queue.async { [weak self] in
            guard let self, let session = self.sessions[id] else { return }
            if case .opening(let mode, _) = session.phase {
                switch mode {
                case .socks5:
                    session.connection.send(content: Data([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { _ in
                        self.closeSession(id: id, notifyRemote: false, reason: reason)
                    })
                case .httpConnect, .httpForward:
                    let msg = reason ?? "TermBridge Host could not reach target"
                    let body = Data("\(msg)\n".utf8)
                    let header = "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
                    var response = Data(header.utf8); response.append(body)
                    session.connection.send(content: response, completion: .contentProcessed { _ in
                        self.closeSession(id: id, notifyRemote: false, reason: reason)
                    })
                }
                return
            }
            self.closeSession(id: id, notifyRemote: false, reason: reason)
        }
    }

    func resetAllTunnels(reason: String) {
        queue.async { [weak self] in
            guard let self else { return }
            for id in Array(self.sessions.keys) {
                self.closeSession(id: id, notifyRemote: false, reason: reason)
            }
        }
    }

    func close() {
        queue.sync {
            guard !closed else { return }
            closed = true
            listener?.cancel()
            listener = nil
            for id in Array(sessions.keys) {
                closeSession(id: id, notifyRemote: true, reason: "Browser closed")
            }
            sessions.removeAll()
        }
    }

    private func accept(_ connection: NWConnection) {
        guard !closed else { connection.cancel(); return }
        let id = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16)
        let session = ClientSession(id: String(id), connection: connection)
        sessions[session.id] = session
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .failed, .cancelled:
                self.closeSession(id: session.id, notifyRemote: true, reason: nil)
            default:
                break
            }
        }
        connection.start(queue: queue)
        receiveNext(session)
    }

    private func receiveNext(_ session: ClientSession) {
        session.connection.receive(minimumIncompleteLength: 1, maximumLength: ProxyTunnelProtocol.maxChunkBytes) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.handleIncoming(session, data: data)
            }
            if isComplete || error != nil {
                self.closeSession(id: session.id, notifyRemote: true, reason: nil)
                return
            }
            if case .closed = session.phase { return }
            self.receiveNext(session)
        }
    }

    private func handleIncoming(_ session: ClientSession, data: Data) {
        if case .streaming = session.phase {
            sendUpstream(id: session.id, data: data)
            return
        }
        if case .opening(let mode, var trailing) = session.phase {
            trailing.append(data)
            session.phase = .opening(mode: mode, trailing: trailing)
            return
        }
        session.buffer.append(data)
        if session.buffer.count > 64 * 1024 {
            closeSession(id: session.id, notifyRemote: false, reason: "Header too large")
            return
        }
        processHandshake(session)
    }

    private func processHandshake(_ session: ClientSession) {
        while true {
            switch session.phase {
            case .detecting:
                guard let first = session.buffer.first else { return }
                session.phase = first == 0x05 ? .socks5Methods : .httpHeaders
            case .socks5Methods:
                guard session.buffer.count >= 2 else { return }
                let nMethods = Int(session.buffer[1])
                guard session.buffer.count >= 2 + nMethods else { return }
                let methods = session.buffer.subdata(in: 2..<(2 + nMethods))
                session.buffer = Data(session.buffer.dropFirst(2 + nMethods))
                let requiresAuth = !authPassword.isEmpty
                if requiresAuth {
                    if methods.contains(0x02) {
                        session.phase = .socks5Auth
                        session.connection.send(content: Data([0x05, 0x02]), completion: .contentProcessed { _ in })
                    } else {
                        session.connection.send(content: Data([0x05, 0xFF]), completion: .contentProcessed { _ in
                            self.closeSession(id: session.id, notifyRemote: false, reason: nil)
                        })
                        return
                    }
                } else {
                    if methods.contains(0x00) {
                        session.phase = .socks5Request
                        session.connection.send(content: Data([0x05, 0x00]), completion: .contentProcessed { _ in })
                    } else {
                        session.connection.send(content: Data([0x05, 0xFF]), completion: .contentProcessed { _ in
                            self.closeSession(id: session.id, notifyRemote: false, reason: nil)
                        })
                        return
                    }
                }
            case .socks5Auth:
                guard session.buffer.count >= 2 else { return }
                let uLen = Int(session.buffer[1])
                guard session.buffer.count >= 2 + uLen + 1 else { return }
                let pLen = Int(session.buffer[2 + uLen])
                guard session.buffer.count >= 3 + uLen + pLen else { return }
                let user = String(data: session.buffer.subdata(in: 2..<(2 + uLen)), encoding: .utf8) ?? ""
                let pass = String(data: session.buffer.subdata(in: (3 + uLen)..<(3 + uLen + pLen)), encoding: .utf8) ?? ""
                session.buffer = Data(session.buffer.dropFirst(3 + uLen + pLen))
                if user == authUsername && pass == authPassword {
                    session.phase = .socks5Request
                    session.connection.send(content: Data([0x01, 0x00]), completion: .contentProcessed { _ in })
                } else {
                    session.connection.send(content: Data([0x01, 0x01]), completion: .contentProcessed { _ in
                        self.closeSession(id: session.id, notifyRemote: false, reason: nil)
                    })
                    return
                }
            case .socks5Request:
                guard session.buffer.count >= 4 else { return }
                let cmd = session.buffer[1]
                let atyp = session.buffer[3]
                guard session.buffer[0] == 0x05, cmd == 0x01 else {
                    session.connection.send(content: Data([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { _ in
                        self.closeSession(id: session.id, notifyRemote: false, reason: nil)
                    })
                    return
                }
                let host: String
                let consumed: Int
                switch atyp {
                case 0x01:
                    guard session.buffer.count >= 4 + 4 + 2 else { return }
                    let bytes = [UInt8](session.buffer.subdata(in: 4..<8))
                    host = bytes.map(String.init).joined(separator: ".")
                    consumed = 10
                case 0x03:
                    guard session.buffer.count >= 5 else { return }
                    let len = Int(session.buffer[4])
                    guard session.buffer.count >= 5 + len + 2 else { return }
                    host = String(data: session.buffer.subdata(in: 5..<(5 + len)), encoding: .utf8) ?? ""
                    consumed = 5 + len + 2
                case 0x04:
                    guard session.buffer.count >= 4 + 16 + 2 else { return }
                    let addr = session.buffer.subdata(in: 4..<20)
                    host = Self.formatIPv6(addr)
                    consumed = 22
                default:
                    session.connection.send(content: Data([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]), completion: .contentProcessed { _ in
                        self.closeSession(id: session.id, notifyRemote: false, reason: nil)
                    })
                    return
                }
                let portHi = Int(session.buffer[consumed - 2])
                let portLo = Int(session.buffer[consumed - 1])
                let targetPort = (portHi << 8) | portLo
                let trailing = session.buffer.subdata(in: consumed..<session.buffer.count)
                session.buffer.removeAll(keepingCapacity: false)
                beginRemoteOpen(session, host: host, port: targetPort, mode: .socks5, trailing: trailing)
                return
            case .httpHeaders:
                let sep = Data([13, 10, 13, 10])
                guard let range = session.buffer.range(of: sep) else { return }
                let headerData = session.buffer.subdata(in: 0..<range.lowerBound)
                let trailing = session.buffer.subdata(in: range.upperBound..<session.buffer.count)
                session.buffer.removeAll(keepingCapacity: false)
                guard let headerText = String(data: headerData, encoding: .isoLatin1) else {
                    closeSession(id: session.id, notifyRemote: false, reason: nil); return
                }
                let lines = headerText.components(separatedBy: "\r\n")
                let parts = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false).map(String.init)
                guard parts.count >= 3 else {
                    closeSession(id: session.id, notifyRemote: false, reason: nil); return
                }
                let method = parts[0].uppercased(), rawTarget = parts[1], version = parts[2]
                if method == "CONNECT" {
                    guard let (host, targetPort) = Self.parseHostPort(rawTarget, defaultPort: 443) else {
                        closeSession(id: session.id, notifyRemote: false, reason: nil); return
                    }
                    beginRemoteOpen(session, host: host, port: targetPort, mode: .httpConnect, trailing: trailing)
                    return
                }
                let headers = lines.dropFirst().filter { !$0.isEmpty }
                let hostHeader = headers.first { $0.lowercased().hasPrefix("host:") }
                    .map { String($0.dropFirst(5)).trimmingCharacters(in: .whitespaces) }
                guard let target = Self.parseHttpForwardTarget(rawTarget, hostHeader: hostHeader) else {
                    closeSession(id: session.id, notifyRemote: false, reason: nil); return
                }
                let hasUpgrade = headers.contains { $0.lowercased().hasPrefix("upgrade:") }
                var rewritten = "\(method) \(target.originTarget) \(version)\r\n"
                var sawHost = false
                for line in headers {
                    let lower = line.lowercased()
                    if lower.hasPrefix("proxy-connection:") || lower.hasPrefix("proxy-authorization:") { continue }
                    if !hasUpgrade && lower.hasPrefix("connection:") { continue }
                    if lower.hasPrefix("host:") { sawHost = true }
                    rewritten += "\(line)\r\n"
                }
                if !sawHost {
                    let displayHost = target.host.contains(":") ? "[\(target.host)]" : target.host
                    rewritten += target.port == 80 ? "Host: \(displayHost)\r\n" : "Host: \(displayHost):\(target.port)\r\n"
                }
                if !hasUpgrade { rewritten += "Connection: close\r\n" }
                rewritten += "\r\n"
                beginRemoteOpen(session, host: target.host, port: target.port,
                                mode: .httpForward(rewrittenHeader: Data(rewritten.utf8)), trailing: trailing)
                return
            case .opening, .streaming, .closed:
                return
            }
        }
    }

    private func beginRemoteOpen(_ session: ClientSession, host: String, port: Int, mode: OpenMode, trailing: Data) {
        guard !host.isEmpty, (1...65535).contains(port) else {
            closeSession(id: session.id, notifyRemote: false, reason: "Invalid target")
            return
        }
        session.phase = .opening(mode: mode, trailing: trailing)
        let work = DispatchWorkItem { [weak self] in
            self?.onTunnelClosed(id: session.id, reason: "Connection timed out")
        }
        session.timeoutWork = work
        queue.asyncAfter(deadline: .now() + 15, execute: work)
        if transport?.sendTunnelOpen(id: session.id, host: host, port: port) != true {
            onTunnelClosed(id: session.id, reason: "Relay not ready")
        }
    }

    private func sendUpstream(id: String, data: Data) {
        var offset = 0
        while offset < data.count {
            let end = min(data.count, offset + ProxyTunnelProtocol.maxChunkBytes)
            let chunk = data.subdata(in: offset..<end)
            if transport?.sendTunnelData(id: id, base64Data: chunk.base64EncodedString()) != true {
                closeSession(id: id, notifyRemote: true, reason: "Failed to forward upstream bytes")
                return
            }
            offset = end
        }
    }

    private func closeSession(id: String, notifyRemote: Bool, reason: String?) {
        guard let session = sessions.removeValue(forKey: id) else { return }
        if case .closed = session.phase { return }
        session.phase = .closed
        session.timeoutWork?.cancel(); session.timeoutWork = nil
        if session.unackedBytes > 0 && notifyRemote {
            _ = transport?.sendTunnelAck(id: id, bytes: session.unackedBytes)
            session.unackedBytes = 0
        }
        if notifyRemote {
            _ = transport?.sendTunnelClose(id: id, reason: reason)
        }
        session.connection.stateUpdateHandler = nil
        session.connection.cancel()
    }

    private static func formatIPv6(_ data: Data) -> String {
        var addr = in6_addr()
        _ = withUnsafeMutableBytes(of: &addr) { data.copyBytes(to: $0) }
        var buf = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        return inet_ntop(AF_INET6, &addr, &buf, socklen_t(INET6_ADDRSTRLEN)).map { String(cString: $0) } ?? "::1"
    }

    private static func parseHostPort(_ authority: String, defaultPort: Int) -> (String, Int)? {
        let trimmed = authority.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.hasPrefix("[") {
            guard let close = trimmed.firstIndex(of: "]") else { return nil }
            let host = String(trimmed[trimmed.index(after: trimmed.startIndex)..<close])
            let rest = trimmed[trimmed.index(after: close)...]
            if rest.isEmpty { return (host, defaultPort) }
            guard rest.hasPrefix(":"), let port = Int(rest.dropFirst()), (1...65535).contains(port) else { return nil }
            return (host, port)
        }
        if let colon = trimmed.lastIndex(of: ":"), trimmed.firstIndex(of: ":") == colon {
            let host = String(trimmed[..<colon])
            guard !host.isEmpty, let port = Int(trimmed[trimmed.index(after: colon)...]), (1...65535).contains(port) else { return nil }
            return (host, port)
        }
        return (trimmed, defaultPort)
    }

    private static func parseHttpForwardTarget(_ rawTarget: String, hostHeader: String?) -> (host: String, port: Int, originTarget: String)? {
        if rawTarget.lowercased().hasPrefix("http://") || rawTarget.lowercased().hasPrefix("https://"),
           let components = URLComponents(string: rawTarget), let host = components.host, !host.isEmpty {
            let defaultPort = components.scheme?.lowercased() == "https" ? 443 : 80
            let port = components.port ?? defaultPort
            let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
            let origin = components.percentEncodedQuery.map { "\(path)?\($0)" } ?? path
            return (host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")), port, origin)
        }
        guard let hostHeader, let (host, port) = parseHostPort(hostHeader, defaultPort: 80) else { return nil }
        let origin = rawTarget.hasPrefix("/") ? rawTarget : "/\(rawTarget)"
        return (host, port, origin)
    }
}
