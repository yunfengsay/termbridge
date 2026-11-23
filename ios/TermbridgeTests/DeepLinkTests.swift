import XCTest

@testable import Termbridge

final class DeepLinkTests: XCTestCase {
  func testParsesSessionURL() throws {
    let url = try XCTUnwrap(URL(string:
      "termbridge://session?host=mac-a&id=herdr%3AwA%3Ap1&name=Codex&source=herdr"))
    XCTAssertEqual(
      SessionDeepLink(url: url),
      SessionDeepLink(
        userInfo: ["hostId": "mac-a", "sessionId": "herdr:wA:p1",
          "displayName": "Codex", "source": "herdr"]))
  }

  func testRejectsMissingNotificationSession() {
    XCTAssertNil(SessionDeepLink(userInfo: ["hostId": "mac-a"]))
  }
}

final class ReviewDeepLinkTests: XCTestCase {
  func testParsesReviewRouteWithHostAndMode() throws {
    let link = try XCTUnwrap(
      ReviewDeepLink(
        url: XCTUnwrap(
          URL(string: "termbridge://review?host=mac-1&id=herdr:w1:p2&name=Codex&mode=files"))))

    XCTAssertEqual("mac-1", link.hostID)
    XCTAssertEqual("herdr:w1:p2", link.sessionID)
    XCTAssertEqual("Codex", link.displayName)
    XCTAssertEqual(.files, link.mode)
    XCTAssertEqual("herdr:w1:p2", link.route.sessionID)
  }

  func testDefaultsToWorkingTreeAndRejectsOtherRoutes() throws {
    let link = try XCTUnwrap(
      ReviewDeepLink(url: XCTUnwrap(URL(string: "termbridge://review?id=abc&mode=bogus"))))
    XCTAssertEqual(.working, link.mode)
    XCTAssertEqual("", link.hostID)

    XCTAssertNil(ReviewDeepLink(url: try XCTUnwrap(URL(string: "termbridge://review"))))
    XCTAssertNil(ReviewDeepLink(url: try XCTUnwrap(URL(string: "termbridge://session?id=abc"))))
    XCTAssertNil(ReviewDeepLink(url: try XCTUnwrap(URL(string: "https://example.com/review?id=a"))))
  }
}
