import SwiftUI

struct ControlCenterView: View {
    @ObservedObject var model: ControlCenterModel
    @Environment(\.openWindow) private var openWindow
    @State private var showTopology = false
    @AppStorage(SessionWindowMode.defaultsKey) private var windowMode = SessionWindowMode.standalone.rawValue

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            hostTabs
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 390, height: 520)
        .background(Color(nsColor: .windowBackgroundColor))

    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text("TermBridge")
                    .font(.system(size: 19, weight: .semibold))
                Text(statusLine)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button { showTopology.toggle() } label: { Image(systemName: "network") }
                .buttonStyle(.borderless).help("连接拓扑").accessibilityLabel("连接拓扑")
                .popover(isPresented: $showTopology) { ConnectionTopologyView(model: model).padding(20).frame(width: 600) }
            Button(action: model.openDesktop) {
                Image(systemName: "desktopcomputer")
            }.buttonStyle(.borderless).help("打开当前 Host 的远程桌面")
                .accessibilityLabel("远程桌面")
            Button(action: newSession) {
                Label("新建对话", systemImage: "plus.bubble")
            }
            .buttonStyle(.borderless)
            .help("在当前 Host 新建 Agent 会话（⌘N）")
            Button {
                if windowMode == SessionWindowMode.navigator.rawValue { model.showSessionNavigator() }
                else { openWindow(id: "sessions"); NSApp.activate(ignoringOtherApps: true) }
            } label: {
                Image(systemName: windowMode == SessionWindowMode.navigator.rawValue ? "sidebar.left" : "macwindow")
            }
            .buttonStyle(.borderless)
            .help(windowMode == SessionWindowMode.navigator.rawValue ? "打开会话导航窗口" : "Open Sessions window")
            Button { openWindow(id: "connection-settings"); NSApp.activate(ignoringOtherApps: true) } label: {
                Image(systemName: "gearshape")
            }.buttonStyle(.borderless).help("连接设置")
            Button(action: model.refresh) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
    }

    private var hostTabs: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                hostTab("本机", id: nil, detail: "这台 Mac 的会话")
                ForEach(model.profiles) { profile in
                    hostTab(MacConnectionCatalog.tabTitle(profile, in: model.profiles), id: profile.id, detail: profile.hostID)
                }
                Button { openWindow(id: "connection-settings"); NSApp.activate(ignoringOtherApps: true) } label: {
                    Image(systemName: "plus").padding(7)
                }.buttonStyle(.plain).help("添加连接源")
            }.padding(.horizontal, 14).padding(.vertical, 9)
        }
    }
    private func hostTab(_ name: String, id: UUID?, detail: String) -> some View {
        Button { model.selectProfile(id) } label: {
            Text(name).font(.system(size: 12, weight: model.activeProfileID == id ? .semibold : .regular))
                .lineLimit(1).padding(.horizontal, 12).padding(.vertical, 7)
                .background(model.activeProfileID == id ? Color.accentColor.opacity(0.15) : Color.secondary.opacity(0.07))
                .clipShape(Capsule())
        }.buttonStyle(.plain).help(detail).accessibilityAddTraits(model.activeProfileID == id ? .isSelected : [])
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .loading:
            VStack(alignment: .leading, spacing: 12) {
                RoundedRectangle(cornerRadius: 6).fill(.secondary.opacity(0.12)).frame(height: 52)
                RoundedRectangle(cornerRadius: 6).fill(.secondary.opacity(0.08)).frame(height: 52)
                RoundedRectangle(cornerRadius: 6).fill(.secondary.opacity(0.06)).frame(height: 52)
            }
            .padding(18)
            .frame(maxHeight: .infinity, alignment: .top)
        case .error(let message):
            emptyState(icon: "bolt.horizontal.circle", title: message, detail: model.activeProfileID == nil ? "Start tb host to restore live Agent status." : "打开右上角设置，检查或添加连接源。")
        case .ready where model.agents.isEmpty:
            emptyState(icon: "bubble.left.and.bubble.right", title: "还没有会话",
                       detail: "在当前 Host 新建对话，或打开已有的 TermBridge / Herdr 会话。", canCreate: true)
        case .ready:
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(model.agents) { agent in
                        AgentRow(agent: agent, open: { model.open(agent) }, copy: { model.copySessionId(agent) })
                        Divider().padding(.leading, 44)
                    }
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(model.phoneHubOnline ? Color.green : Color.secondary.opacity(0.5))
                .frame(width: 7, height: 7)
            Text(model.phoneHubStatus)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
            Spacer()
            Button("Quit") { NSApplication.shared.terminate(nil) }
                .buttonStyle(.borderless)
                .font(.system(size: 11))
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
    }

    private var statusLine: String {
        if model.attentionCount > 0 { return "\(model.attentionCount) need attention · \(model.workingCount) working" }
        if model.workingCount > 0 { return "\(model.workingCount) working · nothing blocked" }
        return "All caught up"
    }

    private func newSession() {
        model.prepareNewSession()
        openWindow(id: "new-session")
        NSApp.activate(ignoringOtherApps: true)
    }

    private func emptyState(icon: String, title: String, detail: String, canCreate: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(Color.green)
            Text(title).font(.system(size: 16, weight: .semibold))
            Text(detail).font(.system(size: 13)).foregroundStyle(.secondary)
            if canCreate {
                Button("新建对话", action: newSession).buttonStyle(.borderedProminent).padding(.top, 6)
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct AgentRow: View {
    let agent: AgentRecord
    let open: () -> Void
    let copy: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            Button(action: open) {
                HStack(alignment: .top, spacing: 11) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                        .padding(.top, 7)
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 6) {
                            Text(agent.displayName)
                                .font(.system(size: 13, weight: .semibold))
                                .lineLimit(1)
                            Text(agent.status.uppercased())
                                .font(.system(size: 9, weight: .bold, design: .monospaced))
                                .foregroundStyle(statusColor)
                        }
                        Text(agent.summary)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Open Terminal")
            // A persistent Menu installs an NSPopUpButton whose item updates
            // can invalidate lazy row layout again on macOS 26. Keep both
            // actions as independent buttons, with no popup adaptor in the list.
            Button(action: copy) {
                Image(systemName: "doc.on.doc")
                    .frame(width: 28, height: 24)
            }
            .buttonStyle(.plain)
            .help("Copy session ID")
            .accessibilityLabel("Copy session ID")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
    }

    private var statusColor: Color {
        if agent.needsAttention { return .orange }
        if agent.isWorking { return .green }
        return .secondary.opacity(0.55)
    }
}
