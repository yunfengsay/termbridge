import CryptoKit
import Darwin
import Foundation

struct MacPeerPermission: Codable, Equatable {
    enum FileAccess: String, Codable, CaseIterable { case off, ro, rw }
    var enabled = false
    var roots: [String] = []
    // Compatibility with existing callers and older App configurations.
    var root: String {
        get { roots.first ?? "" }
        set { roots = newValue.isEmpty ? [] : [newValue] }
    }
    var files: FileAccess = .off
    var execute = false

    init(enabled: Bool = false, root: String = "", files: FileAccess = .off, execute: Bool = false) {
        self.enabled = enabled; self.root = root; self.files = files; self.execute = execute
    }

    private enum CodingKeys: String, CodingKey { case enabled, root, roots, files, execute }
    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try fields.decode(Bool.self, forKey: .enabled)
        files = try fields.decode(FileAccess.self, forKey: .files)
        execute = try fields.decode(Bool.self, forKey: .execute)
        if fields.contains(.roots) { roots = try fields.decode([String].self, forKey: .roots) }
        else { root = try fields.decodeIfPresent(String.self, forKey: .root) ?? "" }
    }
    func encode(to encoder: Encoder) throws {
        var fields = encoder.container(keyedBy: CodingKeys.self)
        try fields.encode(enabled, forKey: .enabled)
        try fields.encode(files, forKey: .files)
        try fields.encode(execute, forKey: .execute)
        try fields.encode(root, forKey: .root)
        try fields.encode(roots, forKey: .roots)
    }

    func validated() throws -> Self {
        var value = self
        guard roots.count <= 32 else { throw MacPeerFailure("最多可开放 32 个目录。") }
        value.roots = []
        for input in roots {
            let path = (input as NSString).expandingTildeInPath
            guard path.hasPrefix("/"), !path.contains("\0") else { throw MacPeerFailure("请输入绝对目录路径，或使用 ~/ 开头。") }
            let canonical = try MacPeerPath.resolve(path, mustExist: true)
            guard canonical != "/" else { throw MacPeerFailure("不能开放整个文件系统，请选择具体目录。") }
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: canonical, isDirectory: &isDirectory), isDirectory.boolValue else {
                throw MacPeerFailure("开放路径必须是已有目录。")
            }
            if !value.roots.contains(canonical) { value.roots.append(canonical) }
        }
        if enabled && (files != .off || execute) && value.root.isEmpty {
            throw MacPeerFailure("请先选择开放目录；命令执行以该目录为工作目录，但不受目录沙箱限制。")
        }
        return value
    }
}

enum MacPeerPath {
    // Foundation intentionally abbreviates /private/var to /var on macOS.
    // Keep the actual POSIX path for O_NOFOLLOW descriptor walks instead.
    static func resolve(_ path: String, mustExist: Bool = false) throws -> String {
        var current = URL(fileURLWithPath: path).standardizedFileURL.path
        var missing: [String] = []
        while true {
            if let resolved = realpath(current, nil) {
                defer { free(resolved) }
                return ([String(cString: resolved)] + missing.reversed()).joined(separator: "/")
            }
            guard !mustExist, errno == ENOENT, current != "/" else { throw MacPeerFailure("路径不存在或无权访问。") }
            missing.append((current as NSString).lastPathComponent)
            current = (current as NSString).deletingLastPathComponent
        }
    }
}

struct MacPeerConfiguration: Codable {
    var version = 1
    var deviceID = "mac-app-" + UUID().uuidString.lowercased()
    var permissions: [String: MacPeerPermission] = [:]

    static func scope(_ profile: ConnectionSettings) -> String {
        // Bind approval to the authenticated endpoint, including credential
        // changes. Persist only the digest, never the room key or private URL.
        let identity = [profile.relayURL, profile.hostID, profile.normalizedFingerprint, profile.secret].joined(separator: "\0")
        return SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func load(from url: URL?) throws -> Self {
        guard let url else { return Self() }
        if !FileManager.default.fileExists(atPath: url.path) {
            let value = Self(); try value.save(to: url); return value
        }
        let value = try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
        guard value.version == 1, value.deviceID.hasPrefix("mac-app-"),
              UUID(uuidString: String(value.deviceID.dropFirst(8))) != nil else {
            throw MacPeerFailure("Peer 配置无法识别，已停止开放；不会自动重置身份或授权。")
        }
        for permission in value.permissions.values { _ = try permission.validated() }
        return value
    }

    func save(to url: URL?) throws {
        guard let url else { return }
        let fm = FileManager.default
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".mac-peer-" + UUID().uuidString)
        defer { try? fm.removeItem(at: temporary) }
        guard fm.createFile(atPath: temporary.path, contents: try JSONEncoder().encode(self), attributes: [.posixPermissions: 0o600]),
              rename(temporary.path, url.path) == 0 else { throw MacPeerFailure("无法保存 Peer 授权。") }
    }

    var registration: [String: MessagePackValue] {
        ["t": .string("peer_register"), "deviceId": .string(deviceID), "platform": .string("darwin"),
         "name": .string(String((ProcessInfo.processInfo.hostName + " · Mac App").prefix(128))),
         "role": .string("manager"), "capabilities": .array(["peer.desktop", "peer.fs", "peer.exec", "termbridge.lan"].map(MessagePackValue.string))]
    }
}

struct MacPeerFailure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
