# Agent 对话模式

状态：第一批已实现，四端外壳均已接线。契约、Claude/Codex adapter、Host 服务已完成。
各端进展不同，"编译通过"不等于"已验收"，逐项状态见下方[各端状态](#各端状态)。实现日期：2026-09-14。

第一批的落地位置与 Windows 验收清单见 [windows-acceptance.md](./windows-acceptance.md)；
wire 契约见 [docs/protocol.md](../protocol.md) 的 `agent_chat_*`。

## 产品范围

新增可选的图形 Agent 对话模式，供不熟悉终端的用户使用。入口与 Terminal 并列，Windows 优先交付，协议和展示组件面向 macOS、Android、iOS 复用。

界面采用项目/会话侧栏、消息正文、可折叠的工具过程和底部输入区。默认展示正在做什么、需要用户回答什么、最终产物在哪里；模型细节和工具原始输出按需展开。沿用 TermBridge 的紧凑间距、可拖动侧栏和系统主题；电脑/浏览器协助开关继续放在设置中。

这是与指定 Codex/Claude Agent 的直接对话，不改变 Global Brain 的云端对话与任务调度职责，也不把普通 Global 消息改送本地 Agent。

## 当前实现能复用什么

| 现有实现 | 可复用边界 | 当前缺口 |
| --- | --- | --- |
| `packages/host/src/herdr.ts` | 精确 pane 身份、provider session 身份、既有输入与观察通道 | 当前 mobile transcript 是终端行重排，不是角色消息、工具调用和回合事件 |
| `packages/host/src/agentTranscriptLinks.ts` | 已有按 Codex session 身份定位、限量读取 transcript 的经验 | 只提取 Markdown HTTP 链接；不能作为完整对话接口 |
| `packages/protocol/src/messages.ts` | 鉴权后的 Host 控制帧、上传与文件能力、类型校验 | `session_message` 只记录输入语义，不能代替真实发送和回执 |
| `packages/brain/src/`、Host Brain 路由 | 消息/任务/工具事件的设计经验、受控卡片与产物模型 | Global 的 active conversation 是 Host 共享状态；`brain_new/restore` 广播替换，不能借此实现设备独立导航 |
| `packages/cli/src/desktop.ts` | CLI 承担连接、鉴权、重连；原生 App 使用 JSONL bridge | 目前主要转发终端；需要明确的 conversation 请求和事件 |
| Windows `CliBridge`、WebView2；其他端的 WebView | 原生安装、设置、Host 选择、附件与窗口能力 | 共用展示模块需要各端 bridge 和打包接线，不会仅因共享 TypeScript 自动可用 |

以上是源码审查结论，不是端到端验证。新模式的设备选择隔离也不等于已修复历史上 Windows 切换影响 Mac mini 的终端问题。

## 模块与责任

按现有 `packages/*` 结构拆分：

- `packages/agent-chat/`：不依赖 UI 的 conversation/event/capability 模型、去重和增量恢复逻辑。
- `packages/agent-chat-ui/`：可本地打包的对话内容组件。Windows 继续 C# + WinUI 3，macOS/手机继续现有原生外壳；共享组件只负责消息区域。原生层承接 IME、剪贴板、附件和系统权限。
- `packages/host/src/agentChat/`：身份解析、provider adapter、订阅与回执、受限历史读取。独立路由文件，Host 入口只做注册。

依赖方向：平台外壳 → 对话展示/客户端状态 → TB 已有连接 → Host 对话服务 → provider adapter。展示层不能访问 provider 凭据、任意本地文件或自行运行 shell。

不引入另一套 Relay、账号系统、后台同步服务或 Electron 主进程。可复用 Brain 的稳定公共类型，但不要让 agent-chat 模块依赖 Voice Call 生命周期或全局 active conversation。

## 两类会话必须分开处理

| 会话所有者 | 数据与控制 | 明确限制 |
| --- | --- | --- |
| 已在 Herdr 中运行的 Agent | 精确绑定 Host、pane、provider session；通过可验证的结构化记录/事件读取；发送走既有 Herdr 输入能力 | 切换视图不能重启、接管、复制 Agent，不能改变 Mac mini 的 pane 焦点或布局。历史格式只属于版本化 adapter，不能成为跨平台协议 |
| TB 为对话模式新建的 Agent | 可评估 provider 的正式结构化运行接口，例如 Codex app-server、Claude 结构化接口；TB 负责自己创建的运行生命周期 | 先验证已安装版本、鉴权、恢复和审批能力。不得把启动第二个进程恢复同一活跃 session 当作无损接管 |

首个闭环优先支持已识别的 Codex/Claude 会话；按实际 adapter 能力显示功能。结构化记录不可用时保留 Terminal 入口，明确原因，不凭 ANSI 文本推断工具成功或审批状态。新建会话的正式结构化路径作为后续可独立交付的 adapter。

## 数据契约

以下是待实现契约，不是现有 wire 字段：

- 每个 conversation 固定绑定 `hostId + conversationId + providerSessionId`，外部 Herdr 会话还绑定精确 pane。身份不明时禁止根据 cwd、标题或最新文件猜测。
- 公共事件包含 conversation、稳定 event/message/turn 身份、单调序号和可验证的状态。消息块只允许文本、工具调用/结果、附件、产物及明确的提问/审批类型。
- 历史与实时读取使用有界分页和增量 cursor；文件型 adapter 在内部处理半行、UTF-8 跨块、截断/轮转与 schema 不支持。不要向客户端暴露原始 transcript 文件路径。
- 同一会话重连后事件去重。发送使用 requestId，区分 Host 接收、交付 Agent、Agent 开始处理、完成/失败。交付结果不确定时返回不确定状态，禁止自动重发产生重复任务。
- 每个连接只订阅所需 conversation。active Host、active conversation、视图类型、草稿、滚动和侧栏宽度保留在客户端；跨端共享消息，导航不广播。
- 权限/提问绑定准确的 requestId、turnId 和会话，Host 拒绝过期、重复或跨会话回答。日志中出现历史提问不意味着当前可操作；不能盲发 Enter 或统一模拟快捷键。
- 停止当前回合、断开视图、退出 App 是不同动作。不能把 `brain_cancel` 当作通用 Agent 中断，它不保证停止已派发 Worker。
- 附件复用 TB 上传校验和受限文件代理；现有上传要求已 attach Terminal，独立 Chat 必须补充 conversation 归属校验，不能为上传伪造终端 attach。由 provider adapter 决定如何提交。图片有预览与发送状态，产物通过 TB 预览/下载；不把 Host 路径当作远端设备可访问地址。
- 仅在有人订阅时观察外部会话；退订释放 watcher、连接和缓存。长记录增量读取，不能每次输出重新扫描全部历史。
- 不输出模型内部推理、凭据或整份原始日志；只转换产品展示所需的消息和有界工具数据。

协议接入须同步 TS、Android、iOS 模型与 `docs/protocol.md`，并声明 Host 支持能力；旧 Host/客户端得到明确的降级行为。

## 各端状态

"源码"= 实现存在且经过审查；"构建"= 该端的构建与自动化测试通过；"渲染"= 有真实渲染产物证明打包的对话界面画得出来；"真机"= 在真实设备或模拟器上完成过交互；"发布"= 已签名/公证/进入分发。截至 2026-09-14：

| 端 | 源码 | 构建与测试 | 渲染证据 | 真机/模拟器交互 | 发布 |
| --- | --- | --- | --- | --- | --- |
| Windows | ✅ `windows/TermBridge.App`（WinUI 3 + WebView2）、`windows/TermBridge.Core/SessionViewPreference.cs` | ✅ 此前在 Windows 11 ARM64 VM 中以 x64 仿真完成发布构建与 20 项原生检查 | ✅ 见 [windows-acceptance.md](./windows-acceptance.md) | ⚠️ 仅 VM；实体 PC、中文 IME 候选词、完整新回复未完成 | ◻ |
| macOS | ✅ `MacAgentChatView.swift`（原生 AppKit composer + WKWebView 渲染器）、`MacAgentChatSession.swift`（独立管理连接）、`TerminalWindowController.swift`（切换栏与通知约束）、`ConnectionSettingsView.swift`（默认视图设置） | ✅ `swift test` 94 项、17 跳过、0 失败，连续 4 次整套运行一致 | ✅ `WKWebView.takeSnapshot` 与 `NSView.cacheDisplay` 产物；运行测试的进程没有"屏幕录制"权限，因此没有整窗 OS 截图，产物旁的说明文件写明每张图的来源 | ◻ 未在已安装 App 中交互 | ◻ 只有 ad-hoc 签名的预览包，未替换 `/Applications`，未公证、未分发 |
| Android | ✅ `android/.../chat/`（AgentChatActivity、AgentChatWebView、SessionUiSettings、SessionHostPin、SessionUiRouting） | ✅ `./gradlew testDebugUnitTest lintDebug assembleDebug`，243 项 JVM 测试通过 | ⚠️ 只有 APK 内的资源存在性证明，没有渲染截图 | ◻ 模拟器因磁盘压力未启动，未做交互验收 | ◻ 仅 debug APK |
| iOS | ✅ `ios/Termbridge/AgentChat/`（AgentChatScreen、AgentChatViewModel、AgentChatWebView） | ⚠️ App target 以 `iphonesimulator` SDK 编译通过；`swift test` 的 55 项只覆盖共享的纯状态（`ios/Package.swift` 没有把 view model 纳入该 target） | ◻ 无 | ◻ 本环境没有可用的模拟器 destination（已装 SDK 26.5，运行时只有 18.5 / 26.4），UI 测试无法执行 | ◻ |

## 设置与视图切换

默认视图是**本机设置**，不是 Host 或 Agent 的属性，也不会同步到其他设备：

| 端 | 存储位置 | 键 |
| --- | --- | --- |
| macOS / iOS | `UserDefaults` | `session.defaultUI` |
| Android | `SharedPreferences("session_ui")` | `default_ui`，另有有界的 `session_overrides`（最多 32 条） |
| Windows | `%APPDATA%/TermBridge/connections.json` | `sessionView` |

三个取值：

- `auto`（默认）：可能是 Agent 对话的会话开在对话视图，其余开在终端。macOS/iOS/Android 用会话身份判断（Herdr agent 会话），Windows 用 Host 报告的该会话 `chat` 能力判断；两者都只对已识别的 Codex/Claude 会话进入对话，第一帧画什么略有差别。
- `chat`：默认开在对话视图。
- `terminal`：默认开在终端。

每个窗口/会话都有自己的切换开关，切换只改这台设备上这个视图，不重启、不接管 Agent，也不改变 Mac mini 上 pane 的焦点或布局。Android 与 Windows 还会记住**单个会话**的手动选择：改了全局默认之后，点开旧通知得到的是用户为那个会话选过的视图，而不是创建通知那一刻的默认值——视图在通知被点开时才解析。Android 的自动降级（会话不支持对话）不算手动选择，不会写入这份记录。

macOS 通知另有一条硬约束：通知指向的会话如果已结束或身份已改变，这个窗口的**两个视图**都会保持拒绝状态，终端回退不会去 attach 复用了同一个 ID 的替代会话；只有新的通知或从当前会话列表重新打开才会清除。

Android 的会话窗口还会**钉住它被打开时的那台 Host**。钉住的身份包含 Host ID 和 relay + 凭据的指纹，后者在 Host 尚未协商出来时也成立，协商完成后再升级成 Host ID；切换视图、切换全局当前连接、旋转屏幕都不会让这个窗口跟着跑到另一台机器。会话与通知导航**只会选中用户已保存的连接**，绝不用当前连接的 relay 和凭据拼出一个同名 Host——被删掉的连接会让这个窗口停下并提示重新添加，而不是静默连到别处。发现新 Host 和配对仍然是唯一可以新建连接的路径。

## 能力降级与不确定的发送

- `capabilities` 中 `stop`、`approvals`、`questions` 为 `false`。客户端禁用对应入口并说明"请在终端操作"，不会用统一快捷键去模拟这些能力。
- 控制键：对话视图没有 attach，因此走 `agent_chat_key`。客户端只命名固定集合内的键
  （Esc/Tab/Enter/Backspace/方向/Home/End、`ctrl-a..z`、`alt-a..z`、`alt-enter`、
  `alt-backspace`），字节由 Host 决定；授权与发送同级——必须持有该 conversation 的有效订阅且
  `generation` 相符。Ctrl/Alt 是"待命"按钮，下一个字母变成组合键并从草稿里取回，不会被当成
  普通消息发出去。回包带 `generation`，客户端只处理自己按过且仍属当前订阅的请求。
- `attachments` 跟随 `send`。图片走的是和文本同一条已验证输入通道：字节上传到 Host，Host 返回它保存的路径，消息里用 `[Image: <path>]` 指名该路径——这正是 Terminal composer 一直以来的做法，所以 Agent 的消费路径没有变化，没有新增 provider 能力假设。授权用的是这条连接对该 conversation 的订阅，不是 Terminal attach，也不伪造 attach。旧 Host 报 `false` 或不报，客户端一律显式禁用附件入口。
  **provider 侧的真实消费（Agent 读取该图片）尚未在真机端到端验证**，见[验收状态](#验收状态)。
- Host 判定该会话没有可读结构化记录时，对话视图显式降级并保留 Terminal 入口，不从 ANSI 文本推断工具成功或审批状态。
- 记录**尚未写入**不属于上面这种情况。刚启动、还没有对话的 Codex/Claude 没有记录文件（Codex 在第一轮之前也不向 Herdr 报告会话标识），对话视图以空会话打开，输入框和按键可用，可以直接发出第一条消息。Host 按同一身份继续查找，记录出现并核对通过后推送新的 snapshot 替换空页面，第一条消息的回执按记录自带时间确认。发出后约 20 秒仍找不到记录时，界面说明回复暂时请在终端查看；记录指名另一个会话或 Agent 已离开 pane 时，按降级处理并把未确认的发送标为 `uncertain`。
- 发送回执只承认可验证事实：`delivered` 是输入通道接受了字节，`observed` 是该 Agent 自己的记录里出现了这条输入。写入结果未知时状态是 `uncertain`，**客户端一律不自动重发**；原文保留在输入框或"复制未确认的消息"里，由用户在终端核对后自行决定。页面重新加载、连接中断、视图关闭都会把待确认的发送标记为 `uncertain`，不会补发。
- 渲染页重新加载后，客户端不会重放缓存的旧快照（它比 Host 之后发出的增量还旧），而是用新的 generation 重新订阅，由 Host 给出有界的新快照；旧 generation 的事件被丢弃。

## 共享消息、独立导航

对话内容是同一个 Agent 会话的同一份记录，多端看到的是同一批消息。但**导航是每台设备自己的**：当前 Host、当前会话、视图类型、草稿、滚动位置和侧栏宽度都留在客户端，不广播。一台设备切到对话视图不会把另一台设备也切过去。

## 开源参考与取舍

调研固定版本：Orca `55b33920180efa188a19dfb7fac0fc993f10a922`；Happy `108a337e87a5653b604250a9ac3e3bd873dba551`。这不是对其运行稳定性的验收。

| 项目 | 已核对的相关实现 | 建议 |
| --- | --- | --- |
| [Orca](https://github.com/stablyai/orca/tree/55b33920180efa188a19dfb7fac0fc993f10a922) | [Chat UI 文档](https://github.com/stablyai/orca/blob/55b33920180efa188a19dfb7fac0fc993f10a922/docs/site/content/docs/agents/native-chat.mdx) 明确为实验功能，支持原会话 Terminal/Chat 切换及手机展示；[公共模型](https://github.com/stablyai/orca/blob/55b33920180efa188a19dfb7fac0fc993f10a922/src/shared/native-chat-types.ts)、[Codex decoder](https://github.com/stablyai/orca/blob/55b33920180efa188a19dfb7fac0fc993f10a922/src/main/native-chat/transcript-line-decoders-codex.ts)、[增量读取](https://github.com/stablyai/orca/blob/55b33920180efa188a19dfb7fac0fc993f10a922/src/main/native-chat/transcript-incremental-reader.ts) 是直接参考点 | 优先参考模式切换、稳定消息身份、增量历史、提问/附件组件。不要整仓移植 Electron、远程运行和终端系统；不照搬 scrape 降级为审批或工具成功依据 |
| [Happy](https://github.com/slopus/happy/tree/108a337e87a5653b604250a9ac3e3bd873dba551) | 手机/Web 对话；[Codex app-server client](https://github.com/slopus/happy/blob/108a337e87a5653b604250a9ac3e3bd873dba551/packages/happy-cli/src/codex/codexAppServerClient.ts)；CLI provider adapter | 参考结构化 Agent 通道及权限交互。其 README 描述的 wrapper/remote 重启流程不适用于 TB 已存在的 Herdr pane |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | TypeScript/React 对话组件，可接自定义 runtime，含消息、输入、流式内容、附件和工具 UI | 可作为共享消息区域的候选；先以 TB 事件做小样验证包体、IME、滚动与原生 bridge。它不提供 Herdr/Agent 后端 |

以上仓库根许可证均为 MIT；实际摘取代码时固定 revision，在派生文件/第三方说明中保留相应版权和许可，并核对涉及文件及依赖的单独许可。首批已经摘取并改编 Orca 的模型、合并、decoder 与增量读取实现，逐文件来源和完整许可见根 THIRD_PARTY_NOTICES.md；Windows 安装目录也包含声明。

## 交付顺序与验收

1. ✅ 独立契约、真实 provider adapter（Claude 与 Codex）、增量历史与发送回执。Claude 的首次报告称已在自建会话跑通真实回复，但当时发送输出未落盘。主 Agent 的 Windows 独立验收确认两次相同消息分别 observed、两条不同记录；受 Claude 额度限制，当前这轮没有正常助手回复。
2. ✅ Windows 首批接线与 VM 验收：WinUI 发布构建、20 项原生检查通过；800×600 下实际验证深色主题、自动聚焦、中文粘贴、Enter 发送、Shift+Enter 换行、草稿隔离与历史翻页。剩余场景见验收清单。
3. ◻ macOS、Android、iOS：外壳、设置与共享渲染器已接线并通过各自的构建与测试；三端都还没有真机/模拟器上的交互验收。详见[各端状态](#各端状态)。
4. ◻ 各 provider 的提问、审批、停止与新建：`capabilities` 中相应位为 `false`，客户端禁用并说明原因；没有用统一快捷键代替 provider capability。
5. ◻ 图片附件：Android 对话视图已复用 Terminal 的原生 composer（同一份 `view_composer.xml`、同一套上传队列），Host 按订阅授权 `session_upload`，`capabilities.attachments` 跟随 `send`。已验证到"上传被授权并返回 Host 路径、路径进入消息文本"；**尚未在真机上验证某个 provider 真的读取了那张图片**。macOS、iOS、Windows 的对话视图还没有附件入口。

必须覆盖：两客户端切换互不影响；中文输入法 Enter 不误发；草稿不丢；图片上传失败可重试；工具失败准确展示；断网重连不重复发送/显示；旧订阅事件不写入新会话；停止不退出；不支持的 Agent 能回到 Terminal；长历史滚动与 CPU 有界。

运行仓库规定的 Node test/build；修改平台运行对应构建与测试。协议还需 Cloudflare 与集成测试。使用自建测试会话做交互，避免中断用户现有 Agent。
