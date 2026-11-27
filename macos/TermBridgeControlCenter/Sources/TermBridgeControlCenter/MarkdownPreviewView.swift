import AppKit
import UniformTypeIdentifiers
import WebKit

/// Renders Markdown files using the bundled read-only Tiptap surface inside a
/// locked-down `WKWebView`, loading local/remote Host images over `tb-md-asset://`
/// and exposing native `⌘F` find-in-document highlighting via `MacFindBarView`.
@MainActor
final class MarkdownPreviewView: NSView, WKNavigationDelegate {
    static let assetScheme = "tb-md-asset"

    let web: WKWebView
    let findBar = MacFindBarView()

    /// Fetches image bytes (and MIME type) for a resolved Host file path.
    var onLoadAsset: ((String, @escaping @MainActor (Result<(Data, String), Error>) -> Void) -> Void)?
    /// Invoked when the reader clicks a non-anchor link (`https://`, file path, etc.).
    var onLink: ((String) -> Void)?
    /// Optional diagnostics hook for tests (`headingCount`, `imageCount`, `carouselCount`).
    var onRendered: ((Int, Int, Int) -> Void)?

    private(set) var currentMarkdown = ""
    private(set) var currentPath = ""
    private var ready = false
    private var hasLoadedPage = false
    private var pendingRender: (markdown: String, path: String)?
    private var lastFindQuery = ""
    private var lastFindCaseSensitive = false
    private let scriptHandler = MarkdownScriptHandler()
    private let assetHandler = MarkdownAssetSchemeHandler()

    static var resourceURL: URL? {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("TermBridgeControlCenter_TermBridgeControlCenter.bundle")
        let bundle = packaged.flatMap(Bundle.init(url:)) ?? Bundle.module
        return bundle.url(forResource: "index", withExtension: "html", subdirectory: "MarkdownPreview")
    }

    static func surfaceBackground(dark: Bool) -> NSColor {
        dark ? NSColor(srgbRed: 0x16 / 255, green: 0x16 / 255, blue: 0x18 / 255, alpha: 1)
             : NSColor(srgbRed: 0xfb / 255, green: 0xfb / 255, blue: 0xfd / 255, alpha: 1)
    }

    override init(frame frameRect: NSRect) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.userContentController.add(scriptHandler, name: "markdownPreview")
        config.setURLSchemeHandler(assetHandler, forURLScheme: Self.assetScheme)
        web = WKWebView(frame: .zero, configuration: config)
        super.init(frame: frameRect)
        wantsLayer = true

        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.setAccessibilityLabel("Markdown 预览")
        web.translatesAutoresizingMaskIntoConstraints = false
        addSubview(web)

        addSubview(findBar)
        NSLayoutConstraint.activate([
            web.leadingAnchor.constraint(equalTo: leadingAnchor),
            web.trailingAnchor.constraint(equalTo: trailingAnchor),
            web.topAnchor.constraint(equalTo: topAnchor),
            web.bottomAnchor.constraint(equalTo: bottomAnchor),
            findBar.topAnchor.constraint(equalTo: topAnchor, constant: 10),
            findBar.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
        ])

        scriptHandler.receive = { [weak self] message in
            self?.receive(message)
        }
        assetHandler.onRequest = { [weak self] rawPath, completion in
            guard let self else {
                completion(.failure(MarkdownAssetError.cancelled))
                return
            }
            guard let resolved = Self.resolveAssetPath(rawPath, relativeTo: self.currentPath) else {
                completion(.failure(MarkdownAssetError.invalidPath))
                return
            }
            guard let loader = self.onLoadAsset else {
                completion(.failure(MarkdownAssetError.unavailable))
                return
            }
            loader(resolved, completion)
        }

        findBar.onQueryChange = { [weak self] query, caseSensitive in
            self?.performFind(query: query, caseSensitive: caseSensitive)
        }
        findBar.onFindNext = { [weak self] query, caseSensitive in
            guard let self else { return }
            if query != self.lastFindQuery || caseSensitive != self.lastFindCaseSensitive {
                self.performFind(query: query, caseSensitive: caseSensitive)
            } else {
                self.send(["op": "findNext"])
            }
        }
        findBar.onFindPrevious = { [weak self] query, caseSensitive in
            guard let self else { return }
            if query != self.lastFindQuery || caseSensitive != self.lastFindCaseSensitive {
                self.performFind(query: query, caseSensitive: caseSensitive)
            } else {
                self.send(["op": "findPrevious"])
            }
        }
        findBar.onClose = { [weak self] in
            guard let self else { return }
            self.lastFindQuery = ""
            self.send(["op": "clearFind"])
            self.window?.makeFirstResponder(self.web)
        }

        applyAppearance()
    }

    required init?(coder: NSCoder) { nil }

    func show(markdown: String, path: String) {
        currentMarkdown = markdown
        currentPath = path
        findBar.dismiss()
        lastFindQuery = ""
        pendingRender = (markdown, path)
        loadIfNeeded()
        flushPendingRender()
    }

    func clear() {
        currentMarkdown = ""
        currentPath = ""
        pendingRender = nil
        lastFindQuery = ""
        findBar.dismiss()
        assetHandler.cancelAll()
        if ready {
            send(["op": "clear"])
        }
    }

    func showFind() {
        findBar.present()
    }

    func findNext() {
        findBar.findNext()
    }

    func findPrevious() {
        findBar.findPrevious()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyAppearance()
    }

    private var isDarkAppearance: Bool {
        effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }

    private func applyAppearance() {
        let dark = isDarkAppearance
        layer?.backgroundColor = Self.surfaceBackground(dark: dark).cgColor
        if ready {
            send(["op": "theme", "theme": dark ? "dark" : "light"])
        }
    }

    private func loadIfNeeded() {
        guard !hasLoadedPage, let url = Self.resourceURL else { return }
        hasLoadedPage = true
        ready = false
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    private func flushPendingRender() {
        guard ready, let pending = pendingRender else { return }
        pendingRender = nil
        send([
            "op": "render",
            "markdown": pending.markdown,
            "path": pending.path,
            "theme": isDarkAppearance ? "dark" : "light",
        ])
    }

    private func performFind(query: String, caseSensitive: Bool) {
        lastFindQuery = query
        lastFindCaseSensitive = caseSensitive
        if query.isEmpty {
            send(["op": "clearFind"])
        } else {
            send(["op": "find", "query": query, "caseSensitive": caseSensitive])
        }
    }

    private func send(_ payload: [String: Any]) {
        guard ready, JSONSerialization.isValidJSONObject(payload),
              let bytes = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: bytes, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.termbridgeMarkdown?.receive(\(json))", completionHandler: nil)
    }

    private func receive(_ message: [String: Any]) {
        switch message["op"] as? String {
        case "ready":
            ready = true
            applyAppearance()
            flushPendingRender()
        case "copy":
            if let text = message["data"] as? String {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
            }
        case "open":
            if let url = message["url"] as? String {
                onLink?(url)
            }
        case "findResult":
            let index = message["index"] as? Int ?? 0
            let total = message["total"] as? Int ?? 0
            findBar.updateCount(index: index, total: total)
        case "rendered":
            let headings = message["headingCount"] as? Int ?? 0
            let images = message["imageCount"] as? Int ?? 0
            let carousels = message["carouselCount"] as? Int ?? 0
            onRendered?(headings, images, carousels)
        default:
            break
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.request.url == Self.resourceURL ? .allow : .cancel)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        ready = false
        hasLoadedPage = false
        if !currentMarkdown.isEmpty {
            pendingRender = (currentMarkdown, currentPath)
            loadIfNeeded()
        }
    }

    // MARK: - Asset Path & MIME Helpers

    /// Resolve a Markdown image or file reference against the open Markdown file's directory.
    nonisolated static func resolveAssetPath(_ rawPath: String, relativeTo markdownPath: String) -> String? {
        let trimmed = rawPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 4096,
              !trimmed.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
            return nil
        }
        if trimmed.hasPrefix("/") || trimmed.hasPrefix("~/") {
            return normalizePosixPath(trimmed)
        }
        let baseDir = (markdownPath as NSString).deletingLastPathComponent
        guard !baseDir.isEmpty else { return normalizePosixPath(trimmed) }
        return normalizePosixPath((baseDir as NSString).appendingPathComponent(trimmed))
    }

    /// Normalize `.` and `..` segments without expanding `~` (the remote Host expands its own `$HOME`).
    private nonisolated static func normalizePosixPath(_ path: String) -> String {
        let prefix: String
        let rest: String
        if path.hasPrefix("~/") {
            prefix = "~/"
            rest = String(path.dropFirst(2))
        } else if path.hasPrefix("/") {
            prefix = "/"
            rest = String(path.dropFirst())
        } else {
            prefix = ""
            rest = path
        }
        var stack: [String] = []
        for component in rest.split(separator: "/", omittingEmptySubsequences: true) {
            if component == "." { continue }
            if component == ".." {
                if let last = stack.last, last != ".." {
                    stack.removeLast()
                } else if prefix.isEmpty {
                    stack.append("..")
                }
            } else {
                stack.append(String(component))
            }
        }
        return prefix + stack.joined(separator: "/")
    }

    /// Sniff safe image MIME types from magic bytes (falling back to image UTType by extension).
    /// Returns `nil` for non-image payloads so arbitrary text files cannot be served as images.
    nonisolated static func imageMimeType(for data: Data, path: String) -> String? {
        let bytes = [UInt8](data.prefix(32))
        if bytes.count >= 8, bytes.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if bytes.count >= 3, bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if bytes.count >= 4, bytes.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
        if bytes.count >= 12,
           bytes[0...3] == [0x52, 0x49, 0x46, 0x46],
           bytes[8...11] == [0x57, 0x45, 0x42, 0x50] { return "image/webp" }
        if bytes.count >= 2, bytes.starts(with: [0x42, 0x4D]) { return "image/bmp" }
        if bytes.count >= 4, bytes.starts(with: [0x00, 0x00, 0x01, 0x00]) { return "image/x-icon" }
        if bytes.count >= 12, bytes[4...7] == [0x66, 0x74, 0x79, 0x70] {
            let brand = String(bytes: bytes[8...11], encoding: .ascii)?.lowercased() ?? ""
            if brand == "avif" || brand == "avis" { return "image/avif" }
            if brand == "heic" || brand == "heix" || brand == "mif1" || brand == "hevc" { return "image/heic" }
        }
        let ext = (path as NSString).pathExtension.lowercased()
        if ext == "svg" || ext == "svgz" {
            if let head = String(data: data.prefix(512), encoding: .utf8)?.lowercased(),
               head.contains("<svg") {
                return "image/svg+xml"
            }
        }
        if !ext.isEmpty, let type = UTType(filenameExtension: ext), type.conforms(to: .image),
           let mime = type.preferredMIMEType {
            return mime
        }
        return nil
    }
}

enum MarkdownAssetError: LocalizedError {
    case invalidPath
    case unavailable
    case notImage
    case cancelled
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .invalidPath: return "图片路径无效"
        case .unavailable: return "当前连接不可用"
        case .notImage: return "文件不是受支持的图片格式"
        case .cancelled: return "已取消"
        case .failed(let text): return text
        }
    }
}

private final class MarkdownScriptHandler: NSObject, WKScriptMessageHandler {
    var receive: (([String: Any]) -> Void)?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, let payload = message.body as? [String: Any] else { return }
        receive?(payload)
    }
}

@MainActor
private final class MarkdownAssetSchemeHandler: NSObject, WKURLSchemeHandler {
    var onRequest: ((String, @escaping @MainActor (Result<(Data, String), Error>) -> Void) -> Void)?
    private var activeTasks: Set<ObjectIdentifier> = []

    func cancelAll() {
        activeTasks.removeAll()
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let key = ObjectIdentifier(urlSchemeTask)
        activeTasks.insert(key)

        guard let requestURL = urlSchemeTask.request.url,
              let components = URLComponents(url: requestURL, resolvingAgainstBaseURL: false),
              let rawPath = components.queryItems?.first(where: { $0.name == "path" })?.value,
              !rawPath.isEmpty else {
            if activeTasks.remove(key) != nil {
                urlSchemeTask.didFailWithError(MarkdownAssetError.invalidPath)
            }
            return
        }

        guard let onRequest else {
            if activeTasks.remove(key) != nil {
                urlSchemeTask.didFailWithError(MarkdownAssetError.unavailable)
            }
            return
        }

        onRequest(rawPath) { [weak self] result in
            guard let self, self.activeTasks.remove(key) != nil else { return }
            switch result {
            case .success(let (data, mimeType)):
                let response = HTTPURLResponse(
                    url: requestURL,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: [
                        "Content-Type": mimeType,
                        "Content-Length": "\(data.count)",
                        "Cache-Control": "no-store",
                    ]
                ) ?? URLResponse(url: requestURL, mimeType: mimeType, expectedContentLength: data.count, textEncodingName: nil)
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(data)
                urlSchemeTask.didFinish()
            case .failure(let error):
                urlSchemeTask.didFailWithError(error)
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        activeTasks.remove(ObjectIdentifier(urlSchemeTask))
    }
}
