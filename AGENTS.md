# Termbridge Agent Guide

本文件是 Termbridge 已验证能力的入口索引。先沿这里找到权威实现和设计文档，再修改代码；不要把临时排障结论、设备地址、账号、AK、二维码或配对密钥写进仓库。

## 工作约束

- 这是共享工作区。先检查 `git status`，只修改当前任务涉及的文件，不覆盖或回退其他人的改动。
- 涉及真机安装或系统角色变更时，先备份现有 APK 与 `run-as` 可读的应用数据，并说明 Android Keystore 等不可导出部分。
- 协议变更必须同步 `packages/protocol/src/messages.ts`、Android `protocol/Models.kt`、iOS 对应模型和 `docs/protocol.md`。
- 密钥只留在 Host/系统凭据存储。手机客户端、日志、Relay 和工具结果都不能出现百炼 AK 或主机私密文件内容。
- Herdr pane 由 Herdr 管理；Termbridge 只 attach/read/write，不替外部 Pane 决定生命周期。

## Terminal 与 Herdr

- Host 统一入口：`packages/host/src/index.ts`、`backend.ts`、`sessionManager.ts`、`bridge.ts`。
- Herdr 原生接入：`packages/host/src/herdr.ts`。运行时以 `herdr api schema` 和本地 socket 返回为权威；稳定会话 ID 为 `herdr:<pane_id>`。
- 设计边界：`docs/decisions/0003-herdr-native-api.md`、`docs/architecture.md`、`docs/protocol.md`。
- Android Terminal：`android/app/src/main/java/com/termbridge/android/TerminalActivity.kt` 和 `terminal/TerminalWebView.kt`。WebView/xterm 负责画面与字节流，原生 composer 负责 IME、粘贴和附件；不要把 Android 输入焦点交给终端画布。
- 移动端惯性滚动算法：`packages/mobile-terminal/src/touch-scroll.ts`。修改手势后同时验证慢拖、快甩、反向、边界回弹和终端输出更新时的滚动位置。
- macOS 文件与改动窗口：`TerminalFilePreview.swift`（单例窗口，改动/文件两种模式）；源码着色 `CodeHighlighter.swift`、代码视图 `CodeTextView.swift`、显示方式与编码判断 `FilePreviewContent.swift`、差异文档 `DiffDocument.swift`、图片对比 `ImageComparisonView.swift`。对话涉及的仓库来自 Host `conversationFiles.ts`（只读 Agent 自己的结构化记录）和 `packages/review` 的 `repositories()`；私密文件规则 `isPrivatePath` 在 `packages/review`，文件预览与 Git 差异共用。
- macOS 会话窗口：`TerminalSessionController` 是单个会话的终端/对话与连接；`TerminalWindowController`（独立窗口）和 `SessionNavigatorController`（按目录导航，按 Herdr 工作区分组，最多保持 4 个会话连接）只是容器，切换模式时会话在容器间移动而不重连。见 `docs/decisions/0023-macos-session-navigator.md`。
- 反向手机工具是显式白名单通道，不是 ADB 或任意 shell：`packages/cli/src/peer.ts`、`peerExecutor.ts`、`android/app/.../peer/`、`docs/android-peer.md`。

## 图形 Agent 对话

- 这是同一个已运行 Agent 的第二个视图，不是新 Agent，也不是 Global Brain 改版。切换视图不重启、不接管会话，不改变 Mac mini 上 pane 的焦点或布局。
- 契约与展示：`packages/agent-chat/`（模型、去重、Claude/Codex 记录 adapter、回执状态机）、`packages/agent-chat-ui/`（无框架对话组件，`scripts/build-webview.mjs` 打包进原生外壳）。
- Host 服务：`packages/host/src/agentChat/`。`index.ts` 只注册路由。身份来自 Herdr 的 `agent_session`；`kind=path` 直接使用，`kind=id` 推导后必须核对文件自述的会话标识，定位失败是显式降级，不按“最新文件”或 cwd 猜测。记录尚未写入（Agent 刚启动、还没有对话）不算失败：以空会话打开并允许发送，记录出现并核对通过后在同一订阅下替换。
- 记录格式是版本化 adapter 的内部细节，不进入 wire。客户端只看到有界的 text / tool-call / tool-result / image-ref；模型内部推理、凭据、原始记录路径都不上线。
- 回执只承认可验证事实：`delivered` 是输入通道接受了字节，`observed` 是该 Agent 自己的记录里出现了这条输入，`uncertain` 是写入结果未知且禁止自动重发。工具状态只来自 provider 记录，不从终端文本推断成功或审批。
- 首批 capability 中 `stop`/`attachments`/`approvals`/`questions` 为 `false`，客户端禁用并说明原因，不用统一快捷键模拟。协议、边界与 Windows 验收清单见 `docs/agent-chat/`。

## Relay、Cloudflare 与配对

- Node Relay：`packages/relay/src/index.ts`；Cloudflare Durable Object Relay：`packages/cloudflare-relay/src/index.ts`。`cloudflare/worker.js` 是部署兼容入口。
- 两条链路只是不同传输实现，共用同一套 frame/envelope 协议。客户端到 Relay 是裸帧，Relay 到 Host 才带 `clientId`；详见 `docs/protocol.md`。
- 多台 Mac 以稳定 `hostId` 共存。扫码加入新 Host 必须新增/合并 profile，不能替换现有 Host；UI 以 Host tab 切换。
- App 内置 CLI 的可选 PATH 入口：`CLIAppExtension.swift`；本地控制与 Peer 配置：`MacAppControl.swift`、`MacLANAutomation.swift`；普通终端 Peer 请求：Host `peerRequests.ts`、CLI `peerNetwork.ts`；更新及服务所有权：CLI `update.ts`、`serveSupervisor.ts`。使用与边界见 `docs/cli-automation.md`。
- 配对实现：`packages/cli/src/pairing.ts`、`cloudflare.ts` 和 Android/iOS 的 `PairingCode`。二维码或 `tb1_...` 等同密码，不得写入文档、测试快照或日志。
- 官方 Cloudflare 与自建 Cloudflare 的使用、信任边界和费用提示在 `docs/cloudflare.md`。部署前重新核对 Cloudflare 当前定价和额度。

## Global Brain 与实时语音

- Brain 的职责是技术讨论、Agent 状态/上下文查询、检查、继续和派发任务，并可调用少量已注册、由手机确认的原生 Action；它不是开放式生活助手。领域约束见 `docs/decisions/0006-voice-brain-context-and-tools.md` 与 `0010-phone-peer-actions.md`。
- Global 文字、静音执行与 Voice Execution Fork 默认统一为百炼 `deepseek-v4.1-flash`，关闭思考；共享默认值在 `packages/brain/src/models.ts`，显式 Host 模型配置仍优先。持续 Call 的语音前端可按会话在百炼 Qwen Omni 与火山豆包 Seeduplex 间切换，但共用同一 Fork/Pi 工具 Harness；ASR 和停顿判断模型不变。Codex/Claude 只是 `continue_agent` / `dispatch_agent` 后面的执行 Worker，禁止把普通 Global 消息无条件路由给本地 Agent，也禁止在 AK 缺失时静默回退成本地对话。
- Host 上下文、记忆和工具聚合：`packages/host/src/contextIndex.ts`、`brainMemory.ts`、`workspaceFiles.ts`、`voicePrompt.ts`、`voiceTools.ts`。模型只接收有界、带时间和稳定 ID 的权威快照。
- Brain 状态与调度：`packages/brain/src/`；百炼语音适配：`packages/voice/src/`。实时主链路是手机采音/端侧门控 → Relay → Host → 百炼 Omni → 受控工具/本地 Agent → 结构化 UI 与流式音频。
- Android Call UI 和音频生命周期：`android/app/src/main/java/com/termbridge/android/brain/`。Call 与文字是两个并列入口；挂断只结束录音、播放和云端会话，不销毁 Global 对话。外放通过 `CallAudioSession` 的 communication-device 路由实现，结束时必须清除路由，不能遗留全局音频状态。
- 后台 Call 必须有实际可见的通话表面或悬浮球，不能以“APP 在前台”代替。入口复用与唯一录音/播放所有权见 `VoiceCallOwnership.kt`；状态透明和不采音验证见 `docs/voice-call-lifecycle.md`。
- 工具结果使用受控 `VoiceToolView` schema，同时持久化到 Global timeline。客户端按注册类型渲染卡片，模型不能发送任意布局；可打开的 Agent 项必须携带稳定 `sessionId`/`source`。
- 打断由端侧说话检测先静音、本人音色确认后清空本地播放，但用户音频必须继续上送；百炼 `semantic_vad` 通过 `interrupt_response` 中断旧回答并以 `create_response` 建立下一轮。`brain_voice_cancel` 只保留给显式取消（如 Watch），不能代替正常插话。回声防护见 `CallAudioSession.kt`、`VoiceBargeInGate.kt` 和 Host `voiceEchoGuard.ts`。
- 本地语音备选：`docs/decisions/0004-local-omni-voice-fallback.md`（MiniCPM-o）与 `0005-nemotronlabs-voicechat-11b-local-option.md`。云端仍是默认，切换实现不能分叉 Brain 工具协议。

## Android 系统入口

- 侧键长按使用标准 `VoiceInteractionService`，实现位于 `android/app/src/main/java/com/termbridge/android/assistant/`，声明在 `AndroidManifest.xml` 和 `res/xml/voice_interaction_service.xml`。
- 用户必须在系统中明确选择 Termbridge 为数字助理，并把侧键长按设为“数字助理”。这只是系统按键路由，不代表后台常驻录音；没有 Hotword/DSP 服务。
- 用户保留 Bixby 时，使用导出的 `GlobalCallEntryActivity`（启动器名称 `Termbridge Call`）作为三星侧键双击和 Bixby“打开应用”的入口；`termbridge://global/call` 是同一入口的显式 deep link。后台 Service 不是 Bixby 能自动发现的调用契约。
- `res/xml/shortcuts.xml` 仍暴露 `Global Call` 静态快捷方式，供桌面长按菜单和支持 Android Shortcuts 的助手使用。
- 两个入口都进入 `BrainActivity.globalCallIntent()`，由 `GlobalCallLaunchGate` 等 Host 握手 ready 后只启动一次。锁屏显示不能绕过系统 Keyguard。

## 参考项目与复用路径

- 本仓库 `ios/`：SwiftUI 客户端、协议、配对、通知和 Terminal WebView 的跨平台对照实现。

## 验证门槛

- Node：`pnpm test`，再执行 `pnpm build`。
- Android：`cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug`。
- iOS：`cd ios && swift test`；通用模拟器构建不能代替真机验证。
- Relay/协议改动还要运行 Cloudflare Worker 测试和端到端 PTY/Herdr 测试，入口见 `docs/testing.md`。
- 真机结论至少核对已安装 APK、`topResumedActivity`、系统角色/服务状态和真实交互；截图或单独构建成功不算端到端完成。
