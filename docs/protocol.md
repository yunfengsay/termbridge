# termbridge 线协议

## 内网直连传输与配对

Node Relay 提供可选的无认证 HTTP 诊断入口 `HEAD / GET /.well-known/termbridge`：返回 HTTP 200、`X-TermBridge-Service: relay-v1` 与 `Cache-Control: no-store`；GET 正文固定为 `{"service":"termbridge","version":1,"transport":"websocket"}`，HEAD 无正文。不返回 Host、会话或凭据，不授予访问权限，也不改变控制消息模型。客户端识别不到此入口（例如旧版返回 426）仍可尝试原有 WebSocket 握手；Host／会话列表始终在原有认证后读取。

App 内置内网服务使用 `ws://IPv4:端口`，沿用 `auth_challenge`、HMAC `auth_response` 和 Host 路由，不增加或修改消息字段。WS 本身不加密传输。`termbridge://pair?v=1` 配对码只在 `mode=direct` 时接受 WS，且不能携带 TLS `pin`；其它配对仍要求 WSS。原有 WSS 配对和已保存连接继续支持，新建内网连接默认关闭 TLS，旧版服务通过客户端的兼容选项连接。详见 [内网直连](lan-direct.md)。

## 完成事件校验与 Global 文件预览

- `brain_completion_action { requestId, id, action: "approve" | "dismiss" }`：已认证客户端的明确确认。`id` 格式为 `completion-` 加 32 位小写十六进制字符；不能由模型工具自行批准。
- `brain_completion_result { requestId, ok, error? }`：操作回执。已派发的任务不能通过 dismiss 伪装成已撤销。实际进展由同 ID 的 `completion_review` 工具卡片持久化并更新；卡片里的 `:handoff` 项先显示应用内确认，再发送 approve。
- `session_file_read.sessionId="@global"`：仅从 `TB_BRAIN_FILES_ROOT`（默认 `~/code`）读取，不继承额外预览目录。沿用分块、版本、大小上限和私密路径检查。普通 session ID 仍绑定各自工作区。

详见 `docs/decisions/0021-completion-review-and-mobile-artifacts.md`。

## 悬浮屏幕上下文

- Android → Host `brain_voice_presentation {requestId, presentation: foreground|overlay}`：仅接受当前连接拥有的活动 Call；状态去重，不含任意 Prompt、屏幕像素或权限声明。
- Host 生成 `<system-reminder source="phone-presentation">`，写入独立 `systemReminders` 会话历史（最多 100 条），而不是 `messages` 或 `hidden` 聊天气泡。Android/iOS 聊天列表不渲染此集合。旧会话状态不作为新 Call 的实时状态。
- Omni 通过官方 `session.update.instructions` 系统提示通道收到最新 System Reminder，不伪造用户消息，不触发 `response.create`；完整状态历史由 Host 持久化。Execution Fork 同时获得当前 Call 状态，静音执行也适用。其他实时提供商通过共用 Fork 获取实时状态。接口依据：https://www.alibabacloud.com/help/en/model-studio/client-events
- `phone_action {action: "screen.capture"}` 复用四档手机审批策略。Android MediaProjection 系统同意仍不可跳过；不在悬浮时自动截屏，不持续采集。动作初始为 `awaiting_user`，最终为 `completed/denied/failed/cancelled`；完成结果的 `imageAttachment` 使用现有加密图片句柄协议。
- Fork 等待真实回执后调用 `inspect_images`，或将确切附件交给编辑 Worker。60 秒未完成保留 actionId 并报告等待/超时，不能假装已读取。画面文本是不可信数据，不能扩大工具权限。截图审批不授予相册全量读取权限。

## 通话内静音执行

`brain_snapshot_result.silentCall` 声明通话内高级模型静音执行能力。`brain_voice_start` 新增可选 `workflow: standard | silent`（缺省 standard）和 `modelTier: advanced | deep`。silent 保留 `brain_voice_input_audio/commit/stop/cancel` 和 transcript/text/status/tool_result 回执，但使用 ASR 加高级执行模型，永不返回 output_audio。outputMode 不再决定模型路由；两条执行路径间切换需关闭旧 requestId 后用新 ID 启动，客户端保留同一通话表面和历史。旧客户端不传字段保持原行为。详情见 [voice-silent-call.md](voice-silent-call.md)。

## 语音输入（ASR，不是实时通话）

- `brain_snapshot_result.dictation?: boolean` 声明支持独立转写、明确收尾及取消；旧 Host 未声明时客户端不开始录音。
- `brain_transcribe_start` 新增可选 `hints?: string[]`，最多 64 项、每项 64 字符；用于技术词和发送词的 ASR corpus，不是系统提示。
- `brain_transcribe_audio` 仍为 16 kHz、单声道 PCM16；`brain_transcribe_commit` 只结束一个识别片段，不派发任务。
- `brain_transcribe_finish` 收尾；`brain_transcribe_result.finished?: true` 确认该会话已结束，普通 `final:true` 只代表一段话结束。
- `brain_transcribe_cancel { requestId }` 关闭转写、不再回传旧片段。客户端离开前台或手动编辑后保留可见草稿，取消剩余录音与旧结果。
- 只有用户点击发送或最终转写匹配明确发送词，才发送独立 `brain_send`。执行仍用兼容的 `workflow:"silent"` 值，但 UI 不再称“高能力模式”。

## 高能力静音文字通道

- `brain_snapshot_result.workflows?: ("standard" | "silent")[]`：Host 能力声明。缺省视为旧 Host，不允许客户端悄悄把 silent 当作普通文字请求。
- `brain_send` 新增可选 `workflow: "standard" | "silent"` 与 `modelTier: "advanced" | "deep"`；缺省仍为原文字流程。客户端不可指定任意模型 URL。静音只关闭实时音频链路，沿用同一对话、工具、历史与 Agent roster。
- `brain_cancel { requestId }` / `brain_cancel_result { requestId, cancelled }`：停止当前静音编排，非原生操作回滚或所有 Worker 的级联停止。
- `brain_text_result { requestId, status: "completed" | "failed" | "cancelled", text }`：向请求方与已注册手机管理通道发送明确终态，`text` 上限 2000 字符；完整文本仍在 timeline。实时通知不是离线投递保证。
- `ExecutionForkEvent` 新增可选 `workflow` 和 `fork_cancelled` 终态；通过原有 `brain_execution_event` 与快照持久化。运行 ID 是 requestId，跟踪 ID 为 `fork-<requestId>`。

状态机、超时、模型配置和兼容边界见 [silent-mode.md](silent-mode.md)。

定义在 `@termbridge/protocol`（`packages/protocol/src/frame.ts` + `messages.ts`）。
所有断言由 [集成测试](./testing.md) 守护。

## 帧格式

### 可选后台省流量订阅

客户端发送 `{ t: "client_stream_policy", background: boolean, notifications: boolean }`，Host 原样以
`client_stream_policy_result` 确认。默认未订阅时保持旧行为；仅收到确认后客户端才停止旧轮询。
设置不改变代理/VPN 路由，不影响主动语音、工具执行或 Peer 文件传输。

- `background=true`：Host 不发送 Brain 全量快照或内部执行事件；客户端停止发出列表、Brain 快照轮询。
- `notifications=true`：用于管理连接。先发一份紧凑 `session_list_result` 基线，然后仅在 Agent 身份、状态、
  完成时间或集合变化时再次发送；不含 preview、终端文本，cols/rows/viewers 为 0。客户端用状态差异生成通知。
  Android 在实际生成提醒后，可复用 `agent_chat_subscribe` 读取一次该会话快照，随即 unsubscribe；
  同时最多一个读取，排队最多八个，五秒超时。只从本轮 user/assistant 的 text 块补充通知标题和正文，
  不使用工具输出或上一轮答案。切换 Host、断线、状态变化会取消读取；迟到结果不得重建已清除的通知。
  当前是“变化时发送紧凑状态列表”，不是持久化通知队列；断线期间的瞬时状态变化仍不保证重放。
- 恢复 `background=false` 后客户端主动拉取页面快照。后台悬浮通话保留音频和工具控制，不轮询页面。
- 手表或其他后台主动发起的 `brain_send` 仍收到本请求的执行事件及回答：回答复用
  `brain_snapshot_result`，仅含该请求的 assistant 消息、空 tasks，不含全局 history/toolCatalog。
- Android 全局设置“前后台分离省流量”默认关闭、独立于 Host tab 持久化；管理连接开启后始终使用紧凑通知，
  页面连接依据 APP 前后台切换。旧 Host 没有确认时保留原同步，避免静默丢通知。iOS 暂未提供 UI，保留旧行为。

验证：`packages/host/src/clientTraffic.test.ts`、`scripts/test.ts` 的后台订阅场景，以及 Android 设置界面测试。

每条 WebSocket 消息 = 一个二进制帧：

```
[type:u8][payload...]
```

| type | 名称 | payload |
|------|------|---------|
| `0` | `Control` | `msgpack(ControlMessage)` |
| `1` | `PtyOut` | `[sid:u16 BE][bytes]` 宿主 → viewer |
| `2` | `PtyIn`  | `[sid:u16 BE][bytes]` viewer → 宿主 |
| `3` | `PtyResize` | `[sid:u16][cols:u16][rows:u16]` |

- `sid` 是**每个客户端连接**内协商的 16-bit 会话索引（attach/create 时由宿主分配）。
  一条 WS 连接靠 `sid` 多路复用多个会话。
- PTY 与旧版 Herdr viewer 的终端数据走**裸二进制**。协商了 `mobilePatches=true` 的 Herdr
  移动 viewer 改走下述结构化控制消息，只发送变化行；普通 PTY 热路径不受影响。

### 手表本地 companion 子协议

Android 与 S3A3 手表之间另有一条不经过 Relay 的加密 BLE GATT 链路。它使用九字节
`TB` 分片头：`magic[2], version:u8, type:u8, sequence:u16 BE, flags:u8,
totalLength:u16 BE`。`0x30` 到 `0x35` 分别是骑行快照、导航提示、日常快照、工作快照、
骑行命令和手机命令；消息 ID 同步定义在 TypeScript、Android、iOS 与固件中。

工作相关的 `0x33`/`0x35` 必须同时携带 `hostId` 与 `sessionId`，不能用手机当前 profile
猜测目标 Mac。空的 `sessionId` 与 `title` 表示清除旧工作卡。骑行快照版本 2 把有符号
海拔（分米）编码为无符号 `elevationDecimeters = actual + 100000`，解码后范围为
`-100000...100000`；版本 1 的非负海拔只为旧固件兼容保留。

## relay 信封（仅 relay ↔ host 链路）

```
[clientId:u32 BE][frame...]
```

- relay ↔ **client** 链路传**裸帧**（client 在握手时已选定 host），所以 client/host 的协议
  在有无 relay 时完全一致。
- relay ↔ **host** 链路才需要 `clientId` 维度，因为一个 host 扇出给多个 client。
- **`clientId = 0` 保留给 relay 控制平面**（如 `host_register_ok`）；真实 client 从 1 起编号。

### 不变量（破坏即 `unknown frame type` 崩溃）

1. 鉴权握手之后，每条 **relay → host** 消息都必须带信封 `[clientId][frame]`，**包括**
   `host_register_ok`（用 clientId 0）。
2. 每条 **client ↔ relay** 消息都是**裸帧**，绝不带信封。
3. 同一条逻辑流内帧序保持（单 WS 连接天然有序）。
4. `auth_challenge` / `auth_response` 在 `hello` 之前。对 host 而言 `auth_challenge` 是**裸帧**
   （信封从 host 发出 `hello`、relay 回 `host_register_ok` 起才计），别拿它去 `decodeEnvelope`
   ——否则又会重演 4 字节切割崩溃。密码用 `HMAC-SHA256(secret, nonce)`，**明文不过线**；
   要连内容也加密就把 relay 放到 `wss://` 后面。

> 历史教训：`host_register_ok` 最初漏了信封，host 把它当 `[clientId][frame]` 切掉 4 字节 →
> 解析崩溃。见 [ADR-0001](./decisions/0001-p0-relay-pure-trust.md) 与 troubleshooting。

## 控制消息（msgpack，判别字段 `t`）

### Global 语音回复的持久状态

`BrainMessage` 增加可选 `voiceStatus: streaming | completed | interrupted`。
仅语音回复使用：同一回复从流式检查点到结束始终复用同一 `id`，客户端按 ID
更新而非追加；`completed`/`interrupted` 为终态，迟到的字幕不能重新打开它。
旧客户端可以忽略该字段，旧记录缺少该字段按既有完整回复处理。
`interrupted` 表示生成/通话在本地观察到中断，不代表已经得到精确的播放游标。
UI 保留已收到文字并标注中断，重建模型上下文时暂不把这些不完整回答当作完整回答。

| `t` | 方向 | 字段 | 含义 |
|-----|------|------|------|
| `hello` | peer → relay | `role`('host'\|'client'), `hostId`, `name?`,`wantsHosts?`,`wantsTopology?`,`clientInstanceId?`,`replaceExisting?`,`hostInstanceId?` | 握手；client 可选择订阅在线 Host 清单，relay 据此配对，不转发给 host |
| `host_register_ok` | relay → host | — | 注册成功（信封 clientId 0） |
| `host_list_result` | relay → client | `hosts[{hostId,name}]`,`selectedHostId?` | 返回在线 Host 与当前路由；仅发送给 `wantsHosts=true` 的客户端，Host 上下线时更新 |
| `relay_topology` | relay → peer | `relayId,selfNodeId,selectedHostId?,generatedAt,nodes,edges,truncated` | 仅 `wantsTopology=true`；Host 使用 clientId=0 信封，client 使用裸帧；节点变化时发送完整快照 |
| `auth_challenge` | relay → peer | `nonce`,`required` | 连接建立即发（裸帧，**先于** hello）；`required`=relay 是否设了密码 |
| `auth_response` | peer → relay | `mac` | `HMAC-SHA256(secret, nonce)` 的 hex（无密码则空串）；relay 校验通过才进 hello |
| `client_connect` | relay → host | — | 合成消息，告知 host 有 viewer 接入（clientId 在信封里） |
| `client_disconnect` | relay → host | — | viewer 断开 |
| `network_policy_get` | client → host | `requestId` | 读取对应 Host 在本机持久化的 Relay 网络策略；手机不是配置真源 |
| `network_policy_set` | client → host | `requestId`,`policy`(`system`/`direct`) | 设置对应 Host 的 Relay 网络策略。`system` 跟随系统及代理环境，`direct` 忽略应用层代理；不能越权重配第三方系统 VPN |
| `network_policy_result` | host → client | `requestId`,`policy`,`changed`,`proxyDetected` | Host 确认已持久化的策略；`proxyDetected` 只表示 Host 环境对当前 Relay 命中了 HTTP(S) 代理。策略变化后 Host 重拨 Relay |
| `error` | relay/host → peer | `message` | 错误并通常随后关闭 |
| `session_create` | client → host | `agent?`,`command?`,`args?`,`cwd?`,`cols`,`rows` | 新建会话。`agent` = 预设名(host 用 `~/.termbridge/config.json` 解析成 `<shell> -lic "..."`，加载登录与交互配置);`command` = 原始直 exec;都没给则 `$SHELL` |
| `session_created` | host → client | `sessionId`,`sid` | 会话已建 |
| `session_list` | client → host | — | 请求会话列表 |
| `session_list_result` | host → client | `sessions[]` | 必含 `sessionId,command,cols,rows,createdAt,viewers`；可含 `source`(`pty`/`herdr`),`name`,`workspace`,`paneId`,`agent`,`status`,`completedAt`,`preview`。`name` 是客户端展示/播报优先使用的 Herdr 名称，`sessionId` 只用于路由；`completedAt` 是 Host 实时观察到进入 `done` 的时间 |
| `attach` | client → host | `sessionId`,`cols`,`rows`,`presentation?`,`mobilePatches?`,`nativeTerminal?` | 接入已有会话；Herdr 可选 `mobile` 获取线性视图。新版原生客户端同时声明 `mobilePatches=true`，旧客户端不声明并继续接收 ANSI 整屏刷新 |
| `attach_ok` | host → client | `sessionId`,`sid`,`nativeTerminal?`,`historyScroll?` | 接入成功，随后回放画面；`nativeTerminal=true` 确认原生 Herdr 终端流已就绪；`historyScroll=true` 表示兼容终端支持按需历史滚动，缺省为不支持 |
| `terminal_mobile_snapshot` | host → client | `sid`,`revision`,`payload` | 首次 attach 或重同步的完整结构化行快照；`payload` 是 UTF-8 JSON bytes，行由受控 `text`/`style`/可选 `href` spans 组成。`href` 只允许无凭据的 HTTP(S) URL；Host 可从 OSC 8、裸 URL 或本机 Agent 原始 Markdown 恢复目标，不能从仅剩标签的屏幕文字猜测 URL |
| `terminal_mobile_patch` | host → client | `sid`,`baseRevision`,`revision`,`payload` | Herdr 移动视图增量。Payload 只携带稳定连续块两侧的变化行；客户端必须保留稳定 DOM 节点并校验 base revision |
| `terminal_mobile_resync` | client → host | `sid`,`revision?` | Patch 乱序、丢失或校验失败时请求完整快照；Host 用连接内 sid 定位精确 Herdr viewer |
| `kill` | client → host | `sessionId` | 杀 TB 自建会话；Herdr pane 拒绝并由 Herdr 保持所有权 |
| `session_exit` | host → client | `sessionId`,`exitCode` | 进程退出，广播给所有 viewer |
| `agents` | client → host | — | 请求 host 的 agent 预设名（给 `tb new` 菜单） |
| `agents_result` | host → client | `names[]` | 预设名列表 |
| `review_snapshot` | client → host | `requestId`,`sessionId`,`mode`,`baseBranch?`,`path?`,`repository?` | 请求当前 Session 所在仓库的结构化审阅；`mode=working/branch/files` 分别表示未提交改动、分支改动和项目文件。`path` 只能是同模式文件清单已返回的仓库相对路径，不能指定任意主机路径。`repository` 只能是同一 Session 的 `review_repositories_result` 已列出的 `repositoryPath`，其余一律以 `Unknown repository for this conversation` 拒绝；省略时仍是 Session 工作目录所在仓库 |
| `review_repositories` | client → host | `requestId`,`sessionId` | 列出与这次对话相关的全部仓库：Session 工作目录所在仓库，以及 Agent 自己的结构化记录（Codex `FileChange`/patch、Claude `Edit`/`Write`/`MultiEdit`/`NotebookEdit`）中改过的文件所在仓库。不根据终端文本或 shell 命令猜测 |
| `review_repositories_result` | host → client | `requestId`,`sessionId`,`repositories[]?`,`error?` | 最多 12 个，工作目录所在仓库（`current=true`）在前，其余按本次对话改过的文件数排序。每项含 `repository`,`repositoryPath`,`branch`,`detached`,`current`，当前未提交改动 `files[]`（不含 hunks，最多 200）、`changedFileCount`,`additions`,`deletions`,`truncated`，以及本次对话改过的仓库相对路径 `touched[]`（最多 500，可能已提交或无差异，`touchedTruncated?`）。单个仓库读取失败时只在该项带 `error` |
| `review_probe` / `review_probe_result` | client ↔ host | `requestId`,`sessionId` → `available`,`mode?`,`error?` | Terminal 顶栏使用的轻量探测；仓库即使没有改动也返回 `available=true,mode=files`，让用户浏览项目。若有未提交或分支改动则分别优先进入 `working` 或 `branch` |
| `review_snapshot_result` | host → client | `requestId`,`sessionId`,`snapshot?`,`error?` | Diff 模式仓库首屏总计 4,000 行，指定 `path` 后单文件最多 20,000 行。`files` 模式返回最多 20,000 个 Git 已跟踪及未忽略的未跟踪文件元数据；选中文件后按需返回最多 8 MiB / 20,000 行源码。二进制、符号链接和超限内容不读取，所有截断均显式标记 `truncated`。私密配置（`.env*`、密钥、凭据等，与文件预览同一规则）只列出路径，带 `private=true` 且没有 hunks：已跟踪的保留 Git 统计的行数，未跟踪的根本不读取，`files` 模式选中也不返回内容。`\ No newline at end of file` 是一条没有行号的 `context` 行 |
| `review_switch_branch` | client → host | `requestId`,`sessionId`,`branch` | 请求切换到 Host 已枚举的本地分支；Host 只在 worktree 完全干净时执行，不接受路径、force 或远端操作 |
| `review_switch_branch_result` | host → client | `requestId`,`sessionId`,`ok`,`branch?`,`error?` | 分支切换结果；成功后客户端重新请求 snapshot |
| `agent_chat_list` | client → host | `requestId` | 请求可用图形对话列表；这是同一批已运行 Agent 的第二个视图，不创建也不接管任何会话 |
| `agent_chat_list_result` | host → client | `requestId`,`conversations[]` | 每项含 `conversationId`,`paneId`,`status`,`chat`，可含 `provider`(`codex`/`claude`),`title`,`workspace`,`reason`。`chat=true` 表示可以打开对话视图：已找到经过身份校验的结构化记录，或者是已识别的 Codex/Claude Agent 且记录尚未写入（刚启动、还没有对话）。`chat=false` 表示不是已识别的 Agent，或记录与会话身份矛盾，客户端只能回到 Terminal 并显示 `reason`，不得用终端文本近似 |
| `agent_chat_subscribe` | client → host | `requestId`,`conversationId`,`generation` | 订阅一个会话的对话事件。`generation` 由客户端自增并由 Host 原样回带，切换会话后旧 generation 的事件必须丢弃；每个连接只订阅当前正在看的会话，最后一个订阅退订即释放 Host 的 watcher |
| `agent_chat_unsubscribe` | client → host | `conversationId` | 退订；不影响 Herdr pane 的生命周期、焦点和布局 |
| `agent_chat_snapshot` | host → client | `requestId`,`conversationId`,`generation`,`status`,`capabilities`,`messages[]`,`seq`,`binding?`,`earlierCursor?`,`error?` | 打开时的有界窗口，记录被轮转/截断后的重建，或等待中的会话找到记录后的替换。`binding` 固定绑定 `hostId+conversationId+provider+providerSessionId`（外部会话另带 `paneId`；等待中的会话 `providerSessionId` 可为空）。`status` 为 `loading/ready/working/empty/unavailable`；`unavailable` 必带 `error`。同一订阅下可能收到多个 snapshot（同一 `requestId` 和 `generation`），后到的整体替换先到的 |
| `agent_chat_append` | host → client | `conversationId`,`generation`,`status`,`capabilities`,`messages[]`,`seq` | 自上次以来新增的记录，或仅状态/能力变化时的空 `messages`。`messages[].id` 在同一会话内稳定，重连按 id 去重 |
| `agent_chat_earlier` | client → host | `requestId`,`conversationId`,`generation`,`cursor` | 向上翻页；`cursor` 是 Host 自有的不透明位置，客户端不解析也拿不到记录文件路径。`generation` 必须是当前订阅的那个，Host 据此拒绝已切换视图或已退订的请求 |
| `agent_chat_earlier_result` | host → client | `requestId`,`conversationId`,`generation`,`messages[]`,`atHead`,`cursor?`,`error?` | 更早的一页；`atHead=true` 表示已到历史开头。`generation` 原样回带**请求里的那个**（不是当前的），这样客户端用与其它事件相同的规则丢弃过期结果；被拒绝时 `messages` 为空并带 `error` |
| `agent_chat_send` | client → host | `requestId`,`conversationId`,`text` | 通过该 Agent 已有的输入通道发送一条消息，不启动第二个 provider 进程 |
| `agent_chat_delivery` | host → client | `requestId`,`conversationId`,`generation`,`state`,`at`,`messageId?`,`error?` | 回执链。`accepted`=Host 已受理；`delivered`=输入通道已接受字节；`observed`=该 Agent 自己的结构化记录里出现了这条输入（带 `messageId`）；`uncertain`=写入结果未知，**客户端不得自动重发**；`failed`=在任何写入前被拒绝，可以重试 |
| `brain_snapshot` | client → host | — | 请求 Global 持久化时间线 |
| `brain_snapshot_result` | host → client | `messages[]`,`tasks[]`,`toolResults[]?`,`routeDecisions[]?`,`runEvents[]?`,`deliverables[]?`,`toolCatalog[]?`,`executionEvents[]?`,`history[]?`,`voiceUsage?` | 当前 Global 快照；`toolCatalog` 是 Host 单一工具注册表的安全公开投影，`executionEvents` 是 Pi/Qwen Execution Fork 的模型与工具生命周期；不含隐藏推理、凭据和原始命令。其余账本字段保持原语义；全部新增字段可选，旧客户端继续读取原字段 |
| `brain_execution_event` | host → client | `event` | Execution Fork 的低延迟增量。`phase` 为 fork/model/tool 的 started/completed/failed，带 `forkId`,`requestId`,`createdAt`，并可带 `model`,`turn`,`callId`,`toolName`,`summary`。客户端按 Fork 和 call 聚合显示，不为每条事件创建大卡 |
| `brain_new` | client → host | — | 将非空当前对话完整归档后开始空白对话；已派发的 Agent 后续完成结果仍写回对应归档 |
| `brain_clear` | client → host | — | 永久清空当前对话和全部 History；有当前回复、Call 或任一归档中的运行任务时 Host 拒绝，避免丢失执行关联 |
| `brain_restore` | client → host | `conversationId` | 将指定 History 原子恢复为当前可继续输入的对话；非空当前对话会先归档回 History |
| `brain_history` | client → host | `conversationId` | 按稳定归档 ID 请求一条完整历史 |
| `brain_history_result` | host → client | `conversation` | 返回归档摘要以及 `messages[]`、`tasks[]`、`toolResults[]?`、`routeDecisions[]?`、`runEvents[]?`、`deliverables[]?`、`executionEvents[]?`；客户端以只读时间线展示 |
| `brain_send` | client → host | `requestId`,`text`,`agent?`,`clientPlatform?`,`sourceSessionId?`,`imageAttachment?` | 发送 Global 文本请求。Host 创建 Pi/Qwen3.8 Flash Execution Fork，并注入当前对话、Agent 状态、任务、Memory、来源 Session、图片句柄与完整 Tool Catalog。普通回答不创建本地进程，只有 `continue_agent` / `dispatch_agent` 才进入 Codex/Claude Worker。来源 Session 只作为隐藏数据，不能污染用户消息或任务文本 |
| `brain_voice_start` | client → host | `requestId`,`locale?`,`sendKeyword`,`mode?`,`provider?`,`agent?`,`technicalTerms?`,`imageAttachment?` | 建立 Host 侧持续听说会话；`provider=auto|bailian|volcengine` 允许每次 Call 在同一 Brain/工具 Harness 下切换实时语音前端。每个有效 utterance 仍只调用 `fork_execution`；`mode=call` 自动分轮，`dictation` 保留关键字提交 |
| `brain_voice_image_attachment` | client → host | `requestId`,`imageAttachment` | 通话中替换或清除当前图片批次；`null` 表示清除。Host 将批次保存在同一个 realtime call 上，因此 Activity 进入后台并显示悬浮球时上下文不丢失 |
| `brain_voice_input_audio` | client → host | `requestId`,`data` | 追加端侧 VAD/声纹放行的 16 kHz mono PCM16；AK 不经过 relay/client |
| `brain_voice_diagnostic` | client → host | `requestId?`,`event`,`provider?`,`fields?` | Android 实时上报不含音频、转写正文、Prompt 或凭据的阶段指标；Host 追加到 `~/.termbridge/logs/voice-events.jsonl`，供跨网与 ADB 联合排障 |
| `brain_voice_commit` | client → host | `requestId` | 提交一个本地 VAD 已结束的语音片段；Call 每段自动触发响应，Dictation 仅在转录以发送关键字结尾时触发 |
| `brain_voice_cancel` | client → host | `requestId` | 显式取消当前百炼响应（例如 Watch 控件）；正常语音插话继续上送音频，由 `semantic_vad.interrupt_response` 中断旧回答并建立下一轮，不取消已经派发的本地 Agent 任务 |
| `brain_voice_stop` | client → host | `requestId` | 结束持续通话会话 |
| `brain_voice_ready` | host → client | `requestId`,`provider?`,`model?`,`connectLatencyMs?` | 所选实时语音前端已就绪；客户端显示实际命中的厂商、模型与连接耗时 |
| `brain_voice_transcript` | host → client | `requestId`,`text`,`final` | 流式/句级用户转录；提交的完整 turn 同时写入 Global 历史 |
| `brain_voice_text` | host → client | `requestId`,`text`,`final` | Omni 对 Execution Fork 最终答案的语音前端文字增量；Global 历史以 Fork 返回的权威文本为准，避免双音色或二次改写造成重复记录 |
| `brain_voice_output_audio` | host → client | `requestId`,`data`,`sampleRate=24000` | Omni 原始 mono PCM16 增量，客户端用 `AudioTrack.MODE_STREAM` 播放 |
| `brain_voice_status` | host → client | `requestId`,`status`,`toolName?`,`toolPhase?`,`toolSummary?`,`latencyMs?` | `responding` / `listening` / `tool` / `echo`；工具过程有 started/completed/failed 和可见摘要，`echo` 表示丢弃回灌转录；`responding.latencyMs` 是最终转写到回复开始的首响耗时 |
| `brain_voice_tool_result` | host → client | `requestId`,`callId`,`toolName`,`view` | 当前 Call 的低延迟结果；Host 同时将相同内容写入 Global snapshot 的 `toolResults[]`。`view.kind` 仅允许 `agent_list` / `completion_list` / `task_list` / `agent` / `receipt`，最多 8 项；项可带 `sessionId` 和 `source` 供客户端打开 Terminal，不接受模型自定义 UI |
| `brain_voice_error` | host → client | `requestId`,`error` | 不含凭据/上游响应正文的安全错误 |
| `brain_voice_stopped` | host → client | `requestId` | Host 已关闭云端会话 |
| `phone_action_event` | registered app Peer → host | `eventId`,`actionId`,`requestId`,`callId`,`toolResultId`,`deviceId`,`action`,`state`,`summary`,`createdAt`,`data?`,`error?` | 手机授权或原生操作的异步结果。Host 以 `eventId` 去重，更新原 Global 对话的固定-schema 工具卡；`photo.count` 只返回统计，`photo.fetch`/`photo.edit` 的 `data.assets[]` 最多包含 3 个 24 小时随机句柄与有界元数据；`call.speaker.set(enabled)` 直接控制当前 Voice Call 路由并持久化偏好 |
| `phone_action_event_ack` | host → registered app Peer | `eventId` | Host 已持久化该手机动作事件；Android 收到 ACK 前保留 outbox，并在 Agent monitor 重连后重发 |

Host 调用 `phone.action` 时额外携带当前 Global 的随机 `conversationId`。Android 不把审批策略或会话 grant
上传给 Host；该 ID 只用于本地判断“单次对话只审批一次”，Global 新建、清空、恢复/切换时都会轮换。

`imageAttachment` 只传输系统 Photo Picker、受预算约束的 `photo.fetch` 或 MediaProjection 单帧明确授权的有界元数据：`actionId`,`deviceId`,`assets[]`，其中每个 asset 含随机 `assetId`、文件名、MIME、字节数和 SHA-256。图片字节仍通过 `phone.asset.read` 的端到端加密分块通道拉取；会话模型不能仅凭元数据声称看过图片。执行 Agent 收到固定的 `tb peer photo pull` / `photo publish` 指令，不能扩展本次句柄范围，也不能持续读取屏幕。
| `brain_transcribe_start` | client → host | `requestId`,`locale?` | 建立 Host 侧百炼实时 ASR 会话；AK 不经过 relay/client |
| `brain_transcribe_audio` | client → host | `requestId`,`data` | 追加手机本地 VAD/声纹门控后的 16 kHz mono PCM16 小块 |
| `brain_transcribe_commit` | client → host | `requestId` | 本地 VAD 已确定一句结束，提交当前实时缓冲区 |
| `brain_transcribe_finish` | client → host | `requestId` | 结束电话回合的实时 ASR 会话 |
| `brain_transcribe` | client → host | `requestId`,`mime=audio/wav`,`data`,`locale?` | 兼容旧客户端的一段式 WAV 识别 |
| `brain_transcribe_result` | host → client | `requestId`,`text?`,`final?`,`error?` | `final=false` 为实时预览，`final=true` 为该句最终原文；或返回安全错误 |
| `brain_synthesize` | client → host | `requestId`,`text`,`locale?`,`voice?` | 请求 Host 合成一段 Brain 回复 |
| `brain_synthesize_result` | host → client | `requestId`,`mime?`,`data?`,`sampleRate?`,`error?` | 返回内存 WAV；客户端播放完成后可继续下一轮监听 |
| `config_get` | client → host | — | `tb info`：请求 host 配置 |
| `config_set` | client → host | `name`,`command` | `tb set`：定义/改预设，host 持久化到 `~/.termbridge/config.json` |
| `config_remove` | client → host | `name` | `tb rm`：删预设 |
| `config_info` | host → client | `hostId`,`hostName`,`shell`,`agents`,`agentRegistry[]?` | 当前配置（set/remove 后回这个）。`agents` 保持命令行兼容；`agentRegistry` 只暴露稳定 id、显示名、runtime、purpose、capabilities 和可选默认 workspace，不暴露真实执行命令 |

### 图形 Agent 对话（`agent_chat_*`）

这是同一个已运行 Agent 的第二个视图，不是新的 Agent，也不是 Global Brain 的改版。
切换视图不重启、不接管、不复制会话，也不改变 Mac mini 上 pane 的焦点与布局。

- 身份来自 Herdr 快照：`conversationId` 是 TB 会话 ID，`providerSessionId` 是该 Agent
  自报的会话标识，外部会话另绑精确 `paneId`。Herdr 报告 `kind=path` 时直接使用该记录
  文件；只能由 `kind=id` 推导时，必须核对文件内自述的会话标识，禁止按“最新文件”或
  “相同 cwd”猜测。Codex 的 v7 会话标识自带创建时间，先查它所在日期的目录，再做有界遍历。
  定位失败是显式降级，客户端回到 Terminal 并展示原因。
- **记录尚未写入不算定位失败。** Agent 在第一轮对话时才写记录（Claude 刚启动时已报告
  标识但文件还不存在；Codex 在第一轮之前不向 Herdr 报告标识）。已识别的 Codex/Claude
  会话若只是“还没有记录”——没有标识，或标识指向的文件不存在、尚未写完第一条带标识的记录——
  Host 以等待中的会话打开：`status=empty`、`messages=[]`、`history`/`send` 为 `true`，
  可以发送第一条消息。Host 持续按同一身份查找，找到并核对通过后在同一订阅下推送新的
  snapshot 整体替换；此前发出的消息按记录自带的时间确认，早于发送时间的同文记录不算。
  文件指名的是另一个会话、或 Agent 已离开该 pane 时，推送 `unavailable` snapshot 并释放
  订阅，未确认的发送以 `uncertain` 结束。发出的消息约 20 秒后仍找不到记录时，
  `capabilities.degraded` 说明回复暂时只能在终端查看。
- 记录格式属于 Host 内部的版本化 adapter，不进入线协议。客户端只看到
  `text` / `tool-call` / `tool-result` / `image-ref` 四种有界块；模型内部推理、凭据、
  原始日志和 Host 文件路径都不上线。图片只保留 provider 自己记录的 http(s) URL 或文件名。
- 工具状态只来自 provider 记录：没有结果记录的调用显示为“进行中”，不得由终端文本
  推断成功或审批通过。首批 `capabilities` 中 `stop`/`attachments`/`approvals`/`questions`
  均为 `false`，客户端据此禁用对应控件并展示 `degraded` 原因，不用统一快捷键模拟。
- 回执只承认可验证的事实。`observed` 的判定限定为：发送前捕获的记录位置之后、同一
  `providerSessionId` 的新用户输入记录，且每条记录只消费一个待确认发送。没有 provider
  侧请求关联时，这表示“观察到匹配输入”，不承诺 exactly-once。写入结果未知时返回
  `uncertain` 并停止，不自动补发。
- `generation` 贯穿 subscribe / earlier 及其全部回包。它由客户端自增，Host 原样回带，
  绝不换成"当前"的那个：过期请求的结果因此被客户端按同一条规则丢弃，而不是写进用户
  已经切过去的视图。退订后、或订阅被释放又重建后的 earlier 请求一律被 Host 拒绝并带原因。
- 失去确认能力本身也是一种结果。确认窗口过期、或记录被轮转/截断导致偏移失效时，待确认
  的发送以 `uncertain` 结束并说明原因，绝不静默丢弃——否则客户端会永远停在"发送中"。
- 导航是设备本地的：active Host、当前会话、视图类型、草稿、滚动位置和侧栏宽度都留在
  客户端，Host 只广播消息本身。一个设备切换会话不会改变另一个设备在看什么。
- 附件复用 `session_upload`/`session_upload_result` 这一对帧，但**授权是独立的
  conversation 归属校验**：对话视图没有 attach，Host 改为检查这条连接当前是否持有该
  conversation 的 `agent_chat_subscribe` 订阅。两条路径都是 Host 自己发出的授权，
  客户端报一个 sessionId 仍然不够，也不允许为上传伪造 attach。
- 上传成功后 Host 返回它保存的路径，客户端把该路径写进消息文本（`[Image: <path>]`），
  与 Terminal composer 完全一致，因此 Agent 的消费路径没有变化。`capabilities.attachments`
  跟随 `send`：能发就能附图，旧 Host 仍报 `false`，客户端据此显式禁用。
- 普通文件扩展：`session_upload.mime = application/octet-stream`，可选 `fileName`
  最长 255 字符；最大 4 MiB，只存储不执行。Host 使用 UUID 文件名，仅保留末尾
  1–16 位字母数字扩展名，不信任原始路径；权限仍为目录 0700、文件 0600。
  `capabilities.fileAttachments = true` 才允许发送普通文件，缺省表示旧 Host 不支持。
  图片仍校验图片签名，普通文件保持原始字节，通过 `[File: <path>]` 随消息引用。
  Mac 允许在连接前选择本地附件，等待上传许可；选择不是授权，也不能绕过发送检查。
- 对话视图没有 attach，因此不能像 Terminal 那样写字节。控制键走 `agent_chat_key`/
  `agent_chat_key_result`：客户端只能**命名**一个固定集合内的键（escape/tab/enter/
  backspace/方向键/home/end/ctrl-c,d,z,l,u,w,r），字节由 Host 自己决定，客户端无法注入任意
  转义序列。授权与发送一致：必须持有该 conversation 的有效订阅，且 `generation` 与当前订阅
  一致，否则拒绝。写入是裸字节，不加 bracketed paste、不补回车——键不是提示词，包装它会顺带
  提交当前行。失败只回报，不自动重试。
- 停止当前回合与 `brain_cancel` 无关，后者不保证停止已派发的 Worker，不能当作通用中断。

P3 预留：`tools_register` / `tools_call` / `tools_result`（见 [architecture §6](./architecture.md)）。

## 握手与路由

```
任意 peer: ws.connect(relay)
        relay → peer: auth_challenge{nonce, required}      (裸帧，先于一切)
        peer → relay: auth_response{mac = HMAC(secret,nonce) 或 ''}
        relay: 若设了密码 → timingSafeEqual 校验；失败 → error + close
        —— 通过后才进入下面的 hello（无密码也要走这一步，mac 为空串）——

host:   send hello{role:host, hostId}
        relay: hosts[hostId] = ws; send host_register_ok (信封0)

client: send hello{role:client, hostId, wantsHosts?}
        relay: host=hosts[hostId]; clientId=host.nextClientId++
               host.clients[clientId]=ws
               send→host: 信封(clientId, client_connect)
               wantsHosts=true 时 send→client: host_list_result{hosts,selectedHostId}

之后:
  client→relay: 裸帧  ──relay──►  host: 信封(clientId, 裸帧)
  host→relay: 信封(clientId, 帧) ──relay──► client: 裸帧
  client 断开 ──► relay ──► host: 信封(clientId, client_disconnect)
```

宿主侧用 `Map<clientId, Map<sid, sessionId>>` 路由终端帧。`sess-N` 进入 `SessionManager` 的 PTY；
`herdr:<pane_id>` 进入 Herdr socket API。两类会话都用 `viewers: {clientId,sid}[]` 决定广播去向。

## 「中转(middle)」不是协议概念

`tb middle` 没有任何新线消息。它只是**每台机器拨向哪个 relay** 的本地设置，存在
`~/.termbridge/settings.json`（`@termbridge/settings`），host 与 client 用
`resolveRelayUrl()` 解析（优先级 env `RELAY_URL` > middle > `localhost:7400`）。
所以「用自己的 VPS 中转」= host 和 client 都把 relay URL 指到那台 VPS，协议帧/信封完全不变。
见 [deploy.md](./deploy.md)。

**wss/TLS 同理**:relay 用自签证书讲 `wss://`、两端按 `settings.tlsPin` 固定证书指纹——都是
传输层 + 本地设置,协议帧不变(真正的新线消息只有上面的 `auth_challenge` / `auth_response`)。

扫码配置使用版本化 URI：

`termbridge://pair?v=1&relay=<wss-url>&secret=<1..256>&host=<id>&name=<name>&pin=<sha256>&mode=<relay|direct>`

`host`、`name` 与 `pin` 为可选字段；`pin` 存在时必须是 64 位十六进制证书 SHA-256 指纹。
旧版没有 `pin` 的公开 CA 二维码继续可用；自签名 WSS 必须携带 `pin`。`tb1_…` 仅表示官方
Termbridge Cloud 的 32-byte base64url 房间密钥，不能用于表达任意自建 Relay。

`mode` 是可选的本地连接方式，不改变 WebSocket 帧。内网服务生成 `mode=direct`；客户端
保存并沿 Host 发现保留用户选择。没有该字段的旧公网 IP 配置继续使用 Relay，不能仅凭
IPv4 地址猜成内网并禁用系统代理。旧私有地址保留原有默认行为。自建服务允许 1–256 字符
密码（包含 4 位密码）；空密码不用于内网服务，留空设置时保留或自动生成。`tb1_` 的密钥格式不变。

### Herdr native terminal negotiation

CLI 0.1.24 对 Herdr `attach` 声明 `nativeTerminal=true`，Host 在 Herdr 原生流的首帧就绪后才
发送 `attach_ok`，并回传同名 true 字段。CLI 收不到确认时停止连接并提示升级 Host，
不把旧的画面快照当成原生终端。Android/iOS 的通用 ControlMessage 保留该可选布尔字段；
移动端不声明它，继续使用 `presentation=mobile`。

原生模式沿用 PtyOut/PtyIn/PtyResize 二进制帧。Host 以快照中的精确 `terminal_id` 调用
`herdr terminal session control`，转发 base64 ANSI 帧、原始输入和控制者窗口尺寸。
Host 将选定 API socket 通过 `HERDR_SOCKET_PATH` 传入，Herdr 自行解析配套 client socket。
不使用 `--takeover`；控制冲突明确失败。客户端离线、Relay 断开或启动失败时释放控制者子进程，
不关闭外部 pane。`nativeTerminal` 与 `presentation=mobile` 不同时使用。

macOS Desktop 在首次原生接入返回 `Herdr native terminal unavailable` 时，仅对同一 Host、同一 session 重试一次普通 `attach`，使用手机也支持的画面快照与输入通道。支持 `historyScroll=true` 的 Host 接受兼容模式的 `session_scroll`，按需读取 Herdr 历史；旧 Host 缺省不支持时客户端提示更新，不发送它无法处理的滚动请求。不会接管或关闭已有控制连接。旧 Host 已成功返回普通 `attach_ok` 时直接使用该连接，不重复 attach。认证失败、会话不存在等错误不触发回退。CLI 的原生模式确认要求不变。

Host 创建的 PTY 通过 `TB_SESSION` 标识其生命周期归属；新版 `tb init` 包装器在此环境中直接调用真实 Agent，不再创建第二层 Herdr 会话。手机原生 composer 在终端已启用 bracketed paste 时将文字封装为粘贴，再在结束标记之后发送独立回车；没有启用时沿用文字加回车。此行为不新增 wire 消息。

### Voice interaction control and personalization v2

`brain_snapshot_result.voiceLearning=2` advertises reviewed context learning; `1` is legacy numeric-only learning. Old
clients ignore it; an Android client selecting adaptive control requires it before starting.
The short-lived learning settings socket registers `peer.control-only` alongside
`voice.personalization`; device-tool routing excludes it so it cannot replace the durable
phone executor. These are strings in the existing capabilities array, not a new Peer role.
`brain_voice_start.turnControl` is `provider` (wire default for older clients) or `adaptive` (
Qwen Call only; not silent execution or Volcengine). Unsupported combinations fail explicitly.
Android now opts into adaptive by default, preserving any explicit user opt-out.
Adaptive control keeps Omni audio/ASR, uses `server_vad` for acoustic segmentation, `interrupt_response=true`, and sets
`create_response=false`. The Host alone permits a response after a bounded cloud text check.
ASR segments keep their original text and stable item IDs; their concatenation enters the
Global timeline once. Semantic interpretation is separate data, never a replacement caption.
An incomplete thought may receive one clarification after approximately 8 seconds of silence;
this uses a cancellable one-shot online TTS reply, not a provider response or task submission.
If Omni replies without the required execution fork, the Host suppresses that unverified reply
and runs the same authorized dispatcher once with the complete transcript. Host-generated IDs
are never sent to the provider as fabricated function-call receipts.
Only an observed `speech_started` can introduce a candidate item: late ASR after explicit
cancel cannot restart it. A new utterance after a 30-second pending-thought window expires
starts a fresh candidate with an explicit waiting/limit notice, not a concatenation with old speech.
`brain_voice_status.turnWaitReason` (`incomplete` / `unavailable`) means still listening,
not response completion: clients retain the pending caption and do not park the call.

`voice_learning_sync` (registered phone Peer → Host):

```typescript
{
  t: 'voice_learning_sync', requestId: UUID,
  revision: safePositiveInteger, enabled: boolean, contextConsent?: boolean,
  samples: [{ // at most 500, unique id, human reviewed only
    id: UUID, group: UUID, at: safeEpochMilliseconds,
    features: [speech, duration, pause, playback, recent, wake], // exactly six values in [0,1]
    head: 'addressed' | 'finished', label: 0 | 1, source: 'human',
    text?: string, context?: string // each <=320 characters; requires contextConsent=true
  }]
}
```

This is a complete bounded snapshot, not an append/gradient stream. Disabling sends an
empty sample list. Host derives the owner from the registered Peer, never a supplied path
or device selector. Same revision+content is idempotent; earlier/conflicting revisions
return `stale`. Revocation atomically erases samples/weights and retains a revision tombstone.
No raw audio, key, teacher output, unreviewed transcript or arbitrary extra field is accepted.
Reviewed short text requires independent context consent, checked before storage; legacy clients send no text.

`voice_learning_result`: `{t, requestId, revision, status, model?, assist?, error?}`.
Status is `completed`, `revoked`, `stale`, or `failed`. `model` has `schema:1`, bounded
`version`, `samples:0..500`, **`mode:'shadow'` only**, and two seven-element arrays
`addressed`/`finished` (bias then six weights, each finite in [-4,4]). The client applies
only a matching revision while local consent still holds; a late response cannot restore
deleted data. Errors also contain only JSON-safe integers, never echoed BigInt values.
`assist` has `schema:2`, `version`, `mode:context-assist|off`, `examples`, optional `rules`, `trainedAt`,
`trainingMs`, and `evaluation:{groups,tested,matched,correct}`. Evaluation is bounded leave-one-conversation-out
retrieval-label agreement (up to 20 groups/100 rows), NOT independently measured intent accuracy.
The TF-IDF case index supplements the cloud turn judge with at most four relevant reviewed examples.
Three distinct reviewed conversation groups with unanimous negative labels and exact text AND nonempty
previous context permit a local Host `wait`/`ignore` rule without a paid judge call. Any contradictory
label, changed text/context or deletion invalidates it. Positive labels NEVER create execution permission.
It cannot rewrite ASR, open microphone gates, grant tools, or claim speaker identity. Clear new user intent
overrides old examples. A not-addressed verdict clears the candidate without clarification or dispatch.
Consent/version are rechecked after inference, so revoked examples cannot approve a late verdict.

Phone storage: private `noBackupFilesDir/voice-control-v1.json`, 250 observations / 30 days,
two independently reviewed labels each. Host storage: private
`~/.termbridge/voice-personalization-v1/<SHA256(registered-peer-id)>.json`, 0700/0600.
After consent, reviewed changes sync automatically to the selected Host; reconnect retries pending snapshots.
Unreviewed observations do not change the training revision. Deletions must be
synced to **each previously used Host**; offline deletion is not claimed as remote deletion.
Each Host applies 30-day retention on startup and hourly. No new public server port is opened:
`tb serve` includes a bounded background training worker and uses the existing authenticated Peer channel.
`tb voice learning status --json` exposes counts/versions/validation, never text. The worker is packaged as
`dist/voice-learning-worker.js`; stale/failed/revoked results cannot replace newer local revisions.
Context consent explicitly permits retrieved text to be sent to the existing cloud judge; it does not
authorize cloud training, and local deletion cannot retract a request already processed by the provider.
The six-feature scalar heads remain shadow calibrators, not semantic DDSD encoders or speaker identity models.

The current Peer device ID is asserted over an authenticated Host connection. The hash is
path isolation, not hardware attestation or cryptographic isolation from other trusted
clients sharing the Host credential. Reinstall/identity reset requires explicit recovery;
do not lower a retained revision tombstone automatically.

### Desktop workspace file browsing and native scrolling

`session_file_read { requestId, sessionId, path, offset, version?, revision? }` requests one
128 KiB-or-smaller binary chunk. `revision: 'HEAD'` reads the file as committed
in its Git repository (also after it was deleted), with `version` naming the blob,
so a commit between chunks aborts the read instead of mixing two versions. `session_file_result` echoes the request and
session IDs and returns `{ name, path, rootPath, size, version, offset, data, eof }`
or a bounded `error`. Clients request sequential offsets, carrying the first
response's version on every following request; a changed file aborts the read.
Files are limited to 20 MiB. Close or a new file selection cancels local progress;
late replies must not replace the newly selected preview.

`session_directory_list { requestId, sessionId, path }` returns
`session_directory_result { requestId, sessionId, path, rootPath, entries,
truncated }`, with at most 1000 `{ name, directory }` entries. Directories are
loaded on expansion. Private configuration names, `.git`, and symlinks are not
listed. Every read/list resolves the selected session's current working directory
on its Host and checks the canonical target against that scope. Optional
`TB_FILE_PREVIEW_ROOTS` adds explicit Host-owned roots (OS path delimiter); it is
never supplied by the client. The repositories `review_repositories` lists for a
session are readable roots of that session as well; a repository its Agent never
changed is not. Paths may be relative, absolute, or `~/` (expanded
on the Host only). Sensitive configuration and key files are denied, including
symlink targets; non-regular files and directory escapes are denied. No shell
command or arbitrary HTTP request is executed by this channel.

macOS intercepts file paths and `file://` terminal links (with `:line`, `:line:col`
or `#Lline`) and uses one reusable inspector window, 文件与改动, bound to the
session's Host. Its 文件 mode is a collapsible lazy directory tree; the clicked
file is selected, revealed, and opened at its line. Every file gets a view:
known source and config (about 50 syntaxes, recognised by name, extension, or
shebang) is coloured in a read-only code view with line numbers and find; any
other text, including GB18030/Big5/Shift JIS/Windows-1252, is shown plain;
images, PDF, audio/video and office documents use native Quick Look; everything
else shows a hex dump. Text that a media type claims (`.ts`) is still text.
HTTP(S) links retain their browser behavior; this API is not a localhost HTTP proxy.
Preview files live in a private temporary directory, removed on selection change
or browser close. HTML preview is a single downloaded file; its separate assets
are not fetched through an implicit website proxy.

Its 改动 mode (also ⌘⇧G and the session footer) lists `review_repositories` as
stacked sections, the session's own repository first, each with its uncommitted
files and the files this conversation changed. Selecting a repository shows the
overview of all its diffs; selecting a file shows its diff or the whole file;
selecting a changed image compares the committed version (`revision: 'HEAD'`)
with the working copy side by side. A Host without `review_repositories` stays
silent for 10 s, after which the inspector falls back to the working directory's
`review_snapshot`. A Host that ignores `revision` is detected by its version not
starting with `HEAD:` and the before image is reported as unavailable.

`session_scroll { sid, direction: 'up' | 'down', lines: 1..100 }` belongs to the
client's attached Herdr viewer. For native streams the Host forwards Herdr's
`terminal.scroll` on the existing controller. For compatible terminal viewers
advertising `historyScroll=true`, the first upward user gesture reads
`pane.read(source=recent, format=text, strip_ansi=true, lines=2000)` and freezes
that viewer's history (at most 2000 lines / 1 MiB). Subsequent gestures use that
snapshot; live broadcasts do not reset its reading position. Scrolling to the
bottom or sending input returns to the current visible screen. No background
history reads, synthetic keys, new controller or takeover are used. An explicit
history read may invoke Herdr's alternate-screen history recovery; its available
history remains an upstream limit, not a guarantee of the entire conversation.
Cancellation, disconnect and replacement discard old replies. A history read
failure returns `session_scroll_result { sid, ok: false, error?: string }` without
disconnecting the terminal. Mobile reading views retain their existing contract;
ordinary PTY terminals retain local scrollback and application mouse handling.

## Windows computer peer tools

Host/CLI 0.1.27 adds `computer.tools` and `computer.call` within the existing
`tool_request` / `tool_response` frames. No new frame type, message variant or
native mobile model field is introduced. Android/iOS keep their existing generic
tool envelope and do not advertise or execute these Windows capabilities.

A Windows App registers a stable `peer_register.deviceId` with capabilities
`computer.tools` and `computer.call`. Host resolves these operations only against
matching registered executors, independently of the terminal's latest viewer.
It never falls back to a phone or session viewer for a missing computer executor.
Multiple computers require `args.deviceId`; the ambiguity error lists exact ids.
Computer-only peers do not participate in routing phone operations. Legacy
unregistered `exec`/`fs.*` clients retain single-viewer compatibility; registered
CLI peers use the device routing described below.

- `computer.tools { deviceId? }` returns `data` with platform, hostname, enabled,
  engine and MCP tool schemas. It is safe while assistance is disabled.
- `computer.call { deviceId?, name, arguments }` requires current local user
  permission and forwards only the Windows App's explicit desktop tool list.
  Arguments are bounded to 64 KiB. The response uses `stdout` containing MCP
  JSON content, `exit: 1` for MCP tool errors, or `ok: false` for bridge failures.
  Screenshots appear as MCP base64 image content. Results are capped at 4 MiB.

The Host-side bridge admits these explicit device operations through the same
owner-only local socket path as phone operations. Windows revokes permission on
disconnect, stop, app close or operation timeout; reconnect does not re-authorize.
Stopping prevents subsequent actions and does not undo actions already completed.
Implementation and VM acceptance evidence: `windows/README.md` and
`windows/docs/acceptance.md`.

## Multiple desktop peers on one Host

CLI attach/create registers through the existing `peer_register` schema on every
connection: `role: manager`, `platform`, `name`, and capabilities `peer.desktop`,
`peer.exec`, `peer.fs`. A random `cli-<UUID>` installation ID is stored in
`~/.termbridge/peer-id` (0600, atomically published); `TB_PEER_ID_FILE` isolates
tests. This is distinct from `hostId`, uses no raw MAC address, and is shared by
multiple CLI terminals on the same computer. Registration is not consent:
the executor reloads `tb expose` for every request; filesystem root restrictions
do not sandbox `exec` (which is full command execution and off unless exposed).

No wire fields, message variants, or Android/iOS model requirements change.
`peer.list` is a Host-local socket operation, not a broadcast tool request. It
returns one row per executor installation/authorization identity with `deviceId`, `name`, `platform`,
`capabilities`, active `connections` count and `attachedToSession`.

```sh
tb peer list
tb peer info --device <device-id>
tb peer exec --device <device-id> --timeout 10000 -- uname -s
tb peer read /tmp/report.md --device <device-id>
```

Routing order: exact requested device, otherwise eligible devices associated
with the current session, otherwise eligible devices anywhere on this Host.
Desktop operations only consider registered desktop capabilities. Generic `info`
prefers an associated desktop; Android actions only consider phone executors and
`computer.*` only considers matching Windows capabilities. More than one
eligible desktop identity returns an ambiguity error listing IDs; explicit
missing or incompatible IDs never fall back. Connections sharing a device ID
deduplicate to its newest active executor, independent of viewer order.
Control-only settings sockets cannot replace executors. Unregistered viewers
are never guessed to be legacy CLI executors: they fail immediately with an
upgrade/reconnect instruction instead of waiting 65 seconds. Older unregistered
CLI versions must upgrade; explicit capability registration is now required.

The native Mac App has one management connection per saved, authenticated Host,
independent of terminal windows, selected tabs and notification settings. It
advertises the same `peer.desktop`, `peer.fs`, `peer.exec` capabilities, but uses
its own `mac-app-<UUID>` identity and local Settings → Peer permissions. App and
CLI on the same Mac deliberately do not inherit each other's command grants.
`~/.termbridge/mac-peer.json` stores this ID and grants (0600 atomic replacement,
no backup). Grants are keyed by a digest of endpoint, Host ID, TLS fingerprint
and credential; changing these cannot inherit prior approval. No credential is
stored in this file. Files and commands default off. `info` and discovery remain
available with grants off; unsupported/unapproved tools return explicit errors.
File tools are bounded, directory-confined native operations; command execution
is separately enabled full current-user access, **not** a directory sandbox.
Maximum file read/write is 1 MiB, directory listing 1000 entries, retained stdout
and stderr 128 KiB each, command runtime 60 seconds, concurrent requests four.
Revocation cancels running processes and returns `data.status: cancelled` on the
original connection. Disconnect stops ongoing local commands but the Host reports
outcome unknown (not replayed); committed file changes are not undone. Reconnect
registers the same identity. Quitting the App closes the manager; no daemon is
installed. Ordinary Apple viewers reject `tool_request` immediately even when
an old Host attempts legacy routing. No Node installation is required for this
native executor. macOS privacy restrictions still apply.

Herdr desktop requests via the owner-only local socket must name a pane present
in Host's live Herdr registry. Arbitrary session strings, unknown operations and
invalid supplied tokens remain denied. Native app management does not acquire
shell permission. The receiving desktop still enforces local exposure.

Every pending tool request records the selected relay `clientId`; only a response
from that connection can complete it. Disconnect clears the pending request with
`execution outcome unknown`, never replays it on another device, and does not
claim the remote command was cancelled. A reconnected CLI sends old responses
only on the original socket (if still open), never its replacement.

Verification: `pnpm test:peer`; integration scenario 15b starts two actual CLI
processes plus a synthetic phone against an isolated real Relay/Host. It checks
phone-last attachment, explicit device selection, same-device reconnect,
Host-wide Herdr routing and live exposure revocation. This is a local network
integration fixture, not acceptance on the user's remote Mac.

Native Mac verification: build `dist`, then run
`node macos/TermBridgeControlCenter/scripts/test-mac-peer.mjs`. Two isolated Hosts
and two native Mac Peer services exercise real CLI read, native write/exec,
per-Host default denial, device ambiguity/selection, revocation → cancelled
receipt → actual PID death, and stable-identity reconnect. This fixture does not
read user reports, alter installed apps, or restart a deployed Host.
# Remote desktop v1

`desktop_subscribe {deviceId, foreground}` registers the current app surface for
generic `desktop_attention {id}` notifications. Region coordinates and prompt
text stay on the Host until the matching device opens the encrypted viewer;
the generic notification contains neither pixels nor dialog content. A pending
attention expires after five minutes and does not auto-open repeatedly after
the user dismisses the desktop screen.

`desktop_open {id, hostId, deviceId, publicKey, nonce, proof}` and `desktop_ready {id,
publicKey, salt, proof}` establish a private P-256 ECDH session. Public keys use
base64 raw uncompressed points. The existing pairing secret authenticates both
transcripts with HMAC-SHA256; desktop accepts the same nonempty 1–256 character connection password.
This inherits the existing pairing trust boundary: a party holding that shared
secret can authenticate as a peer. A self-hosted relay administrator who knows
the shared key remains trusted during establishment. Neither ephemeral private
keys nor desktop content are sent to the relay in plaintext.

HKDF-SHA256 derives separate host/client AES-256-GCM keys using a fresh 32-byte
salt and the Host/session/direction context. `desktop_data {id, sequence, data}`
carries at most 65536 plaintext bytes plus the authentication tag, base64 encoded
(maximum 87408 characters). Sequence starts at 1 in each direction and must be
strictly contiguous; its 32-bit big-endian value is the suffix of a 12-byte nonce
with eight zero bytes. AAD binds protocol version, session, direction and sequence.
Reconnect generates new keys. Decryption failure invalidates the session.

Decrypted byte 0 selects the payload: `0` is a fragment of an RFB 3.8 byte stream;
`1` is one bounded UTF-8 JSON command/event. Commands: start, display, text, key,
scroll, space, release, ping, close, ack, stream, viewport. `start.backend` selects auto/native/system.
Events: backend, display, displays, attention, pong, error. The native backend's
RFB uses Tight JPEG and DesktopSize with no separate password negotiation because
it exists only inside this authenticated encrypted channel. The system backend
forwards the byte stream to macOS screen sharing on loopback port 5900; its RFB
negotiation/authentication stays intact and its input uses RFB, not CGEvent.
Passwords stay in the viewer/server authentication exchange. Host does not open
a public VNC listener or change macOS sharing access policy. `desktop_closed {id, reason}` retires a session. Only one
mobile viewer owns capture/input; disconnect/background timeout releases all
held inputs. CLI read/inspect can coexist, while CLI writes reject a mobile owner.


### Desktop streaming capability 1

The encrypted `start` command optionally offers `streaming: 1` and `flowControl: 1`.
The encrypted `backend` event echoes supported values. Older peers omit/ignore
these properties and retain the original opaque RFB path; the outer native
`desktop_open`/`desktop_ready`/`desktop_data` models do not change. Android, iOS
and macOS use the same bundled viewer for this inner protocol.

With flow control enabled, the viewer sends encrypted `ack {sequence}` after
consuming each Host packet. Acknowledgements must follow packet sequence order. At most eight ordered packets (512 KiB of plaintext) remain unacknowledged;
local WebSocket write completion alone is not an end-to-end receipt. Missing
receipts retire the viewer after 15 seconds, and teardown cancels pending waits.

After RFB ServerInit and before SetEncodings/FramebufferUpdateRequest, a streaming
system viewer sends `stream {width,height}`. Authentication bytes remain opaque.
The loopback Mac connection then requests only Raw and DesktopSize encodings;
the Host compresses changed rectangles as standard Tight JPEG inside the existing
encrypted RFB stream. No new public listener or credential store is introduced.

`viewport {x,y,width,height}` uses integer pixels in the full desktop framebuffer.
The viewer uses the inverse of its render transform for both pointer coordinates
and the visible source rectangle. RFB incremental update requests cover this
rectangle; pan/zoom sends a nonincremental refresh for newly visible content.
In-flight older requests may finish, but output is intersected with the latest
viewport before compression. System quality adapts to downstream delivery time.
The native capture path caches visible tile hashes and sends only changed tiles.

## 内网中转与实时拓扑

### 普通 CLI 的 Peer 请求

已认证 client 可以向其选定的 Host 发送 `peer_call{id,op,args?,timeoutMs?}`。`id` 长度为 1–128；`op` 仅接受 `peer.list`、`peer.topology`、`info`、`exec`、`fs.read/write/ls/stat` 和 `termbridge.lan`；超时为 100–60000ms，请求上限 128KiB。除 list/topology 外，`args.deviceId` 必须显式提供精确设备 ID。Host 使用现有 Peer 路由和 `tool_request/tool_response`，目标设备仍逐次核验自己的按 Host 授权；注册能力不代表同意执行。

回复为 `peer_call_result{id,ok,exit?,stdout?,stderr?,data?,error?}`，只返回给原请求连接。每连接最多 4 个、每 Host 最多 64 个进行中请求；同连接请求 ID 不执行第二次，最多保留 128 个 ID，之后客户端需建立新连接。断线不声称执行已取消，不自动重试不确定请求。Android/iOS 通用控制模型可解码该回执，但不因此获得任意手机 shell 入口。

`peer.topology` 从 Host 当前收到的 Relay 快照读取，Relay 断开即清空。它不是设备端工具，也不触发网络扫描。

Mac Peer 仅在具备 `termbridge.lan` capability 时可接收同名工具，且要求当前 Host 的 execute 授权。远程 `args.action` 仅允许 `status`、`relay.ensure`、`sharing.join`；中转连接凭据只在已认证请求链路内传递，不进入拓扑或人类输出。取消或撤销授权会停止本次尚未完成的新服务启动，不替换已有服务。

本地 CLI 与 App 的控制接口为 owner-only Unix socket `~/.termbridge/app-control.sock`，不是 Relay 协议。换行 JSON 请求含 `version:1,action`，上限 8KiB；响应为 `{ok,data?,error?}`。本地另支持 `bridge`、`connection.add`、`update.check`。服务唯一所有者仍为 App；CLI 不修改 App 私有配置文件。套接字权限为 0600，并验证同 UID；已在使用的端点不被另一份 App 接管。

### 拓扑订阅

内网 App 的共享本机（Host）和提供中转（Relay）独立启停，可同时提供本机中转并向另一个中转共享本机。Host 使用本机中转时显式依赖该入口；客户端连接独立。旧 `direct/relay/join` 仅保留为旧配置迁移和 supervisor 启动参数，不再表示互斥的整机角色。传输沿用 WS 密码握手与 Host 路由，不增加 Agent 生命周期权限。

`hello.replaceExisting` 是 Host 专用可选布尔值。为 `false` 时，Relay 在注册点检查相同 `hostId` 是否在线；若已有不同实例的注册，发送裸 `error{message:"host already registered"}` 并关闭新 socket，不改变旧 Host、客户端或路由。Node 使用关闭码 4007，Cloudflare 使用 1008。`hostInstanceId` 是 Host 每次进程启动生成的 UUID，仅在同一进程的重连间保持；当已有注册的实例 ID 相同时，允许替换自己的旧 socket。该标识不进入 roster、拓扑或日志，也不能代替密码认证。省略或 `true` 保留旧版替换语义。App Host 启动前查询已认证 Host roster，并在注册时设为 false；旧 Relay 只有预检保护，新版 Relay 才提供并发原子保证。Android/iOS 客户端不发送此 Host 专用字段，通用 control 模型可保留它。

`hello.wantsTopology` 为可选订阅；旧客户端无额外事件，旧 Relay 忽略新字段。`hello.clientInstanceId` 为客户端进程 UUID，用于把同一 App 的多个连接合并为一个展示节点，不参与认证或授权。`hostId` 最长 128 字符；拓扑中的显示 `name` 截至 96 字符，兼容旧客户端的长设备名称。

当没有 Host 时，已认证的空 hostId client 同时声明 `wantsHosts` 与 `wantsTopology` 可作为只读观察者订阅。它没有 Host 路由身份，不接受终端或 Peer 请求；选定在线 Host 后需重新连接。

拓扑由 Relay 根据已认证、已完成注册且当前在线的 socket 生成；未认证或握手失败连接不展示。`nodes` 最多 128 个，每项 `{id,role:relay|host|client,name,hostId?,connections}`；`connections` 表示合并后的在线 socket 数。`edges` 最多 127 条 `{from,to}`，从每个 Host/client 指向 Relay。`selfNodeId` 指向接收方，`selectedHostId` 指向其当前访问目标。`generatedAt` 为毫秒时间，`truncated` 标记超限时优先保留本机、目标和 Host 的快照。名称仅是显示标签。

客户端断开后立即清除拓扑，不将旧图描述为在线；没有订阅支持时明确说明不可用。图中禁止包含密码、配对码、认证 nonce、云端 room key、文件路径或会话内容。Cloudflare 与 Node Relay 共用投影规则；Cloudflare 通过 WebSocket attachment 恢复拓扑所需状态。macOS 的内网设置显示服务端视角，客户端「连接拓扑」显示自己和当前 Host 的路径。Android/iOS 共享此模型，UI 可按窄屏使用路径卡。

### Optional CLI automation extension (0.1.38)

`config_info` adds optional `version` and `automation: true`. The client first requests `config_get`; a missing capability fails explicitly before executing anything. Mobile clients retain their existing model and ignore these additive fields; the extension is only requested by the CLI. No mobile frame type or existing message changes.

The existing Control frame carries `automation` messages with a random request `id`, `kind` (`request`, `data`, `ack`, `eof`, `result`, `cancel`), and optional `op`, `args`, `stream`, `seq`, `data`, `result`, `error`. Operations are `exec`, `push`, `pull`, `cat`, `audit`. Relays forward authenticated Control frames unchanged; deployment is unnecessary. Data is base64 in at most 64 KiB raw chunks, acknowledged only after the consumer writes it. Independent stdout/stderr streams each have one outstanding chunk. This bounds transport buffering without a file-size ceiling. `eof` terminates input; file EOF/final results carry SHA-256 and byte count. File destinations are committed by rename only after verification.

The Host owns request channels and foreground process groups. Disconnect/cancel revokes that channel and kills its process group; pooled connections translate a local socket disconnect into cancellation of only that socket's requests. Reconnect never replays a request. Capability handshake and pooled/direct connections use the same `client.ts` dial/pinning/HMAC path. Host option `remoteAutomation: false` rejects exec/fs before resource creation. Audit records only metadata and never serialize request `env`, streamed bytes, or output.

### Optional client-to-host TCP proxy tunnel (`proxy_tunnel`)

`config_info` adds optional `proxyTunnel: 'full' | 'loopback' | 'off'` (default `'full'` on updated Hosts). Authenticated clients may multiplex raw TCP streams through existing Control frames without relay changes using `proxy_tunnel`:

- Client → Host `open`: `{ t: 'proxy_tunnel', id, kind: 'open', host, port }` — Host normalizes `0.0.0.0`/`::` to `127.0.0.1`, enforces `config.proxyTunnel` (`off` rejects all; `loopback` allows only `localhost`/`127.x`/`::1`; `full` allows loopback, Host LAN, and upstream Internet), and dials `host:port`.
- Host → Client `opened`: `{ t: 'proxy_tunnel', id, kind: 'opened' }` once TCP connects.
- Bidirectional `data`: `{ t: 'proxy_tunnel', id, kind: 'data', data }` carries base64 TCP chunks (up to 48 KiB raw per frame).
- Client → Host `ack`: `{ t: 'proxy_tunnel', id, kind: 'ack', bytes }` replenishes the Host's 512 KiB downstream flow-control window (capped at 2 MiB) so streaming endpoints (MJPEG/WebSocket/SSE) pace smoothly to the link.
- Bidirectional `close`: `{ t: 'proxy_tunnel', id, kind: 'close', reason? }` destroys the upstream socket and logs metadata only (`clientId`, `host`, `port`, `bytesUp`, `bytesDown`, `durationMs`, optional `error`) to `~/.termbridge/audit.log` without ever recording payloads. Disconnecting a client or relay immediately destroys all of that client's active tunnels.
