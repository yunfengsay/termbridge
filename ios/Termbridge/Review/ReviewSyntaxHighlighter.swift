import Foundation

/// Language identity mirrors the Prism grammar names the Android peer selects,
/// so both clients agree on what a repository path is before either paints it.
enum ReviewLanguage: String, Equatable {
  case c
  case cpp
  case csharp
  case css
  case dart
  case git
  case go
  case groovy
  case java
  case javascript
  case json
  case kotlin
  case makefile
  case markdown
  case markup
  case python
  case scala
  case sql
  case swift
  case yaml

  static func forPath(_ path: String) -> ReviewLanguage? {
    let name = lastSegment(path).lowercased()
    switch name {
    case "dockerfile", "makefile": return .makefile
    case ".gitignore", ".gitattributes", ".gitmodules": return .git
    default: break
    }
    if name.hasSuffix(".mk") { return .makefile }
    if name.hasSuffix(".gradle") || name.hasSuffix(".gradle.kts") { return .groovy }
    switch fileExtension(name) {
    case "c", "h": return .c
    case "cc", "cpp", "cxx", "hpp": return .cpp
    case "cs": return .csharp
    case "css", "scss": return .css
    case "dart": return .dart
    case "go": return .go
    case "groovy": return .groovy
    case "java": return .java
    case "js", "jsx", "mjs", "cjs", "ts", "tsx": return .javascript
    case "json", "jsonc": return .json
    case "kt", "kts": return .kotlin
    case "md", "mdx": return .markdown
    case "html", "htm", "xml", "svg": return .markup
    case "py": return .python
    case "scala": return .scala
    case "sql": return .sql
    case "swift": return .swift
    case "yaml", "yml": return .yaml
    default: return nil
    }
  }

  private static func lastSegment(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return path }
    return String(path[path.index(after: slash)...])
  }

  private static func fileExtension(_ name: String) -> String {
    guard let dot = name.lastIndex(of: "."), dot != name.startIndex else { return "" }
    return String(name[name.index(after: dot)...])
  }
}

enum ReviewTokenKind: String, Equatable {
  case plain
  case comment
  case string
  case number
  case keyword
  case type
}

struct ReviewToken: Equatable {
  let text: String
  let kind: ReviewTokenKind
}

/// The Host sends one diff line at a time, so highlighting is deliberately
/// line-local: no state carries across rows and a truncated block comment can
/// never paint the rest of the file. Android's Prism pass has the same bound.
final class ReviewSyntaxHighlighter {
  private var cache: [String: [ReviewToken]] = [:]
  private var order: [String] = []
  private let limit: Int

  init(limit: Int = 4_096) { self.limit = max(1, limit) }

  func tokens(path: String, code: String) -> [ReviewToken] {
    guard let language = ReviewLanguage.forPath(path) else {
      return [ReviewToken(text: code, kind: .plain)]
    }
    let key = "\(language.rawValue)\u{0}\(code)"
    if let cached = cache[key] { return cached }
    let tokens = ReviewSyntaxHighlighter.tokenize(code, language: language)
    cache[key] = tokens
    order.append(key)
    if order.count > limit { cache.removeValue(forKey: order.removeFirst()) }
    return tokens
  }

  static func tokenize(_ code: String, language: ReviewLanguage) -> [ReviewToken] {
    let syntax = ReviewSyntax.rules(for: language)
    let characters = Array(code)
    var tokens: [ReviewToken] = []
    var plain = ""
    var index = 0

    func flushPlain() {
      guard !plain.isEmpty else { return }
      tokens.append(ReviewToken(text: plain, kind: .plain))
      plain = ""
    }
    func emit(_ text: String, _ kind: ReviewTokenKind) {
      guard !text.isEmpty else { return }
      flushPlain()
      tokens.append(ReviewToken(text: text, kind: kind))
    }
    func matches(_ marker: String, at start: Int) -> Bool {
      let marker = Array(marker)
      guard start + marker.count <= characters.count else { return false }
      for offset in 0..<marker.count where characters[start + offset] != marker[offset] {
        return false
      }
      return true
    }

    if syntax.markdownHeadings, code.trimmingCharacters(in: .whitespaces).hasPrefix("#") {
      return [ReviewToken(text: code, kind: .keyword)]
    }

    while index < characters.count {
      let character = characters[index]

      if let marker = syntax.lineComments.first(where: { matches($0, at: index) }) {
        _ = marker
        emit(String(characters[index...]), .comment)
        index = characters.count
        continue
      }

      if let block = syntax.blockComment, matches(block.open, at: index) {
        var end = index + block.open.count
        while end < characters.count, !matches(block.close, at: end) { end += 1 }
        let stop = end < characters.count ? end + block.close.count : characters.count
        emit(String(characters[index..<stop]), .comment)
        index = stop
        continue
      }

      if syntax.stringDelimiters.contains(character) {
        var end = index + 1
        var closed = false
        while end < characters.count {
          if characters[end] == "\\" {
            end += 2
            continue
          }
          if characters[end] == character {
            closed = true
            end += 1
            break
          }
          end += 1
        }
        let stop = min(closed ? end : characters.count, characters.count)
        emit(String(characters[index..<stop]), .string)
        index = stop
        continue
      }

      if syntax.markupTags, character == "<" || character == ">" {
        var end = index + 1
        if character == "<" {
          while end < characters.count, isTagCharacter(characters[end]) { end += 1 }
        }
        emit(String(characters[index..<end]), .keyword)
        index = end
        continue
      }

      if character.isNumber, index == 0 || !isIdentifierCharacter(characters[index - 1]) {
        // The initial character was accepted by a broader predicate (for
        // example @ or ①). Consume it even if it is not a continuation.
        var end = index + 1
        while end < characters.count,
          characters[end].isHexDigit || characters[end] == "." || characters[end] == "_"
            || "xXbBoOeEuUlLfFdD".contains(characters[end])
        {
          end += 1
        }
        emit(String(characters[index..<end]), .number)
        index = end
        continue
      }

      if isIdentifierStart(character) {
        // The initial character was accepted by a broader predicate (for
        // example @ or ①). Consume it even if it is not a continuation.
        var end = index + 1
        while end < characters.count, isIdentifierCharacter(characters[end]) { end += 1 }
        let word = String(characters[index..<end])
        let lookup = syntax.caseInsensitiveKeywords ? word.lowercased() : word
        if syntax.keywords.contains(lookup) {
          emit(word, .keyword)
        } else if syntax.capitalizedTypes, let first = word.first, first.isUppercase {
          emit(word, .type)
        } else {
          plain += word
        }
        index = end
        continue
      }

      plain.append(character)
      index += 1
    }
    flushPlain()
    return tokens
  }

  private static func isIdentifierStart(_ character: Character) -> Bool {
    character.isLetter || character == "_" || character == "$" || character == "@"
  }

  private static func isIdentifierCharacter(_ character: Character) -> Bool {
    character.isLetter || character.isNumber || character == "_" || character == "$"
  }

  private static func isTagCharacter(_ character: Character) -> Bool {
    character.isLetter || character.isNumber || "/!?-_:.".contains(character)
  }
}

private struct ReviewSyntax {
  var lineComments: [String] = []
  var blockComment: (open: String, close: String)?
  var stringDelimiters: [Character] = []
  var keywords: Set<String> = []
  var capitalizedTypes = false
  var caseInsensitiveKeywords = false
  var markupTags = false
  var markdownHeadings = false

  static func rules(for language: ReviewLanguage) -> ReviewSyntax {
    switch language {
    case .c, .cpp:
      return curly(keywords: cKeywords)
    case .csharp:
      return curly(keywords: cKeywords.union(csharpKeywords))
    case .java:
      return curly(keywords: cKeywords.union(javaKeywords))
    case .kotlin:
      return curly(keywords: kotlinKeywords, extraStrings: ["`"])
    case .swift:
      return curly(keywords: swiftKeywords)
    case .javascript:
      return curly(keywords: javascriptKeywords, extraStrings: ["`"])
    case .go:
      return curly(keywords: goKeywords, extraStrings: ["`"])
    case .dart:
      return curly(keywords: dartKeywords)
    case .scala:
      return curly(keywords: scalaKeywords)
    case .groovy:
      return curly(keywords: javaKeywords.union(groovyKeywords), extraStrings: ["`"])
    case .css:
      return ReviewSyntax(
        blockComment: ("/*", "*/"), stringDelimiters: ["\"", "'"], keywords: cssKeywords)
    case .json:
      return ReviewSyntax(
        stringDelimiters: ["\""], keywords: ["true", "false", "null"])
    case .python:
      return ReviewSyntax(
        lineComments: ["#"], stringDelimiters: ["\"", "'"], keywords: pythonKeywords,
        capitalizedTypes: true)
    case .yaml:
      return ReviewSyntax(
        lineComments: ["#"], stringDelimiters: ["\"", "'"],
        keywords: ["true", "false", "null", "yes", "no", "on", "off"])
    case .makefile, .git:
      return ReviewSyntax(lineComments: ["#"], stringDelimiters: ["\"", "'"])
    case .sql:
      return ReviewSyntax(
        lineComments: ["--"], blockComment: ("/*", "*/"), stringDelimiters: ["'", "\""],
        keywords: sqlKeywords, caseInsensitiveKeywords: true)
    case .markup:
      return ReviewSyntax(
        blockComment: ("<!--", "-->"), stringDelimiters: ["\"", "'"], markupTags: true)
    case .markdown:
      return ReviewSyntax(stringDelimiters: ["`"], markdownHeadings: true)
    }
  }

  private static func curly(keywords: Set<String>, extraStrings: [Character] = []) -> ReviewSyntax {
    ReviewSyntax(
      lineComments: ["//"], blockComment: ("/*", "*/"),
      stringDelimiters: ["\"", "'"] + extraStrings, keywords: keywords, capitalizedTypes: true)
  }

  private static let cKeywords: Set<String> = [
    "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else",
    "enum", "extern", "float", "for", "goto", "if", "inline", "int", "long", "register", "return",
    "short", "signed", "sizeof", "static", "struct", "switch", "typedef", "union", "unsigned",
    "void", "volatile", "while", "bool", "true", "false", "nullptr", "class", "namespace", "new",
    "delete", "public", "private", "protected", "template", "typename", "using", "virtual",
  ]
  private static let csharpKeywords: Set<String> = [
    "async", "await", "base", "checked", "event", "fixed", "foreach", "in", "interface",
    "internal", "is", "lock", "null", "object", "operator", "out", "override", "params",
    "readonly", "ref", "sealed", "string", "this", "throw", "try", "catch", "finally", "var",
    "where", "yield",
  ]
  private static let javaKeywords: Set<String> = [
    "abstract", "assert", "boolean", "byte", "catch", "extends", "final", "finally",
    "implements", "import", "instanceof", "interface", "native", "new", "null", "package",
    "private", "protected", "public", "strictfp", "super", "synchronized", "this", "throw",
    "throws", "transient", "try", "var", "record", "sealed", "yield",
  ]
  private static let groovyKeywords: Set<String> = [
    "def", "as", "in", "it", "trait", "task", "apply", "dependencies", "plugins",
  ]
  private static let kotlinKeywords: Set<String> = [
    "as", "break", "by", "catch", "class", "companion", "const", "constructor", "continue",
    "crossinline", "data", "do", "else", "enum", "external", "false", "final", "finally", "for",
    "fun", "get", "if", "import", "in", "infix", "init", "inline", "inner", "interface",
    "internal", "is", "it", "lateinit", "null", "object", "open", "operator", "out", "override",
    "package", "private", "protected", "public", "reified", "return", "sealed", "set", "super",
    "suspend", "this", "throw", "true", "try", "typealias", "val", "var", "vararg", "when",
    "where", "while",
  ]
  private static let swiftKeywords: Set<String> = [
    "any", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
    "continue", "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough",
    "false", "fileprivate", "final", "for", "func", "guard", "if", "import", "in", "indirect",
    "init", "inout", "internal", "is", "lazy", "let", "mutating", "nil", "nonisolated", "open",
    "operator", "override", "private", "protocol", "public", "repeat", "required", "return",
    "self", "some", "static", "struct", "subscript", "super", "switch", "throw", "throws",
    "true", "try", "typealias", "var", "weak", "where", "while",
  ]
  private static let javascriptKeywords: Set<String> = [
    "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class",
    "const", "continue", "declare", "default", "delete", "do", "else", "enum", "export",
    "extends", "false", "finally", "for", "from", "function", "get", "if", "implements",
    "import", "in", "instanceof", "interface", "keyof", "let", "namespace", "new", "null",
    "number", "of", "private", "protected", "public", "readonly", "return", "satisfies", "set",
    "static", "string", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
    "undefined", "var", "void", "while", "yield",
  ]
  private static let goKeywords: Set<String> = [
    "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
    "false", "for", "func", "go", "goto", "if", "import", "interface", "map", "nil", "package",
    "range", "return", "select", "struct", "switch", "true", "type", "var",
  ]
  private static let dartKeywords: Set<String> = [
    "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
    "covariant", "default", "deferred", "do", "dynamic", "else", "enum", "export", "extends",
    "extension", "external", "factory", "false", "final", "finally", "for", "get", "if",
    "implements", "import", "in", "is", "late", "library", "mixin", "new", "null", "on",
    "operator", "part", "required", "rethrow", "return", "set", "show", "static", "super",
    "switch", "sync", "this", "throw", "true", "try", "typedef", "var", "void", "while", "with",
    "yield",
  ]
  private static let scalaKeywords: Set<String> = [
    "abstract", "case", "catch", "class", "def", "do", "else", "extends", "false", "final",
    "finally", "for", "forSome", "given", "if", "implicit", "import", "lazy", "match", "new",
    "null", "object", "override", "package", "private", "protected", "return", "sealed", "super",
    "this", "throw", "trait", "true", "try", "type", "val", "var", "while", "with", "yield",
  ]
  private static let pythonKeywords: Set<String> = [
    "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
    "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
    "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while",
    "with", "yield",
  ]
  private static let cssKeywords: Set<String> = [
    "important", "inherit", "initial", "none", "auto", "unset", "revert",
  ]
  private static let sqlKeywords: Set<String> = [
    "select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create",
    "table", "alter", "drop", "index", "view", "join", "inner", "left", "right", "outer", "on",
    "group", "by", "order", "having", "limit", "offset", "union", "all", "distinct", "as", "and",
    "or", "not", "null", "is", "in", "like", "between", "case", "when", "then", "else", "end",
    "primary", "key", "foreign", "references", "default", "constraint", "with", "returning",
  ]
}
