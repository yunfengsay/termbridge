# termbridge 架构

> 这是详细设计文档。快速上手见根目录 [README](../README.md)；线路图见 [roadmap](./roadmap.md)。

## 1. 这是什么

在宿主机（如家里的 Mac mini）上既可用 `node-pty` 包裹任意终端程序，也可直接消费 Herdr
本地 socket API，把现有 workspace/pane 暴露给远程 viewer。通过一个 relay 转发，让
**任何网络下**的终端客户端凭一个 `hostId` attach。目标：

- 跨机器共用一台 Agent（共享你的 token 给家人/同事直接用）；
- 反过来，客户端把**自己机器的文件系统/CLI 能力注入回去**，让跑在宿主上的 Agent 操作
  客户端的文件（P3）。

## 2. 三种角色

整个系统只有三种角色：

| 角色 | 跑在哪 | 职责 |
|------|--------|------|
| **Host（宿主）** | Mac mini | 管理 TB 自建 PTY session，并通过 Herdr API 映射已有 pane |
| **Viewer/Controller** | 浏览器 / 别人的终端 | attach 到某个 session，看 PTY 输出、发键盘输入 |
| **Tool-Provider**（P3） | 客户端那台机器 | 把本机 fs/shell 能力暴露给宿主上的 agent 调用 |

**关键洞察**：Viewer 与 Tool-Provider 通常是**同一个客户端进程**。家人用网页 attach 时只是
Viewer；你在另一台 Mac 用 CLI attach 时，既是 Controller 又是 Tool-Provider——一条
`termbridge attach <id> --serve-tools fs,shell` 同时做了「控制远端 agent」和「把本机文件借给
它用」两件事。数据是双向的：

```
       键盘/控制  ─────────────────────────►
Viewer ──────────────────────────────────►  Host (Mac mini)
       ◄──────────────────────────────────   node-pty + agent + 你的 token
       ◄──── PTY 输出（终端画面）

       ◄──── tools.call（agent 要读你的文件，P3）
Tool-  ──────────────────────────────────►  Host
Provider ──── tools.result（文件内容）─────►
（同一个客户端）
```

## 3. 包结构（pnpm workspace）

| 包 | 状态 | 作用 |
|----|------|------|
| `@termbridge/protocol` | ✅ P0 | 二进制分帧 + relay 信封 + zod 消息 schema。所有人的共同语言 |
| `@termbridge/relay` | ✅ P0 | 会合/转发服务器，按 `hostId + clientId` 路由 |
| `@termbridge/host` | ✅ P0 | 宿主守护进程：PTY 会话管理 + Herdr API 适配 + 广播 |
| `@termbridge/cli` | ✅ P0 | 统一 `tb` 入口:`surf`(relay+host 一条命令)/ `new <agent>` / `ls` / 按序号接入。agent 预设在 `~/.termbridge/config.json` 映射到真实命令(套 `<shell> -lic`,登录配置、proxy/别名生效) |
| `@termbridge/web` | ⏳ P1 | xterm.js 仪表盘 |
| `@termbridge/transport` | ⏳ P1 | 浏览器/Node 共享的 WS 抽象 |
| `@termbridge/tools` | ⏳ P3 | 反向工具注入运行时 + MCP 桥 |

依赖方向（单向，无环）：`protocol ◄ relay/host/cli`。

## 4. 连接拓扑

P0 采用 **relay 优先**（你的决策）：宿主主动外连 relay，无需端口转发，天然穿 NAT。

```
模式 B · 中继（家人在外网也能用，已实现）
┌──────────┐         ┌─────────────┐         ┌──────────────┐
│ Web/CLI  │ ◄─────► │   Relay     │ ◄─────► │ Host(Mac mini)│
└──────────┘  ws/wss └─────────────┘  ws/wss └──────────────┘
                                   Host 主动外连
```

- relay 部署到一台有公网的小机器/云；Host 与客户端都设 `RELAY_URL`。
- 局域网直连（模式 A，mDNS 发现）留作后续优化项；当前一律走 relay。

## 5. 核心交互时序

### 新开一个对话（在宿主上拉起 codex）

```
CLI ──► Relay ──► Host : session_create {command:"codex", cols, rows}
Host        : pty = nodePty.spawn("codex", …)
Host ──► … ──► CLI : session_created {sessionId, sid}
CLI ──► Host : (键盘) pty_in {sid, bytes}
Host ──► CLI : (画面) pty_out {sid, bytes}   ← 持续流式
CLI ──► Host : pty_resize {sid, cols, rows}
```

### 会话持久 + 重新接入（tmux 式）

会话归宿主全局所有，**viewer 断开不杀会话**。宿主为每个会话维护一段 scrollback
环形缓冲（256 KB）；重新 attach 时先回放，画面无缝续上。

```
A ──► Host : session_create bash → 跑命令 → 输出进 scrollback
A 断开（detach），会话仍在
B ──► Host : session_list → 看到该会话
B ──► Host : attach {sessionId} → 先收到 scrollback 回放，再实时跟随
```

多个 viewer 可同时 attach 同一会话：输出广播给所有 viewer，输入来自任意 controller。

详细消息字段与分帧见 [protocol.md](./protocol.md)。

### 进入已有 Herdr pane（无第二层 PTY）

Host 启动和每次 `session_list` 时向 Herdr Unix socket 请求 `session.snapshot`，把每个 pane 映射
为稳定 id `herdr:<pane_id>`。attach 后仍复用 TB 的 `sid` 多路复用，但两侧不是 PTY：

```
Viewer ── PtyIn(sid, bytes) ──► Host ── pane.send_input ──► Herdr pane
Viewer ◄─ PtyOut(sid, ANSI)  ◄── Host ◄─ pane.read(visible) ─ Herdr API
                                      ▲
                 output event；不支持时轮询 pane.read 画面差异
```

- snapshot 同时带 workspace、pane、agent、状态和 pane 几何，客户端列表可明确显示来源。
- 首屏及画面变化都读取 Herdr 已渲染的 ANSI viewport；Host 用 clear/home 重画远端 xterm。Herdr
  0.8.0 的 schema 声明了 output event match、运行时却会拒绝，因此适配器会自动降级为仅对已
  attach pane 做 120ms 画面差异轮询。
- `PtyResize` 对 Herdr session 不改变布局；Herdr 仍是 pane geometry 的唯一所有者。
- TB 不 close/restart Herdr pane，避免远程 session 管理误删用户的 Herdr 工作。
- 现有 Herdr pane 没有 TB 创建时注入的 bridge token。桌面 Peer 调用必须经 owner-only
  Host socket，并核对 sessionId 确实存在于当前 Herdr registry；目标客户端仍逐次执行
  `tb expose` 校验。多端使用 Host 级设备登记与 `--device` 选择，不取最后一个 viewer。

## 6. 反向工具注入（P3，最技术的一块）

通常 MCP server 与 agent 同机。这里要做**「声明在宿主、执行在客户端」**的远程 MCP：

```
┌──────────── Mac mini (Host) ───────────┐
│ ┌───────┐  stdio/SSE  ┌──────────────┐ │
│ │ agent │ ◄──MCP────► │ 桥 MCP server│ │
│ │(codex)│             │ (转发到socket)│ │
│ └───────┘             └──────┬───────┘ │
└────────────────────────────────┼────────┘
                                 │ tools.call / tools.result
                                 ▼
                     ┌──────────────────────┐
                     │ 客户端 Tool-Provider │ ← 真正执行在对方机器
                     │  fs.read / shell.exec │
                     └──────────────────────┘
```

落地要点：

1. **注入**：宿主启动 agent 时写一份临时 MCP 配置指向本地「桥 server」。Codex / Claude Code
   原生支持 MCP，agent 一启动就带上桥工具，无需改 agent。
2. **桥 server**：宿主本地的 stdio MCP server，收到 agent 的 `tools/call` 不执行，按 sessionId
   转发给当前 attach 的 Tool-Provider，拿回结果再回给 agent。
3. **动态工具表**：客户端 `tools_register` 声明能力清单 → 桥 server 动态生成 MCP 工具定义；
   客户端断开 → 工具消失。
4. `@termbridge/tools` 内置 `fs` / `shell` / `git` 等能力组，各带 scope。

协议里已为此预留 `tools_register` / `tools_call` / `tools_result` 三条消息（P0 未实现）。

## 7. 安全模型

P0 默认**纯信任**（你的决策）：`hostId` 即唯一凭证，不做 scope/沙箱/预算。已加一层**可选密码**
（`tb secret` / `TB_SECRET`，HMAC 挑战应答，密码不过线；relay 设了才强制，localhost 仍免密）
拦住「谁能连」。其余按风险列出（双向都在交出信任）：

| 风险 | 对策（P2+） |
|------|------------|
| 谁能 attach 我的 Host | ✅ 共享密码（HMAC，`tb secret`/`TB_SECRET`，密码不过线）；进阶：邀请码（按 host 签发、带 role 与过期），owner 在 Web 签发/吊销 |
| 客户端工具被滥用读全盘 | `scope.paths` 白名单 + `realpath` 防穿越；`shell.exec` 默认关 |
| 客人烧光我的 token | 每 session/每客人 token 或时长预算，超额自动 kill |
| 只想给看不给控 | role 分 `viewer` / `controller` |
| **客人经 agent 自带 fs 工具反读宿主文件** ⚠️ | agent 自带工具作用在宿主上——给客人的会话需沙箱化或锁 cwd |
| 传输内容加密 | ✅ 自签 `wss://` + 指纹固定（`tb middle cert/pin`，无需域名）；密码只认证「谁能连」、不加密内容，两者可叠加 |
| 审计 | 每条 `tools.call`（谁/什么工具/什么路径）落日志 |

## 8. 技术栈

- PTY：TB 自建 session 用 `node-pty`；Herdr session 用 protocol 19 Unix socket API
- 前端终端（P1）：`xterm.js` + `addon-fit` + `addon-webgl` + `addon-serialize`
- WebSocket：`ws`
- 协议编解码：`zod`（schema）+ `msgpackr`（二进制控制帧）
- MCP 桥（P3）：`@modelcontextprotocol/sdk`
- 构建/运行：pnpm workspace + `tsx`（P0 dev 直跑 .ts，免构建）
