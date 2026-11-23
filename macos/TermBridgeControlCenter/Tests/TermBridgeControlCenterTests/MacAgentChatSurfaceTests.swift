import AppKit
import XCTest
@testable import TermBridgeControlCenter

/// The native half of the chat window and the transcript it sits under have to
/// paint the same background, or the window shows a seam across its middle.
/// The colour is declared twice — once in the shared CSS, once in AppKit — so
/// this reads the packaged stylesheet and fails when they drift.
final class MacAgentChatSurfaceTests: XCTestCase {
    @MainActor
    private func css() throws -> String {
        let url = try XCTUnwrap(MacAgentChatView.resourceURL, "the packaged renderer must be present")
        return try String(contentsOf: url.deletingLastPathComponent().appendingPathComponent("chat.css"),
                          encoding: .utf8)
    }

    /// `--tb-bg: #rrggbb;` — the light value first, the dark override second.
    private func backgrounds(_ stylesheet: String) -> [String] {
        stylesheet.components(separatedBy: "--tb-bg:").dropFirst().compactMap { piece in
            piece.prefix(while: { $0 != ";" }).trimmingCharacters(in: .whitespaces).lowercased()
        }
    }

    private func hex(_ color: NSColor) throws -> String {
        let srgb = try XCTUnwrap(color.usingColorSpace(.sRGB))
        return String(format: "#%02x%02x%02x", Int((srgb.redComponent * 255).rounded()),
                      Int((srgb.greenComponent * 255).rounded()), Int((srgb.blueComponent * 255).rounded()))
    }

    @MainActor
    func testTheNativeBackdropMatchesTheTranscriptStylesheet() throws {
        let declared = backgrounds(try css())
        XCTAssertGreaterThanOrEqual(declared.count, 2, "the stylesheet must declare a light and a dark background")
        XCTAssertEqual(try hex(MacAgentChatView.surfaceBackground(dark: false)), declared.first)
        // Every dark override has to agree; the renderer picks between them by
        // media query and by the theme the app pushes.
        for dark in declared.dropFirst() {
            XCTAssertEqual(try hex(MacAgentChatView.surfaceBackground(dark: true)), dark)
        }
    }
}
