import AppKit

/// Git changes as code documents: one file's diff, or a repository's
/// overview with every changed file's hunks one after another.
enum DiffDocument {
    static let addition = NSColor.systemGreen.withAlphaComponent(0.14)
    static let deletion = NSColor.systemRed.withAlphaComponent(0.13)
    static let hunk = NSColor.systemBlue.withAlphaComponent(0.08)
    static let header = NSColor.labelColor.withAlphaComponent(0.06)
    static let privateNote = "私密配置文件，内容只保留在 Host 上。"

    /// A link that opens one changed file of the repository on screen.
    static func link(path: String) -> URL? {
        var components = URLComponents()
        components.scheme = "tb-review"
        components.host = "file"
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        return components.url
    }

    static func path(from link: URL) -> String? {
        guard link.scheme == "tb-review", link.host == "file" else { return nil }
        return URLComponents(url: link, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
    }

    static func statusLetter(_ status: String) -> String {
        switch status {
        case "added": return "A"
        case "untracked": return "U"
        case "deleted": return "D"
        case "renamed": return "R"
        case "modified": return "M"
        default: return "·"
        }
    }

    static func statusColor(_ status: String) -> NSColor {
        switch status {
        case "added", "untracked": return .systemGreen
        case "deleted": return .systemRed
        case "renamed": return .systemBlue
        case "modified": return .systemOrange
        default: return .secondaryLabelColor
        }
    }

    static func statusTitle(_ status: String) -> String {
        switch status {
        case "added": return "新增"
        case "untracked": return "未跟踪"
        case "deleted": return "删除"
        case "renamed": return "重命名"
        case "modified": return "修改"
        default: return "无未提交改动"
        }
    }

    /// One file's hunks with old and new line numbers.
    static func file(_ file: ReviewFileInfo, touched: Bool = false) -> CodeDocument {
        var builder = Builder(width: digits(file))
        builder.fileHeader(file, touched: touched, linked: false)
        builder.hunks(file)
        return builder.finish()
    }

    /// Every file of a repository's change set, in the order Git lists them.
    static func repository(_ snapshot: ReviewSnapshotInfo, touched: Set<String>, title: String) -> CodeDocument {
        var builder = Builder(width: snapshot.files.map(digits).max() ?? 3)
        let totals = "\(snapshot.changedFileCount) 个文件  +\(snapshot.additions) −\(snapshot.deletions)"
        builder.line("\(title)  ·  \(snapshot.branch)  ·  \(totals)", label: "", background: header, kind: .heading)
        if snapshot.files.isEmpty {
            builder.line("", label: "")
            builder.line("这个仓库当前没有未提交的改动。", label: "", kind: .comment)
        }
        for file in snapshot.files {
            builder.line("", label: "")
            builder.fileHeader(file, touched: touched.contains(file.path), linked: true)
            builder.hunks(file)
        }
        if snapshot.truncated {
            builder.line("", label: "")
            builder.line("改动较多，概览已截断。点击单个文件查看它的完整差异。", label: "", kind: .comment)
        }
        return builder.finish()
    }

    private static func digits(_ file: ReviewFileInfo) -> Int {
        let largest = file.hunks.flatMap { $0.lines }.map { max($0.oldLine ?? 0, $0.newLine ?? 0) }.max() ?? 0
        return max(3, String(largest).count)
    }

    private struct Builder {
        let width: Int
        let text = NSMutableAttributedString()
        var labels: [String] = []
        var backgrounds: [NSColor?] = []

        init(width: Int) { self.width = width }

        /// One label and background per line: the last line has no newline of its own.
        func finish() -> CodeDocument {
            let result = NSMutableAttributedString(attributedString: text)
            if result.length > 0, result.string.hasSuffix("\n") { result.deleteCharacters(in: NSRange(location: result.length - 1, length: 1)) }
            return CodeDocument(text: result, gutter: labels, backgrounds: backgrounds)
        }

        mutating func line(_ value: String, label: String, background: NSColor? = nil, kind: CodeTokenKind? = nil) {
            let start = text.length
            text.append(NSAttributedString(string: value + "\n", attributes: [
                .font: CodeDocument.font, .foregroundColor: kind.map(CodeHighlighter.color) ?? NSColor.labelColor,
            ]))
            if kind == .heading {
                text.addAttribute(.font, value: NSFontManager.shared.convert(CodeDocument.font, toHaveTrait: .boldFontMask),
                                  range: NSRange(location: start, length: (value as NSString).length))
            }
            labels.append(label)
            backgrounds.append(background)
        }

        mutating func fileHeader(_ file: ReviewFileInfo, touched: Bool, linked: Bool) {
            let start = text.length
            let path = file.oldPath.map { "\($0) → \(file.path)" } ?? file.path
            var value = "\(DiffDocument.statusLetter(file.status))  \(path)"
            // An untracked private file is never read, so it has no counts to show.
            if !file.binary, !file.isPrivate || file.additions + file.deletions > 0 { value += "   +\(file.additions) −\(file.deletions)" }
            if touched { value += "   ·  本次对话改过" }
            line(value, label: "", background: DiffDocument.header)
            let bold = NSFontManager.shared.convert(CodeDocument.font, toHaveTrait: .boldFontMask)
            let pathRange = NSRange(location: start + 3, length: (path as NSString).length)
            text.addAttribute(.foregroundColor, value: DiffDocument.statusColor(file.status), range: NSRange(location: start, length: 1))
            text.addAttribute(.font, value: bold, range: pathRange)
            if linked, let url = DiffDocument.link(path: file.path) { text.addAttribute(.link, value: url, range: pathRange) }
        }

        mutating func hunks(_ file: ReviewFileInfo) {
            if file.isPrivate {
                line(DiffDocument.privateNote, label: "", kind: .comment)
                return
            }
            if file.binary {
                let note = FilePreviewContent.isImage(file.path) ? "图片 · 在左侧选择这个文件可以对比修改前后" : "二进制文件，没有文本差异"
                line(note, label: "", kind: .comment)
                return
            }
            if file.hunks.isEmpty {
                line(file.truncated ? "差异较长，在左侧选择这个文件查看完整内容。" : "没有文本差异", label: "", kind: .comment)
                return
            }
            let language = CodeLanguage.detect(fileName: file.path)
            for hunk in file.hunks {
                if !hunk.header.isEmpty { line(hunk.header, label: "", background: DiffDocument.hunk, kind: .meta) }
                for diffLine in hunk.lines { code(diffLine, language: language) }
            }
            if file.truncated { line("… 此文件的差异已截断", label: "", kind: .comment) }
        }

        private mutating func code(_ diffLine: ReviewLineInfo, language: CodeLanguage?) {
            // "\ No newline at end of file" belongs to neither version.
            if diffLine.oldLine == nil, diffLine.newLine == nil, diffLine.text.hasPrefix("\\") {
                line(diffLine.text, label: "", kind: .comment)
                return
            }
            let start = text.length
            let marker: String, background: NSColor?
            switch diffLine.kind {
            case "add": marker = "+"; background = DiffDocument.addition
            case "delete": marker = "−"; background = DiffDocument.deletion
            default: marker = " "; background = nil
            }
            let old = diffLine.oldLine.map(String.init) ?? ""
            let new = diffLine.newLine.map(String.init) ?? ""
            let label = old.leftPadded(width) + " " + new.leftPadded(width) + " " + marker
            line(diffLine.text, label: label, background: background)
            if let language, !diffLine.text.isEmpty {
                CodeHighlighter.apply(CodeHighlighter.tokens(diffLine.text, language: language), to: text, offset: start,
                                      font: CodeDocument.font)
            }
        }
    }
}

private extension String {
    func leftPadded(_ width: Int) -> String {
        count >= width ? self : String(repeating: " ", count: width - count) + self
    }
}
