import Foundation
import Security
import CryptoKit

enum ConnectionMode: String, Codable { case relay, direct }

struct ConnectionSettings: Equatable, Identifiable {
  var profileID: UUID
  var relayURL: String
  var hostID: String
  var secret: String
  var tlsFingerprint: String
  var hostName: String
  var mode: ConnectionMode?

  // Old records did not store the user's selection. Preserve the historical
  // private-address default; a public/corporate IPv4 alone never implies LAN.
  var isDirectConnection: Bool {
    if let mode { return mode == .direct }
    return LANConnection.isDirectEndpoint(relayURL)
      && LANConnection.isPrivate(URL(string: relayURL)?.host ?? "")
  }

  var id: UUID { profileID }

  init(
    profileID: UUID = UUID(), relayURL: String, hostID: String, secret: String,
    tlsFingerprint: String, hostName: String = "", mode: ConnectionMode? = nil
  ) {
    self.profileID = profileID
    self.relayURL = relayURL
    self.hostID = hostID
    self.secret = secret
    self.tlsFingerprint = tlsFingerprint
    self.hostName = hostName
    self.mode = mode
  }

  var normalizedFingerprint: String {
    tlsFingerprint.filter { $0.isLetter || $0.isNumber }.lowercased()
  }

  var displayName: String {
    let name = hostName.trimmingCharacters(in: .whitespacesAndNewlines)
    if !name.isEmpty { return name }
    let host = hostID.trimmingCharacters(in: .whitespacesAndNewlines)
    if !host.isEmpty { return host }
    return URL(string: relayURL.trimmingCharacters(in: .whitespacesAndNewlines))?.host
      ?? "Termbridge Mac"
  }

  var isHostedRoom: Bool {
    guard let url = URL(string: relayURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
      return false
    }
    return url.scheme?.lowercased() == "wss"
      && url.path.range(of: #"^/r/[a-fA-F0-9]{64}$"#, options: .regularExpression) != nil
  }

  var validationError: String? {
    guard
      let components = URLComponents(
        string: relayURL.trimmingCharacters(in: .whitespacesAndNewlines)),
      ["ws", "wss"].contains(components.scheme?.lowercased() ?? ""),
      components.host?.isEmpty == false
    else { return "Relay URL must start with ws:// or wss://" }
    let normalizedHost = hostID.trimmingCharacters(in: .whitespacesAndNewlines)
    if !normalizedHost.isEmpty,
      normalizedHost.range(of: #"^[a-zA-Z0-9._:-]{1,128}$"#, options: .regularExpression)
        == nil
    { return "Host ID contains unsupported characters" }
    if hostName.count > 128 { return "Host name is too long" }
    if !normalizedFingerprint.isEmpty && normalizedFingerprint.count != 64 {
      return "TLS fingerprint must contain 64 hexadecimal characters"
    }
    if normalizedFingerprint.unicodeScalars.contains(where: {
      !CharacterSet(charactersIn: "0123456789abcdef").contains($0)
    }) { return "TLS fingerprint is not hexadecimal" }
    return nil
  }

  func normalized() -> ConnectionSettings {
    ConnectionSettings(
      profileID: profileID,
      relayURL: relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
      hostID: hostID.trimmingCharacters(in: .whitespacesAndNewlines), secret: secret,
      tlsFingerprint: normalizedFingerprint,
      hostName: hostName.trimmingCharacters(in: .whitespacesAndNewlines), mode: mode)
  }

  func sharesEndpoint(with other: ConnectionSettings) -> Bool {
    relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
      == other.relayURL.trimmingCharacters(in: .whitespacesAndNewlines)
      && secret == other.secret && normalizedFingerprint == other.normalizedFingerprint
  }

  static let defaults = ConnectionSettings(
    profileID: UUID(uuidString: "00000000-0000-0000-0000-000000000000")!,
    relayURL: "ws://127.0.0.1:7400", hostID: "", secret: "", tlsFingerprint: "")
}

struct ConnectionProfileState: Equatable {
  var profiles: [ConnectionSettings]
  var activeID: UUID?

  var active: ConnectionSettings? {
    profiles.first { $0.profileID == activeID } ?? profiles.first
  }

  func upserting(_ candidate: ConnectionSettings, select: Bool = true) -> ConnectionProfileState {
    let normalized = candidate.normalized()
    var result = profiles
    let activeIndex = result.firstIndex { $0.profileID == activeID }
    let sameID = result.firstIndex { $0.profileID == normalized.profileID }
    let sameHost = normalized.hostID.isEmpty ? nil : result.firstIndex {
      $0.hostID == normalized.hostID
        && $0.relayURL.caseInsensitiveCompare(normalized.relayURL) == .orderedSame
    }
    let sameAnonymous = normalized.hostID.isEmpty ? result.firstIndex {
      $0.hostID.isEmpty && $0.sharesEndpoint(with: normalized)
    } : nil
    let resolvesActiveAnonymous = activeIndex.flatMap { index -> Int? in
      let active = result[index]
      return normalized.hostID.isEmpty || !active.hostID.isEmpty
        || !active.sharesEndpoint(with: normalized) ? nil : index
    }
    let index = sameID ?? sameHost ?? sameAnonymous ?? resolvesActiveAnonymous
    let stored: ConnectionSettings
    if let index {
      stored = ConnectionSettings(
        profileID: result[index].profileID, relayURL: normalized.relayURL,
        hostID: normalized.hostID, secret: normalized.secret,
        tlsFingerprint: normalized.tlsFingerprint, hostName: normalized.hostName, mode: normalized.mode)
      result[index] = stored
    } else {
      stored = normalized
      result.append(stored)
    }
    return ConnectionProfileState(
      profiles: result, activeID: select ? stored.profileID : (activeID ?? result.first?.profileID))
  }

  func mergingHosts(
    base: ConnectionSettings, hosts: [HostInfo], selectedHostID: String?
  ) -> ConnectionProfileState {
    var next = self
    for host in hosts {
      let existing = next.profiles.first {
        $0.hostID == host.hostID
          && $0.relayURL.caseInsensitiveCompare(base.relayURL) == .orderedSame
      }
      let candidate = ConnectionSettings(
        profileID: existing?.profileID ?? (host.hostID == selectedHostID ? base.profileID : UUID()),
        relayURL: base.relayURL, hostID: host.hostID, secret: base.secret,
        tlsFingerprint: base.tlsFingerprint, hostName: host.name, mode: base.mode)
      next = next.upserting(candidate, select: host.hostID == selectedHostID)
    }
    return next
  }

  func selecting(_ profileID: UUID) -> ConnectionProfileState {
    profiles.contains { $0.profileID == profileID }
      ? ConnectionProfileState(profiles: profiles, activeID: profileID) : self
  }

  func removing(_ profileID: UUID) -> ConnectionProfileState {
    guard let removed = profiles.firstIndex(where: { $0.profileID == profileID }) else {
      return self
    }
    var remaining = profiles
    remaining.remove(at: removed)
    let selected = activeID == profileID
      ? (remaining.indices.contains(removed) ? remaining[removed].profileID : remaining.last?.profileID)
      : activeID
    return ConnectionProfileState(profiles: remaining, activeID: selected)
  }
}

extension Notification.Name {
  static let termbridgeSettingsDidChange = Notification.Name("termbridge.settings.changed")
}

enum SettingsStore {
  private struct Record: Codable {
    let profileID: UUID
    let relayURL: String
    let hostID: String
    let tlsFingerprint: String
    let hostName: String
    let mode: ConnectionMode?
  }

  private static let profilesKey = "connectionProfilesV3"
  private static let activeKey = "activeConnectionProfileV3"
  private static let legacyRelayKey = "relayURL"
  private static let legacyHostKey = "hostID"
  private static let legacyFingerprintKey = "tlsFingerprint"
  private static let legacyConfiguredKey = "configured"
  private static let keychainService = "com.termbridge.ios.connection"
  private static let legacyKeychainAccount = "relay-shared-secret"
  #if DEBUG
    private final class ProcessSecretCache: @unchecked Sendable {
      private let lock = NSLock()
      private var values: [String: String] = [:]

      func secret(for account: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[account]
      }

      func set(_ secret: String, for account: String) {
        lock.lock()
        defer { lock.unlock() }
        values[account] = secret
      }

      func remove(_ account: String) {
        lock.lock()
        defer { lock.unlock() }
        values.removeValue(forKey: account)
      }
    }

    // Simulator builds are commonly installed unsigned from command-line Xcode
    // builds. Their Keychain can reject SecItemAdd with errSecMissingEntitlement,
    // so retain the injected secret for this process while still preferring and
    // writing the Keychain whenever it is available.
    private static let processSecrets = ProcessSecretCache()
  #endif

  static var isConfigured: Bool { !profiles().isEmpty }
  static func load() -> ConnectionSettings { state().active ?? ConnectionSettings.defaults }
  static func profiles() -> [ConnectionSettings] { state().profiles }
  static func save(_ settings: ConnectionSettings) { persist(state().upserting(settings)) }

  static func select(_ profileID: UUID) -> Bool {
    let current = state()
    let next = current.selecting(profileID)
    guard next.activeID == profileID else { return false }
    if next != current { persist(next) }
    return true
  }

  @discardableResult
  static func remove(_ profileID: UUID) -> ConnectionSettings? {
    let next = state().removing(profileID)
    persist(next)
    return next.active
  }

  static func mergeDiscoveredHosts(
    base: ConnectionSettings, hosts: [HostInfo], selectedHostID: String?
  ) {
    guard !hosts.isEmpty else { return }
    let current = state()
    let next = current.mergingHosts(base: base, hosts: hosts, selectedHostID: selectedHostID)
    if next != current { persist(next) }
  }

  @discardableResult
  static func applyDebugEnvironment() -> Bool {
    #if DEBUG
      let environment = ProcessInfo.processInfo.environment
      guard let relayURL = environment["TB_RELAY_URL"], !relayURL.isEmpty else { return false }
      let current = load()
      let candidate = ConnectionSettings(
        profileID: current.profileID == ConnectionSettings.defaults.profileID ? UUID() : current.profileID,
        relayURL: relayURL, hostID: environment["TB_HOST_ID"] ?? current.hostID,
        secret: environment["TB_SECRET"] ?? current.secret,
        tlsFingerprint: environment["TB_TLS_FINGERPRINT"] ?? current.tlsFingerprint,
        hostName: environment["TB_HOST_NAME"] ?? current.hostName)
      guard candidate.validationError == nil else { return false }
      save(candidate)
      return true
    #else
      return false
    #endif
  }

  private static func state() -> ConnectionProfileState {
    let defaults = UserDefaults.standard
    if let data = defaults.data(forKey: profilesKey),
      let records = try? JSONDecoder().decode([Record].self, from: data)
    {
      let profiles = records.map { record in
        ConnectionSettings(
          profileID: record.profileID, relayURL: record.relayURL, hostID: record.hostID,
          secret: readSecret(account: record.profileID.uuidString),
          tlsFingerprint: record.tlsFingerprint, hostName: record.hostName, mode: record.mode)
      }
      let activeID = defaults.string(forKey: activeKey).flatMap(UUID.init(uuidString:))
      return ConnectionProfileState(profiles: profiles, activeID: activeID)
    }
    guard defaults.bool(forKey: legacyConfiguredKey) else {
      return ConnectionProfileState(profiles: [], activeID: nil)
    }
    let migrated = ConnectionSettings(
      relayURL: defaults.string(forKey: legacyRelayKey) ?? ConnectionSettings.defaults.relayURL,
      hostID: defaults.string(forKey: legacyHostKey) ?? "",
      secret: readSecret(account: legacyKeychainAccount),
      tlsFingerprint: defaults.string(forKey: legacyFingerprintKey) ?? "")
    let migratedState = ConnectionProfileState(profiles: [migrated], activeID: migrated.profileID)
    persist(migratedState, notify: false)
    return migratedState
  }

  private static func persist(_ state: ConnectionProfileState, notify: Bool = true) {
    let defaults = UserDefaults.standard
    let records = state.profiles.map {
      Record(profileID: $0.profileID, relayURL: $0.relayURL, hostID: $0.hostID,
        tlsFingerprint: $0.normalizedFingerprint, hostName: $0.hostName, mode: $0.mode)
    }
    if let data = try? JSONEncoder().encode(records) { defaults.set(data, forKey: profilesKey) }
    if let activeID = state.activeID { defaults.set(activeID.uuidString, forKey: activeKey) }
    else { defaults.removeObject(forKey: activeKey) }
    let retained = Set(state.profiles.map { $0.profileID.uuidString })
    for profile in state.profiles { saveSecret(profile.secret, account: profile.profileID.uuidString) }
    if let previous = try? keychainAccounts() {
      for account in previous where account != legacyKeychainAccount && !retained.contains(account) {
        deleteSecret(account: account)
      }
    }
    if notify { NotificationCenter.default.post(name: .termbridgeSettingsDidChange, object: nil) }
  }

  private static func readSecret(account: String) -> String {
    let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
      kSecAttrService: keychainService, kSecAttrAccount: account,
      kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]
    var result: CFTypeRef?
    if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data,
      let secret = String(data: data, encoding: .utf8)
    { return secret }
    #if DEBUG
      return processSecrets.secret(for: account) ?? ""
    #else
      return ""
    #endif
  }

  private static func saveSecret(_ secret: String, account: String) {
    deleteSecret(account: account)
    guard !secret.isEmpty else { return }
    #if DEBUG
      processSecrets.set(secret, for: account)
    #endif
    let value: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
      kSecAttrService: keychainService, kSecAttrAccount: account,
      kSecValueData: Data(secret.utf8),
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    SecItemAdd(value as CFDictionary, nil)
  }

  private static func deleteSecret(account: String) {
    #if DEBUG
      processSecrets.remove(account)
    #endif
    SecItemDelete([kSecClass: kSecClassGenericPassword, kSecAttrService: keychainService,
      kSecAttrAccount: account] as CFDictionary)
  }

  private static func keychainAccounts() throws -> [String] {
    let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword,
      kSecAttrService: keychainService, kSecReturnAttributes: true,
      kSecMatchLimit: kSecMatchLimitAll]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
    return (result as? [[CFString: Any]])?.compactMap { $0[kSecAttrAccount] as? String } ?? []
  }
}

// Shared by the native Apple clients. Discovery never sends the connection password.
import CryptoKit

enum LANConnection {
  static func isUnicastIPv4(_ address: String) -> Bool {
    let pieces = address.split(separator: ".", omittingEmptySubsequences: false)
    guard pieces.count == 4, pieces.allSatisfy({ !$0.isEmpty && !($0.count > 1 && $0.first == "0") && $0.utf8.allSatisfy { (48...57).contains($0) } }),
      pieces.allSatisfy({ Int($0).map { (0...255).contains($0) } == true }) else { return false }
    return (1...223).contains(Int(pieces[0])!)
  }
  static func isPrivate(_ address: String) -> Bool {
    guard isUnicastIPv4(address) else { return false }
    let n = address.split(separator: ".").compactMap { Int($0) }
    return n[0] == 10 || n[0] == 127 || (n[0] == 192 && n[1] == 168)
      || (n[0] == 172 && (16...31).contains(n[1])) || (n[0] == 169 && n[1] == 254)
  }
  static func isDirectEndpoint(_ endpoint: String) -> Bool {
    guard let url = URLComponents(string: endpoint), ["ws", "wss"].contains(url.scheme?.lowercased() ?? ""),
      let host = url.host, isUnicastIPv4(host), let port = url.port,
      (1024...65535).contains(port), url.user == nil, url.password == nil,
      url.query == nil, url.fragment == nil else { return false }
    return url.path.isEmpty || url.path == "/"
  }
  static func endpoint(address: String, port: String, useTLS: Bool = false) throws -> String {
    let ip = address.trimmingCharacters(in: .whitespacesAndNewlines)
    guard isUnicastIPv4(ip), let number = Int(port), (1024...65535).contains(number) else {
      throw NSError(domain: "LANConnection", code: 1, userInfo: [NSLocalizedDescriptionKey: "请输入内网 IPv4 地址和 1024–65535 范围内的端口。"])
    }
    return "\(useTLS ? "wss" : "ws")://\(ip):\(number)"
  }
  static func probe(_ endpoint: String) async throws -> String {
    guard isDirectEndpoint(endpoint), var parts = URLComponents(string: endpoint), parts.scheme == "wss" else {
      throw URLError(.badURL)
    }
    parts.scheme = "https"
    guard let url = parts.url else { throw URLError(.badURL) }
    let probe = LANCertificateProbe()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { probe.start(url, continuation: $0) }
    } onCancel: { probe.cancel() }
  }
}

private final class LANCertificateProbe: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<String, Error>?
  private var session: URLSession?
  private var completed = false
  func start(_ url: URL, continuation: CheckedContinuation<String, Error>) {
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 8; config.timeoutIntervalForResource = 10
    config.connectionProxyDictionary = [:]
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    var request = URLRequest(url: url); request.httpMethod = "HEAD"
    let task = session.dataTask(with: request)
    lock.lock()
    if completed {
      lock.unlock(); session.invalidateAndCancel(); continuation.resume(throwing: CancellationError()); return
    }
    self.continuation = continuation; self.session = session
    lock.unlock()
    task.resume()
  }
  func cancel() { finish(.failure(CancellationError())) }
  private func finish(_ result: Result<String, Error>) {
    lock.lock()
    guard !completed else { lock.unlock(); return }
    completed = true
    let pending = continuation, session = session
    continuation = nil; self.session = nil
    lock.unlock()
    pending?.resume(with: result)
    session?.invalidateAndCancel()
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = certificates.first {
      let digest = SHA256.hash(data: SecCertificateCopyData(leaf) as Data).map { String(format: "%02x", $0) }.joined()
      // Discovery sends no HTTP request or password; authentication is a separate
      // connection pinned to this exact certificate.
      completionHandler(.cancelAuthenticationChallenge, nil)
      finish(.success(digest))
    } else {
      completionHandler(.cancelAuthenticationChallenge, nil)
      finish(.failure(URLError(.serverCertificateUntrusted)))
    }
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    finish(.failure(error ?? URLError(.serverCertificateUntrusted)))
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil); finish(.failure(URLError(.redirectToNonExistentLocation)))
  }
}


/// Desktop login is local to the exact paired endpoint, Host and trust material.
/// It is separate from the pairing secret and never travels through Brain.
struct DesktopLoginCredentials: Codable, Equatable {
  let username: String
  let password: String
}

struct DesktopCredentialStore {
  private let settings: ConnectionSettings
  init(settings: ConnectionSettings) { self.settings = settings }
  static func account(for settings: ConnectionSettings) -> String {
    let normalized = settings.normalized()
    let scope = try! JSONEncoder().encode([normalized.relayURL, normalized.hostID, normalized.secret, normalized.tlsFingerprint])
    return SHA256.hash(data: scope).map { String(format: "%02x", $0) }.joined()
  }
  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: "com.termbridge.ios.desktop-login",
     kSecAttrAccount as String: Self.account(for: settings)]
  }
  func load() -> DesktopLoginCredentials? {
    var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess,
      let data = result as? Data else { return nil }
    return try? JSONDecoder().decode(DesktopLoginCredentials.self, from: data)
  }
  func save(_ credentials: DesktopLoginCredentials) throws {
    let data = try JSONEncoder().encode(credentials)
    var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var q = query; q[kSecValueData as String] = data
      q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(q as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
  }
  func clear() { SecItemDelete(query as CFDictionary) }
}
