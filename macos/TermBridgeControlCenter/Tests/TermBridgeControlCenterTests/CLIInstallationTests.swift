import XCTest
@testable import TermBridgeControlCenter

final class CLIInstallationTests: XCTestCase {
    private func temporaryHome() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("TB installer 'space' " + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }
    func testNewPairingRoundTripsWithoutCLIOrNetwork() throws {
        let relay = "wss://relay.example.test"
        let a = try CLIPairing.createCode(hostedRelay: relay); let b = try CLIPairing.createCode(hostedRelay: relay)
        XCTAssertNotEqual(a, b)
        let settings = try PairingCode.parse(a, hostedRelay: relay)
        XCTAssertTrue(settings.isHostedRoom)
        XCTAssertEqual(settings.secret.count, 43)
        XCTAssertNotNil(CLIPairing.qrCode(a))
        let uri = try CLIPairing.createURI(relayURL: relay, hostName: "Studio Mac")
        let parsedURI = try PairingCode.parse(uri)
        XCTAssertEqual(parsedURI.relayURL, relay)
        XCTAssertEqual(parsedURI.hostName, "Studio Mac")
        XCTAssertEqual(parsedURI.secret.count, 43)
    }
    func testManifestRejectsUnexpectedArchitectureVersionAndPath() throws {
        let digest = String(repeating: "a", count: 64)
        let manifest = "\(digest)  node-v24.3.2-darwin-arm64.tar.gz\n\(digest)  node-v24.3.2-darwin-x64.tar.gz"
        XCTAssertEqual(try CLIInstallation.archive(in: manifest, architecture: "arm64").0, "node-v24.3.2-darwin-arm64.tar.gz")
        for name in ["../node-v24.3.2-darwin-arm64.tar.gz", "node-v26.0.0-darwin-arm64.tar.gz", "node-v24.3.2-linux-arm64.tar.gz"] {
            XCTAssertThrowsError(try CLIInstallation.archive(in: "\(digest)  \(name)", architecture: "arm64"))
        }
        XCTAssertEqual(CLIInstallation.sha256(Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
    func testShellSetupPreservesContentAndLinksAndDoesNotRepeat() throws {
        let home = try temporaryHome(); let installer = CLIInstallation(home: home)
        let target = home.appendingPathComponent("custom-zsh")
        try Data("export EXISTING_VALUE=kept\n".utf8).write(to: target)
        let profile = home.appendingPathComponent(".zprofile")
        try FileManager.default.createSymbolicLink(at: profile, withDestinationURL: target)
        try installer.configureShellPath()
        let first = try String(contentsOf: profile)
        try installer.configureShellPath()
        XCTAssertEqual(try String(contentsOf: profile), first)
        XCTAssertTrue(first.hasPrefix("export EXISTING_VALUE=kept\n"))
        XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: profile.path), target.path)
        let output = try CLICommand.run("/bin/zsh", ["-lc", "printf '%s' \"$PATH\""], environment: installer.environment)
        XCTAssertTrue(output.contains(home.appendingPathComponent(".local/bin").path))
        let backups = try FileManager.default.contentsOfDirectory(at: home, includingPropertiesForKeys: nil).filter { $0.pathExtension == "bak" }
        XCTAssertEqual(backups.count, 0)
    }
    func testExistingCommandConflictFailsBeforeDownloading() throws {
        let home = try temporaryHome(); let installer = CLIInstallation(home: home)
        try FileManager.default.createDirectory(at: installer.launcher.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("keep my command".utf8).write(to: installer.launcher)
        XCTAssertThrowsError(try installer.install(force: true) { message in XCTAssertFalse(message.contains("下载")) })
        XCTAssertEqual(try String(contentsOf: installer.launcher), "keep my command")
    }
    func testShellSetupKeepsBashLoginFallbackAndCustomZdotdir() throws {
        for profile in [".bash_login", ".profile"] {
            let home = try temporaryHome()
            let zsh = home.appendingPathComponent("zsh config")
            try FileManager.default.createDirectory(at: zsh, withIntermediateDirectories: true)
            try Data("export TB_TEST_PROFILE=kept\n".utf8).write(to: home.appendingPathComponent(profile))
            let installer = CLIInstallation(home: home, sourceEnvironment: ["PATH": "/usr/bin:/bin", "ZDOTDIR": zsh.path])
            try installer.configureShellPath()
            XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".bash_profile").path))
            let output = try CLICommand.run("/bin/bash", ["-lc", "printf '%s' \"$TB_TEST_PROFILE:$PATH\""], environment: installer.environment)
            XCTAssertTrue(output.hasPrefix("kept:"))
            XCTAssertTrue(output.contains(installer.launcher.deletingLastPathComponent().path))
            for file in [".zprofile", ".zshrc"] {
                XCTAssertTrue(FileManager.default.fileExists(atPath: zsh.appendingPathComponent(file).path))
                XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(file).path))
            }
        }
    }
    func testConfigExportPreservesHostSettingsAndUsesPrivateFiles() throws {
        let home = try temporaryHome(); let url = home.appendingPathComponent("settings.json")
        let original = Data(#"{"middle":"ws://old:7400","tlsPin":"stale","voice":{"provider":"keep"},"expose":{"enabled":false}}"#.utf8)
        try original.write(to: url)
        let profile = ConnectionSettings(relayURL: "wss://relay.example.test", hostID: "mac-1", secret: "fixture-only-secret", tlsFingerprint: "")
        try MacConnectionStore.saveCLIProfile(profile, to: url)
        let settings = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual(settings["middle"] as? String, profile.relayURL)
        XCTAssertEqual(settings["secret"] as? String, profile.secret)
        XCTAssertNil(settings["tlsPin"])
        XCTAssertEqual((settings["voice"] as? [String: String])?["provider"], "keep")
        XCTAssertEqual((settings["expose"] as? [String: Bool])?["enabled"], false)
        let files = try FileManager.default.contentsOfDirectory(at: home, includingPropertiesForKeys: nil)
        XCTAssertEqual(files.count, 2)
        XCTAssertEqual(try Data(contentsOf: XCTUnwrap(files.first { $0.pathExtension == "bak" })), original)
        for file in files {
            XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
        }
        try Data("invalid JSON".utf8).write(to: url)
        XCTAssertThrowsError(try MacConnectionStore.saveCLIProfile(profile, to: url))
        XCTAssertEqual(try String(contentsOf: url), "invalid JSON")
    }
    func testCommandDrainsLargeOutputAndBoundsHangingProcesses() throws {
        let installer = CLIInstallation(home: try temporaryHome())
        let result = try CLICommand.run("/bin/sh", ["-c", "i=0; while [ $i -lt 5000 ]; do echo stderr-012345678901234567890123456789 >&2; i=$((i+1)); done"], environment: installer.environment)
        XCTAssertGreaterThan(result.count, 60_000)
        let start = Date()
        XCTAssertThrowsError(try CLICommand.run("/bin/sleep", ["10"], environment: installer.environment, timeout: 0.2))
        XCTAssertLessThan(Date().timeIntervalSince(start), 2)
    }
    func testRealCleanMachineInstallAndLoginShellDetection() throws {
        guard ProcessInfo.processInfo.environment["TB_MACOS_INSTALL_TEST"] == "1" else {
            throw XCTSkip("Set TB_MACOS_INSTALL_TEST=1 for isolated official Node/npm download and CLI install")
        }
        let home = try temporaryHome()
        for file in [".zprofile", ".bash_profile"] {
            try Data("export PATH=/usr/bin:/bin\n".utf8).write(to: home.appendingPathComponent(file))
        }
        let installer = CLIInstallation(home: home, sourceEnvironment: ["PATH": "/usr/bin:/bin", "SHELL": "/bin/zsh"])
        XCTAssertNil(installer.inspect().runtime)
        let installed = try installer.install { print($0) }
        XCTAssertFalse(installed.version.isEmpty)
        XCTAssertEqual(installer.detect()?.path, installer.launcher.path)
        XCTAssertEqual(installer.detect()?.version, installed.version)
        let output = try CLICommand.run("/bin/zsh", ["-lc", "tb --version"], environment: installer.environment)
        XCTAssertEqual(CLIInstallation.validVersion(output), installed.version)
        XCTAssertTrue(FileManager.default.fileExists(atPath: installer.root.appendingPathComponent("current/runtime/bin/node").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: home.appendingPathComponent(".termbridge/settings.json").path))
    }
}
