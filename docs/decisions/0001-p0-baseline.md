# ADR-0001: P0 基线 — relay 拓扑 / 纯信任 / dev-mode

- 状态: 采纳
- 日期: 2026-06-13

## 背景

要从零搭一个跨机器共用终端 Agent 台。第一版（P0）只需打通核心管线，验证「node-pty 包裹 +
一条 socket 多路复用」可行；安全、Web、工具注入往后排。三个开放问题需要拍板。

## 决策

1. **relay 优先**（而非局域网直连优先）。宿主主动外连 relay，客户端也连 relay，relay 按
   `hostId + clientId` 转发。理由：用户家人在外网也要能用，relay 天然穿 NAT，且 Mac mini
   不必开放端口。局域网 mDNS 直连作为 P2 的优化回落。
2. **纯 shell 全上**。session 的 `command` 任意，缺省 `$SHELL`；`codex` / `claude` / `bash`
   一视同仁，靠 `node-pty` 包。
3. **纯信任**。P0 不做 scope 白名单 / 沙箱 / 预算 / 邀请码；`hostId` 即唯一凭证。安全模型
   整体推迟到 P2/P4（见 [architecture §7](../architecture.md)）。
4. **dev-mode 运行**：包的 `main` 直接指向 `src/*.ts`，用 `tsx` 跑，免构建步骤。全局
   `termbridge` 命令也是一个跑实时源码的 shim，方便快速迭代。P1 再接 `tsup` 出 `dist`。

## 后果

- ✅ 最快验证了核心管线：集成测试 4 场景全过（round-trip / 持久 / 重接 / scrollback / list /
  多 viewer / CLI 二进制）。
- ✅ 协议为 P3 工具注入预留了 `tools_register/call/result`。
- ⚠️ **纯信任意味着现在谁知道 `hostId` 谁就能进**——上公网前必须先做 P2 鉴权 + wss。
- ⚠️ dev-mode 依赖 `tsx`，启动有编译开销；性能/分发优化留给 P1 构建。

## 落地中踩的两个坑（根因 + 对策，已修）

1. **relay→host 信封不一致**：`host_register_ok` 当初没套 relay 信封，host 把它当
   `[clientId][frame]` 切掉 4 字节 → `unknown frame type` 崩溃。
   **对策**：确立不变量「每条 relay→host 消息都带信封」，控制平面消息用保留 `clientId 0`。
   见 [protocol.md](../protocol.md)。
2. **node-pty `spawn-helper` 丢可执行位**：pnpm 抽取预编译产物时没保留 `+x`，运行
   `posix_spawnp failed`。**对策**：`postinstall` 跑 `scripts/fix-pty-perms.mjs` 自动补 +x。
   这是 pnpm + node-pty 的通病，真机重装也会触发，故固化进安装流程。
