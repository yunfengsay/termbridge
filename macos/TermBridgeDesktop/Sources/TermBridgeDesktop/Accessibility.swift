import AppKit
import ApplicationServices

@MainActor final class DesktopAccessibility {
    private struct Target { let element: AXUIElement; let title: String; let role: String; let description: String }
    private var targets: [String: Target] = [:]
    private var inspectedAt = Date.distantPast
    private var deadline = Date.distantPast

    func inspect(pid: pid_t? = nil) throws -> [[String: Any]] {
        guard AXIsProcessTrusted() else { throw DesktopFailure("Accessibility permission is required to inspect desktop controls") }
        targets.removeAll(); inspectedAt = Date()
        deadline = Date().addingTimeInterval(3)
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && (pid == nil || $0.processIdentifier == pid) }
            .sorted { ($0.processIdentifier == front ? 0 : 1) < ($1.processIdentifier == front ? 0 : 1) }
        var windows: [[String: Any]] = []
        for app in apps.prefix(64) {
            if Date() >= deadline { break }
            let root = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(root, 0.1)
            for window in (attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []).prefix(20) {
                var budget = 200
                var controls: [[String: Any]] = []
                walk(window, depth: 0, budget: &budget, controls: &controls)
                windows.append(["app": app.localizedName ?? "", "pid": app.processIdentifier,
                    "title": text(window, kAXTitleAttribute), "role": text(window, kAXRoleAttribute), "subrole": text(window, kAXSubroleAttribute),
                    "bounds": bounds(window) ?? [:], "controls": controls])
                if windows.count >= 64 { return windows }
            }
        }
        return windows
    }

    func press(_ id: String) throws {
        guard Date().timeIntervalSince(inspectedAt) < 30, let target = targets[id] else {
            throw DesktopFailure("Control is stale; inspect the current desktop again before acting")
        }
        guard text(target.element, kAXTitleAttribute) == target.title,
              text(target.element, kAXRoleAttribute) == target.role,
              text(target.element, kAXDescriptionAttribute) == target.description else { throw DesktopFailure("Control changed; inspect again before acting") }
        guard (attribute(target.element, kAXEnabledAttribute) as? Bool) != false else { throw DesktopFailure("Control is disabled") }
        let result = AXUIElementPerformAction(target.element, kAXPressAction as CFString)
        guard result == .success else { throw DesktopFailure("Control press rejected (\(result.rawValue))") }
        targets.removeValue(forKey: id)
    }

    private func walk(_ element: AXUIElement, depth: Int, budget: inout Int, controls: inout [[String: Any]]) {
        guard depth < 8, budget > 0, controls.count < 64, Date() < deadline else { return }
        budget -= 1
        let role = text(element, kAXRoleAttribute)
        if [kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole, kAXTextFieldRole, kAXStaticTextRole,
            kAXSheetRole].contains(role) || text(element, kAXSubroleAttribute) == kAXDialogSubrole {
            let id = UUID().uuidString
            if role == kAXButtonRole || role == kAXCheckBoxRole || role == kAXRadioButtonRole {
                targets[id] = Target(element: element, title: text(element, kAXTitleAttribute), role: role, description: text(element, kAXDescriptionAttribute))
            }
            controls.append(["id": id, "role": role, "subrole": text(element, kAXSubroleAttribute), "title": text(element, kAXTitleAttribute),
                "description": text(element, kAXDescriptionAttribute), "bounds": bounds(element) ?? [:],
                "enabled": (attribute(element, kAXEnabledAttribute) as? Bool) ?? true,
                "pressable": targets[id] != nil])
        }
        for child in (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).prefix(100) {
            walk(child, depth: depth + 1, budget: &budget, controls: &controls)
        }
    }

    private func attribute(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success else { return nil }
        return value
    }
    private func text(_ e: AXUIElement, _ name: String) -> String { String((attribute(e, name) as? String ?? "").prefix(256)) }
    private func bounds(_ e: AXUIElement) -> [String: Double]? {
        guard let p = attribute(e, kAXPositionAttribute), let s = attribute(e, kAXSizeAttribute),
              CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
    }
}
