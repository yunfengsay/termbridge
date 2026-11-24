import Foundation

/// Decides which clicked URLs in a remote Host session should open inside the Host's proxy browser.
enum MacRemoteBrowserPolicy {
    static func shouldIntercept(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        guard let rawHost = url.host?.trimmingCharacters(in: .whitespacesAndNewlines), !rawHost.isEmpty else { return false }
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if isLoopbackHost(host) { return true }
        if host == "0.0.0.0" || host == "::" || host == "0:0:0:0:0:0:0:0" { return true }
        if isPrivateIPv4(host) { return true }
        if host.hasSuffix(".local") || host.hasSuffix(".localhost") || host.hasSuffix(".internal") || host.hasSuffix(".lan") {
            return true
        }
        if !host.contains(".") && !host.contains(":") { return true }
        return false
    }

    static func normalizeEntryURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 4096 else { return nil }
        let candidate: String
        if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
            candidate = trimmed
        } else if !trimmed.contains("://") {
            candidate = "http://\(trimmed)"
        } else {
            return nil
        }
        guard var components = URLComponents(string: candidate),
              let scheme = components.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty else { return nil }
        let lower = host.lowercased()
        if lower == "0.0.0.0" || lower == "::" || lower == "[::]" {
            components.host = "127.0.0.1"
        }
        return components.url
    }

    static func isLoopbackHost(_ host: String) -> Bool {
        let lower = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if lower == "localhost" || lower == "::1" || lower == "0:0:0:0:0:0:0:1" || lower.hasSuffix(".localhost") {
            return true
        }
        let parts = lower.split(separator: ".")
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        return octets.count == 4 && octets.allSatisfy { (0...255).contains($0) } && octets[0] == 127
    }

    static func isPrivateIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".")
        guard parts.count == 4 else { return false }
        let octets = parts.compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
        let (a, b) = (octets[0], octets[1])
        return a == 10
            || (a == 172 && (16...31).contains(b))
            || (a == 192 && b == 168)
            || (a == 169 && b == 254)
            || (a == 100 && (64...127).contains(b))
    }
}
