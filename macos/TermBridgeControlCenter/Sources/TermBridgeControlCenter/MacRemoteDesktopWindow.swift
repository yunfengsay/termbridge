import AppKit
import SwiftUI
import WebKit

@MainActor
final class MacRemoteDesktopWindow: NSWindowController, NSWindowDelegate {
    let session: MacRemoteDesktopSession
    var onClose: (() -> Void)?
    init(profile: ConnectionSettings) {
        session = MacRemoteDesktopSession(profile: profile)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "远程桌面 · \(profile.displayName)"
        window.minSize = NSSize(width: 760, height: 480)
        window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unifiedCompact
        super.init(window: window)
        window.delegate = self
        window.contentView = NSHostingView(rootView: MacRemoteDesktopView(session: session))
        window.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    func present() { showWindow(nil); window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    func windowWillClose(_ notification: Notification) { session.close(); onClose?() }
}

private struct MacRemoteDesktopView: View {
    @ObservedObject var session: MacRemoteDesktopSession
    @Environment(\.colorScheme) private var colorScheme
    @State private var username = ""
    @State private var password = ""
    @State private var remember = true
    @State private var text = ""
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Picker("显示器", selection: Binding(get: { session.displayID }, set: { session.send("display", $0) })) {
                    if session.displays.isEmpty { Text("显示器").tag(0) }
                    ForEach(session.displays) { Text($0.name).tag($0.id) }
                }.labelsHidden().frame(maxWidth: 190).disabled(!session.connected)
                Button { session.send("previous") } label: { Image(systemName: "chevron.left") }.help("上一个桌面")
                    .disabled(!session.connected)
                Button { session.send("overview") } label: { Image(systemName: "rectangle.3.group") }.help("所有桌面")
                    .disabled(!session.connected)
                Button { session.send("next") } label: { Image(systemName: "chevron.right") }.help("下一个桌面")
                    .disabled(!session.connected)
                Spacer(minLength: 12)
                Button { session.send("zoom", max(100, session.zoom - 25)) } label: { Image(systemName: "minus.magnifyingglass") }
                    .help("缩小").disabled(!session.connected || session.zoom <= 100)
                Button("\(session.zoom)%") { session.send("fit") }.help("适合窗口").disabled(!session.connected)
                Button { session.send("zoom", min(600, session.zoom + 25)) } label: { Image(systemName: "plus.magnifyingglass") }
                    .help("放大；按住 Option 滚动可移动画面").disabled(!session.connected || session.zoom >= 600)
                Picker("刷新率", selection: Binding(get: { session.fps }, set: { session.send("fps", $0) })) {
                    Text("10 FPS · 省流").tag(10)
                    Text("20 FPS · 均衡").tag(20)
                    Text("30 FPS · 流畅").tag(30)
                }.labelsHidden().frame(width: 135)
                Menu {
                    Picker("连接方式", selection: Binding(get: { session.backend }, set: { session.send("backend", $0) })) {
                        Text("自动连接").tag("auto")
                        Text("直接桌面").tag("native")
                        Text("系统共享 · 锁屏控制").tag("system")
                    }
                    Divider()
                    Button("忘记桌面密码") { session.forgetPassword() }
                    Divider()
                    Button("Esc") { session.send("key", 53) }
                    Button("Tab") { session.send("key", 48) }
                    Button("Enter") { session.send("key", 36) }
                } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 24)
            }.controlSize(.small).padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            MacDesktopWebView(session: session).frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            HStack(spacing: 10) {
                TextField("输入文字，支持中文", text: $text).textFieldStyle(.roundedBorder)
                    .onSubmit(submit).disabled(!session.connected)
                Button("发送", action: submit).disabled(!session.connected || text.isEmpty)
                if session.retry { Button("重新连接") { session.connect() } }
                Text(session.status).font(.caption).foregroundStyle(.secondary).lineLimit(2).frame(maxWidth: 230)
            }.padding(12)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .onChange(of: colorScheme) { session.configureAppearance(dark: $0 == .dark) }
        .sheet(isPresented: $session.needsLogin) {
            VStack(alignment: .leading, spacing: 18) {
                Text("登录 \(session.profile.displayName)").font(.headline)
                if session.needsUsername { TextField("Mac 用户名", text: $username).textFieldStyle(.roundedBorder) }
                SecureField("密码", text: $password).textFieldStyle(.roundedBorder).onSubmit(login)
                Toggle("记住密码", isOn: $remember)
                Text("验证成功后保存在本机钥匙串中，仅用于这台 Host 的当前连接。").font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("取消") { session.needsLogin = false; session.send("cancelLogin"); clearLogin() }.keyboardShortcut(.cancelAction)
                    Button("登录", action: login).keyboardShortcut(.defaultAction).disabled(password.isEmpty)
                }
            }.padding(24).frame(width: 370).interactiveDismissDisabled()
        }
        .alert("远程桌面", isPresented: Binding(get: { session.notice != nil }, set: { if !$0 { session.notice = nil } })) {
            Button("好") { session.notice = nil }
        } message: { Text(session.notice ?? "") }
        .onChange(of: session.needsLogin) { if !$0 { clearLogin() } }
        .onDisappear { clearLogin(); text = "" }
    }
    private func submit() { guard session.connected, !text.isEmpty else { return }; session.send("text", text); text = "" }
    private func login() {
        guard !password.isEmpty else { return }
        session.submitLogin(username: username.trimmingCharacters(in: .whitespacesAndNewlines), password: password, remember: remember)
        clearLogin()
    }
    private func clearLogin() { username = ""; password = "" }
}

private struct MacDesktopWebView: NSViewRepresentable {
    let session: MacRemoteDesktopSession
    func makeNSView(context: Context) -> WKWebView { session.web }
    func updateNSView(_ view: WKWebView, context: Context) {}
}
