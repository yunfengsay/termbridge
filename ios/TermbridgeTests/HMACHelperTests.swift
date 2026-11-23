import XCTest

@testable import Termbridge

final class HMACHelperTests: XCTestCase {
  func testRFC4231Vector() {
    XCTAssertEqual(
      HMACHelper.sha256Hex(secret: "Jefe", nonce: "what do ya want for nothing?"),
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    )
  }

  func testEmptySecretMatchesPasswordlessProtocol() {
    XCTAssertEqual(HMACHelper.sha256Hex(secret: "", nonce: "abc123"), "")
  }
}
