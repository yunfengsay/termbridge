import AppKit
import UniformTypeIdentifiers

/// Turns a pasteboard or a drag into selected image/file sources, once each.
///
/// A screenshot arrives as PNG *and* TIFF; a Finder copy arrives as a file URL
/// plus a rendered thumbnail. Reading every representation would queue the same
/// picture two or three times, so the richest one wins and the rest are ignored.
///
/// Image encoding is shared with the terminal. Non-image files retain their
/// original bytes and never attach a Finder-generated preview as the document.
enum MacChatAttachmentReader {
    /// Whether this pasteboard holds something to attach at all.
    static func hasImages(_ pasteboard: NSPasteboard) -> Bool { !sources(from: pasteboard).isEmpty }

    static func sources(from pasteboard: NSPasteboard) -> [TerminalImageSource] {
        // Per item, not per pasteboard.
        //
        // Copying two screenshots puts two items on the board; asking the board
        // for "the PNG" returns one of them and loses the other. A file and a
        // separate bitmap are likewise two pictures, not a choice between them.
        // Within one item the representations describe the same picture — a
        // screenshot is PNG and TIFF at once, a Finder copy is a file plus its
        // preview — so there the richest one wins and the rest are skipped.
        (pasteboard.pasteboardItems ?? []).compactMap(source(from:))
    }

    private static func source(from item: NSPasteboardItem) -> TerminalImageSource? {
        // A file reference describes this item completely: its own type decides
        // whether it is an image, and the preview beside it is the same object.
        if let raw = item.string(forType: .fileURL), let url = URL(string: raw) {
            guard url.isFileURL else { return nil }
            return isImage(url) ? .file(url) : .document(url)
        }
        if let data = item.data(forType: .png) ?? item.data(forType: .tiff) {
            return .clipboard(data)
        }
        return nil
    }

    /// Promised files without an actual file URL are not dereferenced.
    static func sources(from dragging: NSDraggingInfo) -> [TerminalImageSource] {
        sources(from: dragging.draggingPasteboard)
    }

    static func isImage(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        if let type = try? url.resourceValues(forKeys: [.contentTypeKey]).contentType {
            return type.conforms(to: .image)
        }
        // A file that has not been read yet still has an extension to go on.
        return UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true
    }
}
