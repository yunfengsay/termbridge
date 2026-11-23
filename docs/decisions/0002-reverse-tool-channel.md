# ADR-0002: 反向工具通道 — host 上的 Agent 反向操作 client 机器（CLI 优先）

- 状态: 采纳（增量 1 已落地 + 测试）
- 日期: 2026-06-19

## 背景

常态拓扑里，client 是「瘦终端」（键盘 + 屏幕），host（Mac mini）才是 Agent 与工具所在地，
数据流是 `client → relay → Agent 在 HOST 上执行`。但真实诉求是反过来的一条箭头：

> 跑在 mini 上的 Agent，要能反向操作「我此刻人坐在的那台机器」（笔记本 / Windows）——
> 它的文件、它的 shell（bash / PowerShell）、以后还有它的浏览器。

即 client 从「只是屏幕」升级为**工具提供方**。这把「跟本地一模一样」延伸到了
*Agent 无论跑在哪，都能操作我本地的文件 / shell*。这是 roadmap 里的 P3，本 ADR 把它
按 **CLI 优先**重新定型。

## 决策

1. **CLI 优先，不做 MCP（至少现在不做）。** Agent 用它自带的 Bash 工具直接调
   `tb peer …`。理由：与 Agent 无关（Claude Code / codex / 纯 bash 都能用）、可组合（管道、
   `$(...)`、xargs）、无需 MCP 握手；未来要 MCP 也只是再包一层 shell-out 的薄壳。CLI 是事实
   来源，MCP 可选、甚至永不做。靠 prompt 告诉 Agent 它的存在。
2. **调用方命名 `tb peer`**（`tb peer exec/read/write/ls/stat/info`）。中性、短，读作「桥的另一端」。
3. **默认关闭，opt-in。** client 必须先 `tb expose on [--root <dir>] [--fs ro|rw] [--exec on|off]`，
   否则一律拒绝。fs.* 限定在 `--root` 内（`..` 逃逸直接拒）；**exec 是完整 shell 权限，root 不沙箱它**，
   故 exec 单独 on/off。每次调用写 `~/.termbridge/peer-audit.log` 审计。
4. **增量 1 = exec + fs 一起做**（fs 在 RPC 通了之后几乎免费）；增量 2 = browser；增量 3（可选）= MCP 壳。

## 机制（四件套）

```
 Agent（mini 上、某 session 的 pty 内）
   │  tb peer exec -- pwsh -c "…"   /   tb peer read ~/notes.md
   ▼
 tb peer ──unix socket──► HOST 守护进程 ──relay(wss,已鉴权,已 pin)──► CLIENT（笔记本/Windows）
   读注入的 env：           查 session→当前 attach 的 clientId，          tool 执行器（仅当 `tb expose on`）
   TB_SESSION              发 tool_request{id,op,args}                  本地跑 fs/exec，回 tool_response{id,…}
   TB_BRIDGE_SOCK    ◄──────────────── tool_response ◄──────────────────┘
   TB_BRIDGE_TOKEN
   ◄── stdout + 退出码 ── HOST 守护进程
```

1. **env 注入（关键）**：`SessionManager.create` 把 `TB_SESSION`（每 session 唯一）+ 主机级
   `TB_BRIDGE_SOCK`/`TB_BRIDGE_TOKEN`（开机生成）塞进 pty env；tmux 后端额外用
   `new-session -e KEY=VAL` 带进会话（tmux server 的子进程不继承我们 pty 的 env）。
2. **host 本地 IPC**：`PeerBridge`（`packages/host/src/bridge.ts`）在 unix socket 上收 NDJSON
   请求；复用 host 已有的、已鉴权的 relay 连接转发，免每次重连。token 把「谁能调」限制在真正的
   session 进程内。
3. **RPC 帧**：协议加 `tool_request` / `tool_response` 两个控制消息，按 `id` 关联 + 超时。它们走
   **现有的** `[clientId][frame]` 信封，relay 握手后是纯转发、不看类型 → **relay 零改动**。
4. **client 执行器**（`packages/cli/src/peerExecutor.ts`）：收到 `tool_request`，按 `tb expose`
   放行后用 `child_process` + `node:fs` 本地执行。**不碰 node-pty** → 仍是 pty-free 的 client bundle
   （Windows 友好）。Win 默认 shell = PowerShell，mac/linux = `$SHELL`。

两道 host 侧闸（与 client 侧的 expose 正交）：unix socket 的属主权限 + 仅注入真实 session 的 token。

## 让 Agent「知道」要调它

env 注入只让 `tb peer` *能用*；Agent（Claude Code / codex，pty 内的不透明进程）还得*知道它存在*、
以及此刻是被远程 client 驱动的。结论：**靠 instructions + 拉取，不做连接时的 stdin 推送**。

- **能力（静态）**：`tb peer prompt` 输出一段规范说明；`tb peer setup [--remove] [--claude] [--codex]`
  把它幂等地（带 `<!-- termbridge:peer:start/end -->` 定界、可逆）写进 host 的 `~/.claude/CLAUDE.md` +
  `~/.codex/AGENTS.md`，于是该 host 上每个新 Agent session 从第 1 轮就知道。这段文字写成**对非
  termbridge 的本地 session 无害**（那时 `tb peer info` 直接报错，让 Agent 忽略本节）。
- **实时态（拉取）**：说明里让 Agent 调 `tb peer info` 看「现在有没有 client、它什么 OS」
  （darwin→bash / win32→PowerShell）。`info` 即使 expose 关着也答，没 client 时短路成 "no client
  attached" —— 三态可分。

为什么不在 client attach 时往 pty 里注入一行「某 client 接入了」：对话型 Agent 而言那是一条
用户轮（污染会话、时序尴尬）。而 session 创建时本来就有 client（就是创建它的人），所以「连进来
即知道」对最常见的「连上→开 Agent」流程天然成立，无需推送。`tb expose serve` 常驻执行器是后话。

## 后果

- ✅ 增量 1（exec + fs）已落地，集成测试新增场景 15：exec 跑通、fs 读写回环、root 逃逸被拒、
  错 token 被 host 拒（forbidden）、expose 关时 client 拒（not exposed）—— 全过（共 14 个 scenario）。
- ✅ relay 零改动；client bundle 仍 0 处 node-pty 引用（`cli.js`），不破坏 0.1.4 的 Windows 客户端。
- ✅ 一个 Agent 现在有两套执行上下文：原生工具作用于 HOST（mini），`tb peer` 作用于「我坐的那台」。
  靠 prompt 讲清区别即可。
- ⚠️ 这等于 host→client 的 RCE。所以默认关、root 限定、审计日志、token 门四样齐上；但
  **exec 本质不可沙箱**——开了 `--exec on` 就是把这台机器的 shell 交出去，文档要诚实写明。
- ✅ Android 原生设备工具已提升到 APP 层：常驻 Agent monitor 用稳定 `deviceId` 注册受限能力，
  `info/logcat/apk` 不依赖某个 Terminal viewer；多台设备同时在线时 Host 拒绝猜测目标。
- ⚠️ 桌面 client 的 exec/fs 仍只在 client **attach 期间**可用，并继续绑定精确 session。未来可加
  `tb expose serve` 常驻守护，但不能借 Android 的 APP 层注册放宽桌面 RCE 边界。
- ⚠️ fs.read / exec 输出上限 1 MiB（截断置位）；二进制 fs.read 走 base64。

## 待办

- 增量 2：`tb peer browser …`——机制三选一（CDP 连真浏览器 / 浏览器扩展 WS 桥 / Playwright 持久化
  profile），到时再拍。
- 增量 3（可选）：MCP 壳包同一套 CLI。
- 可选：脱离 attach 的 client 常驻执行器；真 `tb peer`（走 env 注入）端到端测试。
