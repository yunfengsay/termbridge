import XCTest
@testable import TermBridgeControlCenter

final class CLIDiscoveryTests: XCTestCase {
    private func fixture(_ startupFile: String) throws -> (URL, String) {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("tb-discovery 'space' " + UUID().uuidString)
        let bin = home.appendingPathComponent("node manager/bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: home) }
        for file in [".zprofile", ".bash_profile"] {
            try Data("export PATH=/usr/bin:/bin\n".utf8).write(to: home.appendingPathComponent(file))
        }
        let tb = bin.appendingPathComponent("tb")
        try Data("#!/bin/sh\nprintf '9.8.7\\n'\n".utf8).write(to: tb)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tb.path)
        try Data("export PATH=\(CLIInstallation.quote(bin.path)):\"$PATH\"\n".utf8)
            .write(to: home.appendingPathComponent(startupFile))
        return (home, tb.path)
    }

    private func installer(_ home: URL, shell: String = "/bin/zsh") -> CLIInstallation {
        CLIInstallation(home: home, sourceEnvironment: ["PATH": "/usr/bin:/bin", "SHELL": shell])
    }

    func testDetectFindsCLIInitializedOnlyInZshrc() throws {
        let (home, path) = try fixture(".zshrc")
        let actual = installer(home).detect()
        XCTAssertEqual(actual?.path, path)
        XCTAssertEqual(actual?.version, "9.8.7")
    }

    func testDetectFindsCLIInitializedOnlyInBashrc() throws {
        let (home, path) = try fixture(".bashrc")
        let actual = installer(home, shell: "/bin/bash").detect()
        XCTAssertEqual(actual?.path, path)
        XCTAssertEqual(actual?.version, "9.8.7")
    }

    func testLoginProfilesAndBashProfileFallback() throws {
        for (file, shell) in [(".zprofile", "/bin/zsh"), (".bash_profile", "/bin/bash"), (".profile", "/bin/bash")] {
            let (home, path) = try fixture(file)
            if file == ".profile" { try FileManager.default.removeItem(at: home.appendingPathComponent(".bash_profile")) }
            XCTAssertEqual(installer(home, shell: shell).detect()?.path, path, file)
        }
    }

    func testNoisyShellAndCustomZdotdirDoNotConfuseVersionParsing() throws {
        let (home, path) = try fixture(".zshrc")
        let config = home.appendingPathComponent("zsh config")
        try FileManager.default.createDirectory(at: config, withIntermediateDirectories: true)
        let original = try String(contentsOf: home.appendingPathComponent(".zshrc"))
        try Data(("printf '12.0.0\\n'\n" + original).utf8).write(to: config.appendingPathComponent(".zshrc"))
        let installation = CLIInstallation(home: home, sourceEnvironment: ["PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh", "ZDOTDIR": config.path])
        XCTAssertEqual(installation.detect()?.path, path)
        XCTAssertEqual(installation.detect()?.version, "9.8.7")
    }

    func testExistingCLIInstallIsANoOpAndKeepsDiscoveredPATHForLaunch() throws {
        let (home, path) = try fixture(".bashrc")
        let bin = URL(fileURLWithPath: path).deletingLastPathComponent()
        let helper = bin.appendingPathComponent("tb-test-helper")
        try Data("#!/bin/sh\nprintf '9.8.7\\n'\n".utf8).write(to: helper)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helper.path)
        try Data("#!/bin/sh\nexec tb-test-helper \"$@\"\n".utf8).write(to: URL(fileURLWithPath: path))
        let installation = installer(home, shell: "/bin/bash")
        let found = try installation.install { XCTAssertFalse($0.contains("下载")) }
        XCTAssertEqual(found.path, path)
        XCTAssertFalse(FileManager.default.fileExists(atPath: installation.root.path))
        XCTAssertEqual(try CLICommand.run(found.path, ["--version"], environment: installation.environment(for: found)), "9.8.7")
        XCTAssertThrowsError(try CLICommand.run(found.path, ["--version"], environment: installation.environment))
    }

    func testProbeFailureCannotBecomeAutomaticInstallation() {
        let failed = CLIDiscovery(environment: ["PATH": "/usr/bin:/bin"], shells: ["/bin/zsh", "/bin/bash"], run: { _, _, _, _ in
            throw CLIInstallationError(message: "fixture timeout")
        }).inspect()
        XCTAssertNil(failed.cli)
        XCTAssertFalse(failed.problems.isEmpty)
        XCTAssertFalse(failed.mayBootstrap)
        XCTAssertTrue(failed.summary.contains("未自动安装"))
        let missing = CLIDiscovery(environment: ["PATH": "/usr/bin:/bin"], shells: []).inspect()
        XCTAssertTrue(missing.mayBootstrap)
    }

    @MainActor
    func testSettingsDoesNotAutoinstallAfterIncompleteDetection() async throws {
        let (home, _) = try fixture(".zshrc")
        for file in [".zshrc", ".bashrc"] {
            try Data("exit 19\n".utf8).write(to: home.appendingPathComponent(file))
        }
        let model = MacCLIInstaller(home: home, sourceEnvironment: ["PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh"])
        model.check()
        for _ in 0..<200 {
            if !model.busy { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertFalse(model.busy)
        XCTAssertNil(model.available)
        XCTAssertTrue(model.failed)
        XCTAssertTrue(model.status.contains("未自动安装"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer(home).root.path))
    }

    func testBrokenCLIIsNotReportedAsMissing() throws {
        let (home, path) = try fixture(".zshrc")
        try Data("#!/bin/sh\nexit 1\n".utf8).write(to: URL(fileURLWithPath: path))
        let result = CLIDiscovery(environment: ["PATH": URL(fileURLWithPath: path).deletingLastPathComponent().path], shells: []).inspect()
        XCTAssertNil(result.cli)
        XCTAssertTrue(result.problems.contains { $0.contains("已找到 tb 但无法运行") })
        XCTAssertFalse(result.mayBootstrap)
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer(home).root.path))
    }

    func testNodeVersionRequirement() {
        for version in ["22.19.0", "22.20.0", "24.2.0", "25.0.0"] { XCTAssertTrue(CLIDiscovery.supportsNode(version), version) }
        for version in ["20.19.0", "22.18.9", "24", "24.0.0-rc.1", "no version"] { XCTAssertFalse(CLIDiscovery.supportsNode(version), version) }
    }

    func testRuntimeSelectionAndMissingNpmNeverRequestAnotherNode() throws {
        let (home, tb) = try fixture(".zshrc")
        try FileManager.default.removeItem(atPath: tb)
        let bin = URL(fileURLWithPath: tb).deletingLastPathComponent()
        let node = bin.appendingPathComponent("node")
        try Data("#!/bin/sh\nexit 1\n".utf8).write(to: node)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: node.path)
        func probe(version: String, capabilityWorks: Bool = true) -> CLIDiscovery.Result {
            CLIDiscovery(environment: ["PATH": bin.path], shells: [], run: { _, args, _, _ in
                if let code = args.last, let range = code.range(of: #"TB_NODE_[A-F0-9-]+="#, options: .regularExpression) {
                    let info = try JSONSerialization.data(withJSONObject: ["version": version, "path": node.path])
                    return String(code[range]) + String(decoding: info, as: UTF8.self)
                }
                if args.first == "-e" && capabilityWorks { return "" }
                throw CLIInstallationError(message: "fixture unsupported runtime")
            }).inspect()
        }
        let found = probe(version: "24.2.0")
        XCTAssertEqual(found.runtime?.node.path, node.path)
        XCTAssertNil(found.runtime?.npm)
        XCTAssertFalse(found.mayBootstrap)
        XCTAssertTrue(found.summary.contains("不会重复下载 Node"))
        XCTAssertNil(probe(version: "22.18.0").runtime)
        XCTAssertTrue(probe(version: "22.18.0").mayBootstrap)
        XCTAssertFalse(probe(version: "24.2.0", capabilityWorks: false).mayBootstrap)
        XCTAssertFalse(FileManager.default.fileExists(atPath: installer(home).root.path))
    }

    func testActualInteractiveShellDetectionReadOnly() throws {
        guard ProcessInfo.processInfo.environment["TB_MACOS_DETECTION_TEST"] == "1" else { throw XCTSkip("Opt in to reading the real user's shell configuration") }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let installation = CLIInstallation(home: home, sourceEnvironment: ["PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh"])
        let start = Date()
        let result = installation.inspect()
        let cli = try XCTUnwrap(result.cli, result.summary)
        let runtime = try XCTUnwrap(result.runtime)
        XCTAssertTrue(CLIDiscovery.supportsNode(runtime.node.version))
        XCTAssertEqual(CLIInstallation.validVersion(try CLICommand.run(cli.path, ["--version"], environment: installation.environment(for: cli))), cli.version)
        print("Live CLI detection: \(cli.path) \(cli.version); Node \(runtime.node.path) \(runtime.node.version); \(Date().timeIntervalSince(start)) seconds; no installation")
    }

    func testInstallReusesRealNodeWithoutDownloadingRuntime() throws {
        guard ProcessInfo.processInfo.environment["TB_MACOS_REUSE_NODE_TEST"] == "1",
              let nodePath = ProcessInfo.processInfo.environment["TB_MACOS_TEST_NODE"] else { throw XCTSkip("Opt in to npm/PTY verification in an isolated directory using an existing Node") }
        let (home, tb) = try fixture(".zshrc")
        try FileManager.default.removeItem(atPath: tb)
        let bin = URL(fileURLWithPath: tb).deletingLastPathComponent()
        try FileManager.default.createSymbolicLink(at: bin.appendingPathComponent("node"), withDestinationURL: URL(fileURLWithPath: nodePath))
        let installation = installer(home)
        let result = try installation.install { message in
            print(message)
            XCTAssertFalse(message.contains("下载 Node"))
        }
        XCTAssertEqual(result.path, installation.launcher.path)
        let release = installation.root.appendingPathComponent("current").resolvingSymlinksInPath()
        XCTAssertFalse(FileManager.default.fileExists(atPath: release.appendingPathComponent("runtime").path))
        let launcher = try String(contentsOf: release.appendingPathComponent("launcher"))
        XCTAssertTrue(launcher.contains(CLIInstallation.quote(nodePath)))
        XCTAssertEqual(installation.detect()?.path, installation.launcher.path)
        print("Real npm + node-pty passed using existing Node; no runtime download")
    }
}
