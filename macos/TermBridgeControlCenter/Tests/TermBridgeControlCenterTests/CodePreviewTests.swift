import AppKit
import XCTest
@testable import TermBridgeControlCenter

/// The pieces behind file previews and diffs: language detection, colouring,
/// how a file is shown, text decoding, and diff documents.
final class CodePreviewTests: XCTestCase {
    // MARK: - Languages

    func testLanguageComesFromNameThenExtensionThenFirstLine() {
        XCTAssertEqual(CodeLanguage.detect(fileName: "src/app.ts"), .typescript)
        XCTAssertEqual(CodeLanguage.detect(fileName: "View.SWIFT"), .swift)
        XCTAssertEqual(CodeLanguage.detect(fileName: "Dockerfile"), .dockerfile)
        XCTAssertEqual(CodeLanguage.detect(fileName: "Dockerfile.dev"), .dockerfile)
        XCTAssertEqual(CodeLanguage.detect(fileName: "Makefile"), .makefile)
        XCTAssertEqual(CodeLanguage.detect(fileName: "CMakeLists.txt"), .cmake)
        XCTAssertEqual(CodeLanguage.detect(fileName: ".zshrc"), .shell)
        XCTAssertEqual(CodeLanguage.detect(fileName: ".gitignore"), .ini)
        XCTAssertEqual(CodeLanguage.detect(fileName: "deploy", firstLine: "#!/usr/bin/env python3"), .python)
        XCTAssertEqual(CodeLanguage.detect(fileName: "run", firstLine: "#!/bin/bash"), .shell)
        XCTAssertEqual(CodeLanguage.detect(fileName: "page", firstLine: "<!DOCTYPE html>"), .html)
        XCTAssertNil(CodeLanguage.detect(fileName: "notes.txt", firstLine: "hello"))
        XCTAssertNil(CodeLanguage.detect(fileName: "LICENSE"))
        XCTAssertEqual(CodeLanguage.typescript.title, "TypeScript")
        XCTAssertEqual(CodeLanguage.python.title, "Python")
    }

    // MARK: - Colouring

    private func tokens(_ text: String, _ language: CodeLanguage) -> [(String, CodeTokenKind)] {
        CodeHighlighter.tokens(text, language: language).map { ((text as NSString).substring(with: $0.range), $0.kind) }
    }

    private func assertTokens(_ text: String, _ language: CodeLanguage, contain expected: [(String, CodeTokenKind)],
                              file: StaticString = #filePath, line: UInt = #line) {
        let found = tokens(text, language)
        for (value, kind) in expected where !found.contains(where: { $0.0 == value && $0.1 == kind }) {
            XCTFail("\(language): expected \(kind) \"\(value)\" in \(found)", file: file, line: line)
        }
    }

    func testCurlySourceColoursKeywordsTypesCallsAndLiterals() {
        let swift = "import AppKit\n// note\nlet name = \"hi\" /* block */\nfunc go() -> Int { return 42 }\n@MainActor struct View {}"
        assertTokens(swift, .swift, contain: [
            ("import", .keyword), ("AppKit", .type), ("// note", .comment), ("let", .keyword), ("\"hi\"", .string),
            ("/* block */", .comment), ("func", .keyword), ("go", .function), ("Int", .type), ("return", .keyword),
            ("42", .number), ("@MainActor", .meta), ("struct", .keyword), ("View", .type),
        ])
        XCTAssertFalse(tokens(swift, .swift).contains { $0.0 == "name" }, "a plain identifier stays uncoloured")
    }

    func testScriptLanguagesKeepMultilineStringsAndShellHashes() {
        let python = "@dataclass\ndef greet(name):\n    \"\"\"Say\n    hi\"\"\"\n    return f'hi {name}'  # done\n"
        assertTokens(python, .python, contain: [
            ("@dataclass", .meta), ("def", .keyword), ("greet", .function), ("\"\"\"Say\n    hi\"\"\"", .string),
            ("return", .keyword), ("'hi {name}'", .string), ("# done", .comment),
        ])
        let shell = "echo \"$HOME\" a#b # note\nexport PATH=$PATH:/bin"
        assertTokens(shell, .shell, contain: [
            ("echo", .keyword), ("\"$HOME\"", .string), ("# note", .comment), ("export", .keyword), ("$PATH", .meta),
        ])
        XCTAssertFalse(tokens(shell, .shell).contains { $0.0.contains("#b") }, "a # inside a word is not a comment")
    }

    func testDataFormatsColourKeysApartFromValues() {
        assertTokens("{\"name\": \"app\", \"count\": 3, \"ok\": true, \"none\": null}", .json, contain: [
            ("\"name\"", .attribute), ("\"app\"", .string), ("\"count\"", .attribute), ("3", .number),
            ("true", .keyword), ("null", .keyword),
        ])
        let yaml = "name: build\nsteps:\n  - run: echo hi # note\nurl: \"http://x\"\n"
        assertTokens(yaml, .yaml, contain: [
            ("name", .attribute), ("steps", .attribute), ("run", .attribute), ("# note", .comment),
            ("url", .attribute), ("\"http://x\"", .string),
        ])
        let ini = "[server]\nport = 8080\n; comment\n"
        assertTokens(ini, .toml, contain: [("[server]", .type), ("8080", .number), ("; comment", .comment)])
        XCTAssertTrue(tokens(ini, .toml).contains { $0.0.trimmingCharacters(in: .whitespaces) == "port" && $0.1 == .attribute })
        assertTokens(".card { color: #fff; margin: 4px; }\n@media screen {}", .css, contain: [
            (".card", .type), ("color", .attribute), ("#fff", .number), ("margin", .attribute), ("4px", .number),
            ("@media", .keyword),
        ])
    }

    func testMarkupAndMarkdownColourWhatTheyEmbed() {
        assertTokens("<div class=\"a\">&amp;<script>let x = 1</script></div>", .html, contain: [
            ("<div", .tag), ("class", .attribute), ("\"a\"", .string), ("&amp;", .meta), ("<script", .tag),
            ("let", .keyword), ("1", .number), ("</script", .tag), ("</div", .tag),
        ])
        let markdown = "# Title\nSome `code` and **bold** and [link](http://x)\n```swift\nlet a = 1\n```\n"
        assertTokens(markdown, .markdown, contain: [
            ("# Title", .heading), ("`code`", .string), ("**bold**", .keyword), ("[link]", .attribute),
            ("(http://x)", .meta), ("```swift", .meta), ("let", .keyword), ("1", .number), ("```", .meta),
        ])
        assertTokens("diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new\n", .diff, contain: [
            ("diff --git a/x b/x", .keyword), ("@@ -1 +1 @@", .meta), ("-old", .deletion), ("+new", .addition),
        ])
    }

    func testEveryLanguageColoursWithoutLeavingTheText() {
        // Unterminated strings and comments must end at the text, never past it.
        let sample = "/* open\n\"open\n'x\n<!-- <a href=\"\n```\n#!\n@\n$\n\\\n1e-"
        for language in CodeLanguage.allCases {
            let length = (sample as NSString).length
            for token in CodeHighlighter.tokens(sample, language: language) {
                XCTAssertTrue(token.range.length > 0 && NSMaxRange(token.range) <= length, "\(language) \(token)")
            }
        }
    }

    // MARK: - How a file is shown

    func testEveryFileGetsAWayToBeShown() {
        func modes(_ name: String, _ data: Data) -> [FilePreviewContent.Mode] { FilePreviewContent.classify(name: name, data: data).modes }
        let typeScript = FilePreviewContent.classify(name: "app.ts", data: Data("export const a = 1\n".utf8))
        XCTAssertEqual(typeScript.modes, [.code], "TypeScript is source, not an MPEG transport stream")
        XCTAssertEqual(typeScript.language, .typescript)
        let markdown = FilePreviewContent.classify(name: "README.md", data: Data("# Hello\n".utf8))
        XCTAssertEqual(markdown.modes, [.markdown, .code], "Markdown defaults to Tiptap preview with source toggle")
        XCTAssertEqual(markdown.language, .markdown)
        XCTAssertTrue(FilePreviewContent.isMarkdown("docs/guide.MARKDOWN"))
        XCTAssertTrue(FilePreviewContent.isMarkdown("notes/spec.mdx"))
        XCTAssertFalse(FilePreviewContent.isMarkdown("src/app.ts"))
        XCTAssertEqual(modes("clip.ts", Data([0x47, 0x40, 0x00, 0x10] + [UInt8](repeating: 0xFF, count: 184))), [.quickLook])
        XCTAssertEqual(modes("logo.png", Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13])), [.quickLook])
        XCTAssertEqual(modes("icon.svg", Data("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8)), [.quickLook, .code])
        XCTAssertEqual(modes("index.html", Data("<!doctype html><p>hi</p>".utf8)), [.code, .quickLook])
        XCTAssertEqual(modes("song.mp3", Data([0x49, 0x44, 0x33, 0x03, 0x00, 0x00])), [.quickLook])
        XCTAssertEqual(modes("report.docx", Data([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00])), [.quickLook, .hex])
        XCTAssertEqual(modes("payload.unregistered", Data([0x00, 0x01, 0x02, 0xFF])), [.hex, .quickLook])
        XCTAssertEqual(modes("firmware.bin", Data([0x00, 0x01, 0x02, 0xFF])), [.quickLook, .hex], "registered as an archive")
        // Unknown text is still shown, uncoloured.
        let plain = FilePreviewContent.classify(name: "notes.unknownext", data: Data("hello".utf8))
        XCTAssertEqual(plain.modes, [.code])
        XCTAssertNil(plain.language)
        XCTAssertEqual(plain.text, "hello")
        XCTAssertEqual(FilePreviewContent.classify(name: "empty.txt", data: Data()).text, "")
        XCTAssertTrue(FilePreviewContent.isImage("art/logo.PNG"))
        XCTAssertFalse(FilePreviewContent.isImage("src/app.ts"))
    }

    func testTextDecodingAcceptsUnicodeAndLegacyEncodingsButNotBinary() throws {
        XCTAssertEqual(FileText.decode(Data("héllo".utf8)), "héllo")
        XCTAssertEqual(FileText.decode(Data([0xEF, 0xBB, 0xBF]) + Data("hi".utf8)), "hi")
        XCTAssertEqual(FileText.decode(Data([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00])), "hi")
        let gb18030 = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(
            CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))
        let source = "// 中文注释：读取配置文件\nint main(void) { return 0; }\n"
        XCTAssertEqual(FileText.decode(try XCTUnwrap(source.data(using: gb18030))), source)
        XCTAssertNil(FileText.decode(Data([0x41, 0x00, 0x42])), "a NUL byte means binary")
        XCTAssertNil(FileText.decode(Data((1...31).map { UInt8($0) } + Array(repeating: 0x41, count: 40))), "mostly control characters")
    }

    func testHexDumpShowsOffsetsBytesAndPrintableText() {
        XCTAssertEqual(FilePreviewContent.hexDump(Data([0x41, 0x42, 0x00, 0xFF])),
                       "00000000  " + "41 42 00 ff".padding(toLength: 49, withPad: " ", startingAt: 0) + "  AB..")
        let lines = FilePreviewContent.hexDump(Data(0..<17)).components(separatedBy: "\n")
        XCTAssertEqual(lines.count, 2)
        XCTAssertTrue(lines[0].contains("06 07  08 09"), "a gap after eight bytes")
        XCTAssertTrue(lines[1].hasPrefix("00000010  10"))
        let large = FilePreviewContent.hexDump(Data(count: FilePreviewContent.hexLimit + 1)).components(separatedBy: "\n")
        XCTAssertEqual(large.count, FilePreviewContent.hexLimit / 16 + 1)
        XCTAssertTrue(large.last!.hasPrefix("… 仅显示前 64 KB"))
    }

    // MARK: - Diffs

    private let changed = ReviewFileInfo(path: "src/app.ts", status: "modified", additions: 2, deletions: 1, hunks: [
        ReviewHunkInfo(header: "@@ -1,2 +1,3 @@", oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [
            ReviewLineInfo(kind: "context", oldLine: 1, newLine: 1, text: "export function greet() {"),
            ReviewLineInfo(kind: "delete", oldLine: 2, text: "  return 'hello'"),
            ReviewLineInfo(kind: "add", newLine: 2, text: "  // changed"),
            ReviewLineInfo(kind: "add", newLine: 3, text: "  return 'hi'"),
            ReviewLineInfo(kind: "context", text: "\\ No newline at end of file"),
        ]),
    ])

    func testFileDiffHasOneGutterLabelAndBackgroundPerLine() throws {
        let document = DiffDocument.file(changed, touched: true)
        let lines = document.text.string.components(separatedBy: "\n")
        let gutter = try XCTUnwrap(document.gutter)
        XCTAssertEqual(gutter.count, lines.count)
        XCTAssertEqual(document.backgrounds.count, lines.count)
        XCTAssertTrue(lines[0].hasPrefix("M  src/app.ts   +2 −1"))
        XCTAssertTrue(lines[0].hasSuffix("本次对话改过"))
        XCTAssertEqual(lines[1], "@@ -1,2 +1,3 @@")
        XCTAssertEqual(Array(gutter[2...]), ["  1   1  ", "  2     −", "      2 +", "      3 +", ""])
        XCTAssertEqual(document.backgrounds[3], DiffDocument.deletion)
        XCTAssertEqual(document.backgrounds[4], DiffDocument.addition)
        XCTAssertNil(document.backgrounds[2])
        XCTAssertNil(document.backgrounds[6], "the end-of-file marker belongs to neither version")
        XCTAssertEqual(lines[6], "\\ No newline at end of file")
    }

    func testPrivateAndBinaryFilesExplainWhyThereIsNoText() {
        let secret = DiffDocument.file(ReviewFileInfo(path: ".env", status: "untracked", isPrivate: true))
        XCTAssertEqual(secret.text.string.components(separatedBy: "\n").last, DiffDocument.privateNote)
        let image = DiffDocument.file(ReviewFileInfo(path: "art/logo.png", binary: true))
        XCTAssertTrue(image.text.string.contains("对比修改前后"))
        let binary = DiffDocument.file(ReviewFileInfo(path: "lib/core.so", binary: true))
        XCTAssertTrue(binary.text.string.contains("二进制文件"))
    }

    func testRepositoryOverviewLinksEachFileToItsOwnDiff() throws {
        let snapshot = ReviewSnapshotInfo(repository: "project", repositoryPath: "/work/project", branch: "main",
                                          files: [changed, ReviewFileInfo(path: "docs/a b#c?.md", status: "added", additions: 1)],
                                          changedFileCount: 2, additions: 3, deletions: 1)
        let document = DiffDocument.repository(snapshot, touched: ["src/app.ts"], title: "project")
        XCTAssertEqual(document.gutter?.count, document.text.string.components(separatedBy: "\n").count)
        XCTAssertTrue(document.text.string.hasPrefix("project  ·  main  ·  2 个文件  +3 −1"))
        for path in ["src/app.ts", "docs/a b#c?.md"] {
            let range = (document.text.string as NSString).range(of: path)
            let link = try XCTUnwrap(document.text.attribute(.link, at: range.location, effectiveRange: nil) as? URL)
            XCTAssertEqual(DiffDocument.path(from: link), path)
        }
        XCTAssertNil(DiffDocument.path(from: URL(string: "https://example.com/?path=x")!))
        let empty = DiffDocument.repository(ReviewSnapshotInfo(repository: "clean", repositoryPath: "/work/clean", branch: "main"),
                                            touched: [], title: "clean")
        XCTAssertTrue(empty.text.string.contains("没有未提交的改动"))
    }
}
