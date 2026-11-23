# App 内置 TB、命令入口与自动配置

macOS App 自带 Node、TB 和终端组件，使用 App 不需要额外安装 CLI。设置 → TB 命令行 →「添加到命令行」是可选操作：它把 `~/.local/bin/tb` 指向 App 内置运行环境，并为新终端配置 PATH。关闭 App 后仍能使用 `tb` 的连接、Peer 和服务命令。App 更新后命令自动使用新版本；移动 App 后重新添加入口，删除 App 会使入口失效。已有其它来源的同名入口不会被覆盖。

设置中的「将当前连接用于 CLI」把已有配对用于普通终端。多 Host 时显式使用 `--host <Host ID>`。设备可发现不代表已经允许执行命令。

## 查看连接与操作设备

```sh
tb topology
tb --host <Host ID> peer list
tb --host <Host ID> peer topology
tb --host <Host ID> peer exec --device <Device ID> -- /usr/bin/uname -a
```

普通终端经已经配对的 Relay 和 Host 转发请求，不依赖 Agent 会话或本地 Host socket。`exec` 和文件操作必须指定精确设备 ID；目标 Peer 每次检查当前授权。Mac App 在 Peer 设置中按 Host 授权命令或文件访问；独立 CLI 的授权仍使用 `tb expose`。执行断线时返回结果未知，不自动重发。

`topology` 只表示当前中转实际连接的 Host 和客户端；不会推断其他局域网、SSH 路由或跨中转级联。纯中转没有 Host 时也能查看拓扑，但不能执行命令。

## 经已连接设备配置中转

这些命令管理 macOS App 的服务，与设置页面使用同一个生命周期管理器。目标 Mac 必须已安装支持此功能的 App、在线注册为 Peer，并授权当前 Host 执行命令。已有连接是配置通道；命令不能越过尚未建立的网络连接或权限。

```sh
tb setup status
# 在指定 Mac mini 上启用独立中转，地址唯一时自动选择
tb --host <Host ID> setup relay --device <Mac mini Device ID>
# 让本机共享到 Mac mini，中转已启动则复用
tb --host <Host ID> setup join --relay-device <Mac mini Device ID>
# 让另一台已授权 Mac 共享到该中转
tb --host <Host ID> setup join --device <Target Device ID> --relay-device <Mac mini Device ID>
# 把本机 App 与 CLI 的客户端连接配置到该中转
tb --host <Host ID> setup connect --relay-device <Mac mini Device ID>
```

多地址时用 `--address <中转 IP>`，端口可用 `--port` 指定。手动已有中转使用 `--address` 和 `--password-stdin`，密码通过标准输入传入。自动配置只在已认证的请求链路内传递密码，输出不显示密码。内网 WS 本身不加密，只用于受信任网络。

同配置重复调用复用现有服务；正在运行的不同配置会拒绝替换。共享和中转独立启停，配置中转不启动该机器的 Host。配置本机 App 服务时，App 未运行会自动启动。`connect` 同时保存 App 连接和当前 `TB_SETTINGS` 指定的 CLI 配置；CLI 写入失败会明确说明 App 已保存，允许修复后重试。

## 更新

```sh
tb update --check
tb update
```

- App 内置命令更新整个签名 App。App 正在运行时请求 App 更新器检查并由其完成安装；返回 `requested` 表示已发起，不能当作安装成功。App 未运行时验证官方签名安装包，再替换原路径并保留备份。
- npm 独立安装先准备新包，验证版本与原生 PTY，再替换原包并保留旧目录。失败时不覆盖旧包；不会降级或覆盖源码开发入口。
- 本版 macOS/Linux `tb serve` 的父进程拥有自己的 Relay 和 Host。更新仅向相同安装路径的父进程请求重启，沿用启动时环境；不按进程名寻找或终止服务。App 来源的 `serve` 也检测 App 替换，在更新完成后重启自己的子进程。旧版启动的 `serve` 没有此控制接口，需要首次手动重启一次。
- 重启 Host 会暂时断开客户端。Herdr 管理的 Agent 由 Herdr 保持；直接由该 Host 创建的 PTY 会结束。独立启动的 `tb host`、系统服务和其它安装来源的服务不会被更新命令接管。

`serve` 重启失败时更新结果包含 `restartError`，表示新版本已安装但服务恢复未确认。
