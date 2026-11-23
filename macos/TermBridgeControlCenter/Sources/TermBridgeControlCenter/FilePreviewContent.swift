import Foundation
import UniformTypeIdentifiers

/// How a downloaded file can be shown. Every file gets at least one way:
/// known source is coloured, other text is shown plain, documents and media
/// go to Quick Look, and anything else shows its raw bytes.
struct FilePreviewContent: Equatable {
    enum Mode: Equatable {
        case code, quickLook, hex
        var title: String {
            switch self {
            case .code: return "源码"
            case .quickLook: return "预览"
            case .hex: return "十六进制"
            }
        }
    }

    /// The first mode is the default; more than one offers a switch.
    let modes: [Mode]
    /// Decoded text, when the file is text.
    let text: String?
    /// Language for colouring; nil text is shown plain.
    let language: CodeLanguage?

    static let hexLimit = 64 * 1024

    static func classify(name: String, data: Data) -> FilePreviewContent {
        let text = FileText.decode(data)
        let language = text == nil ? nil : CodeLanguage.detect(fileName: name, firstLine: text.flatMap(firstLine))
        let ext = (name as NSString).pathExtension.lowercased()
        // Pictures read better rendered; SVG keeps its source as the alternative.
        if isPicture(ext) {
            return FilePreviewContent(modes: text == nil ? [.quickLook] : [.quickLook, .code], text: text, language: language)
        }
        if let text {
            // Text is never media: `.ts` is TypeScript far more often than an MPEG stream.
            // Web pages and rich text are source first; Quick Look renders them without fetching anything.
            let modes: [Mode] = ["html", "htm", "xhtml", "rtf"].contains(ext) ? [.code, .quickLook] : [.code]
            return FilePreviewContent(modes: modes, text: text, language: language)
        }
        if isMedia(ext) { return FilePreviewContent(modes: [.quickLook], text: nil, language: nil) }
        if isDocument(ext) { return FilePreviewContent(modes: [.quickLook, .hex], text: nil, language: nil) }
        return FilePreviewContent(modes: [.hex, .quickLook], text: nil, language: nil)
    }

    private static func isPicture(_ ext: String) -> Bool {
        guard !ext.isEmpty, let type = UTType(filenameExtension: ext) else { return false }
        return type.conforms(to: .image) || type.conforms(to: .pdf)
    }

    private static func isMedia(_ ext: String) -> Bool {
        guard !ext.isEmpty, let type = UTType(filenameExtension: ext) else { return false }
        return type.conforms(to: .audiovisualContent)
    }

    static func isImage(_ name: String) -> Bool {
        let ext = (name as NSString).pathExtension.lowercased()
        guard !ext.isEmpty, let type = UTType(filenameExtension: ext) else { return false }
        return type.conforms(to: .image)
    }

    private static func isDocument(_ ext: String) -> Bool {
        if ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "pages", "numbers", "key", "odt", "ods", "odp", "epub",
            "rtf", "rtfd", "zip", "usdz", "ttf", "otf", "woff", "woff2"].contains(ext) { return true }
        guard !ext.isEmpty, let type = UTType(filenameExtension: ext) else { return false }
        return [UTType.presentation, .spreadsheet, .archive, .font, .threeDContent].contains { type.conforms(to: $0) }
    }

    private static func firstLine(_ text: String) -> String? {
        text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).first.map { String($0.prefix(200)) }
    }

    /// Offset, sixteen bytes in hex and their printable ASCII, per line.
    static func hexDump(_ data: Data, limit: Int = hexLimit) -> String {
        var lines: [String] = []
        let bytes = [UInt8](data.prefix(limit))
        lines.reserveCapacity(bytes.count / 16 + 2)
        var offset = 0
        while offset < bytes.count {
            let row = bytes[offset..<min(offset + 16, bytes.count)]
            var hex = row.map { String(format: "%02x", $0) }
            if hex.count > 8 { hex.insert("", at: 8) }
            let padded = hex.joined(separator: " ").padding(toLength: 49, withPad: " ", startingAt: 0)
            let ascii = String(row.map { (32...126).contains($0) ? Character(UnicodeScalar($0)) : "." })
            lines.append(String(format: "%08x  ", offset) + padded + "  " + ascii)
            offset += 16
        }
        if data.count > limit { lines.append("… 仅显示前 \(limit / 1024) KB，共 \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))") }
        return lines.joined(separator: "\n")
    }
}

/// Text detection for previews: Unicode with or without a byte-order mark,
/// then the common legacy encodings, and only if almost nothing would be
/// a control character. Binary data is never decoded into noise.
enum FileText {
    static func decode(_ data: Data) -> String? {
        if data.isEmpty { return "" }
        let bytes = [UInt8](data.prefix(4))
        if bytes.starts(with: [0xEF, 0xBB, 0xBF]) { return String(data: data.dropFirst(3), encoding: .utf8) }
        if bytes.starts(with: [0xFF, 0xFE]) || bytes.starts(with: [0xFE, 0xFF]) { return String(data: data, encoding: .utf16) }
        let sample = data.prefix(8_192)
        if sample.contains(0) { return nil }
        if let text = String(data: data, encoding: .utf8) { return plausible(text) ? text : nil }
        var converted: NSString?
        var lossy = ObjCBool(false)
        let suggested: [NSNumber] = [
            NSNumber(value: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))),
            NSNumber(value: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.big5_HKSCS_1999.rawValue))),
            NSNumber(value: String.Encoding.shiftJIS.rawValue),
            NSNumber(value: String.Encoding.windowsCP1252.rawValue),
        ]
        let encoding = NSString.stringEncoding(for: data, encodingOptions: [
            .suggestedEncodingsKey: suggested, .allowLossyKey: false,
        ], convertedString: &converted, usedLossyConversion: &lossy)
        guard encoding != 0, !lossy.boolValue, let text = converted as String?, plausible(text) else { return nil }
        return text
    }

    /// Text has few control characters besides tab, newlines, form feed and escape.
    private static func plausible(_ text: String) -> Bool {
        var controls = 0, total = 0
        for scalar in text.unicodeScalars.prefix(65_536) {
            total += 1
            if scalar.value < 32, ![9, 10, 12, 13, 27].contains(scalar.value) { controls += 1 }
            if scalar.value == 0xFFFD { controls += 1 }
        }
        return total == 0 || Double(controls) / Double(total) < 0.02
    }
}
