import SwiftUI

struct NewSessionView: View {
    @ObservedObject var creator: MacSessionCreation
    @Environment(\.dismiss) private var dismiss
    @FocusState private var directoryFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("新建对话").font(.title2.weight(.semibold))
            Text("创建到：\(creator.sourceName)").foregroundStyle(.secondary)
            if creator.phase == .connecting || creator.phase == .idle {
                HStack { ProgressView().controlSize(.small); Text("正在读取 Host 的 Agent 配置…") }
            }
            Picker("Agent", selection: $creator.agent) {
                Text("Terminal（普通终端）").tag("")
                ForEach(creator.agents, id: \.self) { Text($0).tag($0) }
            }.disabled(creator.phase != .choosing)
            VStack(alignment: .leading, spacing: 6) {
                TextField("工作目录（可选）", text: $creator.directory)
                    .textFieldStyle(.roundedBorder).focused($directoryFocused)
                    .disabled(creator.phase != .choosing)
                    .onSubmit { creator.create() }
                Text("填写此 Host 上的目录；留空使用 Host 的默认目录。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = creator.error {
                Text(error).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button(creator.phase == .failed ? "关闭" : "取消") { creator.cancel(); dismiss() }
                    .keyboardShortcut(.cancelAction).disabled(creator.phase == .creating)
                Button { creator.create() } label: {
                    if creator.phase == .creating { ProgressView().controlSize(.small) }
                    else { Text("创建并打开") }
                }.keyboardShortcut(.defaultAction).disabled(creator.phase != .choosing)
            }
        }
        .padding(24).frame(width: 460)
        .background(Color(nsColor: .windowBackgroundColor))
        .task { creator.connect() }
        .onChange(of: creator.phase) { phase in
            if phase == .choosing { directoryFocused = true }
            if phase == .finished { dismiss() }
        }
        .onDisappear { creator.cancel() }
    }
}

struct NewSessionCommands: Commands {
    @ObservedObject var model: ControlCenterModel
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("新建对话…") {
                model.prepareNewSession()
                openWindow(id: "new-session")
                NSApp.activate(ignoringOtherApps: true)
            }.keyboardShortcut("n", modifiers: .command)
        }
    }
}
