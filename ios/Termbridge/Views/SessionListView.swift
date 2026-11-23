import SwiftUI

struct SessionListView: View {
  @StateObject private var model = SessionListViewModel()
  @State private var sidebarItem: SidebarItem?
  @State private var terminalPath = NavigationPath()
  @State private var showSettings = !SettingsStore.isConfigured
  @State private var showNewSession = false
  @State private var showDesktop = false
  @State private var editingProfile: ConnectionSettings?
  @State private var killCandidate: SessionInfo?
  @State private var routeError: String?

  var body: some View {
    NavigationSplitView {
      sidebar
        .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
    } detail: {
      NavigationStack(path: $terminalPath) {
        Group {
          if sidebarItem == .global {
            GlobalConversationView { task in
              guard let sessionID = task.sessionID else { return }
              terminalPath.append(
                TerminalRoute.attach(sessionID: sessionID, displayName: task.agent))
            }
            .id(model.activeProfile.profileID)
          } else {
            SessionsPane(
              model: model, open: { terminalPath.append(TerminalRoute.attach($0)) },
              showSettings: { showSettings = true }, showNew: { showNewSession = true },
              kill: { killCandidate = $0 })
          }
        }
        .navigationDestination(for: TerminalRoute.self) { SessionScreen(route: $0) }
        .navigationDestination(for: ReviewRoute.self) { ReviewScreen(route: $0) }
        .toolbar { ToolbarItem(placement: .topBarTrailing) {
          Button("查看桌面", systemImage: "display") { showDesktop = true }
        } }
      }
    }
    .navigationSplitViewStyle(.balanced)
    .preferredColorScheme(showDesktop ? nil : .dark)
    .fullScreenCover(isPresented: $showDesktop) {
      NavigationStack { RemoteDesktopScreen(settings: model.activeProfile) }
    }
    .confirmationDialog("New session", isPresented: $showNewSession, titleVisibility: .visible) {
      Button("Shell") { terminalPath.append(TerminalRoute.create(agent: "shell")) }
      ForEach(model.agents.filter { $0 != "shell" }, id: \.self) { agent in
        Button(agent) { terminalPath.append(TerminalRoute.create(agent: agent)) }
      }
      Button("Cancel", role: .cancel) {}
    } message: { Text("Choose an agent preset on \(model.activeProfile.displayName)") }
    .sheet(isPresented: $showSettings, onDismiss: { editingProfile = nil }) {
      ConnectionSettingsView(canCancel: SettingsStore.isConfigured, settings: editingProfile) {
        terminalPath = NavigationPath()
        model.settingsDidChange()
        NotificationCoordinator.shared.requestAuthorization()
      }
    }
    .alert("Kill session?", isPresented: Binding(
      get: { killCandidate != nil }, set: { if !$0 { killCandidate = nil } }
    ), presenting: killCandidate) { session in
      Button("Kill", role: .destructive) { model.kill(session); killCandidate = nil }
      Button("Cancel", role: .cancel) { killCandidate = nil }
    } message: { session in Text("This stops \(session.displayName) on the Mac.") }
    .alert("Could not open link", isPresented: Binding(
      get: { routeError != nil }, set: { if !$0 { routeError = nil } }
    )) { Button("OK", role: .cancel) { routeError = nil } } message: {
      Text(routeError ?? "Unknown route")
    }
    .onAppear {
      if sidebarItem == nil { sidebarItem = .mac(model.activeProfile.profileID) }
      model.start()
      if SettingsStore.isConfigured { NotificationCoordinator.shared.requestAuthorization() }
      if let pending = NotificationCoordinator.shared.takePendingRoute() {
        handleNotification(pending)
      }
    }
    .onDisappear { model.stop() }
    .onChange(of: sidebarItem) { _, item in
      terminalPath = NavigationPath()
      // Picking a Mac is the act of switching to it; the detail column then shows
      // that Mac's sessions, so the sidebar can never disagree with what is shown.
      if let profileID = item?.macProfileID, profileID != model.activeProfile.profileID {
        model.selectProfile(profileID)
      }
    }
    .onOpenURL(perform: handleURL)
    .onReceive(NotificationCenter.default.publisher(for: .termbridgeOpenSession)) { note in
      handleNotification(note.userInfo ?? [:])
    }
    .onReceive(NotificationCenter.default.publisher(for: Notification.Name("termbridgeOpenDesktop"))) { _ in showDesktop = true }
  }

  private var sidebar: some View {
    List(selection: $sidebarItem) {
      Section {
        Button("查看桌面", systemImage: "display") { showDesktop = true }
        Label("Global", systemImage: "bubble.left.and.bubble.right.fill")
          .tag(SidebarItem.global)
      }

      Section("Mac profiles") {
        ForEach(model.profiles) { profile in
          HStack(spacing: 10) {
            Image(systemName: profile.profileID == model.activeProfile.profileID
              ? "desktopcomputer.and.macbook" : "desktopcomputer")
            Text(profile.displayName).lineLimit(1)
            Spacer()
            if profile.profileID == model.activeProfile.profileID {
              Circle().fill(model.isConnected ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
            }
          }
          .tag(SidebarItem.mac(profile.profileID))
          .contextMenu {
            Button("修改连接", systemImage: "pencil") { editingProfile = profile; showSettings = true }
            Button("重新连接", systemImage: "arrow.clockwise") {
              sidebarItem = .mac(profile.profileID)
              model.selectProfile(profile.profileID)
            }
            Button("远程桌面", systemImage: "display") {
              model.selectProfile(profile.profileID); sidebarItem = .mac(profile.profileID); showDesktop = true
            }
          }
        }
        Button("Manage connections", systemImage: "plus.circle") { showSettings = true }
      }
    }
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func handleURL(_ url: URL) {
    if url.scheme == "termbridge", url.host == "desktop" { showDesktop = true; return }
    if PairingCode.isPairingURL(url) {
      do {
        SettingsStore.save(try PairingCode.parse(url.absoluteString))
        terminalPath = NavigationPath()
        model.settingsDidChange()
        sidebarItem = .mac(model.activeProfile.profileID)
        showSettings = false
        NotificationCoordinator.shared.requestAuthorization()
      } catch { routeError = error.localizedDescription }
      return
    }
    if let review = ReviewDeepLink(url: url) {
      openReview(review)
      return
    }
    guard let route = SessionDeepLink(url: url) else {
      routeError = "This Termbridge link is not supported"
      return
    }
    openSession(route)
  }

  private func handleNotification(_ userInfo: [AnyHashable: Any]) {
    _ = NotificationCoordinator.shared.takePendingRoute()
    guard let route = SessionDeepLink(userInfo: userInfo) else { return }
    openSession(route)
  }

  private func openReview(_ deepLink: ReviewDeepLink) {
    guard selectProfile(hostID: deepLink.hostID) else { return }
    push(deepLink.route)
  }

  private func openSession(_ deepLink: SessionDeepLink) {
    guard selectProfile(hostID: deepLink.hostID) else { return }
    push(
      TerminalRoute.attach(
        sessionID: deepLink.sessionID, displayName: deepLink.displayName,
        source: deepLink.source))
  }

  private func selectProfile(hostID: String) -> Bool {
    guard !hostID.isEmpty else { return true }
    guard let profile = SettingsStore.profiles().first(where: { $0.hostID == hostID }) else {
      routeError = "The Mac profile for this session is no longer available. Pair it again first."
      return false
    }
    if profile.profileID != model.activeProfile.profileID {
      _ = SettingsStore.select(profile.profileID)
      model.settingsDidChange()
    }
    return true
  }

  private func push<Route: Hashable>(_ route: Route) {
    let target = SidebarItem.mac(model.activeProfile.profileID)
    if sidebarItem == target {
      terminalPath = NavigationPath([route])
    } else {
      // Selecting the Mac clears the stack, so the route has to land after it.
      sidebarItem = target
      DispatchQueue.main.async { terminalPath = NavigationPath([route]) }
    }
  }
}

private struct SessionsPane: View {
  @ObservedObject var model: SessionListViewModel
  let open: (SessionInfo) -> Void
  let showSettings: () -> Void
  let showNew: () -> Void
  let kill: (SessionInfo) -> Void

  private let columns = [GridItem(.adaptive(minimum: 300, maximum: 520), spacing: 14)]

  var body: some View {
    ScrollView {
      LazyVGrid(columns: columns, alignment: .leading, spacing: 14) {
        if model.isLoading && model.sessions.isEmpty {
          ProgressView("Loading sessions…").frame(maxWidth: .infinity, minHeight: 260)
            .gridCellColumns(columns.count)
        } else if model.sessions.isEmpty {
          ContentUnavailableView(
            model.isConnected ? "No sessions" : "Not connected",
            systemImage: model.isConnected ? "terminal" : "wifi.slash",
            description: Text(model.isConnected
              ? "Create a shell or agent session to begin." : model.connectionLabel))
          .frame(maxWidth: .infinity, minHeight: 320).gridCellColumns(columns.count)
        } else {
          ForEach(model.sessions) { session in
            SessionCardView(session: session, onEnter: { open(session) }, onKill: { kill(session) })
          }
        }
      }
      .padding(20).padding(.bottom, 70)
    }
    .background(Color(.systemGroupedBackground))
    .refreshable { model.refresh() }
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        HStack(spacing: 8) {
          Text("Sessions").font(.headline)
          Circle().fill(model.isConnected ? Color.green : Color.secondary).frame(width: 7, height: 7)
          Text(model.isConnected ? model.activeProfile.displayName : model.connectionLabel)
            .font(.subheadline).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("sessions-connection-header")
      }
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button("Refresh", systemImage: "arrow.clockwise", action: model.refresh)
        Button("Connection settings", systemImage: "gearshape", action: showSettings)
        Button("New session", systemImage: "plus", action: showNew).disabled(!model.isConnected)
      }
    }
  }

}

private struct SessionCardView: View {
  let session: SessionInfo
  let onEnter: () -> Void
  let onKill: () -> Void
  @ScaledMetric(relativeTo: .body) private var cardHeight = 148.0

  var body: some View {
    VStack(alignment: .leading, spacing: 13) {
      HStack(spacing: 10) {
        Circle().fill(statusColor).frame(width: 10, height: 10)
        Text(session.displayName).font(.headline).lineLimit(1)
        Spacer()
        Text(statusLabel).font(.caption2.weight(.bold)).foregroundStyle(statusColor)
          .padding(.horizontal, 9).padding(.vertical, 5)
          .background(statusColor.opacity(0.14), in: Capsule())
        if !session.isHerdr {
          Menu {
            Button("Kill session", systemImage: "trash", role: .destructive, action: onKill)
          } label: { Image(systemName: "ellipsis").frame(width: 28, height: 28) }
        }
      }
      Text(session.preview ?? "")
        .font(.system(.subheadline, design: .monospaced)).foregroundStyle(.secondary)
        .lineLimit(2, reservesSpace: true).frame(maxWidth: .infinity, alignment: .leading)
      Spacer(minLength: 0)
      HStack {
        Label(metadata, systemImage: session.isHerdr ? "square.split.2x1" : "terminal")
          .font(.caption).foregroundStyle(.secondary).lineLimit(1)
        Spacer()
        if let completedAt = session.completedAt {
          Text("Finished \(completedAt, style: .relative)")
            .font(.caption.weight(.medium)).foregroundStyle(.secondary)
        } else {
          Text("\(session.viewers) viewer\(session.viewers == 1 ? "" : "s")")
            .font(.caption).foregroundStyle(.secondary)
        }
        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
      }
    }
    .padding(16)
    .frame(height: cardHeight, alignment: .top)
    .background(Color(.secondarySystemGroupedBackground),
      in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.primary.opacity(0.08)))
    .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .onTapGesture(perform: onEnter)
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { onEnter() }
    .contextMenu {
      if !session.isHerdr {
        Button("Kill session", systemImage: "trash", role: .destructive, action: onKill)
      }
    }
  }

  private var metadata: String {
    if session.isHerdr {
      return [session.workspace, session.paneID].compactMap { $0 }.joined(separator: " · ")
    }
    return "\(session.cols) × \(session.rows) · created \(session.createdAt.formatted(.relative(presentation: .named)))"
  }
  private var statusLabel: String {
    if session.isHerdr { return (session.status ?? "unknown").uppercased() }
    return session.isActive ? "ACTIVE" : "READY"
  }
  private var statusColor: Color {
    if session.isWorking || session.isActive { return .green }
    if session.isDone { return .cyan }
    if session.status?.lowercased() == "error" { return .red }
    return .secondary
  }
}
