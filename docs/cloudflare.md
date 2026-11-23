# Cloudflare Relay

Termbridge uses a Cloudflare Worker + Durable Object with WebSocket Hibernation as a lightweight cross-network relay, requiring no inbound port forwarding, VPN, or dedicated VPS.

## 推荐：部署到自己的 Cloudflare 账号

需要 Node.js ≥ 22.19：

```sh
tb cloudflare login
tb cloudflare deploy
tb cloudflare pair
tb host enable
```

`tb cloudflare deploy` 会自动完成：

1. 通过固定兼容版本的 Wrangler 部署打包好的 Worker（默认 `cloudflare/wrangler.jsonc`，`TB_PUBLIC_ROOMS: "0"`）；
2. 生成或复用 `~/.termbridge/settings.json` 中的 256-bit shared secret；
3. 将它写为 Cloudflare encrypted secret `TB_SECRET`；
4. 将返回的 `wss://<your-worker>.<your-subdomain>.workers.dev` 保存为当前 middle，并清除自签证书 pin。

随后运行 `tb cloudflare pair` 即可生成手机/桌面端扫码用的 `termbridge://pair?v=1&...` 二维码与 URI。重启或启动 `tb host` 后即可跨网连接。Worker 在 `TB_SECRET` 缺失时返回 503，不会以未鉴权的公开中继启动。

把另一台电脑接入同一个自建中继：

```sh
tb cloudflare use 'termbridge://pair?v=1&relay=wss%3A%2F%2F...&secret=...'
tb host enable
```

## 可选：团队自建多房间中继（`TB_CLOUDFLARE_RELAY`）

如果你希望像公共云中继一样，由一个 Worker 为多个独立房间按密钥 SHA-256 自动分配 Durable Object：

1. 使用 `cloudflare/wrangler.official.jsonc`（含 `TB_PUBLIC_ROOMS: "1"`）部署到你自己的 Cloudflare 账号；
2. 在需要配对的设备上设置环境变量：

```sh
export TB_CLOUDFLARE_RELAY='wss://<your-multi-room-worker>.<your-subdomain>.workers.dev'
tb cloudflare pair
```

此时 `tb cloudflare pair` 会生成独立房间与紧凑的 `tb1_...` 连接码。客户端（CLI / iOS / macOS / Windows）解析 `tb1_...` 短码时同样读取 `TB_CLOUDFLARE_RELAY`；未配置该变量时，所有客户端统一使用完整 `termbridge://pair?v=1&...` 二维码 / URI。

## 为什么是 Durable Object

普通 Worker 请求彼此无状态，无法可靠地把长期在线的 Host 与客户端配对。Termbridge 使用 `TermbridgeRelay` Durable Object 管理同一中继下的 Host 与客户端连接；Socket 元数据写入 Hibernation attachment，空闲时对象自动休眠，下一条消息到达后恢复转发。

协议与 Node relay 完全一致：客户端发送裸二进制 frame，Host 方向增加 4-byte `clientId` envelope；同一个 relay 可注册多个 `hostId`，因此多台主机可在客户端顶部切换。

## 手动部署与验证

仓库开发环境可运行：

```sh
pnpm build
pnpm exec wrangler deploy --dry-run --config cloudflare/wrangler.jsonc
pnpm exec wrangler deploy --config cloudflare/wrangler.jsonc
pnpm exec wrangler secret put TB_SECRET --config cloudflare/wrangler.jsonc
```

健康检查：

```sh
curl https://<worker>.<subdomain>.workers.dev/health
```

返回 `auth: required` 才表示 encrypted secret 已生效。实际流量必须使用 `wss://`。

## 费用

个人低频使用主要消耗 WebSocket 消息和 Durable Object 请求；Hibernation 后空闲连接不持续占用对象执行时长。实际免费额度和计费规则会变化，请在部署前查看 Cloudflare Dashboard 当前的 Workers 与 Durable Objects 用量/定价页。

## 安全边界

- 二维码、`termbridge://pair` URI 与 `tb1_…` 连接码等同密码，不要截图公开分享或提交进代码仓库。
- 多房间模式下不同房间由独立 Durable Object 隔离；Worker 不记录密钥或终端帧。
- WSS 保护传输链路，但 Worker 是 TLS 终点（非端到端加密），部署在自己的 Cloudflare 账号下可完全掌控中继信任边界。
