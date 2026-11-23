import SwiftUI
import UIKit
import WebKit

final class AgentChatWebController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  var onReady: (() -> Void)?
  var onEarlier: ((Int, Int) -> Void)?
  var onFailure: ((String) -> Void)?
  var onReset: (() -> Void)?
  private weak var webView: WKWebView?
  private var ready = false

  func attach(_ webView: WKWebView) { self.webView = webView; ready = false }
  func detach() { webView = nil; ready = false; onReset?() }
  func receive(_ fields: [String: Any]) {
    guard ready, JSONSerialization.isValidJSONObject(fields),
      let data = try? JSONSerialization.data(withJSONObject: fields),
      let json = String(data: data, encoding: .utf8) else { return }
    webView?.evaluateJavaScript("window.termbridgeChat?.receive(\(json))")
  }
  func userContentController(_ userContentController: WKUserContentController,
    didReceive message: WKScriptMessage) {
    guard message.name == "agentChat", message.frameInfo.isMainFrame,
      let body = message.body as? [String: Any] else { return }
    switch body["op"] as? String {
    case "ready": ready = true; onReady?()
    case "earlier":
      if let generation = body["generation"] as? Int, let cursor = body["cursor"] as? Int,
        generation >= 0, cursor >= 0 { onEarlier?(generation, cursor) }
    case "copy":
      if let value = body["data"] as? String, value.utf8.count <= 1_000_000 {
        UIPasteboard.general.string = value
      }
    case "open":
      if let raw = body["url"] as? String, let url = URL(string: raw),
        ["https", "http"].contains(url.scheme?.lowercased() ?? "") { UIApplication.shared.open(url) }
    default: break
    }
  }
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    // Only the bundled main page may navigate. Transcript links go through the
    // explicit bridge and can only open HTTP(S) in the system browser.
    if action.navigationType == .other, action.request.url?.isFileURL == true {
      decisionHandler(.allow)
    } else { decisionHandler(.cancel) }
  }
  func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
    // A reload republishes the bridge, so the page that acknowledged ready is
    // gone. Everything queued for it is dropped rather than replayed blind.
    guard ready else { return }
    ready = false
    onReset?()
  }
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    ready = false
    onReset?()
    webView.reload()
  }
  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    onFailure?("对话页面加载失败，请重新打开会话")
  }
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    onFailure?("对话页面加载失败，请重新打开会话")
  }
}

struct AgentChatWebView: UIViewRepresentable {
  let controller: AgentChatWebController
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.userContentController.add(controller, name: "agentChat")
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.isOpaque = false
    view.backgroundColor = .systemBackground
    view.scrollView.backgroundColor = .systemBackground
    view.scrollView.keyboardDismissMode = .interactive
    view.navigationDelegate = controller
    controller.attach(view)
    if let url = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "AgentChat") {
      view.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    } else { controller.onFailure?("安装包缺少对话资源，请更新 App") }
    return view
  }
  func updateUIView(_ uiView: WKWebView, context: Context) {}
  static func dismantleUIView(_ uiView: WKWebView, coordinator: Void) {
    (uiView.navigationDelegate as? AgentChatWebController)?.detach()
    uiView.configuration.userContentController.removeScriptMessageHandler(forName: "agentChat")
    uiView.navigationDelegate = nil
    uiView.stopLoading()
  }
}

extension MessagePackValue {
  fileprivate var agentChatJSON: Any {
    switch self {
    case .null: return NSNull()
    case .bool(let value): return value
    case .int(let value): return value
    case .uint(let value): return value
    case .double(let value): return value.isFinite ? value as Any : NSNull()
    case .string(let value): return value
    case .array(let value): return value.map(\.agentChatJSON)
    case .map(let value): return value.mapValues(\.agentChatJSON)
    case .binary: return NSNull()
    }
  }
}

func agentChatSurfaceMessage(_ message: ControlMessage, op: String) -> [String: Any] {
  let keys = ["generation", "status", "capabilities", "messages", "earlierCursor", "cursor", "atHead", "error"]
  var result: [String: Any] = ["op": op]
  for key in keys { if let value = message.fields[key] { result[key] = value.agentChatJSON } }
  return result
}
