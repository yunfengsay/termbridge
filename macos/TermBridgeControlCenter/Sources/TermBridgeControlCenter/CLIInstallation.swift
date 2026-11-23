import Foundation
import CryptoKit
import Darwin

struct CLIInstallationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// All blocking work runs on a utility task. Child output stays in a private temporary
/// file, avoiding full stdout/stderr pipes and keeping credentials out of UI errors.
enum CLICommand {
    static func run(_ executable: String, _ arguments: [String], environment: [String: String],
                    timeout: TimeInterval = 30) throws -> String {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tb-command-" + UUID().uuidString)
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CLIInstallationError(message: "无法创建安装临时文件，请检查磁盘空间。")
        }
        defer { try? FileManager.default.removeItem(at: url) }
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable); process.arguments = arguments
        process.environment = environment; process.currentDirectoryURL = url.deletingLastPathComponent()
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = handle; process.standardError = handle
        try process.run()
        let grouped = getpgid(process.processIdentifier) == process.processIdentifier || setpgid(process.processIdentifier, process.processIdentifier) == 0
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning {
            if Date() >= deadline {
                if grouped { kill(-process.processIdentifier, SIGKILL) }
                else { kill(process.processIdentifier, SIGKILL) }
                process.waitUntilExit()
                throw CLIInstallationError(message: "操作超时，请检查网络后重试。")
            }
            Thread.sleep(forTimeInterval: 0.03)
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw CLIInstallationError(message: "\(URL(fileURLWithPath: executable).lastPathComponent) 执行失败（\(process.terminationStatus)）。请检查网络和磁盘空间后重试。")
        }
        let reader = try FileHandle(forReadingFrom: url); defer { try? reader.close() }
        let end = try reader.seekToEnd()
        try reader.seek(toOffset: end > 64 * 1024 ? end - 64 * 1024 : 0)
        return String(decoding: try reader.read(upToCount: 64 * 1024) ?? Data(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct CLIInstallation {
    typealias Available = CLIDiscovery.Program
    let home: URL
    var sourceEnvironment: [String: String]? = nil
    var root: URL { home.appendingPathComponent("Library/Application Support/TermBridge/CLI") }
    var launcher: URL { home.appendingPathComponent(".local/bin/tb") }
    var environment: [String: String] {
        let source = sourceEnvironment ?? ProcessInfo.processInfo.environment
        var result = source.filter { ["USER", "LOGNAME", "TMPDIR", "SHELL", "ZDOTDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                                     "http_proxy", "https_proxy", "all_proxy", "no_proxy", "TB_SETTINGS"].contains($0.key) }
        result["HOME"] = home.path
        let fallback = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        result["PATH"] = home.appendingPathComponent(".local/bin").path + ":" + (source["PATH"] ?? fallback)
            + (sourceEnvironment == nil ? ":" + fallback : "")
        result["LANG"] = "en_US.UTF-8"
        return result
    }
    static func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
    static func validVersion(_ output: String) -> String? {
        output.split(separator: "\n").map(String.init).first {
            $0.range(of: #"^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$"#, options: .regularExpression) != nil
        }
    }
    func inspect() -> CLIDiscovery.Result { CLIDiscovery(environment: environment).inspect() }
    func detect() -> Available? { inspect().cli }
    func environment(for cli: Available) -> [String: String] {
        var env = environment
        if !cli.searchPath.isEmpty { env["PATH"] = cli.searchPath }
        return env
    }
    func install(force: Bool = false, progress: @Sendable (String) -> Void) throws -> Available {
        progress("正在检查已有 CLI 和 Node…")
        let discovery = inspect()
        if !force {
            if let cli = discovery.cli { progress("使用已有 CLI：\(cli.path)"); return cli }
            guard discovery.mayBootstrap else { throw CLIInstallationError(message: discovery.summary) }
        }
        let fm = FileManager.default
        if fm.fileExists(atPath: launcher.path) || (try? fm.destinationOfSymbolicLink(atPath: launcher.path)) != nil {
            guard let destination = try? fm.destinationOfSymbolicLink(atPath: launcher.path), destination == root.appendingPathComponent("current/launcher").path else {
                throw CLIInstallationError(message: "~/.local/bin/tb 已有其他安装，请保留或移动该文件后重试。")
            }
        }
        try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let release = root.appendingPathComponent("releases/" + UUID().uuidString)
        try fm.createDirectory(at: release, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        var activated = false
        defer { if !activated { try? fm.removeItem(at: release) } }
        let runtime: CLIDiscovery.Runtime
        if let existing = discovery.runtime {
            guard existing.npm != nil else { throw CLIInstallationError(message: "已找到 Node \(existing.node.version)，但缺少可用 npm。请补齐 npm；不会重复下载 Node。") }
            progress("复用本机 Node \(existing.node.version)：\(existing.node.path)")
            runtime = existing
        } else {
            progress(discovery.outdatedNodes.isEmpty ? "未找到可用 Node，正在下载 Node.js 24…" : "现有 Node 版本不兼容，正在下载 Node.js 24…")
            runtime = try downloadRuntime(into: release)
        }
        let node = runtime.node.path
        var env = environment
        env["PATH"] = URL(fileURLWithPath: node).deletingLastPathComponent().path + ":" + runtime.node.searchPath
        progress("正在安装 TB CLI 和终端组件…")
        _ = try CLICommand.run(node, [runtime.npm!,
            "install", "--global", "--prefix", release.path, "agent-termbridge@latest", "--registry=https://registry.npmjs.org",
            "--userconfig=/dev/null", "--globalconfig", release.appendingPathComponent("empty-global.npmrc").path, "--cache", root.appendingPathComponent("cache").path,
            "--no-audit", "--no-fund", "--fetch-timeout=120000", "--fetch-retries=2"], environment: env, timeout: 600)
        progress("正在验证 CLI 和本机终端组件…")
        let entry = release.appendingPathComponent("lib/node_modules/agent-termbridge/dist/cli.js").path
        let output = try CLICommand.run(node, [entry, "--version"], environment: env)
        guard let cliVersion = Self.validVersion(output) else { throw CLIInstallationError(message: "CLI 版本验证失败，原安装保持可用。") }
        // A version command alone does not prove that optional node-pty installed.
        _ = try CLICommand.run(node, ["-e", "const {createRequire}=require('module'); const r=createRequire(process.argv[1]); const p=r('node-pty').spawn('/usr/bin/true',[],{env:{PATH:'/usr/bin:/bin'},cwd:'/tmp'}); p.onExit(e=>process.exit(e.exitCode)); setTimeout(()=>process.exit(2),5000).unref();", entry], environment: env)
        let bin = release.appendingPathComponent("launcher")
        let script = "#!/bin/sh\n# TermBridge managed CLI\nexport PATH=\(Self.quote(env["PATH"]!))\nexec \(Self.quote(node)) \(Self.quote(entry)) \"$@\"\n"
        try Data(script.utf8).write(to: bin); try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bin.path)
        // Do not overwrite unrelated user commands. A previous managed link can be replaced.
        try fm.createDirectory(at: launcher.deletingLastPathComponent(), withIntermediateDirectories: true)
        let current = root.appendingPathComponent("current")
        let next = root.appendingPathComponent("next-" + UUID().uuidString)
        try fm.createSymbolicLink(at: next, withDestinationURL: release)
        guard rename(next.path, current.path) == 0 else { try? fm.removeItem(at: next); throw CLIInstallationError(message: "无法启用 CLI，请检查安装目录权限。") }
        activated = true // Retain previous releases: a running Host may still use them.
        if (try? fm.destinationOfSymbolicLink(atPath: launcher.path)) == nil {
            try fm.createSymbolicLink(at: launcher, withDestinationURL: current.appendingPathComponent("launcher"))
        }
        progress("正在设置终端命令路径…")
        try configureShellPath()
        let result = try CLICommand.run(launcher.path, ["--version"], environment: env)
        guard Self.validVersion(result) == cliVersion else { throw CLIInstallationError(message: "安装完成，但命令入口未通过验证，请点击修复。") }
        return Available(path: launcher.path, version: cliVersion, searchPath: env["PATH"]!)
    }

    private func downloadRuntime(into release: URL) throws -> CLIDiscovery.Runtime {
        let fm = FileManager.default
        #if arch(arm64)
        let arch = "arm64"
        #else
        let arch = "x64"
        #endif
        let sums = release.appendingPathComponent("SHASUMS256.txt")
        try download("https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt", to: sums, maxBytes: 100_000)
        let manifest = try String(contentsOf: sums, encoding: .utf8)
        let (filename, checksum) = try Self.archive(in: manifest, architecture: arch)
        let archive = release.appendingPathComponent(filename)
        let version = filename.components(separatedBy: "-")[1]
        try download("https://nodejs.org/dist/\(version)/\(filename)", to: archive, maxBytes: 100_000_000)
        guard Self.sha256(try Data(contentsOf: archive)) == checksum else {
            throw CLIInstallationError(message: "Node.js 下载校验失败，请重新安装。")
        }
        let runtime = release.appendingPathComponent("runtime")
        try fm.createDirectory(at: runtime, withIntermediateDirectories: true)
        _ = try CLICommand.run("/usr/bin/tar", ["-xzf", archive.path, "--strip-components=1", "-C", runtime.path], environment: environment, timeout: 60)
        try fm.removeItem(at: archive); try fm.removeItem(at: sums)
        return CLIDiscovery.Runtime(node: .init(path: runtime.appendingPathComponent("bin/node").path,
            version: String(version.dropFirst()), searchPath: runtime.appendingPathComponent("bin").path + ":" + environment["PATH"]!),
            npm: runtime.appendingPathComponent("lib/node_modules/npm/bin/npm-cli.js").path)
    }
    private func download(_ source: String, to file: URL, maxBytes: Int) throws {
        _ = try CLICommand.run("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
            "--connect-timeout", "20", "--max-time", "240", "--retry", "2", "--max-filesize", String(maxBytes), "--output", file.path, source],
            environment: environment, timeout: 750)
    }
    static func archive(in manifest: String, architecture: String) throws -> (String, String) {
        for line in manifest.split(separator: "\n") {
            let fields = line.split(whereSeparator: \.isWhitespace).map(String.init)
            guard fields.count == 2, fields[0].range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil,
                  fields[1].range(of: "^node-v24\\.\\d+\\.\\d+-darwin-\(architecture)\\.tar\\.gz$", options: .regularExpression) != nil else { continue }
            return (fields[1], fields[0])
        }
        throw CLIInstallationError(message: "未找到适合这台 Mac 的 Node.js 安装包。")
    }
    static func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    func configureShellPath() throws {
        let fm = FileManager.default
        let zshDirectory = environment["ZDOTDIR"].flatMap { $0.hasPrefix("/") ? URL(fileURLWithPath: $0) : nil } ?? home
        try fm.createDirectory(at: zshDirectory, withIntermediateDirectories: true)
        // Bash reads only the first existing login profile. Creating .bash_profile
        // unconditionally would silently disable an existing .bash_login/.profile.
        let bashLogin = [".bash_profile", ".bash_login", ".profile"].map { home.appendingPathComponent($0) }.first {
            fm.fileExists(atPath: $0.path) || (try? fm.destinationOfSymbolicLink(atPath: $0.path)) != nil
        } ?? home.appendingPathComponent(".bash_profile")
        let files = [zshDirectory.appendingPathComponent(".zprofile"), zshDirectory.appendingPathComponent(".zshrc"),
                     bashLogin, home.appendingPathComponent(".bashrc")]
        let marker = "# TermBridge CLI PATH"
        for file in files {
            let exists = FileManager.default.fileExists(atPath: file.path)
            let original = exists ? try String(contentsOf: file, encoding: .utf8) : ""
            if original.contains(marker) { continue }
            let addition = "\n\(marker)\ncase \"$PATH\" in \"$HOME/.local/bin\":*) ;; *) export PATH=\"$HOME/.local/bin:$PATH\" ;; esac\n"
            // Append instead of replacing a dotfile or its symlink target.
            if !exists { FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
            let handle = try FileHandle(forWritingTo: file); defer { try? handle.close() }
            try handle.seekToEnd(); try handle.write(contentsOf: Data(addition.utf8))
        }
    }
}
