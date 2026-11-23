import Foundation

/// Explain the failure without displaying URLs, room keys, or server-provided text.
enum ConnectionFailure {
    static func description(_ error: Error) -> String {
        let error = error as NSError
        if error.domain == DirectWebSocket.errorDomain {
            return error.code == 1
                ? "系统为此连接选择了代理，内网直连已拒绝通过代理认证。请检查直连网络是否可达。"
                : "无法确认内网直连的实际路径，已停止认证。请重新测试连接。"
        }
        // Classify by Foundation codes, never by localized system text. Error
        // userInfo and descriptions can contain private URLs and credentials.
        if error.domain == NSURLErrorDomain {
            // Direct socket failures carry the stage that stopped and their POSIX code.
            let stage = DirectSocketError.stage(of: error)
            let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError
            let posix = underlying?.domain == NSPOSIXErrorDomain ? underlying?.code : nil
            let message: String
            switch URLError.Code(rawValue: error.code) {
            case .cannotConnectToHost:
                message = posix == Int(EHOSTUNREACH) || posix == Int(ENETUNREACH)
                    ? "无法到达该地址，请检查网络路由，以及系统设置 → 隐私与安全性 → 本地网络中的 TermBridge 权限。"
                    : "无法连接服务器端口，请检查 IP、端口、服务状态和防火墙。"
            case .notConnectedToInternet, .dataNotAllowed:
                message = "当前网络不可用。请检查网络连接，以及系统设置 → 隐私与安全性 → 本地网络中的 TermBridge 权限。"
            case .timedOut:
                switch stage {
                case "connect": message = "TCP 连接超时，目标没有响应，请检查 IP、端口、防火墙和网络路由。"
                case "upgrade": message = "TCP 已连接，但服务端未在时限内完成 WebSocket 握手，请确认端口运行的是 TermBridge 内网服务。"
                default: message = "连接超时，请检查两台 Mac 之间的网络、端口和防火墙。"
                }
            case .cannotFindHost, .dnsLookupFailed:
                message = "无法解析服务器地址，请检查地址和网络。"
            case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate,
                 .serverCertificateHasUnknownRoot, .serverCertificateNotYetValid:
                message = "TLS 证书连接失败，内网直连可在高级选项中重新识别证书。"
            case .badServerResponse:
                if stage == "http" {
                    message = "端口返回了无效的 HTTP 响应，请确认地址和端口指向 TermBridge 内网服务。"
                } else if let status = DirectSocketError.httpStatus(of: error), status != 101 {
                    message = "端口返回 HTTP \(status)，未接受 WebSocket 连接，请确认地址和端口指向 TermBridge 内网服务。"
                } else {
                    message = "服务端的 WebSocket 握手响应无效，请确认端口运行的是 TermBridge 内网服务。"
                }
            case .cannotParseResponse, .cannotDecodeContentData, .dataLengthExceedsMaximum:
                message = "服务端发送了无法处理的 WebSocket 数据，连接已关闭。"
            case .networkConnectionLost:
                message = stage == "connect" || stage == "upgrade"
                    ? "连接在 WebSocket 握手完成前被中断，请检查服务端状态，以及本机安全或网络过滤软件是否放行 TermBridge。"
                    : "网络连接中途断开，请检查网络和服务端状态。"
            case .cancelled:
                message = "网络请求被系统取消，请重新测试连接。"
            default:
                message = "网络请求失败。"
            }
            return "\(message) [NSURLErrorDomain/\(error.code)\(posix.map { " · POSIX \($0)" } ?? "")]"
        }
        if error.domain == NSPOSIXErrorDomain {
            return "系统网络连接失败，请检查网络、服务端口及权限。 [NSPOSIXErrorDomain/\(error.code)]"
        }
        return "连接测试失败，未取得网络响应。"
    }

    static func description(_ detail: String) -> String {
        let text = detail.lowercased()
        if text.contains("fingerprint") { return "TLS 指纹不匹配。若服务器重新安装过，请在高级选项中重新识别证书。" }
        if text.contains("tls") || text.contains("ssl") || text.contains("certificate") || text.contains("证书") {
            return "TLS 连接失败，请检查服务器证书；内网直连可在高级选项中重新识别证书。"
        }
        if text.contains("password") || text.contains("authentication") {
            return "认证失败，请核对连接密码。"
        }
        if text.contains("host not found") || text.contains("no host online") {
            return "服务器可达，但目标 Host 不在线。请开启服务，或清空 Host ID 后自动发现。"
        }
        if text.contains("timed out") || text.contains("timeout") || text.contains("超时") {
            return "连接超时，请检查服务器是否已开启、IP、端口和防火墙。"
        }
        if text.contains("host name") || text.contains("hostname") || text.contains("dns") {
            return "无法解析服务器地址，请检查地址和网络。"
        }
        if text.contains("connect to the server") || text.contains("offline") || text.contains("internet connection")
            || text.contains("连接服务器") || text.contains("连接到服务器") || text.contains("refused") {
            return "无法连接服务器，请检查服务器地址、端口、网络和防火墙。"
        }
        return "连接已断开，请检查服务器和 Host 是否在线。"
    }
}
