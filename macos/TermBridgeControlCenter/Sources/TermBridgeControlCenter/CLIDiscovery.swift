import Foundation
import Darwin

/// Discover executable files in the user's shell environment, not aliases or
/// functions. Only PATH crosses back from shell startup; never import its secrets.
struct CLIDiscovery {
    struct Program: Equatable {
        let path: String
        let version: String
        var searchPath: String = ""
    }
    struct Runtime: Equatable {
        let node: Program
        let npm: String?
    }
    struct Result {
        var cli: Program?
        var runtime: Runtime?
        var problems: [String] = []
        var outdatedNodes: [String] = []
        var mayBootstrap: Bool { cli == nil && problems.isEmpty && (runtime == nil || runtime?.npm != nil) }
        var summary: String {
            if cli != nil { return "已检测到现有 CLI，直接使用，不重复安装。" }
            if !problems.isEmpty { return "检测未完成：" + problems.joined(separator: "；") + "。未自动安装。" }
            if let runtime {
                return runtime.npm == nil ? "已找到 Node \(runtime.node.version)，但没有可用 npm；不会重复下载 Node。"
                    : "未找到 TB CLI，将复用 Node \(runtime.node.version) 安装。"
            }
            return outdatedNodes.isEmpty ? "未找到 TB CLI 和 Node，需要安装运行环境。"
                : "现有 Node \(outdatedNodes.joined(separator: "、")) 不满足 >=22.19.0，需要兼容运行环境。"
        }
    }

    typealias Runner = (String, [String], [String: String], TimeInterval) throws -> String
    let environment: [String: String]
    var shells: [String]? = nil
    var shellTimeout: TimeInterval = 3
    var run: Runner = { try CLICommand.run($0, $1, environment: $2, timeout: $3) }

    static func shellPaths(preferred: String?) -> [String] {
        var result: [String] = []
        let loginShell = getpwuid(getuid()).flatMap { $0.pointee.pw_shell }.map { String(cString: $0) }
        for shell in [preferred ?? loginShell ?? "/bin/zsh", "/bin/zsh", "/bin/bash"] {
            guard shell.hasPrefix("/"), ["zsh", "bash"].contains(URL(fileURLWithPath: shell).lastPathComponent),
                  !result.contains(shell), FileManager.default.isExecutableFile(atPath: shell) else { continue }
            result.append(shell)
        }
        return result
    }
    static func supportsNode(_ version: String) -> Bool {
        let parts = version.trimmingCharacters(in: CharacterSet(charactersIn: "v")).split(separator: ".")
        guard parts.count == 3, let major = Int(parts[0]), let minor = Int(parts[1]), Int(parts[2]) != nil else { return false }
        return major > 22 || (major == 22 && minor >= 19)
    }
    static func executables(_ name: String, in path: String) -> [String] {
        var found: [String] = []
        for dir in path.split(separator: ":") where dir.hasPrefix("/") {
            let file = URL(fileURLWithPath: String(dir)).appendingPathComponent(name).path
            if !found.contains(file), FileManager.default.isExecutableFile(atPath: file) { found.append(file) }
        }
        return found
    }

    func inspect() -> Result {
        var result = Result()
        var seenPaths = Set<String>()
        var shellErrors: [String] = [], cliErrors: [String] = [], nodeErrors: [String] = []
        func inspectPath(_ path: String) -> Bool {
            guard seenPaths.insert(path).inserted else { return result.cli != nil }
            var env = environment; env["PATH"] = path
            if result.runtime == nil {
                for candidate in Self.executables("node", in: path) {
                    do {
                        let marker = "TB_NODE_" + UUID().uuidString + "="
                        let output = try run(candidate, ["-e", "console.log('\(marker)'+JSON.stringify({version:process.versions.node,path:process.execPath}))"], env, 3)
                        guard let line = output.components(separatedBy: .newlines).last(where: { $0.hasPrefix(marker) }),
                              let data = String(line.dropFirst(marker.count)).data(using: .utf8),
                              let info = try JSONSerialization.jsonObject(with: data) as? [String: String],
                              let version = info["version"], let executable = info["path"], executable.hasPrefix("/") else {
                            throw CLIInstallationError(message: "Node 版本输出不可识别")
                        }
                        guard Self.supportsNode(version) else {
                            if !result.outdatedNodes.contains(version) { result.outdatedNodes.append(version) }
                            continue
                        }
                        // Check the capability the Host actually uses, not just a version number.
                        _ = try run(executable, ["-e", "require('node:sqlite'); require('node:fs/promises')"], env, 3)
                        let node = Program(path: executable, version: version, searchPath: path)
                        let bin = URL(fileURLWithPath: executable).deletingLastPathComponent()
                        let npmCandidates = [bin.deletingLastPathComponent().appendingPathComponent("lib/node_modules/npm/bin/npm-cli.js").path]
                            + Self.executables("npm", in: bin.path + ":" + path).map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
                        var seenNpm = Set<String>()
                        let npm = npmCandidates.filter { seenNpm.insert($0).inserted }.first { file in
                            guard FileManager.default.fileExists(atPath: file),
                                  let output = try? run(executable, [file, "--version"], env, 3) else { return false }
                            return CLIInstallation.validVersion(output) != nil
                        }
                        result.runtime = Runtime(node: node, npm: npm)
                        break
                    } catch { nodeErrors.append("Node 无法验证：\(candidate)") }
                }
            }
            for candidate in Self.executables("tb", in: path) {
                do {
                    let output = try run(candidate, ["--version"], env, 3)
                    guard let version = CLIInstallation.validVersion(output) else { throw CLIInstallationError(message: "CLI 版本输出不可识别") }
                    result.cli = Program(path: candidate, version: version, searchPath: path)
                    return true
                } catch { cliErrors.append("已找到 tb 但无法运行：\(candidate)") }
            }
            return false
        }

        // Prefer the configured interactive environment over a different global
        // installation. bash login shells need not source .bashrc, hence -ic too.
        for shell in shells ?? Self.shellPaths(preferred: environment["SHELL"]) {
            for mode in ["-lic", "-ic", "-lc"] {
                let marker = "TB_PATH_" + UUID().uuidString + "="
                do {
                    let output = try run(shell, [mode, "printf '\\n\(marker)%s\\n' \"$PATH\""], environment, shellTimeout)
                    guard let line = output.components(separatedBy: .newlines).last(where: { $0.hasPrefix(marker) }) else {
                        throw CLIInstallationError(message: "Shell 未返回 PATH")
                    }
                    if inspectPath(String(line.dropFirst(marker.count))) { return result }
                } catch { shellErrors.append("\(URL(fileURLWithPath: shell).lastPathComponent) \(mode) 失败或超时") }
            }
        }
        if inspectPath(environment["PATH"] ?? "") { return result }
        let failures = shellErrors + cliErrors + (result.runtime == nil ? nodeErrors : [])
        result.problems = failures.reduce(into: []) { if !$0.contains($1) { $0.append($1) } }
        return result
    }
}
