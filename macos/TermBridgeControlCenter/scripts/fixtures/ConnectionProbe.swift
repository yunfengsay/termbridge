import Foundation

@main struct ConnectionProbeMain {
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 3 else { exit(2) }
        var settings = try MacConnectionStore.loadCLIProfile(from: URL(fileURLWithPath: args[1]), environment: [:])
        if args[2] == "wrong-pin" { settings.tlsFingerprint = String(repeating: "0", count: 64) }
        if args[2] == "no-pin" { settings.tlsFingerprint = "" }
        let probe = ConnectionProbe(expected: args[2])
        let client = TermbridgeClient(settings: settings, listener: probe)
        client.connect()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { print("TIMEOUT"); exit(2) }
        RunLoop.main.run()
    }
}

private final class ConnectionProbe: TermbridgeClientListener {
    let expected: String
    init(expected: String) { self.expected = expected }
    func clientIsReady(_ client: TermbridgeClient) { client.sendControl(["t": .string("session_list")]) }
    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        if case .failed(let message) = state {
            let pinRejected = expected == "wrong-pin" && message.contains("fingerprint mismatch")
            let trustRejected = expected == "no-pin" && (message.contains("certificate") || message.contains("TLS"))
            print(pinRejected || trustRejected ? "EXPECTED_REJECTION" : "UNEXPECTED_FAILURE")
            exit(pinRejected || trustRejected ? 0 : 1)
        }
    }
    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        if message.type == "session_list_result" {
            let accepted = expected == "valid-pin" || expected == "plain-ws"
            print(accepted ? "LIST_OK" : "UNEXPECTED_CONNECTION")
            client.disconnect(); exit(accepted ? 0 : 1)
        }
    }
    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}
}
