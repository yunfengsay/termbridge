import XCTest
@testable import TermBridgeControlCenter

final class CLIAppExtensionTests: XCTestCase {
    private func fixture() throws -> CLIAppExtension {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tb app 'space' " + UUID().uuidString)
        let installation = CLIInstallation(home: home, sourceEnvironment: ["PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh"])
        let command = CLIAppExtension(installation: installation, bundle: home.appendingPathComponent("Applications/TermBridge.app"))
        try FileManager.default.createDirectory(at: command.entry.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: command.node, withDestinationURL: URL(fileURLWithPath: "/bin/sh"))
        try Data("{\"version\":\"0.1.34\"}".utf8).write(to: command.runtime.appendingPathComponent("package/package.json"))
        try Data("if [ \"$1\" = --version ]; then echo 0.1.34; else printf '%s\\n' \"$TB_APP_BUNDLE\" \"$@\"; fi\n".utf8).write(to: command.entry)
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        return command
    }
    func testExportRunsWithoutNodeOnPathAndPreservesArguments() throws {
        let command = try fixture()
        let result = try command.export()
        XCTAssertEqual(result.version, "0.1.34")
        XCTAssertTrue(command.isExported)
        let args = ["a b", "$(touch /tmp/not-executed)", "'quoted'", "中文"]
        let output = try CLICommand.run(result.path, args, environment: command.installation.environment)
        XCTAssertEqual(output, ([command.bundle.path] + args).joined(separator: "\n"))
        _ = try command.export()
        let profile = try String(contentsOf: command.installation.home.appendingPathComponent(".zshrc"))
        XCTAssertEqual(profile.components(separatedBy: "# TermBridge CLI PATH").count, 2)
        try command.remove()
        XCTAssertFalse(command.isExported)
        XCTAssertTrue(FileManager.default.fileExists(atPath: command.entry.path))
    }
    func testExportFollowsReplacedAppAndPreservesForeignCommand() throws {
        let command = try fixture()
        _ = try command.export()
        try Data("echo updated-app-runtime\n".utf8).write(to: command.entry)
        XCTAssertEqual(try CLICommand.run(command.installation.launcher.path, ["--version"], environment: command.installation.environment), "updated-app-runtime")
        try command.remove()
        try Data("foreign-command".utf8).write(to: command.installation.launcher)
        XCTAssertThrowsError(try command.export())
        try command.remove()
        XCTAssertEqual(try String(contentsOf: command.installation.launcher), "foreign-command")
    }
    func testMissingRuntimeDoesNotChangeShellFiles() throws {
        let command = try fixture()
        try FileManager.default.removeItem(at: command.node)
        XCTAssertThrowsError(try command.export())
        XCTAssertFalse(FileManager.default.fileExists(atPath: command.installation.home.appendingPathComponent(".zshrc").path))
    }
    func testPackagedNodeRunsExportedCommandWithoutGlobalNode() throws {
        guard let runtime = ProcessInfo.processInfo.environment["TB_TEST_LAN_RUNTIME"] else { throw XCTSkip("Explicit packaged runtime only") }
        let home = URL(fileURLWithPath: "/tmp/tb-cli-export-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: home) }
        let installation = CLIInstallation(home: home, sourceEnvironment: ["PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh"])
        let command = CLIAppExtension(installation: installation, bundle: home.appendingPathComponent("Applications/TermBridge.app"))
        try FileManager.default.createDirectory(at: command.runtime.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: command.runtime, withDestinationURL: URL(fileURLWithPath: runtime))
        let exported = try command.export()
        XCTAssertEqual(try CLICommand.run(exported.path, ["--version"], environment: ["PATH": "/usr/bin:/bin", "HOME": home.path]), command.version)
        let help = try CLICommand.run(exported.path, ["--help"], environment: ["PATH": "/usr/bin:/bin", "HOME": home.path])
        XCTAssertTrue(help.contains("update")); XCTAssertTrue(help.contains("topology")); XCTAssertTrue(help.contains("setup"))
    }
}
