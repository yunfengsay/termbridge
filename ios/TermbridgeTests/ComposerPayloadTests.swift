import XCTest

@testable import Termbridge

final class ComposerPayloadTests: XCTestCase {
  func testSubmitUsesNegotiatedPasteModeAndLeavesReturnOutsideTheText() {
    let text = Data("你好 [Image: /tmp/a.png]".utf8)
    XCTAssertEqual(ComposerPayload.submitBytes(text, bracketedPaste: true),
      Data("\u{1b}[200~你好 [Image: /tmp/a.png]\u{1b}[201~\r".utf8))
    XCTAssertEqual(ComposerPayload.submitBytes(text, bracketedPaste: false), text + Data([13]))
  }

  func testCollapsesWrappedWhitespaceIntoOneLine() {
    XCTAssertEqual(
      "run the tests", ComposerPayload.build(draft: "  run   the\n  tests \n"))
    XCTAssertEqual("ok", ComposerPayload.build(draft: "ok"))
  }

  func testBlankDraftProducesNothingToSend() {
    XCTAssertEqual("", ComposerPayload.build(draft: "   \n\t "))
    XCTAssertEqual("", ComposerPayload.build(draft: ""))
  }

  func testAttachmentsFollowTheTextAsAndroidMarkers() {
    XCTAssertEqual(
      "look [Image: /tmp/a.png] [Image: /tmp/b.png]",
      ComposerPayload.build(draft: "look", attachments: ["/tmp/a.png", " /tmp/b.png "]))
    XCTAssertEqual(
      "[Image: /tmp/a.png]", ComposerPayload.build(draft: " ", attachments: ["/tmp/a.png", "  "]))
  }
}
