import Foundation
import Combine

@MainActor
final class TerminalAttachments: ObservableObject {
    enum State: Equatable {
        case preparing, uploading, ready(String)
        /// Failed before anything was written: retrying is safe.
        case failed(String)
        /// Written, and the outcome was never learned.
        ///
        /// Distinct from `failed` on purpose: the bytes may well have reached
        /// the Host, so offering a retry would risk a second copy. It is kept,
        /// reported, and removed only by the user.
        case unknown(String)
        var label: String {
            switch self {
            case .preparing: return "处理中"
            case .uploading: return "上传中"
            case .ready: return "就绪"
            case .failed(let message): return message
            case .unknown(let message): return message
            }
        }
        /// What fits under a 40pt thumbnail.
        ///
        /// `label` is the whole sentence and is truncated to "上传…" at this
        /// width, which made a refusal and an unresolved upload look identical
        /// — the only difference left was the colour. The full text stays on
        /// the tooltip and the accessibility label.
        var badge: String {
            switch self {
            case .preparing: return "处理中"
            case .uploading: return "上传中"
            case .ready: return ""
            case .failed: return "失败"
            case .unknown: return "未确认"
            }
        }
        /// Only a failure that never reached the Host may be retried.
        var isRetryable: Bool { if case .failed = self { return true } else { return false } }
    }
    struct Item: Identifiable {
        let id: UUID
        let source: TerminalImageSource
        var image: TerminalImage?
        var state: State = .preparing
    }
    @Published private(set) var items: [Item] = [] { didSet { onChange?() } }
    @Published private(set) var error: String? { didSet { onChange?() } }
    @Published var draft = "" { didSet { onChange?() } }
    /// A terminal submission waits locally; no Enter reaches the Agent early.
    @Published private(set) var pendingSubmission: Data? { didSet { onChange?() } }
    var canQueueSubmission: Bool {
        isConnected() && (!items.isEmpty || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) && items.allSatisfy {
            switch $0.state { case .preparing, .uploading, .ready: return true; default: return false }
        }
    }
    func queueSubmission(_ sequence: Data) {
        guard pendingSubmission == nil else { return }
        guard canQueueSubmission else { reportBlockedInsertion(); return }
        error = nil
        pendingSubmission = sequence
    }
    func cancelSubmission() { pendingSubmission = nil }
    var onChange: (() -> Void)?
    /// Whether this conversation takes images at all. Adding is gated on this.
    var isConnected: () -> Bool = { false }

    /// Whether an upload may actually leave right now.
    ///
    /// Separate from `isConnected` on purpose: a picture chosen while the
    /// subscription is still coming up belongs in the draft, and waits. Gating
    /// the choice itself on the connection is how a picked image gets thrown
    /// away for a socket that is merely reconnecting.
    var canUpload: () -> Bool = { true }
    var upload: ((UUID, TerminalImage) -> Bool)?
    private let sessionID: String
    private let remote: Bool
    private let localRoot: URL
    private let timeout: TimeInterval
    private var tasks: [UUID: Task<Void, Never>] = [:]
    private var deadlines: [UUID: Task<Void, Never>] = [:]
    private var expired: Set<UUID> = []

    init(sessionID: String, remote: Bool, localRoot: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/TermBridge/Attachments"), timeout: TimeInterval = 45) {
        self.sessionID = sessionID; self.remote = remote; self.localRoot = localRoot; self.timeout = timeout
    }
    deinit { tasks.values.forEach { $0.cancel() }; deadlines.values.forEach { $0.cancel() } }

    var references: String? {
        guard !items.isEmpty else { return nil }
        var paths: [String] = []
        for item in items {
            guard case .ready(let path) = item.state else { return nil }
            let kind = item.image?.mime == "application/octet-stream" ? "File" : "Image"
            paths.append("[\(kind): \(path)]")
        }
        return " " + paths.joined(separator: " ") + " "
    }

    func add(_ sources: [TerminalImageSource]) {
        guard isConnected() else { error = "这个会话现在不能添加图片。"; return }
        cancelSubmission()
        error = sources.count + items.count > 6 ? "每次最多添加 6 张图片。" : nil
        for source in sources.prefix(max(0, 6 - items.count)) {
            let item = Item(id: UUID(), source: source)
            items.append(item)
            prepare(item)
        }
    }
    func retry(_ id: UUID) {
        guard isConnected(), let index = items.firstIndex(where: { $0.id == id }), items[index].state.isRetryable else {
            error = items.first(where: { $0.id == id })?.state.isRetryable == false
                ? "这张图片的结果未知，请确认后再决定是否重新添加。"
                : "请先连接。"
            return
        }
        // New request identity prevents a late acknowledgement from completing a retry.
        let original = items[index]
        remove(id)
        let source = original.image.flatMap { $0.mime.hasPrefix("image/") ? TerminalImageSource.clipboard($0.data) : nil }
        let item = Item(id: UUID(), source: source ?? original.source)
        items.insert(item, at: index); error = nil; prepare(item)
    }
    func remove(_ id: UUID) {
        cancelSubmission()
        tasks.removeValue(forKey: id)?.cancel(); deadlines.removeValue(forKey: id)?.cancel()
        expired.remove(id)
        items.removeAll { $0.id == id }
    }
    func clear() { cancelSubmission(); draft = ""; items.map(\.id).forEach(remove); error = nil }
    func reportBlockedInsertion() {
        error = isConnected() ? "图片尚未就绪或发送未成功，请检查附件状态后再按回车。" : "连接已断开，图片已保留；重连后再发送。"
    }

    /// The subscription that authorized these uploads is gone.
    ///
    /// An upload already written has an unknown outcome: the bytes may be on the
    /// Host, so it is neither retried nor discarded. One that was still being
    /// encoded has not been sent at all, so it simply waits — the picture stays
    /// in the draft and goes out on the next grant rather than being thrown away
    /// and asked for again.
    func connectionLost() {
        cancelSubmission()
        objectWillChange.send()
        for item in items where item.state == .uploading {
            deadlines.removeValue(forKey: item.id)?.cancel()
            update(item.id, state: .unknown("连接已断开，结果未知；请确认后再决定"))
        }
    }

    /// A result arrived for a subscription this view no longer holds.
    ///
    /// Terminal for that upload: the Host has stopped associating it with this
    /// view, so no later acknowledgement — however well formed — may complete it.
    func expire(_ id: UUID) {
        deadlines.removeValue(forKey: id)?.cancel()
        expired.insert(id)
        guard let index = items.firstIndex(where: { $0.id == id }),
              items[index].state == .uploading || isUnknown(items[index].state) else { return }
        update(id, state: .unknown("这次上传的结果属于已结束的订阅，未能确认"))
    }

    /// A fresh grant: send what is encoded and has never been written.
    ///
    /// Only items that were never sent. Anything already written stays unknown;
    /// re-sending it across a generation is how one image becomes two.
    func uploadsAllowed() {
        guard canUpload() else { return }
        for item in items where item.state == .preparing {
            guard let image = item.image else { continue }
            update(item.id, state: .uploading)
            guard upload?(item.id, image) == true else {
                update(item.id, state: .failed("无法上传，请重试")); continue
            }
            startDeadline(item.id)
        }
    }

    func receive(_ message: ControlMessage) {
        guard message.type == "session_upload_result", message.string("sessionId") == sessionID,
              let rawID = message.string("id"), let id = UUID(uuidString: rawID),
              let index = items.firstIndex(where: { $0.id == id }) else { return }
        // An unresolved upload may still be settled by a valid acknowledgement
        // that arrives late on the same subscription; one from a subscription
        // this view has left never reaches here.
        guard !expired.contains(id) else { return }
        let state = items[index].state
        guard state == .uploading || isUnknown(state) else { return }
        deadlines.removeValue(forKey: id)?.cancel()
        if let error = message.string("error") {
            // The Host refused it outright: nothing was stored, so trying again
            // cannot duplicate anything.
            update(id, state: .failed(error.isEmpty ? "上传失败，请重试" : "上传失败，请重试"))
            return
        }
        guard let path = message.string("path"), Self.validPath(path) else {
            // Accepted without a usable path. The bytes were written, so this is
            // not a clean failure the user can safely repeat.
            update(id, state: .unknown("上传结果无法确认，请确认后再决定"))
            return
        }
        update(id, state: .ready(path))
    }

    private func isUnknown(_ state: State) -> Bool { if case .unknown = state { return true } else { return false } }

    static func validPath(_ path: String) -> Bool {
        // References may also be pasted into a shell: reject executable syntax, not just TTY controls.
        path.hasPrefix("/") && path.utf8.count <= 4096 && path.rangeOfCharacter(from: CharacterSet(charactersIn: "[]\"'`$\\;|&<>(){}!*?")) == nil
            && path.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }

    private func prepare(_ item: Item) {
        let root = localRoot, remote = remote
        tasks[item.id] = Task { [weak self] in
            let work = Task.detached { () throws -> (TerminalImage, String?) in
                let image = try TerminalImage.encode(item.source)
                return (image, remote ? nil : try image.saveLocal(root: root))
            }
            do {
                let (image, path) = try await work.value
                guard !Task.isCancelled, let self, let index = self.items.firstIndex(where: { $0.id == item.id }) else { return }
                self.tasks.removeValue(forKey: item.id)
                self.items[index].image = image
                if let path {
                    self.update(item.id, state: Self.validPath(path) ? .ready(path) : .failed("图片路径包含不支持的字符"))
                    return
                }
                // Encoded but not yet authorized: it waits as `preparing` and
                // goes out on the next grant, rather than failing for a
                // connection that is simply not up yet.
                guard self.canUpload() else { return }
                self.update(item.id, state: .uploading)
                guard self.upload?(item.id, image) == true else { self.update(item.id, state: .failed("无法上传，请重试")); return }
                guard self.items.contains(where: { $0.id == item.id && $0.state == .uploading }) else { return }
                self.startDeadline(item.id)
            } catch {
                guard !Task.isCancelled else { return }
                self?.tasks.removeValue(forKey: item.id)
                self?.update(item.id, state: .failed((error as? TerminalImage.Failure)?.localizedDescription ?? "图片处理失败，请重试"))
            }
        }
    }
    private func startDeadline(_ id: UUID) {
        deadlines[id] = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: UInt64((self?.timeout ?? 45) * 1_000_000_000)) }
            catch { return }
            // The frame went out and nothing came back. That is unknown, not
            // failed: a retry might upload it twice.
            self?.update(id, state: .unknown("上传结果未知，请确认后再决定"))
            self?.deadlines.removeValue(forKey: id)
        }
    }

    private func update(_ id: UUID, state: State) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        switch state { case .failed, .unknown: cancelSubmission(); default: break }
        items[index].state = state
    }
}
