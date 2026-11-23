import XCTest
import ImageIO
import UniformTypeIdentifiers
@testable import Termbridge

final class ComposerAttachmentTests: XCTestCase {
  private let file = PreparedAttachment(name: "notes.txt", mime: "application/octet-stream", data: Data("hello".utf8))

  private func queue() -> (ComposerAttachmentQueue, UUID) {
    var queue = ComposerAttachmentQueue()
    let id = queue.add(name: "notes")!
    queue.prepared(id, result: .success(file))
    return (queue, id)
  }

  private func request(_ item: ComposerAttachmentQueue.Item) -> String {
    guard case .uploading(let request, _) = item.state else { XCTFail("Not uploading"); return "" }
    return request
  }

  func testOnlyMatchingReceiptMakesFileSendable() {
    var (queue, _) = queue()
    XCTAssertFalse(queue.allReady)
    let request = request(queue.next(session: "pane-a")!)
    XCTAssertNil(queue.next(session: "pane-a"))
    XCTAssertFalse(queue.finish(request: request, session: "pane-b", path: "/tmp/hello.txt", error: nil))
    XCTAssertFalse(queue.allReady)
    XCTAssertTrue(queue.finish(request: request, session: "pane-a", path: "/tmp/hello.txt", error: nil))
    XCTAssertTrue(queue.allReady)
    XCTAssertNil(queue.items[0].prepared, "Release uploaded bytes")
    XCTAssertEqual(ComposerPayload.build(draft: "", references: queue.references), "[File: /tmp/hello.txt]")
  }

  func testDisconnectDoesNotReplayAndOldResultCannotWinRetry() {
    var (queue, id) = queue()
    let old = request(queue.next(session: "pane-a")!)
    queue.interrupt()
    XCTAssertNil(queue.next(session: "pane-a"), "No automatic resend")
    XCTAssertFalse(queue.allReady)
    queue.retry(id)
    let fresh = request(queue.next(session: "pane-a")!)
    XCTAssertNotEqual(old, fresh)
    XCTAssertFalse(queue.finish(request: old, session: "pane-a", path: "/tmp/old.txt", error: nil))
    XCTAssertFalse(queue.allReady)
    XCTAssertTrue(queue.finish(request: fresh, session: "pane-a", path: "/tmp/new.txt", error: nil))
    XCTAssertEqual(queue.references.first?.path, "/tmp/new.txt")
  }

  func testRemovalIgnoresLatePreparationAndReceipt() {
    var queue = ComposerAttachmentQueue()
    let id = queue.add(name: "late")!
    queue.remove(id)
    queue.prepared(id, result: .success(file))
    XCTAssertTrue(queue.items.isEmpty)
    let nextID = queue.add(name: "ready")!
    queue.prepared(nextID, result: .success(file))
    let request = request(queue.next(session: "pane")!)
    queue.remove(nextID)
    XCTAssertFalse(queue.finish(request: request, session: "pane", path: "/tmp/late.txt", error: nil))
    XCTAssertTrue(queue.items.isEmpty)
  }

  func testFailureBlocksPartialAttachmentMessageAndReadySurvivesDisconnect() {
    var (queue, id) = queue()
    let first = request(queue.next(session: "pane")!)
    queue.finish(request: first, session: "pane", path: "/tmp/one.txt", error: nil)
    let bad = queue.add(name: "bad")!
    queue.prepared(bad, result: .failure(AttachmentPreparation.Failure.invalid))
    XCTAssertFalse(queue.allReady)
    queue.interrupt()
    XCTAssertEqual(queue.items.first { $0.id == id }?.state, .ready("/tmp/one.txt"))
    queue.remove(bad)
    XCTAssertTrue(queue.allReady)
    queue.clear()
    XCTAssertTrue(queue.items.isEmpty)
  }

  func testUnsentPreparedFilesWaitAcrossDisconnectAndQueueIsBounded() {
    var (queue, _) = queue()
    queue.interrupt()
    XCTAssertNotNil(queue.next(session: "pane"))
    for _ in 1..<ComposerAttachmentQueue.limit { XCTAssertNotNil(queue.add(name: "extra")) }
    XCTAssertNil(queue.add(name: "overflow"))
  }

  func testTimeoutRetiresRequestAndUnsafePathsNeverEnterComposer() {
    for path in ["relative", "/tmp/[bad]", "/tmp/a\nb", "/tmp/$(whoami)", "/tmp/a;cmd", "/tmp/a`cmd`"] {
      var (queue, _) = queue()
      let request = request(queue.next(session: "pane")!)
      queue.finish(request: request, session: "pane", path: path, error: nil)
      XCTAssertFalse(queue.allReady, path)
      XCTAssertTrue(queue.references.isEmpty)
    }
    var (queue, id) = queue()
    let request = request(queue.next(session: "pane")!)
    queue.finish(request: request, session: "pane", path: nil, error: "timeout")
    XCTAssertFalse(queue.finish(request: request, session: "pane", path: "/tmp/late.txt", error: nil))
    XCTAssertTrue(queue.items.first { $0.id == id }!.canRetry)
  }

  func testFileByteBoundaryAndEmptyFiles() throws {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".txt")
    defer { try? FileManager.default.removeItem(at: url) }
    try Data(repeating: 42, count: AttachmentPreparation.maximumBytes).write(to: url)
    let prepared = try AttachmentPreparation.read(url)
    XCTAssertEqual(prepared.data.count, AttachmentPreparation.maximumBytes)
    XCTAssertEqual(prepared.mime, "application/octet-stream")
    try Data(repeating: 42, count: AttachmentPreparation.maximumBytes + 1).write(to: url)
    XCTAssertThrowsError(try AttachmentPreparation.read(url))
    try Data().write(to: url)
    XCTAssertThrowsError(try AttachmentPreparation.read(url))
  }

  func testLargeImageIsDownsampledAndJPEGEncoded() throws {
    let context = try XCTUnwrap(CGContext(data: nil, width: 4096, height: 2048, bitsPerComponent: 8,
      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    let image = try XCTUnwrap(context.makeImage())
    let sourceData = NSMutableData()
    let destination = try XCTUnwrap(CGImageDestinationCreateWithData(sourceData, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    let prepared = try AttachmentPreparation.imageData(sourceData as Data)
    XCTAssertEqual(prepared.mime, "image/jpeg")
    XCTAssertEqual(Array(prepared.data.prefix(3)), [0xff, 0xd8, 0xff])
    XCTAssertLessThanOrEqual(prepared.data.count, AttachmentPreparation.maximumBytes)
    let source = try XCTUnwrap(CGImageSourceCreateWithData(prepared.data as CFData, nil))
    let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    XCTAssertEqual(properties[kCGImagePropertyPixelWidth] as? Int, 2048)
    XCTAssertEqual(properties[kCGImagePropertyPixelHeight] as? Int, 1024)
  }
}
