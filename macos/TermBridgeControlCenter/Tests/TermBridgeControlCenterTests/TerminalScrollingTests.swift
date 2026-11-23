import AppKit
import SwiftTerm
import XCTest
@testable import TermBridgeControlCenter

final class TerminalScrollingTests: XCTestCase {
    @MainActor func testApplicationMouseWheelIsNotDivertedIntoHistory() throws {
        _ = NSApplication.shared
        let terminal = AttachmentTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        let probe = ScrollInputProbe()
        terminal.terminalDelegate = probe
        var history: [Int] = []
        terminal.remoteScroll = { history.append($0) }
        terminal.feed(text: "\u{1b}[?1000h\u{1b}[?1006h")
        let event = try wheel(-2)
        if !terminal.handleRemoteScroll(event) { terminal.scrollWheel(with: event) }
        XCTAssertTrue(history.isEmpty, "Application mouse tracking must receive the wheel")
        XCTAssertTrue(String(decoding: probe.bytes, as: UTF8.self).contains("\u{1b}[<65;"))
    }

    @MainActor func testDownKeyReachesRemoteInputInCursorAndKittyModes() throws {
        _ = NSApplication.shared
        let terminal = AttachmentTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        let probe = ScrollInputProbe()
        terminal.terminalDelegate = probe
        let characters = String(Unicode.Scalar(NSDownArrowFunctionKey)!)
        let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
            modifierFlags: [.numericPad, .function], timestamp: 0, windowNumber: 0, context: nil,
            characters: characters, charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 125))
        for (setup, expected) in [("\u{1b}[?1l", "\u{1b}[B"),
                                  ("\u{1b}[?1h", "\u{1b}OB"),
                                  ("\u{1b}[?1l\u{1b}[>1u", "\u{1b}[B")] {
            terminal.feed(text: setup)
            probe.bytes.removeAll()
            terminal.keyDown(with: event)
            XCTAssertEqual(String(decoding: probe.bytes, as: UTF8.self), expected)
            XCTAssertEqual(String(decoding: AttachmentTerminalView.compatibleHerdrInput(Array(probe.bytes)[...]), as: UTF8.self), "\u{1b}[B")
        }
        let pasted = Array("\u{1b}[200~\u{1b}OB\u{1b}[201~".utf8)
        XCTAssertEqual(AttachmentTerminalView.compatibleHerdrInput(pasted[...]), Data(pasted))
    }
    @MainActor func testNativeViewportScrollsWithoutLocalHistoryOrArrowKeys() throws {
        _ = NSApplication.shared
        let terminal = AttachmentTerminalView(frame: NSRect(x: 0, y: 0, width: 600, height: 400))
        terminal.feed(text: "\u{1b}[2J\u{1b}[HNative viewport only")
        var sent: [Int] = []
        terminal.remoteScroll = { sent.append($0) }
        XCTAssertTrue(terminal.handleRemoteScroll(try wheel(3)))
        XCTAssertTrue(terminal.handleRemoteScroll(try wheel(-2)))
        XCTAssertEqual(sent, [3, -2])
        sent.removeAll()
        for _ in 0..<32 { terminal.handleRemoteScroll(try wheel(1, precise: true)) }
        XCTAssertGreaterThan(sent.reduce(0, +), 0, "Small trackpad deltas must accumulate")
        XCTAssertLessThan(sent.reduce(0, +), 10, "Pixel deltas are not whole lines")
        XCTAssertFalse(terminal.handleRemoteScroll(try wheel(0)))
        terminal.remoteScroll = nil
        XCTAssertFalse(terminal.handleRemoteScroll(try wheel(3)), "Ordinary PTY keeps SwiftTerm scrolling")
    }
    private func wheel(_ delta: Int32, precise: Bool = false) throws -> NSEvent {
        let cg = try XCTUnwrap(CGEvent(scrollWheelEvent2Source: nil, units: precise ? .pixel : .line,
            wheelCount: 1, wheel1: delta, wheel2: 0, wheel3: 0))
        return try XCTUnwrap(NSEvent(cgEvent: cg))
    }
}

@MainActor private final class ScrollInputProbe: @preconcurrency TerminalViewDelegate {
    var bytes = Data()
    func send(source: TerminalView, data: ArraySlice<UInt8>) { bytes.append(contentsOf: data) }
    func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
    func setTerminalTitle(source: TerminalView, title: String) {}
    func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
    func scrolled(source: TerminalView, position: Double) {}
    func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}
