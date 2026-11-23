import XCTest

@testable import Termbridge

final class ReviewNavigatorPresentationTests: XCTestCase {
  func testTreeExposesDirectoriesBeforeSelectableFilesWithDescendantCounts() {
    let rows = ReviewNavigatorPresentation.rows(
      files: [file("README.md"), file("packages/host/index.ts"), file("packages/review/index.ts")],
      mode: .tree, selectedPath: "packages/review/index.ts")

    XCTAssertEqual(
      ["packages", "packages/host", "packages/review"], rows.directories.map(\.path))
    XCTAssertEqual(2, rows.directories.first?.fileCount)
    XCTAssertEqual([0, 1, 1], rows.directories.map(\.depth))
    XCTAssertTrue(
      rows.files.first { $0.file.path == "packages/review/index.ts" }?.selected == true)
  }

  func testCollapsedDirectoryHidesDescendantsAndCanBeReopened() {
    let rows = ReviewNavigatorPresentation.rows(
      files: [file("packages/host/index.ts"), file("README.md")], mode: .tree,
      collapsedDirectories: ["packages/host"])

    XCTAssertFalse(rows.files.contains { $0.file.path.hasPrefix("packages/") })
    XCTAssertEqual(false, rows.directories.first?.expanded)
    XCTAssertEqual(1, rows.directories.count)
    XCTAssertTrue(rows.files.contains { $0.file.path == "README.md" })

    let reopened = ReviewNavigatorPresentation.rows(
      files: [file("packages/host/index.ts"), file("README.md")], mode: .tree)
    XCTAssertTrue(reopened.files.contains { $0.file.path == "packages/host/index.ts" })
  }

  func testTreeCompactsSingleChildDirectoriesThatContainNoFiles() throws {
    let rows = ReviewNavigatorPresentation.rows(
      files: [
        file("android/app/src/main/java/com/example/app/MainActivity.kt"),
        file("android/app/src/main/java/com/example/app/TerminalActivity.kt"),
      ], mode: .tree)

    XCTAssertEqual(1, rows.directories.count)
    let directory = try XCTUnwrap(rows.directories.first)
    XCTAssertEqual("android/app/src/main/java/com/example/app", directory.path)
    XCTAssertEqual("android/app/src/main/java/com/example/app", directory.name)
    XCTAssertEqual(0, directory.depth)
    XCTAssertEqual(2, directory.fileCount)
  }

  func testFlatViewShowsEveryFullPathWithoutDirectoryRows() {
    let rows = ReviewNavigatorPresentation.rows(
      files: [file("z.ts"), file("src/a.ts")], mode: .flat)

    XCTAssertEqual(["src/a.ts", "z.ts"], rows.files.map(\.title))
    XCTAssertTrue(rows.directories.isEmpty)
  }

  func testRootLevelFilesNeverCreateADirectoryRow() {
    let rows = ReviewNavigatorPresentation.rows(
      files: [file("README.md"), file("LICENSE")], mode: .tree)

    XCTAssertTrue(rows.directories.isEmpty)
    XCTAssertEqual(["LICENSE", "README.md"], rows.files.map(\.title))
  }

  private func file(_ path: String) -> ReviewFileInfo {
    ReviewFileInfo(path: path, status: "modified", additions: 1)
  }
}

extension Array where Element == ReviewNavigatorRow {
  fileprivate var directories: [ReviewNavigatorDirectoryRow] {
    compactMap { if case .directory(let row) = $0 { return row } else { return nil } }
  }
  fileprivate var files: [ReviewNavigatorFileRow] {
    compactMap { if case .file(let row) = $0 { return row } else { return nil } }
  }
}
