import XCTest
@testable import TermBridgeControlCenter

final class TerminalLaunchTests: XCTestCase {
    func testDiscoveredCLIExecutesDirectlyWithItsOriginalPATH() throws {
        let cli = CLIInstallation.Available(path: "/tmp/node manager/bin/tb", version: "0.1.26", searchPath: "/tmp/node manager/bin:/usr/bin:/bin")
        let launch = try TerminalLaunch(sessionId: "herdr:wA:p1", hostId: "mac-test", cli: cli)
        XCTAssertEqual(launch.executable, cli.path)
        XCTAssertEqual(launch.arguments, ["--host", "mac-test", "attach", "--", "herdr:wA:p1"])
        XCTAssertTrue(TerminalLaunch.environment(from: ["PATH": "/wrong", "DASHSCOPE_API_KEY": "private"], searchPath: launch.searchPath)
            .contains("PATH=" + cli.searchPath))
    }
    func testExactHostAndSessionArePassedAsArguments() throws {
        let launch = try TerminalLaunch(sessionId: "herdr:wA:p1", hostId: "mac-test")
        XCTAssertEqual(Array(launch.arguments.suffix(2)), ["mac-test", "herdr:wA:p1"])
        XCTAssertFalse(launch.arguments[1].contains("herdr:wA:p1"))
        XCTAssertTrue(launch.arguments[1].hasPrefix("exec tb "))
    }

    func testRejectsShellSyntaxAndOptionInjection() {
        for value in ["", "--help", "$(touch /tmp/unwanted)", "x;exit", "x\ny", "x\"y", "x y"] {
            XCTAssertThrowsError(try TerminalLaunch(sessionId: value, hostId: "mac-test"))
            XCTAssertThrowsError(try TerminalLaunch(sessionId: "sess-1", hostId: value))
        }
    }

    func testExplicitHerdrSocketIsSharedByResolverAndTerminal() {
        let source = ["TB_HERDR_SOCKET": "/tmp/company/herdr.sock", "HERDR_SOCKET_PATH": "/tmp/other/herdr.sock",
                      "HERDR_SESSION": "company", "HERDR_CONFIG_PATH": "/tmp/company/config.toml", "HERDR_PANE_ID": "wA:p1"]
        XCTAssertEqual(TerminalLaunch.herdrEnvironment(from: source)["HERDR_SOCKET_PATH"], "/tmp/company/herdr.sock")
        let launch = TerminalLaunch.environment(from: source)
        XCTAssertTrue(launch.contains("HERDR_SOCKET_PATH=/tmp/company/herdr.sock"))
        XCTAssertTrue(launch.contains("HERDR_SESSION=company"))
        XCTAssertTrue(launch.contains("HERDR_CONFIG_PATH=/tmp/company/config.toml"))
        XCTAssertFalse(launch.contains { $0.hasPrefix("HERDR_PANE_ID=") })
    }

    func testOnlyClientTransportEnvironmentIsForwarded() {
        let result = TerminalLaunch.environment(from: [
            "RELAY_URL": "ws://127.0.0.1:7400", "TB_SETTINGS": "/tmp/settings.json",
            "DASHSCOPE_API_KEY": "private-host-key", "HERDR_PANE_ID": "wA:p1", "CODEX_THREAD_ID": "private-thread"
        ])
        XCTAssertTrue(result.contains("RELAY_URL=ws://127.0.0.1:7400"))
        XCTAssertTrue(result.contains("TB_SETTINGS=/tmp/settings.json"))
        XCTAssertFalse(result.contains { $0.contains("private") || $0.hasPrefix("HERDR_") })
    }
}
