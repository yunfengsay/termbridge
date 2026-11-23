import AppKit
import SwiftUI
import XCTest
@testable import TermBridgeControlCenter

final class SettingsPageHostTests: XCTestCase {
    @MainActor func testSwitchPreservesNativeControlsAndDraftAndReleasesPages() async throws {
        _ = NSApplication.shared
        var container: SettingsPageContainer? = SettingsPageContainer(frame: NSRect(x: 0, y: 0, width: 500, height: 400))
        let window = NSWindow(contentRect: container!.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = container; window.orderFront(nil)
        defer { window.orderOut(nil) }
        let recorder = PageRecorder()
        func show(_ index: Int) async throws {
            container!.show(index, content: AnyView(DraftPage(recorder: recorder, index: index)))
            container!.layoutSubtreeIfNeeded(); window.displayIfNeeded()
            try await Task.sleep(for: .milliseconds(30))
        }
        try await show(0)
        let field = try XCTUnwrap(recorder.fields[0]?.value)
        field.stringValue = "unfinished relay configuration"
        field.delegate?.controlTextDidChange?(Notification(name: NSControl.textDidChangeNotification, object: field))
        for _ in 0..<4 { try await show(1); try await show(0) }
        XCTAssertEqual(recorder.created, [0: 1, 1: 1], "Returning to a tab must reuse its native form")
        XCTAssertTrue(recorder.fields[0]?.value === field)
        XCTAssertEqual(field.stringValue, "unfinished relay configuration")
        weak var page = container!.subviews.first
        window.contentView = nil; container = nil
        try await Task.sleep(for: .milliseconds(30))
        XCTAssertNil(page, "Closing settings must release cached hosting views")
    }
}

@MainActor private final class WeakField { weak var value: NSTextField?; init(_ value: NSTextField) { self.value = value } }
@MainActor private final class PageRecorder {
    var created: [Int: Int] = [:]
    var fields: [Int: WeakField] = [:]
}
private struct DraftPage: View {
    let recorder: PageRecorder
    let index: Int
    @State private var draft = ""
    var body: some View { DraftField(draft: $draft, recorder: recorder, index: index) }
}
private struct DraftField: NSViewRepresentable {
    @Binding var draft: String
    let recorder: PageRecorder
    let index: Int
    func makeCoordinator() -> Coordinator { Coordinator($draft) }
    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField(); field.delegate = context.coordinator
        recorder.created[index, default: 0] += 1; recorder.fields[index] = WeakField(field)
        return field
    }
    func updateNSView(_ field: NSTextField, context: Context) { field.stringValue = draft }
    final class Coordinator: NSObject, NSTextFieldDelegate {
        var draft: Binding<String>
        init(_ draft: Binding<String>) { self.draft = draft }
        func controlTextDidChange(_ notification: Notification) {
            if let field = notification.object as? NSTextField { draft.wrappedValue = field.stringValue }
        }
    }
}
