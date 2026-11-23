import Foundation

/// The three Host-supported review surfaces: uncommitted work, a diff against a
/// chosen local base branch, and read-only project browsing.
enum ReviewMode: String, CaseIterable, Identifiable, Hashable {
  case working
  case branch
  case files

  var id: String { rawValue }

  var title: String {
    switch self {
    case .working: return "Working tree"
    case .branch: return "Branch diff"
    case .files: return "Files"
    }
  }

  var shortTitle: String {
    switch self {
    case .working: return "Changes"
    case .branch: return "Branch"
    case .files: return "Files"
    }
  }

  static func named(_ raw: String?) -> ReviewMode? { raw.flatMap(ReviewMode.init(rawValue:)) }
}

/// One rendered row of the mobile review list. The Host already bounded the
/// snapshot, so flattening happens on the client exactly like the Android peer.
enum ReviewRow: Identifiable, Hashable {
  case file(ReviewFileHeaderRow)
  case hunk(ReviewHunkHeaderRow)
  case line(ReviewLineRow)
  case notice(ReviewNoticeRow)

  var id: String {
    switch self {
    case .file(let row): return row.id
    case .hunk(let row): return row.id
    case .line(let row): return row.id
    case .notice(let row): return row.id
    }
  }
}

struct ReviewFileHeaderRow: Identifiable, Hashable {
  let id: String
  let path: String
  let oldPath: String?
  let status: String
  let additions: Int
  let deletions: Int
}

struct ReviewHunkHeaderRow: Identifiable, Hashable {
  let id: String
  let text: String
}

struct ReviewLineRow: Identifiable, Hashable {
  let id: String
  let path: String
  let line: ReviewLineInfo
}

struct ReviewNoticeRow: Identifiable, Hashable {
  let id: String
  let kind: ReviewNotice
}

enum ReviewNotice: String, Hashable {
  case empty
  case projectEmpty
  case binary
  case privateFile
  case fileTruncated
  case snapshotTruncated
}

enum ReviewPresentation {
  /// A diff row shows one authoritative number. Showing both old and new columns
  /// wastes the narrow gutter without telling the reader anything more.
  static func lineNumber(_ line: ReviewLineInfo) -> String {
    (line.newLine ?? line.oldLine).map(String.init) ?? ""
  }

  static func rows(_ snapshot: ReviewSnapshotInfo, selectedPath: String? = nil) -> [ReviewRow] {
    let files = selectedPath.map { path in snapshot.files.filter { $0.path == path } }
      ?? snapshot.files
    guard !files.isEmpty else {
      return [
        .notice(
          ReviewNoticeRow(
            id: "notice:0", kind: snapshot.mode == "files" ? .projectEmpty : .empty))
      ]
    }

    var rows: [ReviewRow] = []
    var ordinal = 0
    func nextID(_ prefix: String) -> String {
      ordinal += 1
      return "\(prefix):\(ordinal)"
    }

    for file in files {
      rows.append(
        .file(
          ReviewFileHeaderRow(
            id: nextID("file"), path: file.path, oldPath: file.oldPath, status: file.status,
            additions: file.additions, deletions: file.deletions)))
      if file.isPrivate {
        rows.append(.notice(ReviewNoticeRow(id: nextID("notice"), kind: .privateFile)))
      } else if file.binary {
        rows.append(.notice(ReviewNoticeRow(id: nextID("notice"), kind: .binary)))
      }
      for hunk in file.hunks {
        // Project browsing returns whole-file content with no hunk header. Do not
        // invent one; a fake `@@` range would misdescribe unchanged source.
        if !hunk.header.isEmpty {
          rows.append(.hunk(ReviewHunkHeaderRow(id: nextID("hunk"), text: hunk.header)))
        }
        for line in hunk.lines {
          rows.append(.line(ReviewLineRow(id: nextID("line"), path: file.path, line: line)))
        }
      }
      if file.truncated {
        rows.append(.notice(ReviewNoticeRow(id: nextID("notice"), kind: .fileTruncated)))
      }
    }
    if snapshot.truncated && selectedPath == nil {
      rows.append(.notice(ReviewNoticeRow(id: nextID("notice"), kind: .snapshotTruncated)))
    }
    return rows
  }
}
