import AppKit
import ApplicationServices

@MainActor final class DesktopInput {
    private var keys = Set<CGKeyCode>()
    private var buttons = Set<Int>()
    private var position = CGPoint.zero
    private var lastClick = Date.distantPast
    private var lastClickPoint = CGPoint.zero
    private var lastClickButton = -1
    private var clickCount: Int64 = 0
    private let source = CGEventSource(stateID: .hidSystemState)

    func requirePermission() throws {
        guard AXIsProcessTrusted() else { throw DesktopFailure("Accessibility permission is required for TermBridge Desktop") }
    }

    func pointer(_ args: [String: Any], geometry: DesktopGeometry) throws {
        try requirePermission()
        let point = try geometry.point(x: finiteNumber(args["x"], name: "x", range: 0...1),
                                       y: finiteNumber(args["y"], name: "y", range: 0...1))
        let action = args["action"] as? String ?? "move"
        guard ["move", "down", "up", "click"].contains(action) else { throw DesktopFailure("Invalid pointer action") }
        let button = try integerNumber(args["button"] ?? 0, name: "button", range: 0...2)
        position = point
        if action == "click" {
            mouse(button: button, down: true, point: point); mouse(button: button, down: false, point: point)
        } else if action == "down" { buttons.insert(button); mouse(button: button, down: true, point: point) }
        else if action == "up" { buttons.remove(button); mouse(button: button, down: false, point: point) }
        else {
            let held = buttons.sorted().first
            let type: CGEventType = held == 0 ? .leftMouseDragged : held == 1 ? .rightMouseDragged : held == 2 ? .otherMouseDragged : .mouseMoved
            CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
                    mouseButton: CGMouseButton(rawValue: UInt32(held ?? 0))!)?.post(tap: .cghidEventTap)
        }
    }

    private func mouse(button: Int, down: Bool, point: CGPoint) {
        if down {
            let nearby = hypot(point.x - lastClickPoint.x, point.y - lastClickPoint.y) < 4
            clickCount = button == lastClickButton && nearby && Date().timeIntervalSince(lastClick) < NSEvent.doubleClickInterval ? min(3, clickCount + 1) : 1
            lastClick = Date(); lastClickPoint = point; lastClickButton = button
        }
        let type: CGEventType = button == 0 ? (down ? .leftMouseDown : .leftMouseUp)
            : button == 1 ? (down ? .rightMouseDown : .rightMouseUp) : (down ? .otherMouseDown : .otherMouseUp)
        let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point,
                            mouseButton: CGMouseButton(rawValue: UInt32(button))!)
        event?.setIntegerValueField(.mouseEventClickState, value: clickCount)
        event?.flags = modifiers()
        event?.post(tap: .cghidEventTap)
    }

    func key(_ args: [String: Any]) throws {
        try requirePermission()
        let code = CGKeyCode(try integerNumber(args["code"], name: "key code", range: 0...127))
        guard let down = args["down"] as? Bool else { throw DesktopFailure("key down is required") }
        if down { keys.insert(code) } else { keys.remove(code) }
        let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
        event?.flags = modifiers()
        event?.post(tap: .cghidEventTap)
    }

    func text(_ value: String) throws {
        try requirePermission()
        guard value.utf8.count <= 16_384 else { throw DesktopFailure("Text is too large") }
        // CGEvent carries UTF-16. Split on Character boundaries so emoji/CJK are never cut in half.
        for character in value {
            let units = Array(String(character).utf16)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                units.withUnsafeBufferPointer { event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: $0.baseAddress!) }
                event?.post(tap: .cghidEventTap)
            }
        }
    }

    func scroll(_ args: [String: Any]) throws {
        try requirePermission()
        let dx = Int32(try finiteNumber(args["dx"] ?? 0, name: "dx", range: -2000...2000))
        let dy = Int32(try finiteNumber(args["dy"] ?? 0, name: "dy", range: -2000...2000))
        CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
                wheel1: dy, wheel2: dx, wheel3: 0)?.post(tap: .cghidEventTap)
    }

    func space(_ direction: String) throws {
        try requirePermission()
        release()
        if direction == "overview" {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/Mission Control.app"))
            return
        }
        guard ["previous", "next"].contains(direction) else { throw DesktopFailure("Invalid Space direction") }
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: direction == "previous" ? 123 : 124, keyDown: down)
            event?.flags = .maskControl; event?.post(tap: .cghidEventTap)
        }
    }

    func release() {
        for code in keys { CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)?.post(tap: .cghidEventTap) }
        keys.removeAll()
        for button in buttons { mouse(button: button, down: false, point: position) }
        buttons.removeAll()
    }

    private func modifiers() -> CGEventFlags {
        var flags: CGEventFlags = []
        if !keys.isDisjoint(with: [55, 54]) { flags.insert(.maskCommand) }
        if !keys.isDisjoint(with: [56, 60]) { flags.insert(.maskShift) }
        if !keys.isDisjoint(with: [58, 61]) { flags.insert(.maskAlternate) }
        if !keys.isDisjoint(with: [59, 62]) { flags.insert(.maskControl) }
        return flags
    }
}
