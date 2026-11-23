import Foundation

enum TerminalFileLink: Equatable {
    /// A path on the session's Host, with the line a link like `main.swift:12:4` or `#L12` points at.
    case file(String, line: Int? = nil)
    case web(URL)

    static func parse(_ raw: String) -> TerminalFileLink? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 4096,
              !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else { return nil }
        if let url = URL(string: value), let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) {
            return url.host == nil ? nil : .web(url)
        }
        if value.lowercased().hasPrefix("file:") {
            guard let url = URL(string: value), url.isFileURL, !url.path.isEmpty else { return nil }
            let (path, pathLine) = stripLocation(url.path)
            let fragmentLine = url.fragment.flatMap { fragment -> Int? in
                guard fragment.hasPrefix("L") else { return nil }
                return Int(fragment.dropFirst().prefix { $0.isNumber })
            }
            return .file(path, line: pathLine ?? fragmentLine)
        }
        let (path, line) = stripLocation(value)
        guard !path.contains("://"), !path.contains(":"),
              path.contains("/") || (path as NSString).pathExtension.isEmpty == false else { return nil }
        // Keep remote paths untouched. Never expand ~ against this Mac's home.
        return .file(path, line: line)
    }

    private static func stripLocation(_ value: String) -> (String, Int?) {
        guard let match = value.range(of: #"(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)$"#, options: .regularExpression) else { return (value, nil) }
        let suffix = value[match].drop { $0 == ":" || $0 == "#" || $0 == "L" }
        let line = Int(suffix.prefix { $0.isNumber })
        return (String(value[..<match.lowerBound]), line.flatMap { $0 > 0 ? $0 : nil })
    }
}
