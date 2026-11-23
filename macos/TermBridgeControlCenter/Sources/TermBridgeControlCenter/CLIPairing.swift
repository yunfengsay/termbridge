import AppKit
import CoreImage.CIFilterBuiltins
import Security
import SwiftUI

enum CLIPairing {
    static func createCode(
        hostedRelay: String? = ProcessInfo.processInfo.environment["TB_CLOUDFLARE_RELAY"]
    ) throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw CLIInstallationError(message: "无法创建配对信息，请重试。")
        }
        let secret = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let code = PairingCode.prefix + secret
        _ = try PairingCode.parse(code, hostedRelay: hostedRelay)
        return code
    }
    static func createURI(relayURL: String, hostName: String = "", tlsPin: String = "") throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw CLIInstallationError(message: "无法创建配对信息，请重试。")
        }
        let secret = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        var components = URLComponents()
        components.scheme = "termbridge"
        components.host = "pair"
        var items = [
            URLQueryItem(name: "v", value: "1"),
            URLQueryItem(name: "relay", value: relayURL),
            URLQueryItem(name: "secret", value: secret),
        ]
        if !hostName.isEmpty { items.append(URLQueryItem(name: "name", value: hostName)) }
        if !tlsPin.isEmpty { items.append(URLQueryItem(name: "pin", value: tlsPin.lowercased())) }
        components.queryItems = items
        guard let uri = components.string else {
            throw CLIInstallationError(message: "无法创建配对链接，请重试。")
        }
        _ = try PairingCode.parse(uri)
        return uri
    }
    static func qrCode(_ code: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator(); filter.message = Data(code.utf8)
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return NSImage(cgImage: image, size: NSSize(width: 240, height: 240))
    }
}

struct CLIPairingSheet: View {
    let code: String
    var title = "本机配对已配置"
    var detail = "在手机 App 扫码添加连接，再从设置启动本机 Host。\n已运行的 Host 需要重启才能使用新配对。"
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    var body: some View {
        VStack(spacing: 16) {
            Text(title).font(.title2)
            if let image = CLIPairing.qrCode(code) {
                Image(nsImage: image).interpolation(.none).resizable().frame(width: 240, height: 240).padding(16).background(.white)
            }
            Text(detail)
                .multilineTextAlignment(.center)
            Text("配对码包含连接权限，仅分享给自己的设备。").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button(copied ? "已复制配对码" : "复制配对码") {
                    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string); copied = true
                }
                Button("完成") { dismiss() }.keyboardShortcut(.defaultAction)
            }
        }.padding(24).frame(width: 420)
    }
}
