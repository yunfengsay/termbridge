import XCTest
@testable import TermBridgeControlCenter

final class ConnectionFailureTests: XCTestCase {
    func testNetworkCodesSurviveLocalizationWithoutExposingErrorMetadata() {
        for code in [URLError.cannotConnectToHost, .notConnectedToInternet, .dataNotAllowed, .timedOut, .cancelled] {
            let error = NSError(domain: NSURLErrorDomain, code: code.rawValue, userInfo: [
                NSLocalizedDescriptionKey: "本地化网络错误 wss://private.invalid/r/private-room-key",
                NSURLErrorFailingURLStringErrorKey: "wss://private.invalid/r/private-room-key"
            ])
            let message = ConnectionFailure.description(error)
            XCTAssertTrue(message.contains("NSURLErrorDomain/\(code.rawValue)"))
            XCTAssertFalse(message.contains("private"))
            if code == .notConnectedToInternet || code == .dataNotAllowed {
                XCTAssertTrue(message.contains("本地网络"))
            }
        }
    }
    func testDirectSocketFailuresNameTheStageAndPOSIXCode() {
        let refused = ConnectionFailure.description(DirectSocketError.posix(ECONNREFUSED, .connect))
        XCTAssertTrue(refused.contains("无法连接服务器端口")); XCTAssertTrue(refused.contains("[NSURLErrorDomain/-1004 · POSIX 61]"))
        XCTAssertTrue(ConnectionFailure.description(DirectSocketError.posix(EHOSTUNREACH, .connect)).contains("本地网络"))
        XCTAssertTrue(ConnectionFailure.description(DirectSocketError.make(.timedOut, .connect)).contains("TCP 连接超时"))
        XCTAssertTrue(ConnectionFailure.description(DirectSocketError.make(.timedOut, .upgrade)).contains("WebSocket 握手"))
        XCTAssertTrue(ConnectionFailure.description(DirectSocketError.make(.badServerResponse, .upgrade, httpStatus: 403)).contains("HTTP 403"))
        XCTAssertFalse(ConnectionFailure.description(DirectSocketError.make(.badServerResponse, .upgrade, httpStatus: 101)).contains("HTTP 101"))
        XCTAssertTrue(ConnectionFailure.description(DirectSocketError.make(.badServerResponse, .http)).contains("HTTP 响应"))
        let reset = ConnectionFailure.description(DirectSocketError.posix(ENOTCONN, .upgrade))
        XCTAssertTrue(reset.contains("握手完成前被中断")); XCTAssertTrue(reset.contains("[NSURLErrorDomain/-1005 · POSIX 57]"))
        XCTAssertTrue(ConnectionFailure.description(DirectSocketError.posix(ECONNRESET, .open)).contains("中途断开"))
    }
    func testUsefulErrorsDoNotExposePrivateDetails() {
        XCTAssertTrue(ConnectionFailure.description("A TLS error caused the secure connection to fail.").contains("TLS"))
        XCTAssertTrue(ConnectionFailure.description("TLS fingerprint mismatch").contains("指纹不匹配"))
        XCTAssertTrue(ConnectionFailure.description("The request timed out.").contains("超时"))
        let secretURL = "wss://private.invalid/r/private-room-key"
        XCTAssertFalse(ConnectionFailure.description("TLS error: " + secretURL).contains("private"))
        XCTAssertFalse(ConnectionFailure.description(secretURL).contains("private"))
    }
}
