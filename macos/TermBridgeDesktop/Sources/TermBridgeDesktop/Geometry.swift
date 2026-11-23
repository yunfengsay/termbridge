import CoreGraphics
import Foundation

struct DesktopFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

struct DesktopGeometry {
    let displayID: CGDirectDisplayID
    let bounds: CGRect
    func point(x: Double, y: Double) throws -> CGPoint {
        guard x.isFinite, y.isFinite, (0...1).contains(x), (0...1).contains(y),
              bounds.width > 0, bounds.height > 0 else { throw DesktopFailure("Invalid normalized display coordinates") }
        return CGPoint(x: bounds.minX + x * max(0, bounds.width - 1),
                       y: bounds.minY + y * max(0, bounds.height - 1))
    }
}

func finiteNumber(_ value: Any?, name: String, range: ClosedRange<Double>) throws -> Double {
    guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
          n.doubleValue.isFinite, range.contains(n.doubleValue) else { throw DesktopFailure("Invalid \(name)") }
    return n.doubleValue
}

func integerNumber(_ value: Any?, name: String, range: ClosedRange<Double>) throws -> Int {
    let number = try finiteNumber(value, name: name, range: range)
    guard number.rounded(.towardZero) == number else { throw DesktopFailure("Invalid integer \(name)") }
    return Int(number)
}
