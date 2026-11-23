import XCTest

final class RemoteDesktopUITests: XCTestCase {
  func testEncryptedDesktopRendersAndTypesThroughNativeBridge() throws {
    let app = XCUIApplication()
    app.launchEnvironment = ["TB_RELAY_URL": "ws://127.0.0.1:38642", "TB_HOST_ID": "desktop-fixture",
      "TB_HOST_NAME": "Desktop QA", "TB_SECRET": "desktop-fixture-pairing-key", "TB_TLS_FINGERPRINT": ""]
    app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    app.launch()
    let open = app.buttons["查看桌面"].firstMatch
    XCTAssertTrue(open.waitForExistence(timeout: 15)); open.tap()
    let web = app.webViews.firstMatch
    XCTAssertTrue(web.waitForExistence(timeout: 15))
    let ready = app.staticTexts["已连接"].firstMatch
    XCTAssertTrue(ready.waitForExistence(timeout: 20), app.debugDescription)
    app.buttons["键盘"].tap()
    let field = app.textFields["输入文字，支持中文"]
    XCTAssertTrue(field.waitForExistence(timeout: 5)); field.tap(); field.typeText("desktop native acceptance")
    app.buttons["发送"].tap()
    XCTAssertTrue(ready.exists)
    let image = XCTAttachment(screenshot: app.screenshot()); image.name = "Encrypted iPad desktop fixture"; image.lifetime = .keepAlways; add(image)
    app.buttons["完成"].tap()
    XCTAssertTrue(app.buttons["查看桌面"].firstMatch.waitForExistence(timeout: 5))
  }
}
