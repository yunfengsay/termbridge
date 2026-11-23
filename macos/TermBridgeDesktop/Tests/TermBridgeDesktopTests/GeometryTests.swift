import XCTest
@testable import TermBridgeDesktop

final class GeometryTests: XCTestCase {
    func testNormalizedCoordinatesIncludeNegativeOriginDisplay() throws {
        let display = DesktopGeometry(displayID: 1, bounds: CGRect(x: -1920, y: -200, width: 1920, height: 1080))
        XCTAssertEqual(try display.point(x: 0, y: 0), CGPoint(x: -1920, y: -200))
        XCTAssertEqual(try display.point(x: 1, y: 1), CGPoint(x: -1, y: 879))
        XCTAssertThrowsError(try display.point(x: .nan, y: 0))
        XCTAssertThrowsError(try display.point(x: 1.01, y: 0))
    }
    func testNumbersRejectBooleanAndNonfiniteValues() throws {
        XCTAssertThrowsError(try finiteNumber(true, name: "coordinate", range: 0...1))
        XCTAssertThrowsError(try finiteNumber(Double.infinity, name: "coordinate", range: 0...1))
        XCTAssertEqual(try finiteNumber(0.5, name: "coordinate", range: 0...1), 0.5)
    }
    func testDiscreteInputValuesRejectFractionalCodes() throws {
        XCTAssertThrowsError(try integerNumber(1.5, name: "key", range: 0...127))
        XCTAssertThrowsError(try integerNumber(true, name: "key", range: 0...127))
        XCTAssertEqual(try integerNumber(127, name: "key", range: 0...127), 127)
    }
}
