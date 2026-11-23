# 线路图

设计全貌见 [architecture.md](./architecture.md)。

## 决策基线（你拍板）

- **relay 优先**：宿主主动外连 relay，跨网可用，无需端口转发。
- **纯 shell 全上**：session 的 command 任意，默认 `$SHELL`。
- **纯信任**（P0）：`hostId` 即唯一凭证；scope/沙箱/预算留到 P2。

## 阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| **P0 骨架** | `protocol` + `relay` + `host` + `cli`，relay 转发，裸 PTY 透传，会话持久 + scrollback + 多 viewer，统一 `termbridge` 命令，集成测试 | ✅ 完成 |
| **P1 Web** | `@termbridge/web`（xterm.js + webgl）实例/会话列表、新对话、多端镜像；抽出 `@termbridge/transport`（浏览器/Node 共享 WS） | ⏳ 下一步 |
| **P2 加固** | 密码鉴权（✅ HMAC，`tb secret`）+ wss/TLS（✅ 自签 wss + 指纹固定，`tb middle cert/pin`）；token/时长预算；审计日志；局域网 mDNS 直连回落 | 🚧 进行中 |
| **P3 反向工具注入** | `@termbridge/tools` + 桥 MCP；`tools_register/call/result` 三条消息已在协议预留 | ⏳ |
| **P4 沙箱** | 给客人的会话沙箱化，防其经 agent 自带工具反读宿主文件 | ⏳ |

## P0 已交付清单

- 二进制分帧 + relay 信封 + zod 消息 schema（`@termbridge/protocol`）
- relay 按 `hostId + clientId` 路由（`@termbridge/relay`）
- `node-pty` 会话管理 + 256 KB scrollback + 广播（`@termbridge/host`）
- 统一 `tb` 客户端：`surf`（relay+host 一条命令）/ `new <agent>` / `ls` / 按序号接入 / `kill`
- agent 预设 `~/.termbridge/config.json`（claude/codex → 你的 proxy 命令）；relay 默认宿主路由
- 全局 `tb` + `termbridge` 命令（`~/Library/pnpm/bin/` shim，跑实时源码）
- 自己的 VPS 中转：`tb middle serve/set`（relay-first 跨网，三端 3s 自动重连）；可选**密码鉴权**（HMAC 挑战应答，`tb secret`，密码不过线）+ **自签 wss + 指纹固定**（`tb middle cert/pin`，无需域名加密内容）——均在 `@termbridge/settings`
- 集成测试 8 场景 + `test-termbridge` skill
- `postinstall` 自动修 node-pty `spawn-helper` 可执行位

## 建议顺序

先 **P1**：有了可视化实例列表和新开对话，整套东西就能被非技术用户（家人）用起来；
再叠 **P3** 反向工具注入（你最看重的「借别人文件系统」）会更顺。
