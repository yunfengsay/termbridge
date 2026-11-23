import Combine
import Foundation
import UIKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

final class TerminalViewModel: ObservableObject {
  @Published private(set) var status = "Waiting for terminal"
  @Published private(set) var showsStatus = true
  @Published private(set) var title: String
  @Published var controlLatched = false
  @Published var altLatched = false
  @Published var draft = ""
  @Published private(set) var attachmentQueue = ComposerAttachmentQueue()
  @Published var attachmentError: String?
  private var attachmentTasks: [UUID: Task<Void, Never>] = [:]
  private var uploadTimeout: DispatchWorkItem?
  /// The composer's gate must be published state; `sid` alone would leave the
  /// send button stale until some other change happened to redraw the view.
  @Published private(set) var isAttached = false
  /// The Host answers `review_probe` only when this Session's cwd is inside a Git
  /// repository, so the entry point never offers a review that cannot open.
  @Published private(set) var reviewAvailable = false

  let terminal = TerminalController()

  private let pinnedSettings: ConnectionSettings
  private var client: TermbridgeClient?
  private var sid: Int?
  private var sessionID: String?
  private let agent: String
  private let source: String
  private var cols = 80
  private var rows = 24
  private var started = false
  private var terminalReady = false
  private var fatal = false
  private var generation = 0
  private var reconnectWork: DispatchWorkItem?
  private var hideStatusWork: DispatchWorkItem?
  private var reviewProbeRequestID: String?
  private var reviewMode: String?

  init(route: TerminalRoute, settings: ConnectionSettings = SettingsStore.load()) {
    pinnedSettings = settings
    sessionID = route.sessionID
    agent = route.agent
    source = route.source
    title = route.displayName
    terminal.onReady = { [weak self] cols, rows in
      self?.terminalDidBecomeReady(cols: cols, rows: rows)
    }
    terminal.onTextInput = { [weak self] text in self?.sendText(text) }
    terminal.onBinaryInput = { [weak self] data in self?.sendInput(data) }
    terminal.onResize = { [weak self] cols, rows in self?.terminalDidResize(cols: cols, rows: rows)
    }
    terminal.onTitle = { [weak self] title in
      guard !title.isEmpty else { return }
      self?.title = String(title.prefix(80))
    }
    terminal.onTranscriptResync = { [weak self] revision in self?.requestTranscriptResync(revision) }
  }

  var subtitle: String { sessionID ?? "Connecting" }

  var canSubmitComposer: Bool {
    isAttached && attachmentQueue.allReady
      && !ComposerPayload.build(draft: draft, references: attachmentQueue.references).isEmpty
  }

  var reviewRoute: ReviewRoute? {
    guard let sessionID, reviewAvailable else { return nil }
    return ReviewRoute.open(sessionID: sessionID, displayName: title, mode: reviewMode)
  }

  func start() {
    guard !started else { return }
    started = true
    if terminalReady { connectNow() }
  }

  func stop() {
    started = false
    interruptUploads()
    generation += 1
    reconnectWork?.cancel()
    hideStatusWork?.cancel()
    client?.disconnect()
    client = nil
    sid = nil
    isAttached = false
  }

  func reconnect() {
    fatal = false
    connectNow()
  }

  func focusTerminal() { terminal.focus() }
  func copySelection() { terminal.copySelection() }
  func pasteClipboard() {
    if UIPasteboard.general.hasImages,
      let type = UIPasteboard.general.types.first(where: { UTType($0)?.conforms(to: .image) == true }),
      let data = UIPasteboard.general.data(forPasteboardType: type) {
      guard data.count <= 64 * 1024 * 1024 else {
        attachmentError = "剪贴板图片太大，请通过照片或文件添加"
        return
      }
      prepareAttachment(name: "粘贴的图片") { try await TerminalAttachmentReader.shared.imageData(data) }
    } else if let text = UIPasteboard.general.string, !text.isEmpty { terminal.paste(text) }
    clearModifiers()
  }

  func toggleControl() {
    controlLatched.toggle()
    terminal.focus()
  }
  func toggleAlt() {
    altLatched.toggle()
    terminal.focus()
  }

  func sendEscape() { sendSequence(Data([0x1b])) }
  func sendTab() { sendSequence(Data([0x09])) }
  func sendHome() { sendSequence(Data("\u{1b}[H".utf8)) }
  func sendEnd() { sendSequence(Data("\u{1b}[F".utf8)) }
  func sendUp() { sendSequence(Data("\u{1b}[A".utf8)) }
  func sendDown() { sendSequence(Data("\u{1b}[B".utf8)) }
  func sendLeft() { sendSequence(Data("\u{1b}[D".utf8)) }
  func sendRight() { sendSequence(Data("\u{1b}[C".utf8)) }

  private func terminalDidBecomeReady(cols: Int, rows: Int) {
    terminalReady = true
    self.cols = cols
    self.rows = rows
    if started { connectNow() }
  }

  private func terminalDidResize(cols: Int, rows: Int) {
    self.cols = cols
    self.rows = rows
    if let sid { client?.sendResize(sid: sid, cols: cols, rows: rows) }
  }

  private func connectNow() {
    interruptUploads()
    reconnectWork?.cancel()
    reconnectWork = nil
    client?.disconnect()
    client = nil
    sid = nil
    isAttached = false
    reviewAvailable = false
    reviewProbeRequestID = nil
    let settings = pinnedSettings
    if let error = settings.validationError {
      fatal = true
      showStatus(error, persistent: true)
      return
    }
    generation += 1
    let expectedGeneration = generation
    let begin = { [weak self] in
      guard let self, self.started, self.generation == expectedGeneration else { return }
      let next = TermbridgeClient(settings: settings, listener: self)
      self.client = next
      next.connect()
    }
    if sessionID != nil { terminal.reset(completion: begin) } else { begin() }
  }

  private func sendText(_ text: String) {
    sendInput(modified(text))
    clearModifiers()
  }

  /// Control only folds a single character; a composed line keeps its bytes.
  private func modified(_ text: String) -> Data {
    var data = Data(text.utf8)
    if controlLatched, text.unicodeScalars.count == 1, let scalar = text.unicodeScalars.first {
      let value = scalar.value
      if value >= 0x40 && value <= 0x5f {
        data = Data([UInt8(value - 0x40)])
      } else if value >= 0x60 && value <= 0x7f {
        data = Data([UInt8(value - 0x60)])
      } else if value == 0x20 {
        data = Data([0])
      } else if value == 0x3f {
        data = Data([0x7f])
      }
    }
    if altLatched { data.insert(0x1b, at: 0) }
    return data
  }

  /// The composer sends the line as PTY bytes plus Return, then records the same
  /// semantic `session_message` Android sends so Global knows which Agent was
  /// addressed instead of trying to reconstruct it from keystrokes.
  func submitComposer() {
    guard canSubmitComposer, let sid else { return }
    let message = ComposerPayload.build(draft: draft, references: attachmentQueue.references)
    let payload = ComposerPayload.submitBytes(modified(message),
      bracketedPaste: terminal.bracketedPasteMode && !controlLatched && !altLatched)
    guard client?.sendPTYInput(sid: sid, data: payload) == true else {
      showStatus("Terminal is not ready", persistent: false)
      return
    }
    clearModifiers()
    if let sessionID {
      client?.sendControl([
        "t": .string("session_message"),
        "sessionId": .string(sessionID),
        "text": .string(String(message.prefix(16_000))),
        "clientPlatform": .string("ios"),
      ])
    }
    draft = ""
    attachmentQueue.clear()
  }

  deinit {
    attachmentTasks.values.forEach { $0.cancel() }
    uploadTimeout?.cancel()
  }

  func addFiles(_ urls: [URL]) {
    for url in urls {
      prepareAttachment(name: url.lastPathComponent) {
        try await TerminalAttachmentReader.shared.read(url)
      }
    }
  }

  func addPhotos(_ photos: [PhotosPickerItem]) {
    for photo in photos {
      prepareAttachment(name: "照片") {
        guard let transfer = try await photo.loadTransferable(type: TerminalPhotoTransfer.self) else {
          throw AttachmentPreparation.Failure.image
        }
        return transfer.attachment
      }
    }
  }

  private func prepareAttachment(name: String, work: @escaping () async throws -> PreparedAttachment) {
    guard let id = attachmentQueue.add(name: name) else {
      attachmentError = "每条消息最多添加 6 个附件"
      return
    }
    attachmentTasks[id] = Task { @MainActor [weak self] in
      let result: Result<PreparedAttachment, Error>
      do { result = .success(try await work()) }
      catch { result = .failure(error) }
      guard !Task.isCancelled, let self else { return }
      self.attachmentTasks.removeValue(forKey: id)
      self.attachmentQueue.prepared(id, result: result)
      self.flushAttachments()
    }
  }

  func removeAttachment(_ id: UUID) {
    attachmentTasks.removeValue(forKey: id)?.cancel()
    if let item = attachmentQueue.items.first(where: { $0.id == id }),
      case .uploading = item.state {
      uploadTimeout?.cancel()
      uploadTimeout = nil
    }
    attachmentQueue.remove(id)
    flushAttachments()
  }

  func retryAttachment(_ id: UUID) {
    attachmentQueue.retry(id)
    flushAttachments()
  }

  private func interruptUploads() {
    uploadTimeout?.cancel()
    uploadTimeout = nil
    attachmentQueue.interrupt()
  }

  private func flushAttachments() {
    guard started, isAttached, let sessionID, let client,
      let item = attachmentQueue.next(session: sessionID), let prepared = item.prepared,
      case .uploading(let request, _) = item.state else { return }
    guard client.sendControl([
      "t": .string("session_upload"), "id": .string(request),
      "sessionId": .string(sessionID), "mime": .string(prepared.mime),
      "fileName": .string(prepared.name), "data": .binary(prepared.data),
    ]) else {
      attachmentQueue.finish(request: request, session: sessionID, path: nil, error: "连接未就绪，请重试")
      return
    }
    let work = DispatchWorkItem { [weak self, weak client] in
      guard let self, self.client === client else { return }
      self.attachmentQueue.finish(request: request, session: sessionID, path: nil,
        error: "上传超时，结果未确认；可重新上传")
      self.uploadTimeout = nil
      self.flushAttachments()
    }
    uploadTimeout = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 45, execute: work)
  }

  private func handleUploadResult(_ message: ControlMessage) {
    guard message.string("sessionId") == sessionID,
      let sessionID, let request = message.string("id"),
      attachmentQueue.finish(request: request, session: sessionID,
        path: message.string("path"), error: message.string("error")) else { return }
    uploadTimeout?.cancel()
    uploadTimeout = nil
    flushAttachments()
  }

  private func sendSequence(_ sequence: Data) {
    var data = sequence
    if altLatched, data.first != 0x1b { data.insert(0x1b, at: 0) }
    sendInput(data)
    clearModifiers()
    terminal.focus()
  }

  private func sendInput(_ data: Data) {
    guard let sid else { return }
    client?.sendPTYInput(sid: sid, data: data)
  }

  private func requestReviewProbe() {
    guard let sessionID else { return }
    let requestID = UUID().uuidString.lowercased()
    reviewProbeRequestID = requestID
    reviewAvailable = false
    client?.sendControl([
      "t": .string("review_probe"),
      "requestId": .string(requestID),
      "sessionId": .string(sessionID),
    ])
  }

  private func handleReviewProbe(_ message: ControlMessage) {
    guard message.string("requestId") == reviewProbeRequestID,
      message.string("sessionId") == sessionID else { return }
    reviewProbeRequestID = nil
    reviewAvailable = message.bool("available") == true
    reviewMode = message.string("mode")
  }

  private func requestTranscriptResync(_ revision: Int?) {
    guard let sid else { return }
    var fields: [String: MessagePackValue] = [
      "t": .string("terminal_mobile_resync"),
      "sid": .int(Int64(sid)),
    ]
    if let revision { fields["revision"] = .int(Int64(revision)) }
    client?.sendControl(fields)
  }

  private func clearModifiers() {
    controlLatched = false
    altLatched = false
  }

  private func onTransientDisconnect(_ message: String) {
    interruptUploads()
    sid = nil
    isAttached = false
    showStatus(message, persistent: true)
    guard started, !fatal else { return }
    let work = DispatchWorkItem { [weak self] in self?.connectNow() }
    reconnectWork?.cancel()
    reconnectWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
  }

  private func shouldRetry(_ message: String) -> Bool {
    let fatalWords = [
      "password", "fingerprint", "authentication", "host not found", "multiple hosts", "invalid",
    ]
    return !fatalWords.contains { message.localizedCaseInsensitiveContains($0) }
  }

  private func showStatus(_ message: String, persistent: Bool) {
    status = message
    showsStatus = true
    hideStatusWork?.cancel()
    guard !persistent else { return }
    let work = DispatchWorkItem { [weak self] in self?.showsStatus = false }
    hideStatusWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
  }

  private func rejectToolRequest(_ message: ControlMessage) {
    guard let id = message.string("id") else { return }
    client?.sendControl([
      "t": .string("tool_response"),
      "id": .string(id),
      "ok": .bool(false),
      "error": .string("The iOS viewer does not expose peer tools"),
    ])
  }
}

extension TerminalViewModel: TermbridgeClientListener {
  func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
    guard self.client === client else { return }
    switch state {
    case .connecting: showStatus("Connecting", persistent: true)
    case .authenticating: showStatus("Authenticating", persistent: true)
    case .connected: showStatus("Waiting for host", persistent: true)
    case .disconnected: onTransientDisconnect("Disconnected")
    case .failed(let message):
      fatal = !shouldRetry(message)
      onTransientDisconnect(message)
    }
  }

  func clientIsReady(_ client: TermbridgeClient) {
    guard self.client === client else { return }
    if let sessionID {
      var fields: [String: MessagePackValue] = [
        "t": .string("attach"),
        "sessionId": .string(sessionID),
        "cols": .int(Int64(cols)),
        "rows": .int(Int64(rows)),
      ]
      if source == "herdr" {
        fields["presentation"] = .string("mobile")
        fields["mobilePatches"] = .bool(true)
      }
      client.sendControl(fields)
    } else {
      client.sendControl([
        "t": .string("session_create"),
        "agent": .string(agent),
        "cols": .int(Int64(cols)),
        "rows": .int(Int64(rows)),
        "clientPlatform": .string("ios"),
        "clientName": .string(UIDevice.current.name),
      ])
    }
  }

  func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
    guard self.client === client else { return }
    switch message.type {
    case "session_created", "attach_ok":
      guard let attachedID = message.string("sessionId"), let attachedSID = message.int("sid")
      else { return }
      sessionID = attachedID
      sid = attachedSID
      isAttached = true
      showStatus("Attached", persistent: false)
      terminal.focus()
      requestReviewProbe()
      flushAttachments()
    case "session_upload_result":
      handleUploadResult(message)
    case "session_exit":
      interruptUploads()
      sid = nil
      isAttached = false
      fatal = true
      showStatus("Exited (\(message.int("exitCode") ?? 0))", persistent: true)
    case "review_probe_result":
      handleReviewProbe(message)
    case "terminal_mobile_snapshot":
      guard message.int("sid") == sid, let revision = message.int("revision"),
        let payload = message.data("payload") else { return }
      terminal.applyMobileSnapshot(revision: revision, payload: payload)
    case "terminal_mobile_patch":
      guard message.int("sid") == sid, let baseRevision = message.int("baseRevision"),
        let revision = message.int("revision"), let payload = message.data("payload") else { return }
      terminal.applyMobilePatch(baseRevision: baseRevision, revision: revision, payload: payload)
    case "error":
      let detail = message.string("message") ?? "Host rejected the request"
      fatal =
        detail.localizedCaseInsensitiveContains("no session")
        || detail.localizedCaseInsensitiveContains("unknown agent")
      showStatus(detail, persistent: true)
      if fatal { client.disconnect() }
    case "tool_request":
      rejectToolRequest(message)
    default:
      break
    }
  }

  func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {
    guard self.client === client, self.sid == sid else { return }
    terminal.write(data)
  }
}
