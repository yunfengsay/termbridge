import Foundation

/// Uses the existing authenticated TB client; session identifiers never become shell source.
struct TerminalLaunch {
    let executable: String
    let arguments: [String]
    let detachHint: String
    var searchPath: String? = nil

    static func environment(from source: [String: String] = ProcessInfo.processInfo.environment, searchPath: String? = nil) -> [String] {
        // Pass client transport settings, never Host model credentials or Agent identity.
        var source = herdrEnvironment(from: source)
        let bin = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path
        source["PATH"] = searchPath ?? (bin + ":" + (source["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"))
        let keys = ["HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "RELAY_URL", "TB_SETTINGS",
                    "TB_SECRET", "TB_TLS_PIN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                    "HERDR_SOCKET_PATH", "HERDR_CONFIG_PATH", "HERDR_SESSION"]
        return keys.compactMap { key in source[key].map { "\(key)=\($0)" } }
            + ["TERM=xterm-256color", "COLORTERM=truecolor", "LANG=en_US.UTF-8"]
    }

    /// Keep the resolver and attached client on the same explicit Herdr transport.
    static func herdrEnvironment(from source: [String: String] = ProcessInfo.processInfo.environment) -> [String: String] {
        var environment = source
        if let socket = source["TB_HERDR_SOCKET"], !socket.isEmpty {
            environment["HERDR_SOCKET_PATH"] = socket
        }
        return environment
    }

    init(sessionId: String, hostId: String, cli: CLIInstallation.Available? = nil) throws {
        guard Self.validIdentifier(sessionId), Self.validIdentifier(hostId) else {
            throw LaunchError.invalidIdentity
        }
        if let cli {
            executable = cli.path
            arguments = ["--host", hostId, "attach", "--", sessionId]
            searchPath = cli.searchPath
        } else {
            arguments = ["-lc", "exec tb --host \"$1\" attach -- \"$2\"", "termbridge-terminal", hostId, sessionId]
            executable = "/bin/zsh"
        }
        detachHint = "Ctrl-] to detach"
    }

    init(herdrExecutable: String, terminalId: String) throws {
        guard Self.validIdentifier(terminalId) else { throw LaunchError.invalidIdentity }
        executable = herdrExecutable
        arguments = ["terminal", "attach", terminalId]
        detachHint = "Ctrl-B, Q to detach"
    }

    init(herdrExecutable: String, agentPaneId: String) throws {
        guard Self.validIdentifier(agentPaneId) else { throw LaunchError.invalidIdentity }
        executable = herdrExecutable
        arguments = ["agent", "attach", agentPaneId]
        detachHint = "Ctrl-B, Q to detach"
    }

    static func localHostId() throws -> String {
        let environment = ProcessInfo.processInfo.environment
        if let explicit = environment["HOST_ID"], !explicit.isEmpty { return explicit }
        let url = environment["TB_HOST_ID_FILE"].map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".termbridge/host-id")
        return try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func validIdentifier(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 256 && value.utf8.allSatisfy {
            (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
                || [45, 46, 58, 95].contains($0)
        } && !value.hasPrefix("-")
    }

    enum LaunchError: LocalizedError {
        case invalidIdentity
        var errorDescription: String? { "The Host or session ID is invalid. Refresh the session list and try again." }
    }
}
