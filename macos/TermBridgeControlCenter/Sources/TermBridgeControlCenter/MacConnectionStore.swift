import Foundation
import Security

/// The Mac uses its own Keychain item; it never reads the mobile app's settings.
struct MacConnectionStore {
    let service: String
    init(service: String = "dev.termbridge.controlcenter.connections") { self.service = service }

    struct Record: Codable {
        let id: UUID
        let name: String
        let relay: String
        let host: String
        let secret: String
        let fingerprint: String
        let mode: ConnectionMode?
        init(_ settings: ConnectionSettings) {
            id = settings.profileID; name = settings.hostName; relay = settings.relayURL
            host = settings.hostID; secret = settings.secret; fingerprint = settings.tlsFingerprint; mode = settings.mode
        }
        var settings: ConnectionSettings {
            ConnectionSettings(profileID: id, relayURL: relay, hostID: host, secret: secret,
                               tlsFingerprint: fingerprint, hostName: name, mode: mode)
        }
    }

    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "profiles"]
    }
    func load() throws -> [ConnectionSettings] {
        var request = query
        request[kSecReturnData as String] = true
        var value: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &value)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let data = value as? Data else { throw failure(status) }
        return try JSONDecoder().decode([Record].self, from: data).map(\.settings)
    }
    func save(_ profiles: [ConnectionSettings]) throws {
        let data = try JSONEncoder().encode(profiles.map(Record.init))
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let added = SecItemAdd(item as CFDictionary, nil)
            guard added == errSecSuccess else { throw failure(added) }
        } else if status != errSecSuccess { throw failure(status) }
    }
    private func failure(_ status: OSStatus) -> NSError {
        NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: [NSLocalizedDescriptionKey:
            "Unable to access saved connections in Keychain (\(status))."])
    }

    /// Only import the CLI's documented transport fields, never Host voice credentials.
    static func cliProfile(data: Data?, environment: [String: String]) -> ConnectionSettings? {
        try? decodeCLIProfile(data: data, environment: environment)
    }

    enum CLIImportError: LocalizedError {
        case missingFile, unreadableFile, malformedFile, missingRelay, invalidConnection(String)
        var errorDescription: String? {
            switch self {
            case .missingFile: return "未找到本机 TB 配置。若 CLI 使用了自定义位置，请点击「选择配置文件」。"
            case .unreadableFile: return "无法读取 TB 配置文件，请检查文件权限或重新选择文件。"
            case .malformedFile: return "TB 配置文件格式不正确，需要包含连接配置的 JSON 文件。"
            case .missingRelay: return "未找到 TB 连接配置，请选择配置文件或粘贴配对码。"
            case .invalidConnection(let reason): return "TB 连接配置无效：\(reason)"
            }
        }
    }

    static func loadCLIProfile(from url: URL, environment: [String: String]) throws -> ConnectionSettings {
        let data: Data?
        do { data = try Data(contentsOf: url) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            guard environment["RELAY_URL"]?.isEmpty == false else { throw CLIImportError.missingFile }
            data = nil
        } catch { throw CLIImportError.unreadableFile }
        return try decodeCLIProfile(data: data, environment: environment)
    }

    /// Preserve Host-owned settings, and never turn an unreadable config into an empty one.
    static func saveCLIProfile(_ profile: ConnectionSettings, to url: URL) throws {
        let candidate = profile.normalized()
        if let error = candidate.validationError { throw CLIImportError.invalidConnection(error) }
        let fm = FileManager.default
        if (try? fm.destinationOfSymbolicLink(atPath: url.path)) != nil {
            throw CLIInstallationError(message: "CLI 配置是符号链接，请直接修改其目标文件。")
        }
        let previous: Data? = fm.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
        var settings: [String: Any] = [:]
        if let previous {
            guard let object = try JSONSerialization.jsonObject(with: previous) as? [String: Any] else {
                throw CLIImportError.malformedFile
            }
            settings = object
        }
        settings["middle"] = candidate.relayURL
        settings["secret"] = candidate.secret
        settings["tlsPin"] = candidate.normalizedFingerprint.isEmpty ? nil : candidate.normalizedFingerprint
        let data = try JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys])
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        func privateFile(_ data: Data, at path: URL) throws {
            guard fm.createFile(atPath: path.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
                throw CLIInstallationError(message: "无法保存 CLI 配置，请检查文件权限。")
            }
        }
        if let previous {
            try privateFile(previous, at: url.appendingPathExtension("termbridge-" + UUID().uuidString + ".bak"))
        }
        let temporary = url.deletingLastPathComponent().appendingPathComponent(".tb-settings-" + UUID().uuidString)
        try privateFile(data, at: temporary)
        defer { try? fm.removeItem(at: temporary) }
        let current = fm.fileExists(atPath: url.path) ? try Data(contentsOf: url) : nil
        guard current == previous else { throw CLIInstallationError(message: "CLI 配置刚被其他程序修改，请重新同步。") }
        guard rename(temporary.path, url.path) == 0 else { throw CLIInstallationError(message: "无法更新 CLI 配置，请检查文件权限。") }
    }

    static func decodeCLIProfile(data: Data?, environment: [String: String]) throws -> ConnectionSettings {
        struct CLI: Decodable { let middle: String?; let secret: String?; let tlsPin: String? }
        let cli: CLI?
        do { cli = try data.map { try JSONDecoder().decode(CLI.self, from: $0) } }
        catch { throw CLIImportError.malformedFile }
        func nonempty(_ value: String?) -> String? { value?.isEmpty == false ? value : nil }
        guard cli != nil || nonempty(environment["RELAY_URL"]) != nil else { throw CLIImportError.missingRelay }
        let address = (nonempty(environment["RELAY_URL"]) ?? nonempty(cli?.middle) ?? "ws://localhost:7400")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let relay: String
        if address.lowercased().hasPrefix("ws://") || address.lowercased().hasPrefix("wss://") { relay = address }
        else { relay = "ws://" + address + (address.range(of: #":\d+$"#, options: .regularExpression) == nil ? ":8001" : "") }
        let profile = ConnectionSettings(relayURL: relay, hostID: "", secret: nonempty(environment["TB_SECRET"]) ?? cli?.secret ?? "",
            tlsFingerprint: nonempty(environment["TB_TLS_PIN"]) ?? cli?.tlsPin ?? "", hostName: "TB Relay").normalized()
        if let error = profile.validationError { throw CLIImportError.invalidConnection(error) }
        return profile
    }
}

/// A connection is scoped by endpoint and Host identity, independent of roster order.
enum MacConnectionCatalog {
    static func tabTitle(_ profile: ConnectionSettings, in profiles: [ConnectionSettings]) -> String {
        let matches = profiles.filter { $0.displayName == profile.displayName }
        guard matches.count > 1, let index = matches.firstIndex(where: { $0.id == profile.id }) else { return profile.displayName }
        return "\(profile.displayName) · 连接\(index + 1)"
    }

    static func terminalKey(profileID: UUID?, sessionID: String) -> String {
        "\(profileID?.uuidString ?? "local"):\(sessionID)"
    }

    static func merging(_ state: ConnectionProfileState, base: ConnectionSettings,
                        hosts: [HostInfo], selectedHostID: String) -> ConnectionProfileState {
        var profiles = state.profiles
        var selected = state.activeID
        for host in hosts {
            let exact = profiles.firstIndex { $0.hostID == host.hostID && $0.sharesEndpoint(with: base) }
            let resolvesBase = host.hostID == selectedHostID ? profiles.firstIndex { $0.id == base.id } : nil
            let index = exact ?? resolvesBase
            let existing = index.map { profiles[$0] }
            let retainedName = existing.flatMap { $0.hostID.isEmpty || $0.hostName.isEmpty ? nil : $0.hostName }
            let candidate = ConnectionSettings(profileID: existing?.id ?? UUID(), relayURL: base.relayURL,
                hostID: host.hostID, secret: base.secret, tlsFingerprint: base.tlsFingerprint,
                hostName: retainedName ?? host.name, mode: base.mode)
            if let index { profiles[index] = candidate } else { profiles.append(candidate) }
            if host.hostID == selectedHostID {
                selected = candidate.id
                if base.hostID.isEmpty && candidate.id != base.id { profiles.removeAll { $0.id == base.id } }
            }
        }
        return ConnectionProfileState(profiles: profiles, activeID: selected)
    }
}
