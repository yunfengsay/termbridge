import XCTest

final class AgentChatUITests: XCTestCase {
  func testConversationRendersSendsAndPreservesDraftAcrossViewSwitch() throws {
    let app = XCUIApplication()
    app.launchEnvironment = ["TB_RELAY_URL": "ws://127.0.0.1:38641", "TB_HOST_ID": "ios-chat-fixture",
      "TB_HOST_NAME": "Agent Chat QA", "TB_SECRET": "", "TB_TLS_FINGERPRINT": ""]
    app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    addUIInterruptionMonitor(withDescription: "System permission") { alert in
      if alert.buttons["Allow"].exists { alert.buttons["Allow"].tap(); return true }
      if alert.buttons["Don’t Allow"].exists { alert.buttons["Don’t Allow"].tap(); return true }
      return false
    }
    app.launch()
    app.tap()
    let agent = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Synthetic Agent")).firstMatch
    if !agent.waitForExistence(timeout: 5) {
      let profile = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Agent Chat QA")).firstMatch
      XCTAssertTrue(profile.waitForExistence(timeout: 10))
      profile.tap()
    }
    XCTAssertTrue(agent.waitForExistence(timeout: 15))
    agent.tap()
    let transcript = app.webViews.firstMatch
    XCTAssertTrue(transcript.waitForExistence(timeout: 15))
    XCTAssertTrue(transcript.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Synthetic conversation ready")).firstMatch.waitForExistence(timeout: 15))
    let composer = app.descendants(matching: .any)["agent-chat-composer"].firstMatch
    XCTAssertTrue(composer.waitForExistence(timeout: 5))
    composer.tap()
    composer.typeText("native input acceptance")
    let send = app.buttons["agent-chat-send"]
    XCTAssertTrue(send.isEnabled)
    send.tap()
    XCTAssertTrue(transcript.staticTexts["Synthetic reply confirmed."].waitForExistence(timeout: 10))
    XCTAssertEqual(app.staticTexts["agent-chat-receipt"].label, "Agent 已收到")
    composer.tap()
    composer.typeText("keep this independent draft")
    let picker = app.segmentedControls["session-ui-picker"]
    picker.buttons["终端"].tap()
    picker.buttons["对话"].tap()
    XCTAssertTrue(composer.waitForExistence(timeout: 10))
    XCTAssertEqual(composer.value as? String, "keep this independent draft")
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "iOS shared conversation and native composer"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
