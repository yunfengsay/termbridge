import Foundation
import ImageIO
import UniformTypeIdentifiers

struct PreparedAttachment: Sendable {
  let name: String
  let mime: String
  let data: Data
  var isImage: Bool { mime.hasPrefix("image/") }
}

enum AttachmentPreparation {
  static let maximumBytes = 4 * 1024 * 1024

  enum Failure: String, Error, LocalizedError {
    case tooLarge = "文件超过 4 MB，请选择较小的文件"
    case invalid = "无法读取附件，请重新选择"
    case image = "无法处理图片，请换一张图片"
    var errorDescription: String? { rawValue }
  }

  /// Called off the interaction thread. ImageIO downsamples before decoding, so
  /// a large camera image never becomes a full-resolution UIKit bitmap.
  static func read(_ url: URL, forceImage: Bool = false) throws -> PreparedAttachment {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey, .contentTypeKey])
    guard values.isRegularFile == true else { throw Failure.invalid }
    let name = String(url.lastPathComponent.prefix(255))
    let isImage = forceImage || values.contentType?.conforms(to: .image) == true
      || UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true
    if isImage {
      guard let source = CGImageSourceCreateWithURL(url as CFURL,
        [kCGImageSourceShouldCache: false] as CFDictionary) else { throw Failure.image }
      return try encode(source, name: name)
    }
    guard let size = values.fileSize, size > 0 else { throw Failure.invalid }
    guard size <= maximumBytes else { throw Failure.tooLarge }
    // A second bounded read protects against the file growing after stat().
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
    guard !data.isEmpty else { throw Failure.invalid }
    guard data.count <= maximumBytes else { throw Failure.tooLarge }
    return PreparedAttachment(name: name, mime: "application/octet-stream", data: data)
  }

  static func imageData(_ data: Data) throws -> PreparedAttachment {
    guard let source = CGImageSourceCreateWithData(data as CFData,
      [kCGImageSourceShouldCache: false] as CFDictionary) else { throw Failure.image }
    return try encode(source, name: "粘贴的图片.jpg")
  }

  private static func encode(_ source: CGImageSource, name: String) throws -> PreparedAttachment {
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: 2048,
      kCGImageSourceShouldCacheImmediately: true,
    ] as CFDictionary) else { throw Failure.image }
    for quality in [0.85, 0.65, 0.45] {
      let data = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)
      else { throw Failure.image }
      CGImageDestinationAddImage(destination, image,
        [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
      guard CGImageDestinationFinalize(destination) else { throw Failure.image }
      if data.length <= maximumBytes {
        let base = (name as NSString).deletingPathExtension
        return PreparedAttachment(name: String(base.prefix(245)) + ".jpg", mime: "image/jpeg", data: data as Data)
      }
    }
    throw Failure.tooLarge
  }
}

/// Pure queue state. The owner pins the Host; each upload additionally pins its
/// session and request. Removed, interrupted and superseded results cannot win.
struct ComposerAttachmentQueue {
  enum State: Equatable {
    case preparing, waiting, uploading(request: String, session: String)
    case ready(String), failed(String)

    var label: String {
      switch self {
      case .preparing: return "处理中"
      case .waiting: return "等待上传"
      case .uploading: return "上传中"
      case .ready: return "已上传"
      case .failed(let message): return message
      }
    }
    var busy: Bool {
      switch self { case .preparing, .uploading: return true; default: return false }
    }
  }
  struct Item: Identifiable {
    let id: UUID
    var name: String
    var prepared: PreparedAttachment?
    var isImage = false
    var state: State = .preparing
    var canRetry: Bool {
      if case .failed = state { return prepared != nil }
      return false
    }
  }
  static let limit = 6
  private(set) var items: [Item] = []
  var allReady: Bool { items.allSatisfy { if case .ready = $0.state { return true }; return false } }
  var references: [ComposerPayload.Attachment] {
    items.compactMap { item in
      guard case .ready(let path) = item.state else { return nil }
      return ComposerPayload.Attachment(path: path, isImage: item.isImage)
    }
  }
  mutating func add(name: String) -> UUID? {
    guard items.count < Self.limit else { return nil }
    let id = UUID()
    items.append(Item(id: id, name: name))
    return id
  }
  mutating func prepared(_ id: UUID, result: Result<PreparedAttachment, Error>) {
    guard let index = items.firstIndex(where: { $0.id == id && $0.state == .preparing }) else { return }
    switch result {
    case .success(let attachment):
      guard !attachment.data.isEmpty, attachment.data.count <= AttachmentPreparation.maximumBytes else {
        items[index].state = .failed(AttachmentPreparation.Failure.tooLarge.localizedDescription)
        return
      }
      items[index].name = attachment.name
      items[index].isImage = attachment.isImage
      items[index].prepared = attachment
      items[index].state = .waiting
    case .failure(let error): items[index].state = .failed(error.localizedDescription)
    }
  }
  mutating func next(session: String) -> Item? {
    guard !items.contains(where: { if case .uploading = $0.state { return true }; return false }),
      let index = items.firstIndex(where: { $0.state == .waiting && $0.prepared != nil }) else { return nil }
    items[index].state = .uploading(request: UUID().uuidString.lowercased(), session: session)
    return items[index]
  }
  @discardableResult
  mutating func finish(request: String, session: String, path: String?, error: String?) -> Bool {
    guard let index = items.firstIndex(where: { $0.state == .uploading(request: request, session: session) }) else { return false }
    if let error {
      let detail = error.trimmingCharacters(in: .whitespacesAndNewlines)
      items[index].state = .failed(detail.isEmpty ? "上传失败，请重试" : String(detail.prefix(200)))
    } else if let path, Self.validPath(path) {
      items[index].state = .ready(path)
      items[index].prepared = nil
    } else {
      items[index].state = .failed("上传结果无效，未发送附件")
    }
    return true
  }
  mutating func interrupt() {
    for index in items.indices {
      if case .uploading = items[index].state {
        items[index].state = .failed("连接中断，结果未确认；可重新上传")
      }
    }
  }
  mutating func retry(_ id: UUID) {
    guard let index = items.firstIndex(where: { $0.id == id && $0.canRetry }) else { return }
    items[index].state = .waiting
  }
  mutating func remove(_ id: UUID) { items.removeAll { $0.id == id } }
  mutating func clear() { items.removeAll() }
  static func validPath(_ path: String) -> Bool {
    path.hasPrefix("/") && path.utf8.count <= 4096
      && path.rangeOfCharacter(from: CharacterSet(charactersIn: "[]\"'`$\\;|&<>(){}!*?")) == nil
      && path.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
  }
}
