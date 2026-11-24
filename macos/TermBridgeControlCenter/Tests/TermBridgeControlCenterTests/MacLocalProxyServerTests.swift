import Foundation
import Network
import XCTest
@testable import TermBridgeControlCenter

final class MacLocalProxyServerTests: XCTestCase {
    func testPolicyInterceptsLocalAndPrivateURLs() {
        XCTAssertTrue(MacRemoteBrowserPolicy.shouldIntercept(URL(string: "http://127.0.0.1:8765")!))
        XCTAssertTrue(MacRemoteBrowserPolicy.shouldIntercept(URL(string: "http://localhost:3000/app")!))
        XCTAssertTrue(MacRemoteBrowserPolicy.shouldIntercept(URL(string: "http://0.0.0.0:5173")!))
        XCTAssertTrue(MacRemoteBrowserPolicy.shouldIntercept(URL(string: "http://192.168.0.177/stream")!))
        XCTAssertTrue(MacRemoteBrowserPolicy.shouldIntercept(URL(string: "http://mac-mini.local:8765")!))
        XCTAssertFalse(MacRemoteBrowserPolicy.shouldIntercept(URL(string: "https://github.com/yunfengsay/termbridge")!))
        XCTAssertEqual(MacRemoteBrowserPolicy.normalizeEntryURL("http://0.0.0.0:8765/live")?.absoluteString, "http://127.0.0.1:8765/live")
        XCTAssertEqual(MacRemoteBrowserPolicy.normalizeEntryURL("127.0.0.1:8765")?.absoluteString, "http://127.0.0.1:8765")
    }

    func testSocks5WithAuthAndHttpProxyRoundTrip() throws {
        // Start a minimal loopback TCP HTTP echo server on an ephemeral port.
        let upstreamQueue = DispatchQueue(label: "test.upstream")
        let upstreamListener = try NWListener(using: .tcp, on: .any)
        let upstreamReady = DispatchSemaphore(value: 0)
        upstreamListener.stateUpdateHandler = { state in
            if case .ready = state { upstreamReady.signal() }
        }
        upstreamListener.newConnectionHandler = { conn in
            conn.start(queue: upstreamQueue)
            conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { _, _, _, _ in
                let response = Data("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\npong".utf8)
                conn.send(content: response, completion: .contentProcessed { _ in conn.cancel() })
            }
        }
        upstreamListener.start(queue: upstreamQueue)
        XCTAssertEqual(upstreamReady.wait(timeout: .now() + 5), .success)
        let upstreamPort = Int(upstreamListener.port!.rawValue)
        defer { upstreamListener.cancel() }

        final class MockTransport: MacProxyTunnelTransport, @unchecked Sendable {
            weak var server: MacLocalProxyServer?
            private let lock = NSLock()
            private var conns: [String: NWConnection] = [:]
            private let q = DispatchQueue(label: "test.mock-transport")

            func sendTunnelOpen(id: String, host: String, port: Int) -> Bool {
                guard let nwPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return false }
                let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: .tcp)
                lock.withLock { conns[id] = conn }
                conn.stateUpdateHandler = { [weak self] state in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        self.server?.onTunnelOpened(id: id)
                        self.pump(id: id, conn: conn)
                    case .failed(let err):
                        self.server?.onTunnelClosed(id: id, reason: err.localizedDescription)
                    default:
                        break
                    }
                }
                conn.start(queue: q)
                return true
            }

            private func pump(id: String, conn: NWConnection) {
                conn.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] data, _, isComplete, error in
                    guard let self else { return }
                    if let data, !data.isEmpty {
                        self.server?.onTunnelData(id: id, base64Data: data.base64EncodedString())
                    }
                    if isComplete || error != nil {
                        self.server?.onTunnelClosed(id: id, reason: nil)
                        self.lock.withLock { _ = self.conns.removeValue(forKey: id) }
                        return
                    }
                    self.pump(id: id, conn: conn)
                }
            }

            func sendTunnelData(id: String, base64Data: String) -> Bool {
                guard let data = Data(base64Encoded: base64Data),
                      let conn = lock.withLock({ conns[id] }) else { return false }
                conn.send(content: data, completion: .contentProcessed { _ in })
                return true
            }

            func sendTunnelAck(id: String, bytes: Int) -> Bool { true }

            func sendTunnelClose(id: String, reason: String?) -> Bool {
                lock.withLock { conns.removeValue(forKey: id) }?.cancel()
                return true
            }
        }

        let transport = MockTransport()
        let proxy = try MacLocalProxyServer(transport: transport, requireSocksAuth: true)
        transport.server = proxy
        defer { proxy.close() }

        // Test SOCKS5 with username/password authentication
        let exp = expectation(description: "SOCKS5 response")
        let clientQ = DispatchQueue(label: "test.client")
        let conn = NWConnection(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: proxy.port)!, using: .tcp)
        var collected = Data()

        conn.stateUpdateHandler = { state in
            guard case .ready = state else { return }
            // Greeting: version 5, 1 method (0x02 username/password)
            conn.send(content: Data([0x05, 0x01, 0x02]), completion: .contentProcessed { _ in
                conn.receive(minimumIncompleteLength: 2, maximumLength: 2) { data, _, _, _ in
                    XCTAssertEqual(data, Data([0x05, 0x02]))
                    let u = Data(proxy.authUsername.utf8), p = Data(proxy.authPassword.utf8)
                    var auth = Data([0x01, UInt8(u.count)]); auth.append(u); auth.append(UInt8(p.count)); auth.append(p)
                    conn.send(content: auth, completion: .contentProcessed { _ in
                        conn.receive(minimumIncompleteLength: 2, maximumLength: 2) { data, _, _, _ in
                            XCTAssertEqual(data, Data([0x01, 0x00]))
                            let req = Data([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, UInt8(upstreamPort >> 8), UInt8(upstreamPort & 0xFF)])
                            conn.send(content: req, completion: .contentProcessed { _ in
                                conn.receive(minimumIncompleteLength: 10, maximumLength: 10) { data, _, _, _ in
                                    XCTAssertEqual(data?.prefix(2), Data([0x05, 0x00]))
                                    conn.send(content: Data("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n".utf8), completion: .contentProcessed { _ in
                                        func readMore() {
                                            conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { chunk, _, done, _ in
                                                if let chunk { collected.append(chunk) }
                                                if done || String(data: collected, encoding: .utf8)?.hasSuffix("pong") == true {
                                                    exp.fulfill()
                                                } else {
                                                    readMore()
                                                }
                                            }
                                        }
                                        readMore()
                                    })
                                }
                            })
                        }
                    })
                }
            })
        }
        conn.start(queue: clientQ)
        wait(for: [exp], timeout: 5)
        conn.cancel()
        XCTAssertTrue(String(data: collected, encoding: .utf8)?.hasSuffix("\r\n\r\npong") == true)
    }
}
