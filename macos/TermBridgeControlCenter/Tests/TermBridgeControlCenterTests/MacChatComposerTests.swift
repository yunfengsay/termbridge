import AppKit
import XCTest
@testable import TermBridgeControlCenter

/// The desktop composer's input rules, on a private pasteboard and synthetic
/// events. Nothing here touches the user's clipboard or their sessions.
final class MacChatComposerTests: XCTestCase {
    private func board(_ name: String = UUID().uuidString) -> NSPasteboard {
        let pasteboard = NSPasteboard(name: NSPasteboard.Name(name))
        pasteboard.clearContents()
        return pasteboard
    }

    private func png() throws -> Data {
        let image = NSImage(size: NSSize(width: 4, height: 4))
        image.lockFocus(); NSColor.systemTeal.drawSwatch(in: NSRect(x: 0, y: 0, width: 4, height: 4)); image.unlockFocus()
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: image.tiffRepresentation ?? Data()))
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }

    /// A screenshot is PNG and TIFF at once. That is one picture.
    func testOneScreenshotIsQueuedOnceDespiteTwoRepresentations() throws {
        let pasteboard = board()
        let item = NSPasteboardItem()
        item.setData(try png(), forType: .png)
        item.setData(try XCTUnwrap(NSImage(data: try png())?.tiffRepresentation), forType: .tiff)
        pasteboard.writeObjects([item])
        XCTAssertEqual(MacChatAttachmentReader.sources(from: pasteboard).count, 1)
    }

    /// Two separate copies are two pictures. Asking the board for "the PNG"
    /// returns one of them and silently loses the other.
    func testIndependentItemsAreAllKept() throws {
        let pasteboard = board()
        let first = NSPasteboardItem(); first.setData(try png(), forType: .png)
        let second = NSPasteboardItem(); second.setData(try png(), forType: .png)
        pasteboard.writeObjects([first, second])
        XCTAssertEqual(MacChatAttachmentReader.sources(from: pasteboard).count, 2)
    }

    /// A file item and a separate bitmap item are two pictures, not a choice.
    func testAFileAndASeparateBitmapAreBothTaken() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("shot.png")
        try png().write(to: file)

        let pasteboard = board()
        let fileItem = NSPasteboardItem(); fileItem.setString(file.absoluteString, forType: .fileURL)
        let bitmapItem = NSPasteboardItem(); bitmapItem.setData(try png(), forType: .png)
        pasteboard.writeObjects([fileItem, bitmapItem])
        XCTAssertEqual(MacChatAttachmentReader.sources(from: pasteboard).count, 2)
    }

    /// Finder puts a rendered preview beside the file — including for things
    /// that are not images. The file's own type decides, or a PDF's thumbnail
    /// gets attached as if it were the user's screenshot.
    func testANonImageFilesPreviewIsNotAttached() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("notes.pdf")
        try Data("%PDF-1.4".utf8).write(to: file)

        let pasteboard = board()
        let item = NSPasteboardItem()
        item.setString(file.absoluteString, forType: .fileURL)
        item.setData(try png(), forType: .tiff)
        pasteboard.writeObjects([item])
        let sources = MacChatAttachmentReader.sources(from: pasteboard)
        XCTAssertEqual(sources.count, 1)
        guard case .document(let selected) = sources.first else { return XCTFail("attach the PDF, not its thumbnail") }
        XCTAssertEqual(selected, file)
    }

    func testPlainTextIsNotAnAttachment() {
        let pasteboard = board()
        pasteboard.setString("/Users/me/notes.png 只是一段文字", forType: .string)
        XCTAssertTrue(MacChatAttachmentReader.sources(from: pasteboard).isEmpty)
    }

    /// `keyCode` 36 is Return; 76 is the keypad's Enter, which is a different
    /// key and reaches `keyDown` with its own code.
    private func returnKey(_ flags: NSEvent.ModifierFlags, keyCode: UInt16 = 36) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
            timestamp: 0, windowNumber: 0, context: nil, characters: "\r",
            charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: keyCode))
    }

    /// Caps Lock and the numeric keypad both appear in the raw modifier flags.
    /// Comparing against those made Return stop sending whenever Caps Lock was
    /// on, or when the key came from the keypad.
    @MainActor
    func testReturnSendsRegardlessOfCapsLockAndKeypad() throws {
        let view = MacChatTextView()
        var sends = 0
        view.onSend = { sends += 1 }

        view.keyDown(with: try returnKey([]))
        view.keyDown(with: try returnKey(.capsLock))
        view.keyDown(with: try returnKey(.numericPad))
        view.keyDown(with: try returnKey([.command]))
        XCTAssertEqual(sends, 4, "plain and Cmd Return send, whatever else the keyboard reports")

        // The keypad's own Enter key, which arrives as keyCode 76 rather than
        // 36 — testing only 36 never exercised the second half of that check.
        view.keyDown(with: try returnKey([], keyCode: 76))
        view.keyDown(with: try returnKey(.numericPad, keyCode: 76))
        view.keyDown(with: try returnKey([.command], keyCode: 76))
        XCTAssertEqual(sends, 7, "keypad Enter sends like Return")

        // Shift is a newline; Control and Option with Return are neither, and
        // must not quietly send a message.
        view.keyDown(with: try returnKey(.shift))
        view.keyDown(with: try returnKey(.control))
        view.keyDown(with: try returnKey(.option))
        view.keyDown(with: try returnKey(.shift, keyCode: 76))
        XCTAssertEqual(sends, 7)

        // An ordinary character is not a send, whichever key produced it.
        view.keyDown(with: try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [],
            timestamp: 0, windowNumber: 0, context: nil, characters: "a",
            charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0)))
        XCTAssertEqual(sends, 7)
    }

    /// A drag that AppKit will actually deliver.
    ///
    /// `NSDraggingInfo` is a protocol, so the drop is driven through a real
    /// `MacChatTextView` with a private dragging pasteboard rather than the
    /// user's own board.
    private final class FakeDrag: NSObject, NSDraggingInfo {
        let draggingPasteboard: NSPasteboard
        init(_ pasteboard: NSPasteboard) { self.draggingPasteboard = pasteboard }
        var draggingDestinationWindow: NSWindow? { nil }
        var draggingSourceOperationMask: NSDragOperation { .copy }
        var draggingLocation: NSPoint { .zero }
        var draggedImageLocation: NSPoint { .zero }
        var draggedImage: NSImage? { nil }
        var draggingSource: Any? { nil }
        var draggingSequenceNumber: Int { 1 }
        var animatesToDestination: Bool { get { false } set {} }
        var numberOfValidItemsForDrop: Int { get { 1 } set {} }
        var draggingFormation: NSDraggingFormation { get { .default } set {} }
        var springLoadingHighlight: NSSpringLoadingHighlight { .none }
        func slideDraggedImage(to screenPoint: NSPoint) {}
        override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
        func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions, for view: NSView?,
                                    classes classArray: [AnyClass], searchOptions: [NSPasteboard.ReadingOptionKey: Any],
                                    using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
        func resetSpringLoading() {}
    }

    /// AppKit only routes a drag to a view registered for one of its types.
    /// Overriding the callbacks without registering meant a Finder drop on the
    /// composer did nothing at all — no callback ever ran.
    @MainActor
    func testTheComposerIsRegisteredForTheTypesAFinderDropArrivesAs() throws {
        _ = NSApplication.shared
        let view = MacChatTextView()
        let registered = view.registeredDraggedTypes
        for type in [NSPasteboard.PasteboardType.fileURL, .png, .tiff] {
            XCTAssertTrue(registered.contains(type), "a drop of \(type.rawValue) would never reach the composer")
        }
        // A bare NSTextView registers nothing at all — text drops were as dead
        // as image ones — so text is registered here too and handed to AppKit.
        XCTAssertTrue(registered.contains(.string), "dragging text in must still insert it")
        XCTAssertTrue(NSTextView().registeredDraggedTypes.isEmpty,
                      "this is why registering is needed: AppKit registers none of them itself")
    }

    /// The whole path: a dropped screenshot reaches `performDragOperation` and
    /// is queued exactly once, with both of its representations on the board.
    @MainActor
    func testADroppedScreenshotIsQueuedOnceThroughPerformDragOperation() throws {
        _ = NSApplication.shared
        let view = MacChatTextView()
        var queued: [[TerminalImageSource]] = []
        view.onImages = { queued.append($0) }

        let board = board()
        let item = NSPasteboardItem()
        let png = try png()
        item.setData(png, forType: .png)
        item.setData(Data([0x4d, 0x4d, 0x00, 0x2a]), forType: .tiff)
        board.writeObjects([item])

        let drag = FakeDrag(board)
        XCTAssertEqual(view.draggingEntered(drag), .copy, "the composer has to accept the drop it can read")
        XCTAssertTrue(view.performDragOperation(drag))
        XCTAssertEqual(queued.count, 1)
        XCTAssertEqual(queued.first?.count, 1, "one screenshot with two representations is one picture")
        guard case .clipboard(let data) = try XCTUnwrap(queued.first?.first) else {
            return XCTFail("a dropped screenshot is clipboard bytes, not a file reference")
        }
        XCTAssertEqual(data, png, "the richest representation is the one kept")
    }

    /// Dropped text is not an attachment; AppKit's own insertion handles it.
    @MainActor
    func testDroppedTextIsLeftToTheTextView() throws {
        _ = NSApplication.shared
        let view = MacChatTextView()
        var queued = 0
        view.onImages = { _ in queued += 1 }
        let board = board()
        board.clearContents()
        board.setString("/etc/hosts", forType: .string)
        let drag = FakeDrag(board)
        XCTAssertEqual(queued, 0, "text is not something the composer attaches")
        // Handed to AppKit rather than refused: `performDragOperation` falls
        // through to the text view, which inserts the characters.
        XCTAssertTrue(view.performDragOperation(drag))
        XCTAssertEqual(view.string, "/etc/hosts", "a path-looking string is inserted as text, not attached")
        XCTAssertEqual(queued, 0)
    }
}
