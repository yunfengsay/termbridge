import AppKit
import SwiftUI
import WebKit

@MainActor
final class MacRemoteBrowserWindow: NSWindowController, NSWindowDelegate {
    private static var openWindows: [UUID: MacRemoteBrowserWindow] = [:]

    let session: MacRemoteBrowserSession
    private let findBar = MacFindBarView(frame: .zero)
    var onClose: (() -> Void)?

    static func present(profile: ConnectionSettings, url: URL? = nil) {
        if let existing = openWindows[profile.id], existing.session.profile == profile, !existing.session.closed {
            if let url { existing.session.open(url: url) }
            existing.present()
            return
        }
        openWindows[profile.id]?.close()
        let controller = MacRemoteBrowserWindow(profile: profile, initialURL: url)
        let id = profile.id
        controller.onClose = { [weak controller] in
            if openWindows[id] === controller { openWindows.removeValue(forKey: id) }
        }
        openWindows[id] = controller
        controller.present()
    }

    init(profile: ConnectionSettings, initialURL: URL?) {
        session = MacRemoteBrowserSession(profile: profile, initialURL: initialURL)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "代理浏览器 · \(profile.displayName)"
        window.minSize = NSSize(width: 680, height: 460)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unifiedCompact
        super.init(window: window)
        window.delegate = self
        let container = NSView()
        let hosting = NSHostingView(rootView: MacRemoteBrowserView(session: session))
        hosting.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(hosting)
        container.addSubview(findBar)
        NSLayoutConstraint.activate([
            hosting.topAnchor.constraint(equalTo: container.topAnchor),
            hosting.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hosting.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            hosting.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            findBar.topAnchor.constraint(equalTo: container.topAnchor, constant: 48),
            findBar.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14),
        ])
        findBar.onQueryChange = { [weak self] query, cs in self?.performWebFind(query: query, backwards: false, caseSensitive: cs) }
        findBar.onFindNext = { [weak self] query, cs in self?.performWebFind(query: query, backwards: false, caseSensitive: cs) }
        findBar.onFindPrevious = { [weak self] query, cs in self?.performWebFind(query: query, backwards: true, caseSensitive: cs) }
        findBar.onClose = { [weak self] in
            guard let self else { return }
            MacWebViewFind.clear(self.session.web)
            self.window?.makeFirstResponder(self.session.web)
        }
        window.contentView = container
        window.center()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc func showFindBar(_ sender: Any?) { findBar.present() }
    @objc func findNextMatch(_ sender: Any?) { if findBar.isHidden { findBar.present() } else { findBar.findNext() } }
    @objc func findPreviousMatch(_ sender: Any?) { if findBar.isHidden { findBar.present() } else { findBar.findPrevious() } }

    private func performWebFind(query: String, backwards: Bool, caseSensitive: Bool) {
        if query.isEmpty {
            MacWebViewFind.clear(session.web)
            findBar.updateMatchStatus(found: false, hasQuery: false)
            return
        }
        MacWebViewFind.search(session.web, query: query, backwards: backwards, caseSensitive: caseSensitive) { [weak self] found in
            self?.findBar.updateMatchStatus(found: found, hasQuery: !query.isEmpty)
        }
    }

    func present() {
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        session.close()
        onClose?()
    }
}

private struct MacRemoteBrowserView: View {
    @ObservedObject var session: MacRemoteBrowserSession

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button(action: session.goBack) {
                    Image(systemName: "chevron.left")
                }
                .disabled(!session.canGoBack)
                .help("后退")

                Button(action: session.goForward) {
                    Image(systemName: "chevron.right")
                }
                .disabled(!session.canGoForward)
                .help("前进")

                Button(action: session.reloadOrStop) {
                    Image(systemName: session.isLoading ? "xmark" : "arrow.clockwise")
                }
                .help(session.isLoading ? "停止加载" : "刷新")

                TextField("输入网址（全流量经 \(session.profile.displayName) 代理）", text: $session.urlText)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 13, design: .monospaced))
                    .onSubmit { session.navigate(to: session.urlText) }

                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(session.urlText, forType: .string)
                } label: {
                    Image(systemName: "doc.on.doc")
                }
                .help("复制网址")

                if !session.connected && session.supported {
                    Button("重连") { session.connect() }
                }

                Text(session.status)
                    .font(.caption)
                    .foregroundStyle(session.isError ? Color.red : Color.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: 240, alignment: .trailing)
            }
            .controlSize(.small)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)

            if session.isLoading && session.progress > 0 && session.progress < 1 {
                ProgressView(value: session.progress)
                    .progressViewStyle(.linear)
                    .frame(height: 2)
            } else {
                Divider()
            }

            MacRemoteBrowserWebView(session: session)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

private struct MacRemoteBrowserWebView: NSViewRepresentable {
    let session: MacRemoteBrowserSession
    func makeNSView(context: Context) -> WKWebView { session.web }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
