import SwiftUI

/// The picker changes this device's view only; neither path starts a second Agent.
struct SessionScreen: View {
  let route: TerminalRoute
  @State private var chatMode: Bool
  @State private var fallbackReason: String?
  @State private var autoFallback: Bool
  @StateObject private var chat: AgentChatViewModel
  @StateObject private var terminal: TerminalViewModel

  init(route: TerminalRoute) {
    self.route = route
    let preference = SessionUIPreference.load()
    _chatMode = State(initialValue: preference.startsInChat(sessionID: route.sessionID, source: route.source))
    _autoFallback = State(initialValue: preference == .auto)
    let settings = SettingsStore.load()
    _chat = StateObject(wrappedValue: AgentChatViewModel(sessionID: route.sessionID ?? "", settings: settings))
    _terminal = StateObject(wrappedValue: TerminalViewModel(route: route, settings: settings))
  }

  var body: some View {
    VStack(spacing: 0) {
      if route.sessionID != nil {
        HStack(spacing: 8) {
          Picker("会话视图", selection: $chatMode) {
            Label("对话", systemImage: "bubble.left.and.bubble.right").tag(true)
            Label("终端", systemImage: "terminal").tag(false)
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("session-ui-picker")
          .frame(maxWidth: 240)
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        if let fallbackReason, !chatMode {
          HStack(alignment: .top, spacing: 6) {
            Text(fallbackReason).font(.caption).foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Button("关闭提示", systemImage: "xmark") { self.fallbackReason = nil }.labelStyle(.iconOnly)
          }.padding(.horizontal, 12).padding(.bottom, 5)
        }
      }
      if chatMode {
        AgentChatScreen(model: chat, title: route.displayName) { chatMode = false; autoFallback = false }
      } else { TerminalScreen(model: terminal) }
    }
    .onAppear {
      chat.onUnavailable = { reason in
        guard autoFallback, chatMode else { return }
        fallbackReason = reason
        autoFallback = false
        chatMode = false
      }
    }
    .onChange(of: chatMode) { _, active in
      if !active { chat.stop() }
      else { autoFallback = false; fallbackReason = nil }
    }
    .onDisappear { chat.stop() }
  }
}

struct AgentChatScreen: View {
  @ObservedObject var model: AgentChatViewModel
  let title: String
  let openTerminal: () -> Void
  @Environment(\.scenePhase) private var scenePhase
  @FocusState private var composerFocused: Bool

  var body: some View {
    VStack(spacing: 0) {
      if let reason = model.unavailable {
        ContentUnavailableView {
          Label("暂时无法使用对话视图", systemImage: "bubble.left.and.exclamationmark.bubble.right")
        } description: { Text(reason) } actions: {
          Button("打开终端", action: openTerminal).buttonStyle(.borderedProminent)
          Button("重新连接", action: model.reconnect)
        }
      } else {
        AgentChatWebView(controller: model.web)
      }
      VStack(alignment: .leading, spacing: 6) {
        if let label = model.receiptLabel {
          Text(label).font(.caption).foregroundStyle(model.composer.state == .uncertain ? .orange : .secondary)
            .accessibilityIdentifier("agent-chat-receipt")
        } else {
          Text(model.capabilities.degraded ?? model.status).font(.caption).foregroundStyle(.secondary)
        }
        if let detail = model.composer.detail, model.composer.state == .failed || model.composer.state == .uncertain {
          Text(detail).font(.caption2).foregroundStyle(.secondary).lineLimit(3)
        }
        if model.composer.draft.utf16.count > 16_000 {
          Text("消息不能超过 16,000 个字符").font(.caption).foregroundStyle(.orange)
        }
        HStack(alignment: .bottom, spacing: 8) {
          TextField("给这个 Agent 发消息", text: $model.composer.draft, axis: .vertical)
            .lineLimit(1...6)
            .focused($composerFocused)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            .accessibilityIdentifier("agent-chat-composer")
          Button {
            model.send()
            composerFocused = true
          } label: {
            Image(systemName: "arrow.up.circle.fill").font(.system(size: 30))
          }
          .accessibilityLabel(model.composer.canRetry ? "重试发送" : "发送")
          .accessibilityIdentifier("agent-chat-send")
          .disabled(!model.canSend)
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 8)
      .background(.bar)
    }
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button("显示键盘", systemImage: "keyboard") { composerFocused = true }
          Button("重新连接", systemImage: "arrow.clockwise", action: model.reconnect)
          Button("打开终端", systemImage: "terminal", action: openTerminal)
          Divider()
          Label("附件、停止与审批请在终端操作", systemImage: "info.circle")
        } label: { Image(systemName: "ellipsis.circle") }
      }
    }
    .onAppear { model.start() }
    .onDisappear { model.stop() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { model.start() }
      else if phase == .background { model.stop() }
    }
  }
}
