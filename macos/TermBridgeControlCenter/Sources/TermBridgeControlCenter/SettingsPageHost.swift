import AppKit
import SwiftUI

/// Owns one native hosting view per visited settings page (at most seven).
/// Swapping a tab preserves its controls, scroll position, draft and SwiftUI state.
struct SettingsPageHost: NSViewRepresentable {
    let selection: Int
    let content: (Int) -> AnyView
    func makeNSView(context: Context) -> SettingsPageContainer { SettingsPageContainer() }
    func updateNSView(_ view: SettingsPageContainer, context: Context) {
        view.show(selection, content: content(selection))
    }
}

final class SettingsPageContainer: NSView {
    private var pages: [Int: NSHostingView<AnyView>] = [:]
    private var selected: Int?
    func show(_ selection: Int, content: AnyView) {
        guard (0...6).contains(selection) else { return }
        let page: NSHostingView<AnyView>
        if let existing = pages[selection] { page = existing; page.rootView = content }
        else {
            page = NSHostingView(rootView: content)
            page.autoresizingMask = [.width, .height]
            pages[selection] = page
        }
        guard selected != selection else { return }
        if let selected { pages[selected]?.removeFromSuperview() }
        selected = selection
        page.frame = bounds; addSubview(page)
    }
}
