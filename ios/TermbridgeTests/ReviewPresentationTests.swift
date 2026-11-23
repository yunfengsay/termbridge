import XCTest

@testable import Termbridge

final class ReviewPresentationTests: XCTestCase {
  func testShowsOnePrimaryLineNumberInsteadOfDuplicateColumns() {
    XCTAssertEqual(
      "12", ReviewPresentation.lineNumber(
        ReviewLineInfo(kind: "context", oldLine: 12, newLine: 12, text: "same")))
    XCTAssertEqual(
      "13", ReviewPresentation.lineNumber(ReviewLineInfo(kind: "add", newLine: 13, text: "added")))
    XCTAssertEqual(
      "14",
      ReviewPresentation.lineNumber(ReviewLineInfo(kind: "delete", oldLine: 14, text: "removed")))
    XCTAssertEqual("", ReviewPresentation.lineNumber(ReviewLineInfo(kind: "context", text: "")))
  }

  func testFlattensFilesAndHunksIntoASingleColumnReview() {
    let rows = ReviewPresentation.rows(snapshot())

    guard case .file = rows.first else { return XCTFail("The first row must name the file") }
    guard case .hunk = rows[1] else { return XCTFail("The hunk header must follow its file") }
    XCTAssertEqual(["delete", "add"], rows.lines.map(\.line.kind))
    XCTAssertEqual(["src/example.ts", "src/example.ts"], rows.lines.map(\.path))
    XCTAssertEqual(.snapshotTruncated, rows.notices.last?.kind)
    XCTAssertEqual(rows.count, Set(rows.map(\.id)).count, "Row identity must stay unique")
  }

  func testShowsAnExplicitEmptyStateWhenNoChangesExist() {
    let rows = ReviewPresentation.rows(snapshot(files: [], truncated: false))
    XCTAssertEqual([.empty], rows.notices.map(\.kind))
  }

  func testProjectBrowsingReportsItsOwnEmptyState() {
    let rows = ReviewPresentation.rows(
      snapshot(files: [], truncated: false, mode: "files"))
    XCTAssertEqual([.projectEmpty], rows.notices.map(\.kind))
  }

  func testSingleFileSelectionExcludesUnrelatedDiffs() {
    var other = changedFile
    other = ReviewFileInfo(
      path: "src/other.ts", status: other.status, additions: other.additions,
      deletions: other.deletions, hunks: other.hunks)
    let rows = ReviewPresentation.rows(
      snapshot(files: [changedFile, other]), selectedPath: "src/other.ts")

    XCTAssertEqual(["src/other.ts"], rows.headers.map(\.path))
    XCTAssertFalse(rows.notices.contains { $0.kind == .snapshotTruncated })
  }

  func testBinaryAndTruncatedFilesAnnounceTheirOwnLimit() {
    let binary = ReviewFileInfo(path: "assets/logo.png", status: "added", binary: true)
    let large = ReviewFileInfo(
      path: "src/huge.ts", truncated: true,
      hunks: [ReviewHunkInfo(header: "@@ -1 +1 @@",
        lines: [ReviewLineInfo(kind: "add", newLine: 1, text: "x")])])
    let rows = ReviewPresentation.rows(snapshot(files: [binary, large], truncated: false))

    XCTAssertEqual([.binary, .fileTruncated], rows.notices.map(\.kind))
  }

  func testPrivateFileSaysItsContentsStayOnTheHost() {
    let secret = ReviewFileInfo(path: ".env", status: "untracked", isPrivate: true)
    let rows = ReviewPresentation.rows(snapshot(files: [secret], truncated: false))

    XCTAssertEqual([.privateFile], rows.notices.map(\.kind))
  }

  func testProjectFileContentRendersWithoutAFakeDiffHunkHeader() {
    let file = ReviewFileInfo(
      path: "src/App.tsx", status: "unchanged",
      hunks: [
        ReviewHunkInfo(
          header: "", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          lines: [
            ReviewLineInfo(kind: "context", oldLine: 1, newLine: 1, text: "const app = true;")
          ])
      ])
    let rows = ReviewPresentation.rows(
      snapshot(files: [file], truncated: false, mode: "files"), selectedPath: file.path)

    XCTAssertEqual(1, rows.headers.count)
    XCTAssertEqual(1, rows.lines.count)
    XCTAssertFalse(rows.contains { if case .hunk = $0 { return true } else { return false } })
  }

  private var changedFile: ReviewFileInfo {
    ReviewFileInfo(
      path: "src/example.ts", status: "modified", additions: 1, deletions: 1,
      hunks: [
        ReviewHunkInfo(
          header: "@@ -1 +1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
          lines: [
            ReviewLineInfo(kind: "delete", oldLine: 1, text: "before"),
            ReviewLineInfo(kind: "add", newLine: 1, text: "after"),
          ])
      ])
  }

  private func snapshot(
    files: [ReviewFileInfo]? = nil, truncated: Bool = true, mode: String = "working"
  ) -> ReviewSnapshotInfo {
    let files = files ?? [changedFile]
    return ReviewSnapshotInfo(
      repository: "termbridge", repositoryPath: "/code/termbridge", branch: "feature/review",
      mode: mode, dirty: true, branches: ["feature/review", "main"], files: files,
      changedFileCount: files.count, additions: 1, deletions: 1, truncated: truncated)
  }
}

extension Array where Element == ReviewRow {
  fileprivate var headers: [ReviewFileHeaderRow] {
    compactMap { if case .file(let row) = $0 { return row } else { return nil } }
  }
  fileprivate var lines: [ReviewLineRow] {
    compactMap { if case .line(let row) = $0 { return row } else { return nil } }
  }
  fileprivate var notices: [ReviewNoticeRow] {
    compactMap { if case .notice(let row) = $0 { return row } else { return nil } }
  }
}
