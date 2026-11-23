import Foundation

enum ReviewNavigatorMode: String, Hashable, CaseIterable {
  case tree
  case flat
}

enum ReviewNavigatorRow: Identifiable, Hashable {
  case directory(ReviewNavigatorDirectoryRow)
  case file(ReviewNavigatorFileRow)

  var id: String {
    switch self {
    case .directory(let row): return row.id
    case .file(let row): return row.id
    }
  }

  var depth: Int {
    switch self {
    case .directory(let row): return row.depth
    case .file(let row): return row.depth
    }
  }
}

struct ReviewNavigatorDirectoryRow: Identifiable, Hashable {
  let path: String
  let name: String
  let depth: Int
  let expanded: Bool
  let fileCount: Int

  var id: String { "directory:\(path)" }
}

struct ReviewNavigatorFileRow: Identifiable, Hashable {
  let file: ReviewFileInfo
  let title: String
  let depth: Int
  let selected: Bool

  var id: String { "file:\(file.path)" }
}

enum ReviewNavigatorPresentation {
  static func rows(
    files: [ReviewFileInfo], mode: ReviewNavigatorMode,
    collapsedDirectories: Set<String> = [], selectedPath: String? = nil
  ) -> [ReviewNavigatorRow] {
    switch mode {
    case .flat:
      return files.sorted { $0.path < $1.path }.map { file in
        .file(
          ReviewNavigatorFileRow(
            file: file, title: file.path, depth: 0, selected: file.path == selectedPath))
      }
    case .tree:
      return treeRows(files, collapsedDirectories, selectedPath)
    }
  }

  private static func treeRows(
    _ files: [ReviewFileInfo], _ collapsedDirectories: Set<String>, _ selectedPath: String?
  ) -> [ReviewNavigatorRow] {
    var directories: Set<String> = []
    var directoryCounts: [String: Int] = [:]
    for file in files {
      let parts = file.path.split(separator: "/").filter { !$0.isEmpty }
      guard parts.count > 1 else { continue }
      for index in 1..<parts.count {
        let path = parts.prefix(index).joined(separator: "/")
        directories.insert(path)
        directoryCounts[path, default: 0] += 1
      }
    }
    var directoryChildren: [String: [String]] = [:]
    for path in directories.sorted() {
      directoryChildren[directoryParent(path), default: []].append(path)
    }
    var fileChildren: [String: [ReviewFileInfo]] = [:]
    for file in files {
      fileChildren[directoryParent(file.path), default: []].append(file)
    }

    var rows: [ReviewNavigatorRow] = []
    func append(parent: String, depth: Int) {
      for firstPath in directoryChildren[parent] ?? [] {
        // A chain of directories that holds no file of its own is one navigation
        // step, not five. Compact it into a single row like the Android tree.
        var path = firstPath
        var compactNames = [lastSegment(path)]
        while (fileChildren[path] ?? []).isEmpty {
          let children = directoryChildren[path] ?? []
          guard children.count == 1, let only = children.first else { break }
          path = only
          compactNames.append(lastSegment(path))
        }
        let expanded = !collapsedDirectories.contains(path)
        rows.append(
          .directory(
            ReviewNavigatorDirectoryRow(
              path: path, name: compactNames.joined(separator: "/"), depth: depth,
              expanded: expanded, fileCount: directoryCounts[path] ?? 0)))
        if expanded { append(parent: path, depth: depth + 1) }
      }
      for file in (fileChildren[parent] ?? []).sorted(by: { $0.path < $1.path }) {
        rows.append(
          .file(
            ReviewNavigatorFileRow(
              file: file, title: lastSegment(file.path), depth: depth,
              selected: file.path == selectedPath)))
      }
    }

    append(parent: "", depth: 0)
    return rows
  }

  private static func directoryParent(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "" }
    return String(path[path.startIndex..<slash])
  }

  private static func lastSegment(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return path }
    return String(path[path.index(after: slash)...])
  }
}
