import Combine
import Foundation

/// The viewer's transport. The app always uses the packaged client; the seam
/// exists so the subscription state machine can be driven without a relay.
protocol AgentChatTransport: AnyObject {
    func connect()
    func disconnect()
    @discardableResult func sendControl(_ fields: [String: MessagePackValue]) -> Bool
}

extension TermbridgeClient: AgentChatTransport {}

/// A conversation viewer owns one connection and subscription, never a terminal.
@MainActor
final class MacAgentChatSession: ObservableObject, @preconcurrency TermbridgeClientListener {
    @Published private(set) var status = "正在连接…"
    @Published private(set) var unavailable: String?
    @Published private(set) var connected = false
    @Published private(set) var capabilities = AgentChatCapabilities(map: nil)
    @Published var composer: AgentChatComposerState {
        didSet { Self.composers[cacheKey] = composer }
    }
    let conversationID: String
    /// Replacing the target clears the previous rejection: a new notification is
    /// a new claim about identity and gets validated on its own.
    var notificationRoute: MacNotificationRoute? {
        didSet { if notificationRoute != oldValue { routeRejection = nil } }
    }
    /// Set once this exact notification target failed identity validation. The
    /// window keeps it across view switches so no mode attaches the stale target.
    private(set) var routeRejection: String?
    var routeRejected: Bool { routeRejection != nil }
    var onUnavailable: ((String) -> Void)?
    var onSurface: (([String: Any]) -> Void)?

    private static var composers: [String: AgentChatComposerState] = [:]
    private let settings: ConnectionSettings
    private let cacheKey: String
    private var subscription: AgentChatSubscription
    private var client: AgentChatTransport?
    /// Replaced only by tests. The app never substitutes the transport.
    var makeTransport: (ConnectionSettings, TermbridgeClientListener) -> AgentChatTransport = {
        TermbridgeClient(settings: $0, listener: $1)
    }
    private var started = false
    private var surfaceIsReady = false
    private var listedAsSupported = false
    private var receivedSnapshot = false
    private var validatingNotification = false
    private var listRequestID: String?
    /// Held until unsubscribe or reconnect. A transcript rewind replays the
    /// snapshot under the same request and generation, so forgetting this ID
    /// would silently drop the replacement and keep removed messages on screen.
    private var subscribeRequestID: String?
    private var awaitingSnapshot = false
    private var earlierRequestID: String?
    private var connectionTimeout: Task<Void, Never>?
    private var receiptTimeout: Task<Void, Never>?
    private var earlierTimeout: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?

    init(sessionID: String, settings: ConnectionSettings, notificationRoute: MacNotificationRoute? = nil) {
        conversationID = sessionID
        self.settings = settings
        self.notificationRoute = notificationRoute
        cacheKey = [settings.relayURL.trimmingCharacters(in: .whitespacesAndNewlines),
                    settings.hostID.trimmingCharacters(in: .whitespacesAndNewlines), sessionID].joined(separator: "\0")
        subscription = AgentChatSubscription(conversationID: sessionID)
        composer = Self.composers[cacheKey] ?? AgentChatComposerState()
    }

    /// The plain-text case, kept for callers with no attachments.
    var canSend: Bool { canSend(payload: composer.draft) }

    var receiptLabel: String? {
        switch composer.state {
        case .accepted: return "正在发送…"
        case .delivered: return "已送达，等待 Agent 记录确认"
        case .observed: return "Agent 已收到"
        case .uncertain: return "结果未知，请在终端确认后再决定是否发送"
        case .failed: return "发送失败，可以重试"
        case nil: return nil
        }
    }

    func start() {
        guard !started else { return }
        started = true
        connect()
    }

    func stop() {
        started = false
        closeConnection(reason: "对话视图已关闭，无法继续确认；请检查终端")
    }

    func reconnect() {
        guard started else { return }
        closeConnection(reason: "连接已重建，无法继续确认此前发送；请检查终端")
        connect()
    }

    private func connect() {
        guard started, client == nil else { return }
        unavailable = nil
        status = "正在连接…"
        if let error = settings.validationError {
            setUnavailable(error)
            return
        }
        if let routeRejection {
            setUnavailable(routeRejection)
            return
        }
        if let route = notificationRoute, route.sessionID != conversationID {
            rejectRoute("通知目标与当前会话不一致，请从会话列表打开。")
            return
        }
        let next = makeTransport(settings, self)
        client = next
        armConnectionTimeout()
        next.connect()
    }

    private func closeConnection(reason: String) {
        connectionTimeout?.cancel(); connectionTimeout = nil
        receiptTimeout?.cancel(); receiptTimeout = nil
        earlierTimeout?.cancel(); earlierTimeout = nil
        reconnectTask?.cancel(); reconnectTask = nil
        composer.loseConfirmation(reason)
        let old = client
        client = nil
        if subscription.active {
            old?.sendControl(["t": .string(AgentChatProtocol.unsubscribe),
                              "conversationId": .string(conversationID)])
        }
        subscription.end()
        old?.disconnect()
        connected = false
        capabilities = AgentChatCapabilities(map: nil)
        listRequestID = nil; subscribeRequestID = nil; earlierRequestID = nil
        // Every in-flight upload loses its authorization with the subscription.
        uploadGenerations.removeAll()
        onConnectionLost?()
        listedAsSupported = false; receivedSnapshot = false; validatingNotification = false
        awaitingSnapshot = false
        if surfaceIsReady { onSurface?(["op": "clear"]) }
    }

    private func armConnectionTimeout() {
        connectionTimeout?.cancel()
        connectionTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard let self, self.started else { return }
            self.setUnavailable("Host 尚未提供对话视图，请检查连接或更新 Host 后重试")
        }
    }

    private func setUnavailable(_ reason: String) {
        guard started else { return }
        // A conversation that cannot be shown cannot take images either.
        acceptsAttachments = false
        closeConnection(reason: "对话已不可用，请检查终端中的发送结果")
        unavailable = reason
        status = "对话模式不可用"
        onUnavailable?(reason)
    }

    /// The notification target itself is wrong. This outlives the connection so a
    /// fallback view cannot reach the replacement session that reused the ID.
    private func rejectRoute(_ reason: String) {
        routeRejection = reason
        setUnavailable(reason)
    }

    private func connectionLost(_ reason: String, fatal: Bool = false) {
        guard started else { return }
        if fatal { setUnavailable(reason); return }
        closeConnection(reason: "连接中断，无法继续确认；请检查终端")
        status = "连接中断，正在重连…"
        reconnectTask = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
            self?.connect()
        }
    }

    private func subscribe() {
        guard started, connected, listedAsSupported, let client else { return }
        subscription.begin()
        receivedSnapshot = false
        earlierRequestID = nil; earlierTimeout?.cancel(); earlierTimeout = nil
        let requestID = UUID().uuidString
        subscribeRequestID = requestID
        awaitingSnapshot = true
        if surfaceIsReady { onSurface?(["op": "clear"]) }
        status = "正在读取对话…"
        armConnectionTimeout()
        if !client.sendControl(["t": .string(AgentChatProtocol.subscribe),
            "requestId": .string(requestID), "conversationId": .string(conversationID),
            "generation": .int(Int64(subscription.generation))]) {
            connectionLost("订阅未写入连接")
        }
    }

    /// No transcript is retained here. A late/reloaded page gets a fresh snapshot
    /// from the same Host connection rather than an ever-growing replay queue.
    func surfaceReady() {
        let reloaded = surfaceIsReady
        surfaceIsReady = true
        // The renderer follows the app's own appearance rather than a constant.
        onSurface?(["op": "theme", "theme": theme])
        guard started, connected, listedAsSupported, unavailable == nil else { return }
        if reloaded || receivedSnapshot || !subscription.active {
            if reloaded {
                composer.loseConfirmation("对话页面重新加载，请检查之前的发送结果")
                receiptTimeout?.cancel(); receiptTimeout = nil
            }
            subscribe()
        }
    }

    /// Uploads an image for this conversation over the chat connection.
    ///
    /// The Host authorizes it by this connection's live subscription — there is
    /// no terminal attached here and none is faked to get one. Refused before a
    /// snapshot has answered the current generation, because the Host has not
    /// bound the conversation yet and would reject it.
    @discardableResult
    func upload(id: UUID, image: TerminalImage) -> Bool {
        guard canAttach, let client else { return false }
        guard image.mime != "application/octet-stream" || supportsFileUploads else { return false }
        var fields: [String: MessagePackValue] = [
            "t": .string("session_upload"), "id": .string(id.uuidString),
            "sessionId": .string(conversationID), "mime": .string(image.mime),
            "data": .binary(image.data),
        ]
        if let name = image.fileName { fields["fileName"] = .string(name) }
        let sent = client.sendControl(fields)
        // Remembered against the subscription that authorized it. A reloaded
        // surface resubscribes on the same socket, so matching the client alone
        // would let a result issued under the previous generation complete an
        // image the Host has since stopped associating with this view.
        if sent { uploadGenerations[id] = subscription.generation }
        return sent
    }

    /// Whether an upload may be started right now, for the composer's controls.
    ///
    /// Gated on the Host's own `attachments` capability, not on `send`: a
    /// conversation can legitimately report that it takes text and not images,
    /// and offering a paperclip there would queue something nothing will accept.
    var canAttach: Bool {
        started && connected && subscription.active && receivedSnapshot
            && unavailable == nil && capabilities.attachments
    }

    /// Whether this conversation takes images at all, regardless of whether the
    /// connection is up this instant.
    ///
    /// Sticky across a reconnect on purpose. `capabilities` is reset while the
    /// socket is down, and a picture chosen in that window is still this
    /// conversation's picture — refusing it there means the user watches their
    /// image disappear because the connection happened to be reconnecting.
    /// Only the Host saying otherwise turns it off.
    private(set) var acceptsAttachments = false
    private(set) var supportsFileUploads = false

    /// The message this composer would send, draft plus any image references.
    func payload(appending references: String?) -> String {
        composer.draft + (references ?? "")
    }

    /// Whether that exact payload may be sent, rather than the draft alone.
    ///
    /// Asked of the text that will actually go out: an image-only message still
    /// has to respect the pending receipt and the length limit, which checking
    /// `canSend` on the bare draft quietly skipped.
    func canSend(payload text: String) -> Bool {
        started && connected && subscription.active && receivedSnapshot && surfaceIsReady
            && unavailable == nil && capabilities.send && !composer.pending
            && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && text.utf16.count <= 16_000
    }

    /// @return whether the message was written to the connection.
    ///
    /// A refusal before the write leaves the draft and the attachment queue
    /// exactly as they were, so nothing is cleared for a message that never went.
    @discardableResult
    func send(appending references: String? = nil) -> Bool {
        let text = payload(appending: references)
        guard canSend(payload: text), let client else { return false }
        let restore = composer.draft
        composer.draft = text
        let requestID = UUID().uuidString
        let generation = subscription.generation
        composer.begin(requestID: requestID, generation: generation)
        guard client.sendControl(["t": .string(AgentChatProtocol.send),
            "requestId": .string(requestID), "conversationId": .string(conversationID),
            "text": .string(composer.submittedText ?? "")]) else {
            if let receipt = AgentChatDelivery(map: ["requestId": .string(requestID),
                "conversationId": .string(conversationID), "generation": .int(Int64(generation)),
                "state": .string("failed"), "error": .string("消息未写入连接，请重连后重试")]) {
                composer.apply(receipt)
            }
            // Nothing left, so the draft goes back to what the user typed —
            // without the references, which their images still own.
            composer.draft = restore
            return false
        }
        receiptTimeout?.cancel()
        receiptTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 45_000_000_000) } catch { return }
            guard let self, self.composer.requestID == requestID,
                  self.composer.generation == generation else { return }
            self.composer.loseConfirmation("等待确认超时，请在终端检查；不会自动重发")
        }
        return true
    }

    func loadEarlier(generation: Int, cursor: Int) {
        guard started, connected, surfaceIsReady, receivedSnapshot, capabilities.history,
              subscription.generation == generation, earlierRequestID == nil else { return }
        let requestID = UUID().uuidString
        guard let fields = subscription.earlier(requestID: requestID, cursor: cursor) else { return }
        guard client?.sendControl(fields) == true else {
            status = "历史请求未写入连接，请重连后重试"
            return
        }
        earlierRequestID = requestID
        earlierTimeout = Task { [weak self] in
            do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }
            guard let self, self.earlierRequestID == requestID,
                  self.subscription.generation == generation else { return }
            self.earlierRequestID = nil
            self.status = "加载更早记录超时，请重试"
        }
    }

    /// The subscription each in-flight upload was authorized under.
    private var uploadGenerations: [UUID: Int] = [:]

    /// The appearance the surface should draw in, set by the view that owns it.
    var theme = "dark" {
        didSet { guard theme != oldValue, surfaceIsReady else { return }
            onSurface?(["op": "theme", "theme": theme]) }
    }

    /// Upload results for this conversation, handed to whoever owns the queue.
    var onUploadResult: ((ControlMessage) -> Void)?

    /// A result that arrived for a subscription this view no longer holds.
    var onUploadExpired: ((UUID) -> Void)?

    /// The connection or subscription went away; the queue decides what that
    /// means for each image rather than the session guessing.
    var onConnectionLost: (() -> Void)?

    /// A fresh grant: anything encoded and still unsent may go out now.
    var onUploadsAllowed: (() -> Void)?

    /// Mirrors the outstanding send into the transcript, beside its own words.
    ///
    /// The receipt belongs to the message it is about. Repeating it in a status
    /// strip and a footer as well is what made three copies of one sentence.
    /// Cleared once the Agent's own record carries the message, which the shared
    /// surface decides by `messageId` so it never shows the text twice.
    func pushPendingSend() {
        guard surfaceIsReady else { return }
        guard let requestID = composer.requestID, let state = composer.state else {
            onSurface?(["op": "pending", "id": "", "text": ""])
            return
        }
        var payload: [String: Any] = [
            "op": "pending", "id": requestID,
            "text": composer.submittedText ?? "", "state": String(describing: state),
        ]
        if let detail = composer.detail { payload["error"] = detail }
        if let messageID = composer.observedMessageID { payload["messageId"] = messageID }
        onSurface?(payload)
    }

    private func handle(_ message: ControlMessage) {
        switch message.type {
        case "session_upload_result":
            // Matched by the queue against the request it actually made; a
            // result for a conversation this session is not on never gets here.
            guard message.string("sessionId") == conversationID,
                  let rawID = message.string("id"), let id = UUID(uuidString: rawID),
                  let issued = uploadGenerations[id] else { return }
            uploadGenerations.removeValue(forKey: id)
            // A result from a subscription this view has left is not this view's
            // to apply; the queue reports it as unresolved instead.
            guard issued == subscription.generation else {
                onUploadExpired?(id)
                return
            }
            onUploadResult?(message)
        case "session_list_result":
            guard validatingNotification, let route = notificationRoute else { return }
            validatingNotification = false
            guard AgentRecord.remoteRecords(message.sessions()).contains(where: route.matches) else {
                rejectRoute("通知中的会话已结束或身份已改变，请从当前会话列表打开。")
                return
            }
            requestChatList()
        case AgentChatProtocol.listResult:
            guard let listRequestID, message.string("requestId") == listRequestID else { return }
            self.listRequestID = nil
            let item = message.fields["conversations"]?.arrayValue?.compactMap {
                $0.mapValue.flatMap(AgentChatConversation.init(map:))
            }.first { $0.conversationID == conversationID }
            guard let item, item.chat else {
                setUnavailable(item?.reason ?? "此会话没有可读取的 Agent 对话记录，请使用终端")
                return
            }
            listedAsSupported = true
            subscribe()
        case AgentChatProtocol.snapshot, AgentChatProtocol.append:
            guard subscription.accepts(message) else { return }
            // Read before the frame is applied, so the grant below is a real
            // transition rather than a repeat.
            let couldUpload = canAttach
            if message.type == AgentChatProtocol.snapshot {
                guard let subscribeRequestID, message.string("requestId") == subscribeRequestID else { return }
                awaitingSnapshot = false
                connectionTimeout?.cancel(); connectionTimeout = nil
                receivedSnapshot = true
                // A rewind replaces the whole transcript; a cursor from the old
                // one can no longer be answered.
                earlierRequestID = nil; earlierTimeout?.cancel(); earlierTimeout = nil
            } else if !receivedSnapshot { return }
            capabilities = AgentChatCapabilities(map: message.fields["capabilities"]?.mapValue)
            supportsFileUploads = message.fields["capabilities"]?.mapValue?["fileAttachments"]?.boolValue == true
            // The Host's own word on whether this conversation takes images.
            acceptsAttachments = capabilities.attachments
            if message.string("status") == "unavailable" {
                setUnavailable(message.string("error") ?? capabilities.degraded ?? "对话模式不可用")
                return
            }
            // Only now, with this frame's capabilities and availability
            // applied, is the grant real. Announcing it while `capabilities`
            // still held the reset defaults meant the queue asked "may I
            // upload?", was told no, and waited for a grant that never came
            // again — the picture sat ready and never left.
            //
            // Appends grant too, not just snapshots. The Host drops
            // `attachments` while the Agent is blocked in its own terminal and
            // restores it by append once it is ready; an image that finished
            // encoding inside that window stops at `preparing`, and a
            // snapshot-only grant would leave it there for good.
            if canAttach && !couldUpload { onUploadsAllowed?() }
            switch message.string("status") {
            case "working": status = "Agent 正在处理"
            case "empty": status = "这个会话还没有内容"
            case "loading": status = "正在读取对话…"
            default: status = "可以继续对话"
            }
            if surfaceIsReady {
                onSurface?(Self.surfacePayload(message, op: message.type == AgentChatProtocol.snapshot ? "snapshot" : "append"))
            }
        case AgentChatProtocol.earlierResult:
            guard subscription.accepts(message), let earlierRequestID,
                  message.string("requestId") == earlierRequestID else { return }
            self.earlierRequestID = nil
            earlierTimeout?.cancel(); earlierTimeout = nil
            // A failed request must not hide the renderer's earlier-page button.
            if let error = message.string("error") { status = error; return }
            if surfaceIsReady { onSurface?(Self.surfacePayload(message, op: "earlier")) }
        case AgentChatProtocol.delivery:
            guard subscription.accepts(message), let receipt = AgentChatDelivery(map: message.fields),
                  composer.apply(receipt) else { return }
            if !composer.pending { receiptTimeout?.cancel(); receiptTimeout = nil }
        case "error":
            let requestID = message.string("requestId")
            if let requestID, requestID == earlierRequestID {
                earlierRequestID = nil; earlierTimeout?.cancel(); earlierTimeout = nil
                status = message.string("message") ?? "无法加载更早记录，请重试"
            } else if (requestID != nil && (requestID == listRequestID || requestID == subscribeRequestID))
                        || (requestID == nil && (validatingNotification || listRequestID != nil || awaitingSnapshot)) {
                // An untagged error only closes the view while the open handshake
                // is still outstanding. The retained subscription ID is for
                // rewinds and must not make every later error look fatal.
                setUnavailable(message.string("message") ?? "Host 无法打开对话，请更新 Host 后重试")
            }
        default: break
        }
    }

    func client(_ client: TermbridgeClient, changedState state: ConnectionState) {
        guard self.client === client, started else { return }
        transport(changedState: state)
    }

    func transport(changedState state: ConnectionState) {
        guard started, client != nil else { return }
        switch state {
        case .connecting: status = "正在连接…"
        case .authenticating: status = "正在验证连接…"
        case .connected: break
        case .disconnected: connectionLost("连接中断")
        case .failed(let reason):
            let fatal = ["password", "authentication", "fingerprint", "invalid", "protocol error"].contains {
                reason.localizedCaseInsensitiveContains($0)
            }
            connectionLost(reason, fatal: fatal)
        }
    }

    func clientIsReady(_ client: TermbridgeClient) {
        guard self.client === client, started else { return }
        transportIsReady()
    }

    func transportIsReady() {
        guard started, let client else { return }
        connected = true
        if notificationRoute != nil {
            validatingNotification = true
            status = "正在核对通知会话…"
            armConnectionTimeout()
            if !client.sendControl(["t": .string("session_list")]) {
                connectionLost("通知会话核对请求未写入连接")
            }
        } else { requestChatList() }
    }

    private func requestChatList() {
        guard started, connected, let client else { return }
        let requestID = UUID().uuidString
        listRequestID = requestID
        armConnectionTimeout()
        if !client.sendControl(["t": .string(AgentChatProtocol.list), "requestId": .string(requestID)]) {
            connectionLost("会话列表请求未写入连接")
        }
    }

    func client(_ client: TermbridgeClient, receivedControl message: ControlMessage) {
        guard self.client === client, started else { return }
        receive(message)
    }

    func receive(_ message: ControlMessage) {
        guard started, client != nil else { return }
        handle(message)
    }

    func client(_ client: TermbridgeClient, receivedPTYOutput data: Data, sid: Int) {}

    static func surfacePayload(_ message: ControlMessage, op: String) -> [String: Any] {
        let keys = ["generation", "status", "capabilities", "messages", "earlierCursor", "cursor", "atHead", "error"]
        var payload: [String: Any] = ["op": op]
        for key in keys {
            if let value = message.fields[key] { payload[key] = jsonValue(value) }
        }
        return payload
    }

    private static func jsonValue(_ value: MessagePackValue) -> Any {
        switch value {
        case .null, .binary: return NSNull()
        case .bool(let value): return value
        case .int(let value): return value
        case .uint(let value): return value
        case .double(let value): return value.isFinite ? value as Any : NSNull()
        case .string(let value): return value
        case .array(let values): return values.map(jsonValue)
        case .map(let values): return values.mapValues(jsonValue)
        }
    }
}
