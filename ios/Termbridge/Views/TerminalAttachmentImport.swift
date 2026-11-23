import CoreTransferable
import Foundation
import UniformTypeIdentifiers

/// Serial image/file preparation bounds peak decode memory across a multi-pick.
actor TerminalAttachmentReader {
  static let shared = TerminalAttachmentReader()
  func read(_ url: URL, forceImage: Bool = false) throws -> PreparedAttachment {
    try Task.checkCancellation()
    return try autoreleasepool { try AttachmentPreparation.read(url, forceImage: forceImage) }
  }
  func imageData(_ data: Data) throws -> PreparedAttachment {
    try Task.checkCancellation()
    return try autoreleasepool { try AttachmentPreparation.imageData(data) }
  }
}

struct TerminalPhotoTransfer: Transferable {
  let attachment: PreparedAttachment
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in
      // The provider's temporary URL stays valid until this import completes.
      let attachment = try await TerminalAttachmentReader.shared.read(received.file, forceImage: true)
      return TerminalPhotoTransfer(attachment: attachment)
    }
  }
}
