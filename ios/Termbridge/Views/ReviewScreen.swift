import SwiftUI

struct ReviewScreen: View {
  @StateObject private var model: ReviewViewModel
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @State private var branchCandidate: String?

  init(route: ReviewRoute) {
    _model = StateObject(wrappedValue: ReviewViewModel(route: route))
  }

  /// iPad keeps the navigator beside the file. iPhone reuses the Android flow
  /// where picking a file replaces the list.
  private var isWide: Bool { horizontalSizeClass == .regular }

  var body: some View {
    VStack(spacing: 0) {
      header
      Divider().overlay(ReviewPalette.line)
      content
    }
    .background(ReviewPalette.background)
    .navigationTitle(model.title)
    .navigationBarTitleDisplayMode(.inline)
    .toolbarColorScheme(.dark, for: .navigationBar)
    .toolbarBackground(ReviewPalette.chrome, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbar { toolbarContent }
    .overlay(alignment: .bottom) { branchNotice }
    .alert(
      "Switch branch",
      isPresented: Binding(
        get: { branchCandidate != nil }, set: { if !$0 { branchCandidate = nil } }),
      presenting: branchCandidate
    ) { branch in
      Button("Switch") {
        model.switchBranch(branch)
        branchCandidate = nil
      }
      Button("Cancel", role: .cancel) { branchCandidate = nil }
    } message: { branch in
      Text("Switch this repository to \(branch)? The Mac keeps the working tree untouched.")
    }
    .task(id: model.branchNotice) {
      guard model.branchNotice != nil else { return }
      try? await Task.sleep(nanoseconds: 2_600_000_000)
      model.dismissBranchNotice()
    }
    .preferredColorScheme(.dark)
    .onAppear { model.start() }
    .onDisappear { model.stop() }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 9) {
      Picker("Review mode", selection: $model.mode) {
        ForEach(ReviewMode.allCases) { mode in Text(mode.shortTitle).tag(mode) }
      }
      .pickerStyle(.segmented)

      HStack(spacing: 10) {
        if let status = model.statusLine {
          Text(status).font(.caption.weight(.semibold))
            .foregroundStyle(model.isConnected ? Color.secondary : ReviewPalette.modified)
            .lineLimit(1).truncationMode(.middle)
        } else {
          Text(model.subtitle)
            .font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 8)
        if model.mode == .branch, let snapshot = model.snapshot, !snapshot.branches.isEmpty {
          Menu {
            ForEach(snapshot.branches, id: \.self) { branch in
              Button(branch) { model.selectCompareBranch(branch) }
            }
          } label: {
            Label(model.compareBranch ?? "Compare with", systemImage: "arrow.triangle.pull")
              .font(.caption.weight(.semibold)).lineLimit(1)
          }
        }
      }
    }
    .padding(.horizontal, 14)
    .padding(.top, 10)
    .padding(.bottom, 9)
    .background(ReviewPalette.chrome)
  }

  @ViewBuilder private var content: some View {
    if model.snapshot == nil {
      placeholder
    } else if isWide {
      HStack(spacing: 0) {
        if model.navigatorOpen {
          navigator.frame(width: 300)
          Divider().overlay(ReviewPalette.line)
        }
        diff
      }
    } else if model.navigatorOpen {
      navigator
    } else {
      diff
    }
  }

  private var placeholder: some View {
    VStack(spacing: 14) {
      if model.isLoading {
        ProgressView()
        Text(model.status ?? "Finding repository…").font(.footnote).foregroundStyle(.secondary)
      } else {
        ContentUnavailableView(
          "Review unavailable", systemImage: "arrow.triangle.branch",
          description: Text(model.status ?? "This session is not inside a Git repository."))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var navigator: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(model.navigatorTitle).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
        Spacer()
        Text("\(model.files.count) file\(model.files.count == 1 ? "" : "s")")
          .font(.caption2).foregroundStyle(.tertiary)
      }
      .padding(.horizontal, 14).padding(.vertical, 8)

      Divider().overlay(ReviewPalette.line)

      ScrollView {
        LazyVStack(spacing: 0) {
          ForEach(model.navigatorRows) { row in
            ReviewNavigatorRowView(row: row, showsStats: model.mode != .files) {
              switch row {
              case .directory(let directory): model.toggleDirectory(directory.path)
              case .file(let file): model.select(path: file.file.path, keepNavigator: isWide)
              }
            }
          }
        }
        .padding(.vertical, 4)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(ReviewPalette.navigator)
  }

  private var diff: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(model.rows) { row in
          switch row {
          case .file(let header): ReviewFileHeaderView(row: header)
          case .hunk(let hunk): ReviewHunkHeaderView(row: hunk)
          case .line(let line): ReviewLineView(row: line, highlighter: model.highlighter)
          case .notice(let notice): ReviewNoticeView(row: notice)
          }
        }
      }
      .padding(.bottom, 28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(ReviewPalette.background)
  }

  @ViewBuilder private var branchNotice: some View {
    if let notice = model.branchNotice {
      Text(notice)
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(ReviewPalette.chrome, in: Capsule())
        .overlay(Capsule().stroke(ReviewPalette.line))
        .padding(.bottom, 22)
        .transition(.opacity)
    }
  }

  @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
    ToolbarItemGroup(placement: .topBarTrailing) {
      Button(
        model.navigatorOpen ? "Hide files" : "Show files",
        systemImage: model.navigatorOpen ? "sidebar.leading" : "sidebar.left",
        action: model.toggleNavigator
      )
      .disabled(model.files.isEmpty)

      Menu {
        Button(
          model.navigatorMode == .tree ? "Use flat file list" : "Use directory tree",
          systemImage: model.navigatorMode == .tree ? "list.bullet" : "list.bullet.indent",
          action: model.toggleLayout
        )
        .disabled(model.files.isEmpty)
        Button("Refresh", systemImage: "arrow.clockwise", action: model.refresh)
        if let snapshot = model.snapshot, snapshot.branches.count > 1 {
          Divider()
          Menu("Switch branch", systemImage: "arrow.triangle.branch") {
            if model.canSwitchBranch {
              ForEach(model.switchableBranches, id: \.self) { branch in
                Button(branch) { branchCandidate = branch }
              }
            } else {
              Text("Commit or stash the current changes on the Mac before switching branches.")
            }
          }
        }
      } label: {
        Image(systemName: "ellipsis.circle")
      }
    }
  }
}

private struct ReviewNavigatorRowView: View {
  let row: ReviewNavigatorRow
  let showsStats: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 7) {
        Color.clear.frame(width: CGFloat(row.depth) * 13, height: 1)
        switch row {
        case .directory(let directory):
          Image(systemName: directory.expanded ? "chevron.down" : "chevron.right")
            .font(.system(size: 9, weight: .bold)).foregroundStyle(.tertiary).frame(width: 10)
          icon(ReviewFileIcon.directory(directory.path, expanded: directory.expanded))
          Text(directory.name).font(.system(size: 13, weight: .medium)).lineLimit(1)
            .truncationMode(.head)
          Spacer(minLength: 6)
          Text("\(directory.fileCount)").font(.caption2).foregroundStyle(.tertiary)
        case .file(let file):
          Color.clear.frame(width: 10, height: 1)
          icon(ReviewFileIcon.file(file.file.path))
          Text(file.title).font(.system(size: 13, design: .monospaced)).lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 6)
          if showsStats, file.file.additions > 0 || file.file.deletions > 0 {
            Text("+\(file.file.additions)").font(.caption2).foregroundStyle(ReviewPalette.addText)
            Text("−\(file.file.deletions)").font(.caption2)
              .foregroundStyle(ReviewPalette.deleteText)
          }
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(Rectangle())
      .background(isSelected ? ReviewPalette.selection : .clear)
    }
    .buttonStyle(.plain)
  }

  private var isSelected: Bool {
    if case .file(let file) = row { return file.selected }
    return false
  }

  private func icon(_ icon: ReviewIcon) -> some View {
    Image(systemName: icon.symbol)
      .font(.system(size: 12))
      .foregroundStyle(ReviewPalette.tint(icon.tint))
      .frame(width: 17)
  }
}

private struct ReviewFileHeaderView: View {
  let row: ReviewFileHeaderRow

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      let icon = ReviewFileIcon.file(row.path)
      Image(systemName: icon.symbol).font(.system(size: 13))
        .foregroundStyle(ReviewPalette.tint(icon.tint))
      VStack(alignment: .leading, spacing: 2) {
        Text(row.path).font(.system(size: 12, weight: .semibold, design: .monospaced))
          .lineLimit(1).truncationMode(.middle)
        if let oldPath = row.oldPath {
          Text("from \(oldPath)").font(.system(size: 10, design: .monospaced))
            .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
        }
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 2) {
        Text(statusLabel).font(.system(size: 9, weight: .bold)).foregroundStyle(statusColor)
        if row.additions > 0 || row.deletions > 0 {
          Text("+\(row.additions)  −\(row.deletions)").font(.system(size: 9))
            .foregroundStyle(.secondary)
        }
      }
    }
    .padding(.horizontal, 10).padding(.vertical, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      ReviewPalette.chrome, in: RoundedRectangle(cornerRadius: 9, style: .continuous)
    )
    .overlay(RoundedRectangle(cornerRadius: 9).stroke(ReviewPalette.line))
    .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 3)
  }

  private var statusLabel: String {
    switch row.status {
    case "added": return "ADDED"
    case "deleted": return "DELETED"
    case "renamed": return "RENAMED"
    case "untracked": return "UNTRACKED"
    case "unchanged": return "FILE"
    default: return "MODIFIED"
    }
  }

  private var statusColor: Color {
    switch row.status {
    case "added", "untracked": return ReviewPalette.addText
    case "deleted": return ReviewPalette.deleteText
    case "renamed": return ReviewPalette.renamed
    case "unchanged": return .secondary
    default: return ReviewPalette.modified
    }
  }
}

private struct ReviewHunkHeaderView: View {
  let row: ReviewHunkHeaderRow

  var body: some View {
    Text(row.text)
      .font(.system(size: 10, design: .monospaced))
      .foregroundStyle(.secondary)
      .padding(.horizontal, 12).padding(.vertical, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(ReviewPalette.hunk)
  }
}

private struct ReviewLineView: View {
  let row: ReviewLineRow
  let highlighter: ReviewSyntaxHighlighter

  var body: some View {
    HStack(alignment: .top, spacing: 0) {
      Text(ReviewPresentation.lineNumber(row.line))
        .foregroundStyle(.tertiary)
        .frame(width: 38, alignment: .trailing)
        .padding(.trailing, 5)
      Text(prefix).fontWeight(.bold).foregroundStyle(baseColor).frame(width: 13)
      Text(code)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }
    .font(.system(size: 11.5, design: .monospaced))
    .padding(.vertical, 1)
    .padding(.trailing, 8)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(background)
  }

  private var prefix: String {
    switch row.line.kind {
    case "add": return "+"
    case "delete": return "−"
    default: return " "
    }
  }

  private var background: Color {
    switch row.line.kind {
    case "add": return ReviewPalette.addBackground
    case "delete": return ReviewPalette.deleteBackground
    default: return .clear
    }
  }

  private var baseColor: Color {
    switch row.line.kind {
    case "add": return ReviewPalette.addText
    case "delete": return ReviewPalette.deleteText
    default: return ReviewPalette.ink
    }
  }

  /// Syntax colour wins where the tokenizer is confident; the diff colour stays
  /// the base so an added or removed line still reads as added or removed.
  private var code: AttributedString {
    let text = row.line.text.isEmpty ? " " : row.line.text
    var result = AttributedString()
    for token in highlighter.tokens(path: row.path, code: text) {
      var piece = AttributedString(token.text)
      piece.foregroundColor = ReviewPalette.token(token.kind) ?? baseColor
      result.append(piece)
    }
    return result.characters.isEmpty ? AttributedString(text) : result
  }
}

private struct ReviewNoticeView: View {
  let row: ReviewNoticeRow

  var body: some View {
    Text(message)
      .font(.footnote)
      .foregroundStyle(.secondary)
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 22).padding(.vertical, 18)
  }

  private var message: String {
    switch row.kind {
    case .empty: return "No changes in this view."
    case .projectEmpty: return "No project files were found."
    case .binary: return "Binary file — content preview is unavailable."
    case .privateFile: return "Private configuration — its contents stay on the Host."
    case .fileTruncated: return "This file is larger than the mobile preview limit."
    case .snapshotTruncated:
      return "The review was shortened for mobile. Use Terminal for the complete diff."
    }
  }
}

private enum ReviewPalette {
  static let background = Color(red: 0.051, green: 0.063, blue: 0.055)
  static let chrome = Color(red: 0.075, green: 0.091, blue: 0.080)
  static let navigator = Color(red: 0.063, green: 0.075, blue: 0.067)
  static let line = Color.white.opacity(0.09)
  static let selection = Color.green.opacity(0.16)
  static let hunk = Color.white.opacity(0.05)
  static let ink = Color.white.opacity(0.86)
  static let addBackground = Color(red: 0.086, green: 0.192, blue: 0.114)
  static let addText = Color(red: 0.545, green: 0.855, blue: 0.616)
  static let deleteBackground = Color(red: 0.216, green: 0.086, blue: 0.086)
  static let deleteText = Color(red: 0.937, green: 0.588, blue: 0.565)
  static let modified = Color(red: 0.882, green: 0.729, blue: 0.400)
  static let renamed = Color(red: 0.545, green: 0.694, blue: 0.925)

  static func token(_ kind: ReviewTokenKind) -> Color? {
    switch kind {
    case .plain: return nil
    case .comment: return Color.white.opacity(0.38)
    case .string: return Color(red: 0.945, green: 0.706, blue: 0.478)
    case .number: return Color(red: 0.882, green: 0.812, blue: 0.518)
    case .keyword: return Color(red: 0.812, green: 0.588, blue: 0.933)
    case .type: return Color(red: 0.478, green: 0.812, blue: 0.847)
    }
  }

  static func tint(_ tint: ReviewIconTint) -> Color {
    switch tint {
    case .folder: return Color(red: 0.514, green: 0.741, blue: 0.573)
    case .source: return Color(red: 0.545, green: 0.855, blue: 0.616)
    case .kotlin: return Color(red: 0.788, green: 0.545, blue: 0.937)
    case .typescript: return Color(red: 0.400, green: 0.663, blue: 0.918)
    case .java: return Color(red: 0.918, green: 0.596, blue: 0.451)
    case .swift: return Color(red: 0.945, green: 0.475, blue: 0.325)
    case .markup: return Color(red: 0.905, green: 0.549, blue: 0.478)
    case .json: return Color(red: 0.902, green: 0.796, blue: 0.478)
    case .markdown: return Color(red: 0.639, green: 0.729, blue: 0.847)
    case .shell: return Color(red: 0.588, green: 0.847, blue: 0.694)
    case .git: return Color(red: 0.918, green: 0.529, blue: 0.400)
    case .gradle: return Color(red: 0.478, green: 0.796, blue: 0.812)
    case .plain: return Color.white.opacity(0.55)
    }
  }
}
