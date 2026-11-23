import AppKit
import ImageIO
import UniformTypeIdentifiers
import SwiftTerm

enum TerminalImageSource: Sendable {
    case file(URL)
    case document(URL)
    case clipboard(Data)
}

struct TerminalImage: Sendable {
    let data: Data
    let mime: String
    var fileName: String? = nil
    static let maxBytes = 4 * 1024 * 1024 // Existing session_upload contract.

    static func encode(_ input: TerminalImageSource) throws -> TerminalImage {
        let data: Data
        switch input {
        case .document(let url):
            let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values.isRegularFile == true, let size = values.fileSize, size > 0, size <= maxBytes else {
                throw Failure("请选择非空的普通文件，大小不能超过 4 MB。")
            }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let bytes = try handle.read(upToCount: maxBytes + 1) ?? Data()
            guard !bytes.isEmpty, bytes.count <= maxBytes else { throw Failure("文件大小超过 4 MB。") }
            return TerminalImage(data: bytes, mime: "application/octet-stream", fileName: String(url.lastPathComponent.prefix(255)))
        case .file(let url):
            guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 40 * 1024 * 1024 else {
                throw Failure("原始图片不能超过 40 MB。")
            }
            data = try Data(contentsOf: url)
        case .clipboard(let bytes): data = bytes
        }
        guard !data.isEmpty, data.count <= 40 * 1024 * 1024,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 2048,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { throw Failure("无法读取图片，请选择 PNG、JPEG、HEIC 或其他系统支持的图片。") }
        func encoded(_ image: CGImage, type: UTType, properties: [CFString: Any] = [:]) throws -> Data {
            let output = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil) else {
                throw Failure("图片转换失败。")
            }
            CGImageDestinationAddImage(destination, image, properties as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { throw Failure("图片转换失败。") }
            return output as Data
        }
        let png = try encoded(image, type: .png)
        if png.count <= maxBytes { return TerminalImage(data: png, mime: "image/png") }
        // Flatten transparency only when lossy compression is necessary to meet the Host limit.
        guard let context = CGContext(data: nil, width: image.width, height: image.height, bitsPerComponent: 8,
            bytesPerRow: image.width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw Failure("图片转换失败。") }
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let flat = context.makeImage() else { throw Failure("图片转换失败。") }
        let jpeg = try encoded(flat, type: .jpeg, properties: [kCGImageDestinationLossyCompressionQuality: 0.82])
        guard jpeg.count <= maxBytes else { throw Failure("转换后的图片超过 4 MB，请缩小图片后重试。") }
        return TerminalImage(data: jpeg, mime: "image/jpeg")
    }

    func saveLocal(root: URL) throws -> String {
        let directory = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let file = directory.appendingPathComponent(mime == "image/png" ? "image.png" : "image.jpg")
        try data.write(to: file, options: .withoutOverwriting)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        return file.path
    }

    struct Failure: LocalizedError {
        let errorDescription: String?
        init(_ message: String) { errorDescription = message }
    }
}

@MainActor
final class AttachmentTerminalView: LocalProcessTerminalView {
    func stopLocalProcess() {
        if process.running || process.childfd >= 0 { terminate() }
    }

    override func processTerminated(_ source: LocalProcess, exitCode: Int32?) {
        // SwiftTerm 1.20 marks natural exits stopped but leaves DispatchIO open.
        // Release through its owner before forwarding the event (which may
        // reconnect); closing raw FDs here would race libdispatch's cleanup.
        source.terminate()
        super.processTerminated(source, exitCode: exitCode)
    }

    var remoteScroll: ((Int) -> Void)?
    private var scrollRemainder: CGFloat = 0
    @discardableResult
    func handleRemoteScroll(_ event: NSEvent) -> Bool {
        guard let remoteScroll else { return false }
        // Mouse-aware TUIs own their viewport. Let SwiftTerm send the negotiated
        // mouse sequence to the application; Shift still browses Host history.
        if allowMouseReporting && getTerminal().mouseMode != .off && !event.modifierFlags.contains(.shift) {
            scrollRemainder = 0
            return false
        }
        // Native Herdr frames contain the viewport, not local scrollback. Send
        // explicit scroll operations without translating them into arrow keys.
        guard event.scrollingDeltaY != 0 else { return false }
        if event.phase.contains(.began) { scrollRemainder = 0 }
        let lines: Int
        if event.hasPreciseScrollingDeltas {
            scrollRemainder += event.scrollingDeltaY
            let height = max(1, font.ascender - font.descender + font.leading)
            lines = Int(scrollRemainder / height)
            scrollRemainder -= CGFloat(lines) * height
        } else {
            scrollRemainder = 0
            let rounded = Int(event.scrollingDeltaY.rounded())
            lines = rounded == 0 ? (event.scrollingDeltaY > 0 ? 1 : -1) : rounded
        }
        if lines != 0 { remoteScroll(max(-100, min(100, lines))) }
        return true
    }

    var openTerminalLink: ((String) -> Void)?
    override func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        openTerminalLink?(link)
    }

    var receiveImages: (([TerminalImageSource]) -> Void)?
    var receivedLocalOutput: (() -> Void)?
    /// Return true when Enter was consumed, including a blocked attachment send.
    var submitPendingAttachments: ((Data) -> Bool)?
    var writeAttachmentInput: ((Data) -> Bool)?

    /// Older snapshot Hosts understand CSI arrows but not SS3 application-cursor
    /// arrows. Normalize a single key only; leave paste and native streams intact.
    static func compatibleHerdrInput(_ data: ArraySlice<UInt8>) -> Data {
        let bytes = Array(data)
        if bytes.count == 3, bytes[0] == 27, bytes[1] == 79, (65...68).contains(bytes[2]) {
            return Data([27, 91, bytes[2]])
        }
        return Data(data)
    }

    override func send(source: Terminal, data: ArraySlice<UInt8>) {
        // The IME only emits this after composition is committed. Modified Enter
        // sequences and pasted multiline input retain their normal behavior.
        if consumeAttachmentSubmit(data) { return }
        super.send(source: source, data: data)
    }
    override func send(source: TerminalView, data: ArraySlice<UInt8>) {
        if consumeAttachmentSubmit(data) { return }
        super.send(source: source, data: data)
    }
    func consumeAttachmentSubmit(_ data: ArraySlice<UInt8>) -> Bool {
        Self.isSubmitKey(data) && !hasMarkedText() && submitPendingAttachments?(Data(data)) == true
    }
    static func isSubmitKey(_ data: ArraySlice<UInt8>) -> Bool {
        if data.count == 1, data.first == 13 { return true }
        // Kitty keyboard protocol, including keypad Enter, press/repeat and lock
        // modifiers. Shift/Alt/Ctrl/Cmd Enter and release events are not submits.
        guard data.count < 32 else { return false }
        return String(decoding: data, as: UTF8.self).range(of: #"^\x1b\[(?:13|57414)(?:;(?:1|65|129|193)(?::[12])?)?u$"#,
                                                          options: .regularExpression) != nil
    }

    override func dataReceived(slice: ArraySlice<UInt8>) {
        super.dataReceived(slice: slice)
        if !slice.isEmpty { receivedLocalOutput?() }
    }

    override func paste(_ sender: Any) {
        if !pasteImages(from: .general) { super.paste(sender) }
    }

    @discardableResult
    func pasteImages(from clipboard: NSPasteboard) -> Bool {
        // Finder also supplies a thumbnail; prefer the selected original file.
        let urls = (clipboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.contentTypeKey]).contentType?.conforms(to: .image)) == true }
        if !urls.isEmpty { receiveImages?(urls.map(TerminalImageSource.file)); return true }
        if let data = clipboard.data(forType: .png) ?? clipboard.data(forType: .tiff) {
            receiveImages?([.clipboard(data)]); return true
        }
        return false
    }

    /// One ordered write at the remote line editor's current cursor; no cursor movement.
    @discardableResult func insertAttachmentReferences(_ text: String, returnSequence: Data? = nil) -> Bool {
        let terminal = getTerminal()
        let paste = terminal.bracketedPasteMode ? "\u{1b}[200~\(text)\u{1b}[201~" : text
        let payload = Data(paste.utf8) + (returnSequence ?? Data())
        if let writeAttachmentInput { return writeAttachmentInput(payload) }
        super.send(source: terminal, data: Array(payload)[...])
        return true
    }
}
