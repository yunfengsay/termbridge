import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct TerminalScreen: View {
  @ObservedObject var model: TerminalViewModel
  @FocusState private var composerFocused: Bool
  @State private var showsFiles = false
  @State private var showsPhotos = false
  @State private var photos: [PhotosPickerItem] = []

  var body: some View {
    VStack(spacing: 0) {
      ZStack(alignment: .top) {
        TerminalWebView(controller: model.terminal)
        if model.showsStatus {
          Text(model.status)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.white.opacity(0.76))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Color.black.opacity(0.68), in: Capsule())
            .padding(.top, 10)
            .transition(.opacity)
        }
      }
      .background(Color(red: 0.051, green: 0.063, blue: 0.055))

      attachmentStrip
      composer

      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 7) {
          key("ESC", action: model.sendEscape)
          toggleKey("CTRL", isOn: model.controlLatched, action: model.toggleControl)
          toggleKey("ALT", isOn: model.altLatched, action: model.toggleAlt)
          key("TAB", action: model.sendTab)
          key("HOME", action: model.sendHome)
          key("↑", action: model.sendUp, narrow: true)
          key("↓", action: model.sendDown, narrow: true)
          key("←", action: model.sendLeft, narrow: true)
          key("→", action: model.sendRight, narrow: true)
          key("END", action: model.sendEnd)
          key("COPY", action: model.copySelection)
          key("PASTE", action: model.pasteClipboard)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
      }
      .background(Color(red: 0.075, green: 0.091, blue: 0.080))
    }
    .navigationTitle(model.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.visible, for: .navigationBar)
    .toolbarColorScheme(.dark, for: .navigationBar)
    .toolbarBackground(Color(red: 0.075, green: 0.091, blue: 0.080), for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button("Keyboard", systemImage: "keyboard") { composerFocused = true }
        if let route = model.reviewRoute {
          NavigationLink(value: route) {
            Label("Review changes", systemImage: "arrow.triangle.branch")
          }
        }
        Menu {
          Button("Copy selection", systemImage: "doc.on.doc", action: model.copySelection)
          Button("Paste", systemImage: "doc.on.clipboard", action: model.pasteClipboard)
          Divider()
          Button("Reconnect", systemImage: "arrow.clockwise", action: model.reconnect)
        } label: {
          Image(systemName: "ellipsis.circle")
        }
      }
    }
    .preferredColorScheme(.dark)
    .fileImporter(isPresented: $showsFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      switch result {
      case .success(let urls): model.addFiles(urls)
      case .failure(let error): model.attachmentError = error.localizedDescription
      }
    }
    .photosPicker(isPresented: $showsPhotos, selection: $photos,
      maxSelectionCount: max(1, ComposerAttachmentQueue.limit - model.attachmentQueue.items.count),
      matching: .images)
    .onChange(of: photos) { _, selected in
      guard !selected.isEmpty else { return }
      model.addPhotos(selected)
      photos = []
    }
    .alert("附件", isPresented: Binding(get: { model.attachmentError != nil }, set: { if !$0 { model.attachmentError = nil } })) {
      Button("好", role: .cancel) { model.attachmentError = nil }
    } message: { Text(model.attachmentError ?? "") }
    .onAppear { model.start() }
    .onDisappear { model.stop() }
  }

  /// In mobile presentation the xterm surface is hidden, so it can never take the
  /// keyboard. Typing lives in this native composer on both presentations, the
  /// same split the Android terminal uses.
  private var composer: some View {
    HStack(spacing: 9) {
      Menu {
        Button("照片", systemImage: "photo") { showsPhotos = true }
        Button("文件", systemImage: "doc") { showsFiles = true }
        Button("粘贴", systemImage: "doc.on.clipboard", action: model.pasteClipboard)
      } label: {
        Image(systemName: "paperclip").font(.title3).frame(width: 44, height: 44)
      }
      .accessibilityLabel("添加附件")
      .accessibilityIdentifier("terminal-add-attachment")
      .disabled(model.attachmentQueue.items.count >= ComposerAttachmentQueue.limit)
      TextField("Message this agent", text: $model.draft)
        .focused($composerFocused)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .submitLabel(.send)
        .onSubmit {
          model.submitComposer()
          composerFocused = true
        }
        .font(.system(.body, design: .monospaced))
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(
          Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

      Button {
        model.submitComposer()
        composerFocused = true
      } label: {
        Image(systemName: "arrow.up.circle.fill").font(.system(size: 27))
      }
      .accessibilityLabel("发送")
      .accessibilityIdentifier("terminal-send")
      .disabled(!model.canSubmitComposer)
    }
    .padding(.horizontal, 10)
    .padding(.top, 8)
    .background(Color(red: 0.075, green: 0.091, blue: 0.080))
  }

  @ViewBuilder
  private var attachmentStrip: some View {
    if !model.attachmentQueue.items.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(model.attachmentQueue.items) { item in
            HStack(spacing: 8) {
              if item.state.busy { ProgressView().controlSize(.small) }
              else { Image(systemName: item.isImage ? "photo" : "doc") }
              VStack(alignment: .leading, spacing: 3) {
                Text(item.name).font(.caption.weight(.medium)).lineLimit(1)
                Text(item.state.label).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
              }
              .frame(maxWidth: 220, alignment: .leading)
              if item.canRetry {
                Button { model.retryAttachment(item.id) } label: {
                  Image(systemName: "arrow.clockwise").frame(width: 44, height: 44)
                }.accessibilityLabel("重新上传 \(item.name)")
              }
              Button { model.removeAttachment(item.id) } label: {
                Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44)
              }.accessibilityLabel("移除 \(item.name)")
            }
            .padding(.leading, 12)
            .padding(.trailing, 2)
            .padding(.vertical, 4)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
          }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
      }
      .accessibilityIdentifier("terminal-attachments")
      .background(Color(red: 0.075, green: 0.091, blue: 0.080))
    }
  }

  private func key(_ title: String, action: @escaping () -> Void, narrow: Bool = false) -> some View
  {
    Button(title, action: action)
      .font(.caption.weight(.bold))
      .foregroundStyle(Color.white.opacity(0.78))
      .frame(width: narrow ? 46 : 64, height: 38)
      .background(
        Color.white.opacity(0.075), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private func toggleKey(_ title: String, isOn: Bool, action: @escaping () -> Void) -> some View {
    Button(title, action: action)
      .font(.caption.weight(.bold))
      .foregroundStyle(isOn ? Color(red: 0.65, green: 0.88, blue: 0.69) : Color.white.opacity(0.68))
      .frame(width: 64, height: 38)
      .background(
        isOn ? Color.green.opacity(0.22) : Color.white.opacity(0.075),
        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }
}
