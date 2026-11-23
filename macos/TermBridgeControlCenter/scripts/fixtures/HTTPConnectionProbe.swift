import Foundation

@main struct HTTPConnectionProbeMain {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        guard args.count == 3 else { exit(2) }
        let settings = ConnectionSettings(relayURL: args[1], hostID: "", secret: "probe-password", tlsFingerprint: "", mode: .direct)
        let task = Task { @MainActor in
            try await MacConnectionTest.run(settings, discoverCertificate: false) { print("PROGRESS \($0)") }
        }
        if args[2] == "cancel" {
            try? await Task.sleep(for: .milliseconds(150))
            task.cancel()
        }
        do { print("HOST \(try await task.value.hostID)") }
        catch is CancellationError { print("CANCELLED") }
        catch { print("FAILED \(error.localizedDescription)") }
    }
}
