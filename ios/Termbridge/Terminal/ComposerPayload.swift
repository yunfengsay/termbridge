import Foundation

/// The terminal's native composer, mirroring the Android peer: the WebView draws
/// the session and the composer owns typing. In mobile presentation the xterm
/// surface is deliberately hidden, so it can never hold the keyboard focus.
enum ComposerPayload {
  /// Return is a key after the paste event, never part of pasted text.
  static func submitBytes(_ text: Data, bracketedPaste: Bool) -> Data {
    if bracketedPaste { return Data("\u{1b}[200~".utf8) + text + Data("\u{1b}[201~\r".utf8) }
    return text + Data([0x0d])
  }

  struct Attachment {
    let path: String
    let isImage: Bool
  }

  static func build(draft: String, references: [Attachment]) -> String {
    let text = build(draft: draft)
    let markers = references.map { "[\($0.isImage ? "Image" : "File"): \($0.path)]" }
    return ([text] + markers).filter { !$0.isEmpty }.joined(separator: " ")
  }

  /// One line of intent, not keystrokes: the draft is trimmed and its whitespace
  /// runs collapsed so a wrapped phone paste does not reach the Agent as ragged
  /// input. Attachments follow as the same `[Image: path]` markers Android sends.
  static func build(draft: String, attachments: [String] = []) -> String {
    var parts: [String] = []
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
      .split(whereSeparator: { $0.isWhitespace })
      .joined(separator: " ")
    if !text.isEmpty { parts.append(text) }
    for path in attachments {
      let path = path.trimmingCharacters(in: .whitespacesAndNewlines)
      if !path.isEmpty { parts.append("[Image: \(path)]") }
    }
    return parts.joined(separator: " ")
  }
}
