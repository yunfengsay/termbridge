import Foundation
import Darwin

/// A shell entry point into the signed App runtime. The App need not be running.
/// Keep the bundle path, rather than a versioned extraction path, so App updates
/// also update the command without downloading a second Node/npm installation.
struct CLIAppExtension {
    let installation: CLIInstallation
    let bundle: URL
    var runtime: URL { bundle.appendingPathComponent("Contents/Resources/Runtime") }
    var node: URL { runtime.appendingPathComponent("node") }
    var entry: URL { runtime.appendingPathComponent("package/dist/cli.js") }
    var command: URL { installation.root.appendingPathComponent("app-launcher") }
    var isExported: Bool {
        (try? FileManager.default.destinationOfSymbolicLink(atPath: installation.launcher.path)) == command.path
    }
    var version: String? {
        guard FileManager.default.isExecutableFile(atPath: node.path),
              FileManager.default.fileExists(atPath: entry.path),
              let data = try? Data(contentsOf: runtime.appendingPathComponent("package/package.json")),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let value = object["version"] as? String else { return nil }
        return CLIInstallation.validVersion(value)
    }
    func export() throws -> CLIInstallation.Available {
        let fm = FileManager.default
        guard let version else { throw CLIInstallationError(message: "App 内置命令不完整，请重新安装正式 App。") }
        let link = try? fm.destinationOfSymbolicLink(atPath: installation.launcher.path)
        let previousManaged = installation.root.appendingPathComponent("current/launcher").path
        if fm.fileExists(atPath: installation.launcher.path) || link != nil {
            guard link == command.path || link == previousManaged else {
                throw CLIInstallationError(message: "~/.local/bin/tb 已有其他命令，未覆盖。请先移走该入口再添加。")
            }
        }
        // Verify the real executable before changing shell files or command links.
        let result = try CLICommand.run(node.path, [entry.path, "--version"], environment: installation.environment)
        guard CLIInstallation.validVersion(result) == version else {
            throw CLIInstallationError(message: "内置命令验证失败，原命令入口未更改。")
        }
        try fm.createDirectory(at: installation.root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try fm.createDirectory(at: installation.launcher.deletingLastPathComponent(), withIntermediateDirectories: true)
        let q = CLIInstallation.quote
        let script = """
        #!/bin/sh
        # TermBridge App command extension
        export TB_APP_BUNDLE=\(q(bundle.path))
        if [ ! -x \(q(node.path)) ]; then
          echo 'TermBridge App 已移动或移除，请在 App 设置中重新添加命令行入口。' >&2
          exit 127
        fi
        exec \(q(node.path)) \(q(entry.path)) "$@"

        """
        try Data(script.utf8).write(to: command, options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: command.path)
        try installation.configureShellPath()
        let pending = installation.launcher.deletingLastPathComponent().appendingPathComponent(".tb-" + UUID().uuidString)
        try fm.createSymbolicLink(at: pending, withDestinationURL: command)
        defer { try? fm.removeItem(at: pending) }
        guard rename(pending.path, installation.launcher.path) == 0 else {
            throw CLIInstallationError(message: "无法添加命令行入口，请检查 ~/.local/bin 权限。")
        }
        return .init(path: installation.launcher.path, version: version, searchPath: installation.environment["PATH"] ?? "")
    }
    func remove() throws {
        guard isExported else { return }
        try FileManager.default.removeItem(at: installation.launcher)
        // Leave PATH and previous independently installed CLI releases intact.
    }
}
