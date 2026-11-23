# ADR-0003: Herdr 原生 API 会话，不再包第二层 PTY

- 状态: 采纳
- 日期: 2026-08-19

## 背景

Herdr 已经拥有 workspace/tab/pane、Agent 识别、状态机、终端渲染与输入 API。若 TB 为这些
Agent 再启动或包一层 node-pty，会复制会话、丢失 Herdr 身份与状态，并造成生命周期所有权冲突。
目标是 TB 一启动就能看见所有现有 Herdr pane，并让远端 CLI/Android/iOS 直接进入操作。

## 决策

1. Host 默认探测 Herdr 的 Unix socket，使用 Herdr 0.8.0 / protocol 19 的公开 NDJSON API。
2. `session.snapshot` 中每个 pane 映射为稳定 TB id `herdr:<pane_id>`，和 `sess-N` 一起由
   `session_list_result` 返回；新增可选元数据 `source/workspace/paneId/agent/status`，旧客户端兼容。
3. attach 后，默认首屏及输出 revision 变化走 `pane.read(source=visible, format=ansi)`；移动端可在
   attach 时声明 `presentation=mobile`，将 `visible` ANSI 画面在本机窄屏重排，
   保留命令、路径和 Agent 状态的颜色高亮。输入仍将
   xterm 字节拆为有序 text/logical keys 后走 `pane.send_input`。更新优先尝试
   `events.wait(pane_output_changed)`；Herdr 0.8.0 运行时返回 `unsupported_event_wait_match` 时，
   自动降级为已 attach pane 的 120ms `pane.read` 画面差异轮询。relay 和终端二进制帧不改。
4. 生命周期和布局仍归 Herdr。TB 忽略 Herdr 的 resize，并拒绝 kill/restart，不把远端管理动作
   解释成关闭用户 pane。
5. `TB_HERDR=off` 可禁用，`TB_HERDR_SOCKET` 可覆盖 socket 路径。Herdr 不存在时 Host 继续只服务
   普通 PTY session。
6. 后台预览、Global 上下文和移动阅读视图只读 `source=visible`，不请求额外历史行。
   `recent_unwrapped` 在 alternate screen 中可能通过实际翻动 Agent 界面补足历史，再回到底部；
   定时读取会造成无人操作时的反复回跳。按缓存的 pane 高度限制 `lines` 也不能避免并发缩窗的竞态。
   完整对话历史由 Agent Chat 从已核实的 provider 记录读取，不通过操纵桌面滚动获取。
7. Desktop 兼容终端的显式滚轮操作可按需读取 `source=recent` 的有界历史（最多 2000 行 / 1 MiB），
   在该 viewer 内冻结并滚动；后台 watcher、预览、Global 和 mobile 仍仅使用 visible。
   返回底部或输入时恢复实时画面，关闭/替换后丢弃旧历史响应。此能力由 attach_ok.historyScroll 协商。
   Herdr 在 alternate screen 中可能为这次显式请求执行历史恢复；不保证其拥有完整 Agent 对话记录。
8. macOS 终端已启用鼠标报告时，滚轮遵循应用的鼠标协议；Shift 保留显式历史浏览。
   兼容输入识别 CSI 与 SS3 两种方向键；Mac 端对单个 SS3 方向键归一为 CSI，以兼容旧 Host。
   原生输入流和 bracketed paste 不做此归一化。验收使用实际 SwiftTerm 按键事件、隔离 WebSocket
   peer 与 Herdr API fixture；不能替代用户正在运行的 Codex 会话验收。
9. macOS 的 Codex 会话保留原生终端。0.3.32 强制使用兼容快照的方案已撤回：快照没有光标与
   resize 契约，也不能代表完整历史。原生 `terminal.scroll` 必须带当前视口中心坐标；省略位置
   会落在 Codex 固定标题区。Herdr 的 mouse-report 分支每条命令只产生一个事件，故 Host 将
   有界行数拆成单行命令，保留滚动量，同时兼容普通终端 scrollback。输入、关闭与 Agent 生命周期
   不变。验收同时覆盖光标、窗口缩放、远超一屏的历史及反向返回，不能用输出字节变化代替画面比较。

## 后果

- 远端能看到所有 workspace/pane/agent 与工作状态，并操作原来的 Agent；没有额外 agent 进程或 PTY。
- Herdr 的 ANSI viewport 以 clear/home 全屏重画投递；Android 默认使用不改变桌面 pane 几何的
  移动阅读视图，并可切回原始桌面画面。两种模式都只对已 attach pane 建 output watcher。
- Herdr pane 的尺寸以 Herdr layout 为准，远端窗口不会反向改用户布局。
- TB 创建时注入的 `TB_SESSION`/bridge token 不存在于早已运行的 Herdr pane，所以 `tb peer`
  反向工具能力仍只天然适用于 TB 自建 session；原生 Herdr 交互本身不受影响。
