import SwiftUI
import UIKit
import WebKit

final class TerminalController: NSObject, WKScriptMessageHandler, WKNavigationDelegate,
  UIGestureRecognizerDelegate
{
  var onReady: ((Int, Int) -> Void)?
  var onTextInput: ((String) -> Void)?
  var onBinaryInput: ((Data) -> Void)?
  var onResize: ((Int, Int) -> Void)?
  var onTitle: ((String) -> Void)?
  var onTranscriptResync: ((Int?) -> Void)?
  private(set) var bracketedPasteMode = false

  private weak var webView: WKWebView?
  private weak var panGesture: UIPanGestureRecognizer?
  private var previousPanTranslationY: CGFloat = 0
  private var isReady = false
  private var pendingOutput = Data()
  private var flushScheduled = false

  func attach(_ webView: WKWebView) {
    self.webView = webView
    let pan = UIPanGestureRecognizer(target: self, action: #selector(handleTerminalPan(_:)))
    pan.minimumNumberOfTouches = 1
    pan.maximumNumberOfTouches = 1
    pan.cancelsTouchesInView = false
    pan.delegate = self
    webView.addGestureRecognizer(pan)
    panGesture = pan
  }

  func detach() {
    webView?.evaluateJavaScript("window.Termbridge?.cancelScroll()")
    if let panGesture, let view = panGesture.view { view.removeGestureRecognizer(panGesture) }
    panGesture = nil
    webView = nil
    isReady = false
    pendingOutput.removeAll(keepingCapacity: false)
  }

  func write(_ data: Data) {
    guard !data.isEmpty else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.pendingOutput.append(data)
      guard !self.flushScheduled else { return }
      self.flushScheduled = true
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.012) { [weak self] in self?.flush() }
    }
  }

  func applyMobileSnapshot(revision: Int, payload: Data) {
    let encoded = payload.base64EncodedString()
    webView?.evaluateJavaScript("window.Termbridge?.applyMobileSnapshot(\(revision),'\(encoded)')")
  }

  func applyMobilePatch(baseRevision: Int, revision: Int, payload: Data) {
    let encoded = payload.base64EncodedString()
    webView?.evaluateJavaScript(
      "window.Termbridge?.applyMobilePatch(\(baseRevision),\(revision),'\(encoded)')")
  }

  func reset(completion: (() -> Void)? = nil) {
    bracketedPasteMode = false
    DispatchQueue.main.async { [weak self] in
      self?.pendingOutput.removeAll(keepingCapacity: true)
      self?.webView?.evaluateJavaScript("window.Termbridge?.reset()") { _, _ in completion?() }
    }
  }

  func focus() {
    webView?.evaluateJavaScript("window.Termbridge?.focus()")
  }

  func copySelection() {
    webView?.evaluateJavaScript("window.Termbridge?.copySelection()")
  }

  func paste(_ text: String) {
    guard let json = try? JSONSerialization.data(withJSONObject: [text]),
      var value = String(data: json, encoding: .utf8)
    else { return }
    value.removeFirst()
    value.removeLast()
    webView?.evaluateJavaScript("window.Termbridge?.paste(\(value))")
  }

  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.name == "termbridge", let body = message.body as? [String: Any],
      let type = body["type"] as? String
    else { return }
    switch type {
    case "inputMode":
      bracketedPasteMode = body["bracketedPaste"] as? Bool ?? false
    case "ready":
      let cols = body["cols"] as? Int ?? 80
      let rows = body["rows"] as? Int ?? 24
      isReady = true
      onReady?(cols, rows)
      flush()
    case "data":
      if let data = body["data"] as? String { onTextInput?(data) }
    case "binary":
      if let encoded = body["data"] as? String, let data = Data(base64Encoded: encoded) {
        onBinaryInput?(data)
      }
    case "resize":
      onResize?(body["cols"] as? Int ?? 80, body["rows"] as? Int ?? 24)
    case "title":
      if let title = body["title"] as? String { onTitle?(title) }
    case "copy":
      if let text = body["text"] as? String, !text.isEmpty {
        UIPasteboard.general.string = text
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
      }
    case "bell":
      UINotificationFeedbackGenerator().notificationOccurred(.warning)
    case "transcriptResync":
      let revision = body["revision"] as? Int
      onTranscriptResync?(revision.flatMap { $0 >= 0 ? $0 : nil })
    case "openLink":
      if let value = body["url"] as? String, let url = safeExternalURL(value) {
        UIApplication.shared.open(url)
      }
    default:
      break
    }
  }

  func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async
    -> WKNavigationActionPolicy
  {
    guard let url = navigationAction.request.url else { return .cancel }
    if url.isFileURL || url.absoluteString == "about:blank" { return .allow }
    if let externalURL = safeExternalURL(url.absoluteString) {
      await UIApplication.shared.open(externalURL)
    }
    return .cancel
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }

  @objc private func handleTerminalPan(_ recognizer: UIPanGestureRecognizer) {
    guard let webView else { return }
    let translationY = recognizer.translation(in: webView).y
    switch recognizer.state {
    case .began:
      previousPanTranslationY = translationY
      let location = recognizer.location(in: webView)
      webView.evaluateJavaScript(
        "window.Termbridge?.beginScroll(\(Int(location.x)), \(Int(location.y)))")
    case .changed:
      let deltaY = Int((previousPanTranslationY - translationY).rounded())
      previousPanTranslationY = translationY
      guard deltaY != 0 else { return }
      let location = recognizer.location(in: webView)
      webView.evaluateJavaScript(
        "window.Termbridge?.scrollByPixels(\(deltaY), \(Int(location.x)), \(Int(location.y)))")
    case .ended:
      let velocityY = Int((-recognizer.velocity(in: webView).y).rounded())
      webView.evaluateJavaScript("window.Termbridge?.endScroll(\(velocityY))")
      previousPanTranslationY = 0
    case .cancelled, .failed:
      webView.evaluateJavaScript("window.Termbridge?.cancelScroll()")
      previousPanTranslationY = 0
    default:
      break
    }
  }

  private func flush() {
    flushScheduled = false
    guard isReady, !pendingOutput.isEmpty, let webView else { return }
    let data = pendingOutput
    pendingOutput.removeAll(keepingCapacity: true)
    var offset = 0
    while offset < data.count {
      let end = min(offset + 24 * 1024, data.count)
      let chunk = data.subdata(in: offset..<end).base64EncodedString()
      webView.evaluateJavaScript("window.Termbridge?.writeBase64('\(chunk)')")
      offset = end
    }
  }

  private func safeExternalURL(_ value: String) -> URL? {
    guard value.count <= 4_096, let url = URL(string: value),
      let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
      url.host?.isEmpty == false, url.user == nil, url.password == nil
    else { return nil }
    return url
  }
}

struct TerminalWebView: UIViewRepresentable {
  let controller: TerminalController

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.defaultWebpagePreferences.allowsContentJavaScript = true
    let contentController = WKUserContentController()
    contentController.addUserScript(
      WKUserScript(
        source: Self.nativeBridge,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
      ))
    contentController.add(controller, name: "termbridge")
    configuration.userContentController = contentController

    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = controller
    webView.isOpaque = false
    webView.backgroundColor = UIColor(red: 0.051, green: 0.063, blue: 0.055, alpha: 1)
    webView.scrollView.backgroundColor = webView.backgroundColor
    webView.scrollView.contentInsetAdjustmentBehavior = .never
    webView.scrollView.bounces = false
    webView.scrollView.isScrollEnabled = false
    webView.allowsLinkPreview = false
    controller.attach(webView)
    if let url = Bundle.main.url(forResource: "terminal", withExtension: "html") {
      webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }
    return webView
  }

  func updateUIView(_ uiView: WKWebView, context: Context) {}

  static func dismantleUIView(_ uiView: WKWebView, coordinator: Void) {
    (uiView.navigationDelegate as? TerminalController)?.detach()
    uiView.configuration.userContentController.removeScriptMessageHandler(forName: "termbridge")
    uiView.stopLoading()
    uiView.loadHTMLString("", baseURL: nil)
  }

  private static let nativeBridge = #"""
    window.TermbridgeNative = {
      onInputMode: (bracketedPaste) => window.webkit.messageHandlers.termbridge.postMessage({type: 'inputMode', bracketedPaste}),
      onReady: (cols, rows) => window.webkit.messageHandlers.termbridge.postMessage({type: 'ready', cols, rows}),
      onData: (data) => window.webkit.messageHandlers.termbridge.postMessage({type: 'data', data}),
      onBinary: (data) => window.webkit.messageHandlers.termbridge.postMessage({type: 'binary', data}),
      onResize: (cols, rows) => window.webkit.messageHandlers.termbridge.postMessage({type: 'resize', cols, rows}),
      onTitle: (title) => window.webkit.messageHandlers.termbridge.postMessage({type: 'title', title}),
      onCopy: (text) => window.webkit.messageHandlers.termbridge.postMessage({type: 'copy', text}),
      onBell: () => window.webkit.messageHandlers.termbridge.postMessage({type: 'bell'}),
      onTranscriptResync: (revision) => window.webkit.messageHandlers.termbridge.postMessage({type: 'transcriptResync', revision}),
      onOpenLink: (url) => window.webkit.messageHandlers.termbridge.postMessage({type: 'openLink', url})
    };
    """#
}
