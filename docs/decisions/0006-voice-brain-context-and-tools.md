# ADR-0006: Voice Brain 使用 Host 权威上下文与显式工具过程

- 状态: 采纳
- 日期: 2026-08-29

## 背景

Android 完成通知根据 Herdr pane 从 `working` 到 `done` 的转换发出；旧 Voice Prompt 却主要读取
Agent 当前状态和大量终端原文。一个 Agent 完成后立即开始下一轮时，完成通知已经出现，但其当前状态
又变成 `working`，Voice 因而可能把更老的 `done` pane 误认为“最近完成”。大量旧上下文也会削弱
工具约束，使语音模型像通用生活助手一样直接作答。

## 决策

1. Host 把 Agent 当前状态与完成事件分开建模。完成时间和当时的最终摘要在 Agent 再次工作后仍保留，
   并按时间生成权威的最近完成列表。
2. Voice 会话启动时只注入结构化基线：完整 roster 的身份/状态/摘要、最近完成事件、Global 消息与任务。
   不再一次性注入每个 pane 的大段原始终端文本；需要证据时用 `inspect_workspace(view=agent)` 精确读取。
3. 所有只读状态聚合到 `inspect_workspace`：Agent 数量/当前状态使用 `overview`，通知、刚完成、
   最近完成使用 `recent`，任务结果使用 `tasks`，精确上下文使用 `agent`。需要实时 Agent 状态的视图先刷新 Herdr。
   `continue_agent` 与 `dispatch_agent` 保持独立，因为它们有不同的副作用与安全边界。
4. 文件证据通过一个只读的 `workspace_files(action, path)` 聚合工具提供。它只支持 `list` 与 `read`，
   默认限定在 `~/code`，并用 `@memory` 显式读取长期 Memory；可通过 `TB_BRAIN_FILES_ROOT` 覆盖项目根。
   路径穿越、逃逸 symlink、二进制、大文件和常见凭据文件由 Host 拒绝。写文件仍由本地 Agent 完成。
5. Voice Brain 的职责限定为技术方案讨论、Agent 状态与上下文查询、检查、继续和派发工作；非技术生活
   问题简短说明范围，不作为通用助手扩展回答。已注册的 `phone_action` 和 `home_assistant` 是显式设备能力例外；
   家庭状态/单设备控制遵循 Host 持续授权白名单，见 `docs/home-assistant.md`，文字与语音共用同一执行边界。
6. 工具调用通过协议发送 `started` / `completed` / `failed` 和安全摘要，Android 同时播放提示音并展示
   过程。派发成功只代表已派发，不能表述为已完成。
7. 每个 Host 工具在同一个注册点声明定义、执行、进度文案，以及可选的 `ui(result)`。UI 不由模型生成；
   注册了 UI 的结构化结果只能转换为固定的原生卡片协议：一次工具结果是一张卡，Agent 列表、完成列表、
   任务列表、单 Agent 和操作回执中的每项各占一行，最多 8 项。卡片行携带稳定 `sessionId` 时，Android
   可直接进入对应 Terminal，并通过原 Activity 栈返回 Global；列表已显示后 Voice 不逐条朗读。Host
   将结果作为独立的 Global 时间线事件持久化，Call 内也通过实时事件立即显示，重连或挂断不会丢失。
   没有注册 UI 的工具只返回结果，不产生卡片；询问单个最新结果时工具只请求一项。
8. 文字输入与 Call 是并列操作，不是互斥模式。Android 的 `Call` 按钮只负责开始通话，`End call` 只
   停止当前 Realtime 会话；文字输入框和未发送草稿不随通话开始、结束或失败而切换。
9. 跨会话 Memory 使用 Host 本机的单一 Markdown 文件，默认路径为 `~/.termbridge/memory.md`。新建
   Realtime 会话时把有界快照注入一次；同一 Call 不按音频分片重复上传。云端 Voice Brain 不获得直接
   FS 权限，只能通过上述只读边界访问；本地 Codex/Claude 只接收路径并使用自身文件能力读写，因此不增加
   Memory 专用工具。Memory
   不保存凭据或瞬时 Agent 状态。
10. Voice Brain 本身没有代码写入、Shell、测试、构建、安装、发版或部署能力。它可以直接讨论技术方案，
    但只要用户要求执行修改，就必须在同一轮通过 `continue_agent` 交给精确现有会话，或通过
    `dispatch_agent` 创建新的本地工作 Agent；派发后仍需查询实时结果，不能把方案描述当作已实现。
11. Global 对话历史由 Host 的 Brain store 持久化，并在新 Voice 会话中有界携带 user 与 brain 两侧，
    以保留代词、追问和纠错语境；旧 brain 文本只负责对话连续性，不具备事实优先级。Agent 当前状态与
    最近完成仍必须来自 Context Index 或实时工具。每份 Host 快照和 `inspect_workspace` 结果都携带
    观测时刻，完成事件同时携带相对秒数，避免模型用未知的时钟推断“几分钟前”。
12. Realtime 音频授权后先进入 Android 本机有界 outbox，再尝试发送。网络中断不会结束 Call；重连时
    从未确认 utterance 的首帧重放，并在前一段 transcript 被确认后逐段提交。该缓存只解决临时断网，
    不把百炼 AK、Agent 上下文或执行工具下放手机；当前完整 Voice Brain 仍由 Host 代理，因为这些凭据
    和权威状态只存在于 Host。真正的纯手机模式需要另建经过鉴权的云控制面，而不是把 AK 写进 APK。
13. Call 中打开工具卡片或任务详情时，Brain Activity 保留当前 Realtime 会话与端侧采音；Terminal 在
    右上角显示同一音量/状态驱动的紧凑 Voice orb，点击返回 Call。用户回桌面或切换到其他 App 时，由已在
    前台启动的 `microphone` Foreground Service 维持录音资格，并在用户明确授予悬浮窗权限后显示同状态、
    可拖动的系统 Voice orb；回到 TermBridge 时系统 orb 隐藏，避免和页内入口重复。通话界面的“保持屏幕
    常亮”设置默认开启，并在 Call 与其 Terminal 详情之间一致生效；用户结束 Call 后才清理音频、队列、
    前台服务和悬浮入口。
14. Call 音频路由使用 Android communication-device 模型。开始通话时优先保留系统当前的蓝牙、助听器、
    有线或 USB 通信设备；否则优先选择已连接的蓝牙通信设备，最后才按持久化偏好回退到内置外放或听筒。
    “外放”按钮只在当前通话中强制内置扬声器，关闭后重新进入自动路由。设备热插拔会重新计算路由，通话结束
    必须移除监听并调用 `clearCommunicationDevice()`；选择通信输出时由 Android 同时选择匹配的输入麦克风。

## 后果

- 手机通知和 Voice 对“刚完成”的理解都来自同一 Herdr 状态事实，但 Voice 保留独立的完成事件历史。
- 长通话中的动态事实依赖工具刷新，启动时的 Prompt 只作为静态基线。
- 临时断网期间可以继续说话，但本机缓存尚未送达云端时不会生成回复；恢复连接后按语句顺序补发。
- 上下文更短、更可控；读取完整执行细节多一次工具往返，但避免旧终端文字污染当前判断。
- 工具事实可以视觉浏览并继续操作；新增结果类型时必须显式扩展 Host 转换器、协议 schema 和 Android
  renderer，模型输出本身没有创建控件或导航目标的权限。
