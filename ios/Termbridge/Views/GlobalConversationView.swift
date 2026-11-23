import SwiftUI

struct GlobalConversationView: View {
  @StateObject private var model = GlobalConversationViewModel()
  @State private var showClearConfirmation = false
  let openTask: (BrainTaskInfo) -> Void

  var body: some View {
    VStack(spacing: 0) {
      connectionBar
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(spacing: 14) {
            if model.messages.isEmpty && !model.isLoading {
              ContentUnavailableView(
                "Start a global conversation", systemImage: "sparkles",
                description: Text("Tell Brain what you want to do. It will answer or delegate when execution is needed."))
              .padding(.top, 72)
            }
            ForEach(model.messages) { message in
              BrainMessageBubble(message: message)
                .id("message:\(message.id)")
            }
            ForEach(model.tasks) { task in
              BrainTaskCard(task: task) { openTask(task) }
                .id("task:\(task.id)")
            }
            ForEach(model.deliverables) { deliverable in
              BrainDeliverableCard(deliverable: deliverable)
                .id("deliverable:\(deliverable.id)")
            }
            ForEach(executionTraces) { trace in
              ExecutionForkCard(trace: trace)
                .id("execution:\(trace.id)")
            }
          }
          .padding(20)
        }
        .onChange(of: model.messages.count) { _, _ in
          if let last = model.messages.last { proxy.scrollTo("message:\(last.id)", anchor: .bottom) }
        }
      }
      composer
    }
    .background(Color(.systemGroupedBackground))
    .navigationTitle("Global")
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button("New conversation", systemImage: "plus", action: model.newConversation)
        Menu("History", systemImage: "clock.arrow.circlepath") {
          if model.history.isEmpty {
            Text("No previous conversations")
          } else {
            ForEach(model.history) { conversation in
              Button {
                model.restoreHistory(conversation)
              } label: {
                Text(conversation.title)
                Text(conversation.updatedAt, style: .relative)
              }
            }
          }
        }
        Menu("Tools", systemImage: "point.3.connected.trianglepath.dotted") {
          if model.toolCatalog.isEmpty {
            Text("Tool catalog unavailable")
          } else {
            ForEach(model.toolCatalog) { tool in
              VStack(alignment: .leading) {
                Text(tool.label)
                Text("\(tool.execution) · \(tool.category)")
              }
            }
          }
        }
        Menu("More", systemImage: "ellipsis.circle") {
          Button("Refresh", systemImage: "arrow.clockwise", action: model.refresh)
          Button("Clear all conversations", systemImage: "trash", role: .destructive) {
            showClearConfirmation = true
          }
        }
      }
    }
    .confirmationDialog(
      "Clear Global history?",
      isPresented: $showClearConfirmation,
      titleVisibility: .visible
    ) {
      Button("Clear", role: .destructive, action: model.clearConversation)
    } message: {
      Text("The current conversation and every archived conversation will be permanently removed.")
    }
    .onAppear { model.start() }
    .onDisappear { model.stop() }
  }

  private var executionTraces: [ExecutionForkTrace] {
    Dictionary(grouping: model.executionEvents, by: \.forkID).values.compactMap(ExecutionForkTrace.init(events:))
      .sorted { $0.startedAtMilliseconds < $1.startedAtMilliseconds }
  }

  private var connectionBar: some View {
    HStack(spacing: 8) {
      Circle().fill(model.isConnected ? Color.green : Color.secondary).frame(width: 8, height: 8)
      Text(model.connectionLabel).font(.caption.weight(.semibold)).lineLimit(1)
      Spacer()
      if model.isLoading { ProgressView().controlSize(.small) }
    }
    .foregroundStyle(.secondary)
    .padding(.horizontal, 20).padding(.vertical, 5)
    .background(.ultraThinMaterial)
  }

  private var composer: some View {
    VStack(spacing: 8) {
      if let status = model.composerStatus {
        HStack {
          Spacer()
          Text(status).font(.caption).foregroundStyle(.secondary)
        }
      }
      HStack(alignment: .bottom, spacing: 10) {
        TextField("Ask every Mac agent…", text: $model.draft, axis: .vertical)
          .lineLimit(1...6).textFieldStyle(.plain).padding(12)
          .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))
          .onSubmit(model.send)
        Button("Send", systemImage: "arrow.up.circle.fill", action: model.send)
          .labelStyle(.iconOnly).font(.system(size: 34)).disabled(!model.canSend)
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 10)
    .background(.bar)
  }
}

private struct ExecutionForkTrace: Identifiable {
  let id: String
  let model: String
  let phase: String
  let startedAtMilliseconds: Double
  let tools: [ExecutionForkEventInfo]

  init?(events: [ExecutionForkEventInfo]) {
    let ordered = events.sorted { $0.createdAtMilliseconds < $1.createdAtMilliseconds }
    guard let first = ordered.first, let last = ordered.last else { return nil }
    id = first.forkID
    model = ordered.compactMap(\.model).last ?? "qwen3.8-flash"
    phase = ordered.last { ["fork_completed", "fork_failed", "fork_cancelled"].contains($0.phase) }?.phase ?? last.phase
    startedAtMilliseconds = first.createdAtMilliseconds
    tools = Dictionary(grouping: ordered.filter { $0.callID != nil }, by: { $0.callID ?? "" })
      .values.compactMap { $0.last }.sorted { $0.createdAtMilliseconds < $1.createdAtMilliseconds }
  }
}

private struct ExecutionForkCard: View {
  let trace: ExecutionForkTrace
  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack {
        ProgressView().controlSize(.small).opacity(isActive ? 1 : 0)
        Text(trace.model).font(.subheadline.weight(.semibold))
        Spacer()
        Text(status).font(.caption.weight(.semibold)).foregroundStyle(isFailed ? .red : .secondary)
      }
      if trace.tools.isEmpty {
        Text(isActive ? "Analyzing context…" : "No tools used").font(.caption).foregroundStyle(.secondary)
      } else {
        ForEach(trace.tools) { tool in
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: tool.phase == "tool_failed" ? "exclamationmark.circle" : tool.phase == "tool_completed" ? "checkmark.circle" : "circle.dotted")
            Text(tool.summary ?? tool.toolName ?? "Tool").lineLimit(2)
          }.font(.caption).foregroundStyle(.secondary)
        }
      }
    }
    .padding(12)
    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 15))
  }
  private var isActive: Bool { !["fork_completed", "fork_failed", "fork_cancelled"].contains(trace.phase) }
  private var isFailed: Bool { trace.phase == "fork_failed" }
  private var status: String { isActive ? "Running" : isFailed ? "Failed" : trace.phase == "fork_cancelled" ? "Cancelled" : "Completed" }
}

private struct BrainMessageBubble: View {
  let message: BrainMessageInfo
  var body: some View {
    HStack {
      if message.role == "user" { Spacer(minLength: 48) }
      VStack(alignment: .leading, spacing: 5) {
        Text(message.role == "user" ? "You" : "Brain")
          .font(.caption2.weight(.bold)).foregroundStyle(.secondary)
        if let status = message.voiceStatus, status != "completed" {
          Text(status == "interrupted" ? "Voice · Interrupted" : "Voice · Responding")
            .font(.caption2).foregroundStyle(.secondary)
        }
        Text(message.text).textSelection(.enabled)
      }
      .padding(14)
      .background(
        message.role == "user" ? Color.accentColor.opacity(0.22) : Color(.secondarySystemGroupedBackground),
        in: RoundedRectangle(cornerRadius: 18, style: .continuous))
      if message.role != "user" { Spacer(minLength: 48) }
    }
  }
}

private struct BrainTaskCard: View {
  let task: BrainTaskInfo
  let open: () -> Void
  var body: some View {
    Button(action: open) {
      HStack(spacing: 12) {
        Image(systemName: statusSymbol).foregroundStyle(statusColor)
        VStack(alignment: .leading, spacing: 3) {
          Text(task.agent).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
          Text(task.error ?? task.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
        }
        Spacer()
        Text(task.status.capitalized).font(.caption.weight(.semibold)).foregroundStyle(statusColor)
        if task.sessionID != nil { Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary) }
      }
      .padding(13)
      .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 15))
    }
    .buttonStyle(.plain).disabled(task.sessionID == nil)
  }

  private var statusSymbol: String {
    switch task.status { case "completed": return "checkmark.circle.fill"; case "failed": return "xmark.circle.fill"; default: return "bolt.circle.fill" }
  }
  private var statusColor: Color { task.status == "failed" ? .red : task.status == "completed" ? .green : .orange }
}

private struct BrainDeliverableCard: View {
  let deliverable: BrainDeliverableInfo

  var body: some View {
    Group {
      if let url = deliverable.url {
        Link(destination: url) { content }
      } else {
        content
      }
    }
    .buttonStyle(.plain)
  }

  private var content: some View {
    HStack(spacing: 12) {
      Image(systemName: symbol).foregroundStyle(.cyan)
      VStack(alignment: .leading, spacing: 3) {
        Text(deliverable.title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
        Text(deliverable.path ?? deliverable.url?.absoluteString ?? deliverable.kind.capitalized)
          .font(.caption).foregroundStyle(.secondary).lineLimit(2)
      }
      Spacer()
      Text(deliverable.kind.capitalized).font(.caption.weight(.semibold)).foregroundStyle(.cyan)
      if deliverable.url != nil { Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(.tertiary) }
    }
    .padding(13)
    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 15))
  }

  private var symbol: String {
    switch deliverable.kind {
    case "preview": return "safari"
    case "report": return "doc.text"
    case "canvas": return "paintpalette"
    case "diff": return "arrow.left.arrow.right"
    case "file": return "doc"
    default: return "link"
    }
  }
}
