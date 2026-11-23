import Foundation

/// Android ships VS Code icon drawables. iOS resolves the same categories to SF
/// Symbols so the navigator stays legible without bundling an icon set.
struct ReviewIcon: Equatable {
  let symbol: String
  let tint: ReviewIconTint
}

enum ReviewIconTint: String, Equatable {
  case folder
  case source
  case kotlin
  case typescript
  case java
  case swift
  case markup
  case json
  case markdown
  case shell
  case git
  case gradle
  case plain
}

enum ReviewFileIcon {
  static func directory(_ path: String, expanded: Bool) -> ReviewIcon {
    if sourceDirectories.contains(lastSegment(path).lowercased()) {
      return ReviewIcon(symbol: "folder.badge.gearshape", tint: .source)
    }
    return ReviewIcon(symbol: expanded ? "folder.fill" : "folder", tint: .folder)
  }

  static func file(_ path: String) -> ReviewIcon {
    let name = lastSegment(path).lowercased()
    switch name {
    case ".gitignore", ".gitattributes", ".gitmodules":
      return ReviewIcon(symbol: "arrow.triangle.branch", tint: .git)
    case "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts":
      return ReviewIcon(symbol: "hammer", tint: .gradle)
    default: break
    }
    switch fileExtension(name) {
    case "kt", "kts": return ReviewIcon(symbol: "k.square", tint: .kotlin)
    case "ts", "tsx": return ReviewIcon(symbol: "curlybraces", tint: .typescript)
    case "java": return ReviewIcon(symbol: "cup.and.saucer", tint: .java)
    case "swift": return ReviewIcon(symbol: "swift", tint: .swift)
    case "xml", "html", "htm", "svg":
      return ReviewIcon(symbol: "chevron.left.forwardslash.chevron.right", tint: .markup)
    case "json", "jsonc": return ReviewIcon(symbol: "curlybraces.square", tint: .json)
    case "md", "mdx": return ReviewIcon(symbol: "doc.richtext", tint: .markdown)
    case "sh", "bash", "zsh", "fish": return ReviewIcon(symbol: "terminal", tint: .shell)
    default: return ReviewIcon(symbol: "doc.text", tint: .plain)
    }
  }

  private static let sourceDirectories: Set<String> = ["src", "source", "sources"]

  private static func lastSegment(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return path }
    return String(path[path.index(after: slash)...])
  }

  private static func fileExtension(_ name: String) -> String {
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return "" }
    return String(name[name.index(after: dot)...])
  }
}
