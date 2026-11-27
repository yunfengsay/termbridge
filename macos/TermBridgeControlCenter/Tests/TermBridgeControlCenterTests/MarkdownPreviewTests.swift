import AppKit
import XCTest
@testable import TermBridgeControlCenter

final class MarkdownPreviewTests: XCTestCase {
    private static let onePixelPNG = Data(base64Encoded:
        "iVBORw0KGgoAAAANSUhEUgAAAAYAAAAGCAIAAABvrngfAAAAEUlEQVR4nGO4o6GBhhhoKwQAfvkqMfvTi9EAAAAASUVORK5CYII=")!

    func testAssetPathResolutionHandlesAbsoluteRelativeAndTilde() {
        let base = "/Users/alice/docs/guide/intro.md"
        XCTAssertEqual(MarkdownPreviewView.resolveAssetPath("/Users/alice/img/a.png", relativeTo: base), "/Users/alice/img/a.png")
        XCTAssertEqual(MarkdownPreviewView.resolveAssetPath("~/shots/demo.png", relativeTo: base), "~/shots/demo.png")
        XCTAssertEqual(MarkdownPreviewView.resolveAssetPath("./fig.png", relativeTo: base), "/Users/alice/docs/guide/fig.png")
        XCTAssertEqual(MarkdownPreviewView.resolveAssetPath("../shared/arch.png", relativeTo: base), "/Users/alice/docs/shared/arch.png")
        XCTAssertEqual(MarkdownPreviewView.resolveAssetPath("sub/pic.webp", relativeTo: base), "/Users/alice/docs/guide/sub/pic.webp")
        XCTAssertNil(MarkdownPreviewView.resolveAssetPath("", relativeTo: base))
        XCTAssertNil(MarkdownPreviewView.resolveAssetPath("bad\u{0000}path.png", relativeTo: base))
    }

    func testImageMimeTypeSniffsImagesAndRejectsTextPayloads() {
        XCTAssertEqual(MarkdownPreviewView.imageMimeType(for: Self.onePixelPNG, path: "shot.png"), "image/png")
        XCTAssertEqual(MarkdownPreviewView.imageMimeType(for: Data([0xFF, 0xD8, 0xFF, 0xE0]), path: "photo.jpg"), "image/jpeg")
        XCTAssertEqual(MarkdownPreviewView.imageMimeType(for: Data("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".utf8), path: "icon.svg"), "image/svg+xml")
        XCTAssertNil(MarkdownPreviewView.imageMimeType(for: Data("SECRET_KEY=123\n".utf8), path: ".env"))
        XCTAssertNil(MarkdownPreviewView.imageMimeType(for: Data("export const x = 1".utf8), path: "app.ts"))
    }

    @MainActor
    func testNativeBackdropMatchesPackagedMarkdownStylesheet() throws {
        let url = try XCTUnwrap(MarkdownPreviewView.resourceURL, "MarkdownPreview bundle must exist")
        let css = try String(contentsOf: url.deletingLastPathComponent().appendingPathComponent("markdown.css"), encoding: .utf8)
        let declared = css.components(separatedBy: "--tb-bg:").dropFirst().compactMap { piece in
            piece.prefix(while: { $0 != ";" }).trimmingCharacters(in: .whitespaces).lowercased()
        }
        XCTAssertGreaterThanOrEqual(declared.count, 2)
        func hex(_ color: NSColor) throws -> String {
            let srgb = try XCTUnwrap(color.usingColorSpace(.sRGB))
            return String(format: "#%02x%02x%02x", Int((srgb.redComponent * 255).rounded()),
                          Int((srgb.greenComponent * 255).rounded()), Int((srgb.blueComponent * 255).rounded()))
        }
        XCTAssertEqual(try hex(MarkdownPreviewView.surfaceBackground(dark: false)), declared.first)
        for dark in declared.dropFirst() {
            XCTAssertEqual(try hex(MarkdownPreviewView.surfaceBackground(dark: true)), dark)
        }
    }

    @MainActor
    func testTiptapWebViewRendersRichMarkdownLoadsAssetsAndSearches() async throws {
        _ = NSApplication.shared
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 920, height: 680),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        let preview = MarkdownPreviewView(frame: NSRect(x: 0, y: 0, width: 920, height: 680))
        window.contentView = preview

        var loadedAssets: [String] = []
        preview.onLoadAsset = { path, completion in
            loadedAssets.append(path)
            completion(.success((Self.onePixelPNG, "image/png")))
        }

        var renderedStats: (Int, Int, Int)?
        preview.onRendered = { headings, images, carousels in
            renderedStats = (headings, images, carousels)
        }

        let sample = """
        ---
        title: Spec Review
        status: Active
        ---

        # Tiptap Preview Title

        > [!TIP]
        > Rendered by **Tiptap** inside TermBridge.

        - [x] Verified task
        - [ ] Open task

        | Item | Count |
        | :--- | ---: |
        | Alpha | 7 |

        ```swift
        let answer = 42
        ```

        ![Diagram](./img/diagram.png)

        ````carousel
        ![Slide One](/abs/one.png)
        <!-- slide -->
        ![Slide Two](/abs/two.png)
        ````
        """

        preview.show(markdown: sample, path: "/work/docs/spec.md")

        for _ in 0..<120 {
            if renderedStats != nil { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let stats = try XCTUnwrap(renderedStats, "Tiptap surface should finish rendering")
        XCTAssertEqual(stats.0, 1)
        XCTAssertEqual(stats.1, 3)
        XCTAssertEqual(stats.2, 1)

        // Wait for custom tb-md-asset:// image scheme loads to complete.
        for _ in 0..<80 {
            if loadedAssets.contains("/work/docs/img/diagram.png") && loadedAssets.contains("/abs/one.png") { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(loadedAssets.contains("/work/docs/img/diagram.png"), "Relative image resolved via Host loader: \(loadedAssets)")
        XCTAssertTrue(loadedAssets.contains("/abs/one.png"), "Carousel image resolved via Host loader: \(loadedAssets)")

        let domSummary = try await preview.web.evaluateJavaScript("""
            (() => {
              const root = document.querySelector('.ProseMirror');
              if (!root) return null;
              const img = root.querySelector('figure img');
              return {
                h1: root.querySelector('h1')?.textContent ?? '',
                callout: root.querySelector('aside[data-kind="tip"]')?.textContent ?? '',
                tasks: root.querySelectorAll('ul[data-type="taskList"] li').length,
                tableCells: root.querySelectorAll('table th, table td').length,
                highlightedTokens: root.querySelectorAll('pre code span[class^="hljs-"]').length,
                carouselCounter: root.querySelector('.tb-md-carousel-counter')?.textContent ?? '',
                imgWidth: img ? img.naturalWidth : 0,
              };
            })()
        """) as? [String: Any]

        let summary = try XCTUnwrap(domSummary, "ProseMirror DOM must be mounted")
        XCTAssertEqual(summary["h1"] as? String, "Tiptap Preview Title")
        XCTAssertTrue((summary["callout"] as? String)?.contains("Tiptap") == true)
        XCTAssertEqual(summary["tasks"] as? Int, 2)
        XCTAssertEqual(summary["tableCells"] as? Int, 4)
        XCTAssertGreaterThan(summary["highlightedTokens"] as? Int ?? 0, 0, "lowlight should highlight Swift code")
        XCTAssertEqual(summary["carouselCounter"] as? String, "1 / 2")
        XCTAssertEqual(summary["imgWidth"] as? Int, 6, "6x6 PNG loaded via custom tb-md-asset:// scheme")

        // Exercise in-document Tiptap search highlighting.
        preview.showFind()
        preview.findBar.field.stringValue = "Tiptap"
        preview.findBar.onQueryChange?("Tiptap", false)
        var matchCount = 0
        for _ in 0..<40 {
            matchCount = (try await preview.web.evaluateJavaScript("document.querySelectorAll('.tb-find-match').length") as? Int) ?? 0
            if matchCount >= 2 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(matchCount, 2, "Tiptap SearchHighlight should mark both occurrences of 'Tiptap'")

        // Optional visual QA snapshot when TB_MARKDOWN_QA_DIR is provided (captures real living_doc_showcase.md).
        if let qaDir = ProcessInfo.processInfo.environment["TB_MARKDOWN_QA_DIR"],
           let qaFile = ProcessInfo.processInfo.environment["TB_MARKDOWN_QA_FILE"],
           let md = try? String(contentsOfFile: qaFile, encoding: .utf8) {
            try FileManager.default.createDirectory(atPath: qaDir, withIntermediateDirectories: true)
            preview.onLoadAsset = { path, completion in
                if let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
                   let mime = MarkdownPreviewView.imageMimeType(for: data, path: path) {
                    completion(.success((data, mime)))
                } else {
                    completion(.failure(MarkdownAssetError.unavailable))
                }
            }
            for (name, appearance) in [("dark", NSAppearance(named: .darkAqua)), ("light", NSAppearance(named: .aqua))] {
                window.appearance = appearance
                var done = false
                preview.onRendered = { _, _, _ in done = true }
                preview.show(markdown: md, path: qaFile)
                for _ in 0..<100 {
                    if done { break }
                    try await Task.sleep(nanoseconds: 50_000_000)
                }
                try await Task.sleep(nanoseconds: 500_000_000)
                let img = try await preview.web.takeSnapshot(configuration: nil)
                if let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try png.write(to: URL(fileURLWithPath: qaDir).appendingPathComponent("tiptap_markdown_\(name).png"))
                }
            }
        }
    }
}
