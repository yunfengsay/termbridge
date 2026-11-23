# Termbridge Android

独立 Android 客户端：连接 Termbridge relay/host，管理远端 session，并通过完整的
xterm.js 终端进入同一个 PTY。最低 Android 7.0（API 24），目标 Android 16（API 36）。

## 功能

- session 列表：`READY` / `ACTIVE` 状态、viewer 数量、刷新、进入和 Kill
- New session：Shell，以及 host 返回的 `codex` / `claude` 等 agent 预设
- 真实 PTY：ANSI/VT 渲染、10,000 行 scrollback、窗口 resize、标题和响铃
- Herdr 移动阅读：首次结构化快照，随后按 revision 发送行级 patch；丢包自动全量重同步，滚动中的稳定行节点不会被整窗重建
- 移动端按键：ESC、CTRL、ALT、TAB、HOME、方向键、END、复制和粘贴
- 断线自动重连；重新进入 session 时恢复 host scrollback
- 扫描 `tb cloudflare use` 显示的二维码，直接通过 Termbridge Cloud 跨网连接
- relay 共享密码的 HMAC-SHA256 鉴权
- `wss://` 和 Termbridge 自签证书 SHA-256 指纹固定
- 全局设置中配对 TermBridge Watch；手表跟随当前 Mac profile，可选蓝牙网关、Wi-Fi 直连或自动切换
- 手表语音经蓝牙传输完整 16 kHz 输入 / 24 kHz 回复 PCM，不要求使用 Cloudflare

## Agent 对话界面

在 **连接设置 → 会话界面** 选择自动、对话或终端；偏好只保存于此设备。
自动会为已有 Herdr Agent 打开图形对话，Host 无结构化记录或版本不支持时说明原因并回到终端。
两个界面的会话菜单都能切换视图；不会启动第二个 Agent，也不会切换 Host 上的 pane。

`chat/AgentChatActivity` 使用独立连接订阅 `agent_chat_*`，不需要终端 attach。
原生输入框负责中文、多行、粘贴和发送；共享 `assets/agent-chat` 只渲染历史。
草稿按 Host/session 隔离，切换或离开页面会退订。`uncertain` 不自动重发，也不给重试按钮；
只有明确未写出的 `failed` 可以重试。附件、停止、审批暂时提示使用终端。

共享页面资源从仓库根目录显式生成：

```bash
pnpm exec tsx packages/agent-chat-ui/scripts/build-webview.mjs android/app/src/main/assets/agent-chat
```

新增状态回归测试在 `app/src/test/java/com/termbridge/android/chat/AgentChatStateTest.kt`。
构建和单测不代替手机上的 IME、断线重连和真实 Agent 发送验收。

Android 客户端不暴露任意 shell 或手机文件系统；它可以向当前附着的 agent 提供白名单
设备工具：应用级/可选系统级 logcat、端到端加密 APK 传输，以及必须由用户确认的系统安装。
命令和安全边界见 [`docs/android-peer.md`](../docs/android-peer.md)。

## 构建

需要 JDK 17 和 Android SDK 36。Android Studio 可直接打开本目录，也可以命令行构建：

```bash
cd android
./gradlew clean testDebugUnitTest assembleDebug lintDebug
```

Debug APK 输出到：

```text
app/build/outputs/apk/debug/app-debug.apk
```

终端前端资源已经提交到 `app/src/main/assets/`。修改 `web/src/terminal.ts` 后重新生成：

```bash
cd android/web
npm ci
npm run build
```

## 连接

推荐的跨网方式不需要局域网或 VPN：

1. 在电脑运行 `tb cloudflare use`，再运行 `tb host`。
2. 打开 App 的 Connection settings，点 **Scan pairing QR**。
3. 扫描终端二维码；App 会保存配置并立即连接。二维码等同密码，不要公开分享。

手动或局域网连接仍然支持：

1. 在 host 所在机器运行 `tb surf`，或分别启动 relay 和 host。
2. 打开 app 的 Connection settings。
3. 填写 relay WebSocket 地址；Android 模拟器访问 Mac 本机用 `ws://10.0.2.2:7400`。
4. 单 host 可留空 Host ID；多 host 时填写目标 `hostId`。
5. relay 开启密码时填写同一 Shared secret。
6. 使用 Termbridge 自签 `wss://` 时填写 `tb middle cert` 输出的 SHA-256 指纹。

公网使用时建议同时开启共享密码和 `wss://` 指纹固定。连接设置只保存在 app 私有数据中，
并已禁用 Android 备份；不会写入仓库或 APK。

## TermBridge Watch

打开 **Connection settings → TermBridge Watch → Pair watch**，选择正在附近广播的
`TermBridge Watch` 并完成 Android 蓝牙配对。配对后，切换手机上的连接 profile 会立即同步到
手表。**Auto** 优先走手机的蓝牙网关，手机不在或网关未就绪时由手表通过 Wi-Fi 使用相同 profile；也可以固定
为 **Bluetooth** 或 **Wi-Fi**。详细的安全与协议边界见
[`docs/watch-companion.md`](../docs/watch-companion.md)。

## 本地模拟器冒烟测试

Debug build 支持用 ADB extras 写入一次连接配置，便于可重复测试且不会提交凭据：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -W -n com.termbridge.android/.MainActivity \
  --es tb_relay_url ws://10.0.2.2:7400 \
  --es tb_host_id your-host-id
```

可选 extras：`tb_secret`、`tb_tls_fingerprint`。这些入口只存在于 debug build。

第三方终端组件及许可见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
