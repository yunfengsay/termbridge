# 测试

termbridge 的主价值仍由端到端套件验证（pty → host → relay → client）。Herdr 适配另外有一个
假 Unix socket 单元测试，覆盖 snapshot 映射、Unicode/控制键顺序与 `pane.send_input` 请求。

> 我（agent）每次改完代码用 `test-termbridge` skill 跑这套；你手动跑就一条命令。

## 跑

```bash
pnpm test
```

= `pnpm typecheck` + `pnpm test:unit` + `tsx scripts/test.ts`（集成），退出码 0 才算通过。

若上次的 relay/host 卡住，先清理孤儿进程：

```bash
pkill -f 'packages/(relay|host|cli)/src' 2>/dev/null; true
```

## 覆盖的保证

| 场景 | 防止回归 |
|------|----------|
| 1. PTY round-trip | 分帧 / sid 路由——字节必须经 pty→host→relay→client 原样回传 + 退出码正确 |
| 2+3+4. 持久 + 重接 + scrollback + list | 会话须比 viewer 活得久；按 id 重接；回放 scrollback；`session_list` |
| 5b. agent 预设 + 默认宿主路由 | host 用配置(隔离的 `TB_CONFIG`)解析 `agent`；relay 把空 hostId 路由到唯一宿主 |
| 5. 多 viewer 广播 | 输出扇出到每个 attach 的 viewer |
| 6. CLI 二进制 `tb new -- echo` | 出厂的 `tb` 客户端 + 调度器真的能用 |
| 7. config set / get | `tb set` 把 agent 写进 host 配置并持久化；`tb info` 读得到；新 agent 能跑 |
| 8. middle 设置解析 | `resolveRelayUrl` 优先级 env > `tb middle` 中转 > 本机；`middleToUrl` 归一化(裸 IP→`:8001`、`ip:port`/`ws(s)://` 原样) |
| 9. 中转密码鉴权 | 起一个带 `TB_SECRET` 的 relay+host;**对密码**的 client 能跑通会话,**错密码**在 hello 前被 `authentication failed` 拒掉(HMAC 挑战应答) |
| 10. 自签 wss + 指纹固定 | 生成自签证书、起 `wss://` relay+host;**对指纹**的 client 跑通会话,**错指纹**在 TLS upgrade 时被拒、建不了会话 |
| Herdr unit | 假 socket 返回 protocol 19 snapshot；断言 pane 映射、稳定 id、workspace/agent/status/geometry，以及 text/Ctrl/arrow/Enter 输入顺序 |

> 测试用 `TB_CONFIG` / `TB_SETTINGS` 指向临时文件,**绝不碰你的 `~/.termbridge/{config,settings}.json`**。

## 加新场景

新增协议消息 / 控制流 / 功能（如 P3 反向工具注入）时，在 `scripts/test.ts` 加场景：

- `makeClient()` 造一个协议层 viewer：`createSession` / `attach` / `list` / `input` / `kill`。
- `waitOutput(client, /regex/)` 断言 PTY 输出；`client.state.exit` 看退出码；
  `onControl(t)` 等控制回包。
- 包进 `await scenario('N. 名称', async () => { … })`。
- 长生命周期 shell 用 `BASH`（`bash --norc --noprofile -i`）让提示符确定；命令带结尾 `\n`。

**一条新线消息，在有场景覆盖它之前不算「做完」。**

## 失败排查

见 [troubleshooting.md](./troubleshooting.md)。最常见：`posix_spawnp failed` →
`node scripts/fix-pty-perms.mjs`；`host not found` / 空的 `[connection error]` → 跑上面的
`pkill` 再试。
