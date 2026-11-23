import XCTest

@testable import Termbridge

final class ReviewSyntaxHighlighterTests: XCTestCase {
  func testMapsCommonRepositoryFilesToTheSameGrammarsAsTheAndroidPeer() {
    XCTAssertEqual(.kotlin, ReviewLanguage.forPath("android/MainActivity.kt"))
    XCTAssertEqual(.javascript, ReviewLanguage.forPath("packages/host/index.ts"))
    XCTAssertEqual(.groovy, ReviewLanguage.forPath("android/app/build.gradle.kts"))
    XCTAssertEqual(.swift, ReviewLanguage.forPath("ios/Termbridge/Views/ReviewScreen.swift"))
    XCTAssertEqual(.git, ReviewLanguage.forPath(".gitignore"))
    XCTAssertEqual(.makefile, ReviewLanguage.forPath("Dockerfile"))
    XCTAssertNil(ReviewLanguage.forPath("assets/archive.bin"))
  }

  func testMapsSourceFilesAndDirectoriesToSFSymbols() {
    XCTAssertEqual("k.square", ReviewFileIcon.file("MainActivity.kt").symbol)
    XCTAssertEqual("curlybraces", ReviewFileIcon.file("index.ts").symbol)
    XCTAssertEqual("swift", ReviewFileIcon.file("ReviewScreen.swift").symbol)
    XCTAssertEqual("hammer", ReviewFileIcon.file("build.gradle.kts").symbol)
    XCTAssertEqual("doc.text", ReviewFileIcon.file("archive.bin").symbol)
    XCTAssertEqual(
      "folder.badge.gearshape", ReviewFileIcon.directory("android/src", expanded: true).symbol)
    XCTAssertEqual("folder", ReviewFileIcon.directory("docs", expanded: false).symbol)
    XCTAssertEqual("folder.fill", ReviewFileIcon.directory("docs", expanded: true).symbol)
  }

  func testHighlightsKeywordsStringsNumbersAndTypes() {
    let tokens = ReviewSyntaxHighlighter.tokenize(
      "let count: Int = 42 // total", language: .swift)

    XCTAssertEqual("let", tokens.first(where: { $0.kind == .keyword })?.text)
    XCTAssertEqual("Int", tokens.first(where: { $0.kind == .type })?.text)
    XCTAssertEqual("42", tokens.first(where: { $0.kind == .number })?.text)
    XCTAssertEqual("// total", tokens.first(where: { $0.kind == .comment })?.text)
    XCTAssertEqual("let count: Int = 42 // total", tokens.map(\.text).joined())
  }

  func testStringsSwallowKeywordsAndSurviveAnUnterminatedQuote() {
    let closed = ReviewSyntaxHighlighter.tokenize(#"val a = "class \" x" + b"#, language: .kotlin)
    XCTAssertEqual([#""class \" x""#], closed.filter { $0.kind == .string }.map(\.text))
    XCTAssertEqual(#"val a = "class \" x" + b"#, closed.map(\.text).joined())

    let unterminated = ReviewSyntaxHighlighter.tokenize(#"val a = "oops"#, language: .kotlin)
    XCTAssertEqual([#""oops"#], unterminated.filter { $0.kind == .string }.map(\.text))
    XCTAssertEqual(#"val a = "oops"#, unterminated.map(\.text).joined())
  }

  func testBlockCommentStaysInsideOneLineBecauseTheHostSendsOneLineAtATime() {
    let tokens = ReviewSyntaxHighlighter.tokenize("int x; /* open", language: .c)
    XCTAssertEqual(["/* open"], tokens.filter { $0.kind == .comment }.map(\.text))
    XCTAssertEqual("int x; /* open", tokens.map(\.text).joined())
  }

  func testSQLKeywordsMatchRegardlessOfCaseAndMarkdownHeadingsStayWhole() {
    let sql = ReviewSyntaxHighlighter.tokenize("SELECT id from users -- note", language: .sql)
    XCTAssertEqual(["SELECT", "from"], sql.filter { $0.kind == .keyword }.map(\.text))
    XCTAssertEqual(["-- note"], sql.filter { $0.kind == .comment }.map(\.text))

    let heading = ReviewSyntaxHighlighter.tokenize("## Review changes", language: .markdown)
    XCTAssertEqual([ReviewToken(text: "## Review changes", kind: .keyword)], heading)
  }

  func testUnknownLanguageAndEmptyLineRoundTripUnchanged() {
    let highlighter = ReviewSyntaxHighlighter()
    XCTAssertEqual(
      [ReviewToken(text: "raw bytes", kind: .plain)],
      highlighter.tokens(path: "assets/archive.bin", code: "raw bytes"))
    XCTAssertEqual([], highlighter.tokens(path: "a.swift", code: ""))
  }

  func testSkillMarkdownAndUnicodeNumbersAlwaysAdvanceAndPreserveText() {
    let lines = ["Use @skill to continue", "@", "name@example.com", "① First step", "١ step", "Ⅳ section", "½ fraction", "1️⃣ first", "＠ fullwidth", "中文 @工具 ②步骤"]
    let highlighter = ReviewSyntaxHighlighter()
    for line in lines {
      for path in ["SKILL.md", "example.swift", "config.yaml", "page.html"] {
        let tokens = highlighter.tokens(path: path, code: line)
        XCTAssertEqual(tokens.map(\.text).joined(), line, path)
        XCTAssertTrue(tokens.allSatisfy { !$0.text.isEmpty })
      }
    }
  }

  func testCacheReturnsTheSameTokensForARepeatedLine() {
    let highlighter = ReviewSyntaxHighlighter(limit: 1)
    let first = highlighter.tokens(path: "a.swift", code: "let x = 1")
    XCTAssertEqual(first, highlighter.tokens(path: "a.swift", code: "let x = 1"))
    _ = highlighter.tokens(path: "a.swift", code: "let y = 2")
    XCTAssertEqual(first, highlighter.tokens(path: "a.swift", code: "let x = 1"))
  }
}
