# 内网直连

手机、iPad 或另一台 Mac 与被控 Mac 能通过内网互相访问时，可以直接使用固定 IPv4 地址。终端、附件和桌面控制流量在客户端与这台 Mac 之间传输，不需要公网 Relay、域名或 Cloudflare。

## 使用

1. 在被控 Mac 的 TermBridge 中打开「设置 → 内网服务」，选择本机 IP 和端口，点击「开启内网服务」。需要时允许 macOS 防火墙的入站连接提示。
2. 密码留空会保留已有密码，首次开启则随机生成。手动密码为 1–256 个字符，支持 4 位密码。开启后及重新打开设置时显示已保存密码的掩码和长度；修改时先停止服务。页面提供复制密码和二维码，无需生成证书。
3. 手机打开「Global 设置 → 新增连接」，选择「内网直连」，输入名称、IP、端口及密码，默认使用 `ws://IP:端口`。也可直接扫描 Mac 显示的配对二维码，无需确认 TLS 指纹。
4. 另一台 Mac 在「连接与通知 → 添加连接」使用相同信息。服务端 App 也能通过「在此 App 连接」控制自身 Host。
5. 可以保存多个连接，分别编辑、连接和删除。Android 顶部 Server 标签长按后选择「编辑连接」，可修改对应连接的名称、IP／地址、端口、Host ID 和密码；保存并连接后切换到修改后的配置，取消编辑不改变连接。同一个 Host 的不同地址独立保存；新增不会覆盖其他 Mac。
6. 旧 `wss://` 配置继续按原方式连接。服务端升级为 WS 后，编辑客户端的内网连接并关闭「兼容旧版 TLS 服务」（Apple 客户端在高级连接选项内），再保存；也可重新扫描服务端二维码。仍连接旧版 TLS 服务时保留该选项。不会因 TLS 失败自动降级，也不改写已有公网 Relay 配置。

关闭 Mac 窗口不停止服务，退出 App 会停止。在「设置 → 内网服务 → 自动启动」可分别开启「登录 Mac 后自动启动」与「打开 App 时自动开启内网服务」。两项都开启后，登录 Mac 会自动打开 App 并恢复已保存的内网服务。普通客户端也可在「连接与通知 → 启动」单独开启登录启动。状态以 macOS 登录项为准；若系统要求允许，页面会提供系统设置入口，返回 App 时重新读取状态。关闭登录启动只影响下次登录，不会关闭当前 App 或服务。Mac 重启后需要先登录 macOS；此功能不是登录前系统守护服务，也不会绕过系统锁屏或屏幕录制、辅助功能授权。

直连只改变传输路径。Global 使用的云端模型仍按模型配置联网；它不会自动变成本地离线模型。已有的其他连接配置保留，可在连接列表管理。

## 保存与诊断

- macOS「保存」不要求服务器在线，也不切换当前连接。「保存并连接」先保存输入，再测试密码、Host 和会话列表；测试失败仍保留配置。错误显示具体阶段及网络错误码，传输断开不再笼统描述为密码错误。
- 「设置 → 诊断」可以打开日志目录或导出日志。日志在 `~/Library/Logs/TermBridge`，只保留当天和前两天（按 UTC 日期）的文件；每份最多 2 MiB，每天最多 4 份，超出轮换覆盖。启动、写入、导出和每分钟维护时清理旧日志。
- 记录 App、连接测试、WebSocket、认证及内网服务子进程的状态与错误码。字段使用白名单，不记录密码、二维码、模型密钥、消息或终端内容；端点只保留协议、主机和端口。
- 两台 Mac 连接失败时，在重现后分别导出客户端和服务端日志。`-1005` 只表示连接中断，需结合断开阶段与服务端关闭事件区分协议、认证和进程退出。
- macOS 对 WS 直连执行「测试连接」时，先经与 WebSocket 相同的 BSD socket 路径发不带密码的 HTTP HEAD 到 `/.well-known/termbridge`，再建立 WebSocket、验证密码和读取 Host／会话列表。HTTP 最多等待三秒，不跟随重定向；它只提供诊断依据，失败或旧版返回 426 都不会阻断后续 WebSocket 验证。失败提示同时保留 HTTP 检测结果和 WebSocket 失败阶段。
- WS 直连日志按阶段记录：`connection.direct_tcp_connected`（TCP 建立耗时）、`connection.direct_upgrade_response`（`httpStatus` 与耗时）、`connection.websocket_open`。失败的 `connection.transport_failed` 带 `stage`（`resolve` / `connect` / `upgrade` / `open`）、HTTP 状态和底层 POSIX 码，可区分端口拒绝、TCP 超时、握手被拒或中断。若同一台 Mac 上 curl 能完成握手而 App 在 `connect`／`upgrade` 阶段被中断，优先核对本机安全或网络过滤软件对 TermBridge 的策略。
- Android「连接设置」的「测试连接」不保存配置：先按网络路径逐条测试服务端是否应答（耗时、应答与本机地址，并标出「TCP 被接受但服务端无应答」），再发 HTTP 检测，最后用同一客户端完成密码认证并读取目标 Host 的会话列表；结果逐条显示在对话框中，可据此区分网络不可达、VPN 拦截、端口非 TermBridge 服务和密码错误。
- Node 服务的此 HTTP 入口只返回固定服务标识，不公开 Host 列表或密码。客户端日志用 `connection_test.http_result` 记录状态码／识别结果，服务端用 `lan.http_probe` 记录到达；WebSocket 失败时记录可用的 HTTP 状态码，任务指标可用时记录 `connection.transport_metrics` 的代理标志和耗时。身份与权限仍由既有认证决定。

## 信任与边界

- 接受本机接口实际拥有的单播 IPv4，包括公司分配的非 RFC1918 网段；回环地址供本机和测试使用。服务只绑定所选本机地址，默认端口 7400，使用 WS，不提供 TLS 传输加密。
- 内网服务不生成、读取或覆盖旧证书。新配对码携带 `mode=direct` 和 `ws://` 地址，不携带 `pin`；各端只在显式直连配对中接受 WS，公网配对仍要求 WSS。
- 只有兼容旧版 TLS 服务时才探测证书。macOS 的「测试连接」在 WS 下先做明文 HTTP 诊断，不尝试 HTTPS 或自动切换 TLS；随后验证密码、Host 注册和 session list 响应。
- 认证沿用随机 challenge 和 HMAC。二维码等同连接密码，不写入公共日志。
- Apple 客户端的显式 WS 直连在 BSD socket 上运行 WebSocket（`SocketWebSocket`），与 curl 走相同的系统调用路径：不读取系统代理，不经过 URLSession／Network.framework 的代理选择与协议栈，要么直达所配置的地址，要么带该路径自身的 errno 失败。Network.framework 的 `preferNoProxies` 只表示优先直连，直连候选失败后仍会尝试系统代理（Apple 文档如此定义），因此不再用于 WS 直连。旧版 WSS 直连仍用 Network.framework（证书 pin 依赖其 TLS），建立后核验实际路径，若回退到代理或路径无法确认，在发送认证和业务消息前拒绝。日志 `transport=socket` / `network` 区分两条路径，`connection.transport_metrics` 记录 `proxy`。此约束针对应用代理，不为内网连接强制绑定手机的公网物理网络；系统已配置的 VPN／TUN 路由在 IP 层生效，对 socket 同样适用。没有公网中转兜底。

## 实现与生命周期

- `packages/cli/src/lan.ts` 提供 App 私有的 `lan-app` JSON stdin/stdout 接口。父进程持有唯一 lease，按顺序启动本地 WS Relay 和 Host，显式设置 `TB_RELAY_NO_TLS=1`、清空子进程的证书配置，收到 Host 注册成功的 IPC 消息后才发布 ready。EOF、取消、异常退出都会清理它创建的子进程。
- Relay 是运行在被控 Mac 上的协议入口，不是外部服务器。wire 协议未变。
- Relay/Host 的白名单诊断事件通过 App 私有的子进程 IPC 汇入上述日志；不转发原始 stdout/stderr 或新增客户端协议帧。
- 原生服务控制器为 `macos/TermBridgeControlCenter/Sources/TermBridgeControlCenter/LANService.swift`，处理启动、停止和过期回调。App 从自身 `Contents/Resources/Runtime` 启动组件，不依赖全局 npm、Node 或 CLI。
- 服务拥有 `~/Library/Application Support/TermBridge/LAN` scope。目录权限 0700，密码配置和私钥 0600。此 scope 包含证书、连接配置、Host 状态与模型对话状态；备份/恢复以整个目录为单位。`TB_LAN_DIR` 仅用于指定私有运行 scope 和隔离验收。
- 机器使用原有稳定 Host ID。独立 bridge socket 与状态目录允许已有 Host 共存。外部 Herdr pane 的生命周期继续由 Herdr 管理。
- Android 连接身份包含 Host ID 和端点；加载时迁移旧的 active key，保留原选中连接。Apple 客户端沿用 UUID 与端点约束。
- Android 的显式直连不论地址是否属于 RFC1918（公司分配的 30.x 等网段同样适用），都不使用应用代理。VPN 占用默认路由时，同时尝试默认路由（VPN）和各物理网络（Wi‑Fi、移动网络），采用服务端最先应答的路径（WS 升级返回 HTTP 状态行，或 TLS 握手完成）。代理类 VPN 常在手机本机直接接受 TCP，所以仅 TCP 连通不算到达：办公 Wi‑Fi 上的代理类 VPN 到不了内网时改走 Wi‑Fi，离开办公室依赖公司 VPN 时仍走 VPN；VPN 不允许绕过时只剩默认路由。所有路径都失败时，错误信息逐条列出各路径结果。旧连接未保存模式时仍按私有地址推断。实现：`android/.../network/LanRoutes.kt`（`DirectRouteSocketFactory`）。
- `scripts/prepare-runtime.mjs`（macOS 项目目录）构建并安装当前 checkout 的 CLI 依赖，嵌入独立官方 Node。打包签署嵌入的 Mach-O 与原生扩展后，再签署 App。Developer ID 发布仍需正常签名和公证流程。

## 验证

- Node `lan.test.ts`：WS 密码认证、Host ready、错误密码、旧证书不参与启动、重复 lease、端口冲突、取消、子进程异常、停止与重启。
- Android `ConnectionProfilesTest` / `LanConnectionTest` / `PairingCodeTest`：迁移、多端点共存、编辑保留其他连接、输入校验和 WS 配对。`LanConnectionSettingsTest` 在显式临时 WS 服务下验证新增时跳过证书确认、保留旧连接，以及原生客户端真实 PTY 与认证拒绝。
- Apple `LANConnectionTests`：端点与多连接；显式 TLS fixture 验证证书探测。macOS `LANServiceTests` 用指定 Runtime 验证原生控制器和打包组件的启动/停止/重启。
- 模拟器和本机回环验证不等于用户手机到另一台 Mac mini 的真实网络验收。不同机器的防火墙、系统隐私权限与网络可达性仍需现场验证。
- `node macos/TermBridgeControlCenter/scripts/test-http-connection.mjs` 使用带正式 Info.plist 的临时 App，经直连的 BSD socket 路径做真实 HTTP 检测和 WebSocket，验证 HTTP 在先、认证在后、旧服务兼容、握手拒绝、拒绝重定向与取消。不会启动用户 Agent。

- `scripts/test-direct-transport.mjs`（macOS 项目目录）对 socket 与 Network.framework 两种传输验证分片、大消息限制、ping/pong、关闭、重复取消、回调中替换连接。socket 传输另验证端口拒绝立即失败、握手停滞的超时阶段、HTTP 403、错误 Accept、服务端掩码帧、分段到达的响应头与帧、文本帧、服务端 ping、应用关闭码和 2 MiB 边界。对照用例复现故障机制：直连候选失败后 Network.framework 会尝试已配置代理，socket 传输不会；强制代理路由的旧版路径在认证前被拒绝且没有认证消息。`test-packaged-connection.mjs` 同时验证直连 WS、旧 WSS 的证书 pin 和公网 Relay。

- 登录启动使用 macOS 13+ `SMAppService.mainApp`，不创建额外 LaunchAgent、脚本或重复的本地布尔开关；注册、撤销、系统拒绝及过期状态读取由 `LoginLaunchSettingsTests` 覆盖。
