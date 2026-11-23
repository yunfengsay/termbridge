import XCTest
@testable import Termbridge

final class ReviewRepositoryInfoTests: XCTestCase {
  func testParsesAConversationsRepositoriesAndDropsInvalidOnes() {
    let fields: [String: MessagePackValue] = [
      "repositories": .array([
        .map([
          "repository": .string("termbridge"),
          "repositoryPath": .string("/code/termbridge"),
          "branch": .string("master"),
          "detached": .bool(false),
          "current": .bool(true),
          "files": .array([
            .map([
              "path": .string("art/logo.png"), "status": .string("modified"), "additions": .int(0),
              "deletions": .int(0), "binary": .bool(true), "truncated": .bool(false),
            ]),
            .map([
              "path": .string(".env"), "status": .string("untracked"), "binary": .bool(false),
              "truncated": .bool(false), "private": .bool(true),
            ]),
            .map(["path": .string("bad.txt"), "status": .string("exploded")]),
          ]),
          "changedFileCount": .int(1),
          "touched": .array([.string("art/logo.png"), .string(""), .int(7)]),
          "touchedTruncated": .bool(true),
        ]),
        .map(["repository": .string("missing-path")]),
      ])
    ]
    let repositories = ReviewRepositoryInfo.list(fields)
    XCTAssertEqual(repositories.count, 1)
    let repository = repositories[0]
    XCTAssertTrue(repository.current)
    XCTAssertEqual(repository.id, "/code/termbridge")
    XCTAssertEqual(repository.files.map(\.path), ["art/logo.png", ".env"])
    XCTAssertEqual(repository.files.map(\.isPrivate), [false, true])
    XCTAssertTrue(repository.files[0].binary)
    XCTAssertTrue(repository.files[0].hunks.isEmpty)
    XCTAssertEqual(repository.touched, ["art/logo.png"])
    XCTAssertTrue(repository.touchedTruncated)
    XCTAssertEqual(ReviewProtocol.headRevision, "HEAD")
  }
}
