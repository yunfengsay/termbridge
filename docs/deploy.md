# 在 Mac mini 上部署

Mac mini = **host**(包 node-pty、跑 codex/claude、放你 token 的那台)。推荐让
**relay 和 host 都跑在 Mac mini 上**:relay 绑 `0.0.0.0:7400`,host 连本机 relay,远程设备
连 Mac mini 的可达 IP。

```
┌──────────────── Mac mini ────────────────┐
│  relay (0.0.0.0:7400)  ◄──  host (本机连) │
└───────▲───────────────────────────────────┘
        │ 远程设备连这里
   ┌────┴─────┐
   │ 笔记本/手机 │  termbridge attach
   └──────────┘
```

## 0. 前提

- 仓库已在 Mac mini 上(`git clone` 或拷过去),`pnpm install` 过。
- **codex / claude 装在 Mac mini 上、且你的 token/登录在这台机器**——这就是「共享你的 token」
  的本体。agent 在这里跑。

## 1. 决定远程设备怎么连到 relay

| 场景 | RELAY_URL 用什么 |
|------|------------------|
| 家人/你在**同一个 WiFi** | Mac mini 的局域网 IP:`ws://$(ipconfig getifaddr en0):7400` |
| 在**外网/另一个网络** | 用 [Tailscale](https://tailscale.com)(免公网免端口转发):两端都装,Mac mini 的 tailscale IP 形如 `ws://100.x.y.z:7400` |
| **用自己的服务器中转**(任意网络,最省心) | 在 VPS 上 `tb middle serve`,两端 `tb middle set <vps-ip>`——见下面一节,**不用** 手写 RELAY_URL |
| 想要域名/多人 | relay 单独部署到云 VPS,两端设 `wss://你的域名` |

> 首次远程连,macOS 可能弹「是否允许 node 接受传入连接」——允许;或在 系统设置→网络→防火墙 放行。

## 用自己的 VPS 当中转(`tb middle`,跨网最省心)

不想装 Tailscale、又要任意网络可达:把**你自己的服务器**(如阿里云
`<vps-ip>`)当 relay,Mac mini 和客户端都拨向它——host 拨出、client 拨入,
**两端都不用端口转发**。

**1) 在服务器上跑中转**(就一个 relay,端口 8001):

```bash
# ssh root@<vps-ip>
cd ~/code/termbridge && pnpm install
tb middle serve            # = relay 绑 0.0.0.0:8001(env PORT 可改)
```

放行安全组/防火墙的 **8001/tcp**。常驻同样用 launchd/systemd(思路见 §4),或先简单
`nohup tb middle serve >~/tb-middle.log 2>&1 &`。

**2) 两端指向中转**(Mac mini 和客户端各跑一次):

```bash
tb middle set <vps-ip>            # 写进本机 ~/.termbridge/settings.json
tb middle                         # 看当前: → ws://<vps-ip>:8001
tb info                            # host / relay / middle 一行看全
```

`tb middle set` 之后:**Mac mini 重启 `tb surf` / host** 让它改连中转;客户端的
`tb new` / `tb ls` / `tb <#>` 自动走中转(每次读 settings)。回本机直连:`tb middle unset`。

> 优先级:env `RELAY_URL` > `tb middle set` 的中转 > 本机 `localhost:7400`。
> 临时覆盖一发:`RELAY_URL=ws://1.2.3.4:8001 tb ls`。

**三端都自带每 3s 重试**:中转没起来 / 网断了,host、client、以及中转自己(端口被占)
都会每 3s 重连,网络恢复后自动接上——client 还会自动重接回原会话并回放 scrollback。

> ⚠️ **公网中转 = 更大的暴露面**。不加密码时,8001 是裸 WebSocket、纯信任:**谁能连到
> `<vps-ip>:8001` 且知道你的 `hostId`,谁就能开会话、烧你的 token、用你的 shell**。
> 所以公网必做下面这一节的**密码**(并建议安全组只放行自己的 IP)。

## 给中转加密码(`tb secret`,HMAC 挑战应答)

一个共享密码就能把中转锁上。三端(relay / Mac mini / 客户端)设同一个密码即可——relay 每次
连接发一个随机 nonce,两端用 `HMAC-SHA256(密码, nonce)` 应答,**密码本身不过线**(明文 `ws://`
也安全),没有正确密码的连接在 `hello` 之前就被拒。密码越长越好。

```bash
# 1) 服务器(VPS):设密码再起中转。两种方式二选一——
TB_SECRET='一段很长的口令…' tb middle serve     # 用环境变量(密码不落盘)
#   或:  tb secret set   # 交互式隐藏输入,存进 ~/.termbridge/settings.json(chmod 600),再 tb middle serve

# 2) Mac mini + 每个客户端:设同一个密码
tb secret set                 # 隐藏输入,粘贴同一段口令(避免进 shell 历史)
tb secret                     # 看状态(只显示 set/none + 长度,绝不回显明文)
tb info                       # 末尾 auth on / off 一眼可见
```

`tb secret set` 后:**Mac mini 重启 `tb surf` / host**;客户端命令每次读 settings,无需重启。
密码不对会被 relay 拒:`✖ authentication failed: wrong password …`。优先级:env `TB_SECRET` >
settings 里的密码。

> 这层只解决**「谁能连」**(防陌生人连上来烧 token);它**不加密流量内容**。要连 PTY 字节、
> 你敲进去的 token 都加密,用下面一节的**自签 wss**(无需域名)。
> 注意:三端版本要一致(老二进制不发 `auth_response`,会握手失败)。

## 流量加密:自签 wss + 指纹固定(无需域名)

裸 IP、没域名也能加密——`tb middle` 自带自签证书 wss:relay 用自签证书(IP 写进 SAN)讲
`wss://`,两端**固定证书指纹**来认证(防中间人),不依赖任何公共 CA / 域名。

```bash
# 1) VPS 上:生成证书(把你的公网 IP 写进 SAN),记下打印出来的 SHA-256 指纹
tb middle cert <vps-ip>
#   → 写到 ~/.termbridge/tls/{cert,key}.pem(key 自动 chmod 600)

# 2) VPS 上:照常起中转——检测到证书就自动讲 wss(看日志 “tls: on”)
tb middle serve

# 3) Mac mini + 每个客户端:固定指纹 + 指向 wss
tb middle pin <上面那串指纹>
tb middle set wss://<vps-ip>:8001
tb info          # 末尾显示 “tls pinned” 就对了
```

指纹对不上(被换了证书 / 填错)→ 直接拒连:`✖ TLS fingerprint mismatch`。优先级:env
`TB_TLS_PIN` > settings 里的 pin;证书路径可用 `TB_TLS_CERT` / `TB_TLS_KEY` 覆盖。

> 重新 `tb middle cert` 会换指纹,记得各端重新 `tb middle pin`。`wss://` 但没 pin → 会走系统
> 信任库、自签证书被拒(`tb info` 显示 `wss but UNPINNED`)。`tb surf`(本机 loopback)永远是
> 明文 ws,不受影响。密码 + wss 可以叠加:既挡「谁能连」又加密内容。

## 2. 先前台跑通(验证)

Mac mini 上一条命令起守护进程(relay + host):

```bash
cd ~/code/termbridge
tb surf            # 默认 PORT=7400；首次会生成 ~/.termbridge/config.json
```

另一台设备(命令很短,只需 RELAY_URL 指到 Mac mini):

```bash
RELAY_URL=ws://<macmini-ip>:7400 tb ls           # 看会话
RELAY_URL=ws://<macmini-ip>:7400 tb new claude   # 开一个 claude
```

只有一个宿主时不用写它是谁;多宿主用 `tb @<hostId> ...`。

## 3. 配置 agent(proxy / 别名 / shell 语法都在这解决)

`tb new <名字>` 里的名字在 **`~/.termbridge/config.json`** 映射到真实命令,host 用
`<shell> -ic "<命令>"` 起——所以 `&&`、`proxy` 这种别名、`.zshrc` 里的 PATH **全都生效**
(交互式 shell 会加载 `~/.zshrc`)。`tb surf` 首次已自动写好:

```json
{
  "shell": "zsh",
  "agents": {
    "claude": "proxy && claude --dangerously-skip-permissions",
    "codex": "proxy && codex"
  }
}
```

于是你那条又臭又长的命令现在就是:

```bash
RELAY_URL=ws://<macmini-ip>:7400 tb new claude
```

> 前提:`proxy` / `claude` 在 **Mac mini 的 `~/.zshrc` / PATH** 里(agent 在那台跑)。
> 临时跑个原始命令、不想进配置:`tb new -- <command...>`(直接 exec,不走 shell)。

不用手动编辑 JSON,客户端就能管这些预设(改的是 host 上的配置):

```bash
tb info                                          # 看每个 agent 到底跑什么
tb set gemini "proxy && gemini"                  # 加/改一个预设
tb rm  gemini                                    # 删一个
```

## 4. 常驻（后台 + 登录启动 + 崩溃重启）

npm 安装版优先让 TB 自己生成和管理用户级 LaunchAgent，不再手改仓库路径：

```bash
# 如果 Cloudflare 必须经过代理，先在同一个 shell 中 export/proxy
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890

tb host start          # 后台运行，仅当前登录会话
tb host enable         # 后台运行，并在以后登录 macOS 时自动启动
tb host restart        # pair 或代理变化后，重写环境并真正重启
tb host status
tb host logs -f
tb host stop
tb host disable        # 只取消登录启动，不停止当前 Host
tb host doctor --fix   # 修复 node-pty spawn-helper 的 +x 权限
```

`start/restart/enable` 会捕获当前 shell 的大小写 `HTTP_PROXY`、`HTTPS_PROXY`、
`ALL_PROXY`、`NO_PROXY`，并写入权限为 `0600` 的受管 plist。代理带账号密码时也不会打印到
状态和日志，但它会存在本机 plist 中。Host 使用 `KeepAlive`，异常退出后由 launchd 拉起。

手机端长按某个 Host 标签可设置该 Host 的网络路线；配置由对应 Mac 写入
`~/.termbridge/settings.json`，手机重装后会从 Host 重新同步。本机也可使用同一配置：

```bash
tb network system     # 默认：跟随 captured proxy / 系统路线
tb network direct     # 忽略 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
tb host restart       # 本机改动后立即重拨
```

`direct` 只控制 Termbridge 能明确管理的应用层代理。macOS 的 TUN/系统 VPN 仍可能接管 socket；
Android 是否能按 Host 绕过 VPN，则取决于该 VPN 是否允许应用绑定底层网络。Termbridge 不会把
“已保存策略”误报成“第三方 VPN 已成功切换”。
`tb host` 无子命令时仍以前台方式运行，便于临时调试。

仓库源码开发模式仍可手工安装示例 plist。单台 Mac mini 用 **一个 surf 服务**最省事
（`deploy/launchd/com.termbridge.surf.plist`，改好仓库路径/PATH）：

```bash
mkdir -p ~/Library/LaunchAgents ~/Library/Logs
cp deploy/launchd/com.termbridge.surf.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.termbridge.surf.plist

# 看状态 / 日志 / 停
launchctl print gui/$(id -u)/com.termbridge.surf | head
tail -f ~/Library/Logs/termbridge-surf.log
launchctl bootout gui/$(id -u)/com.termbridge.surf    # 卸载
```

> 想把 relay 和 host 拆开部署(比如 relay 放云上),改用
> `com.termbridge.relay.plist` + `com.termbridge.host.plist` 这两个(host 设
> `RELAY_URL` 指向云上 relay)。

注意:

- 用 **LaunchAgent**(不是 LaunchDaemon),它以你的用户身份跑,能拿到你的 token 与文件。
- LaunchAgent 在**你登录后**才起。无人值守的 Mac mini 想一直在线:系统设置→用户与群组→
  开启**自动登录**;或睡眠设置里关掉自动睡眠(`系统设置→能源`)。
- 默认会话是交互式 zsh(plist 里 `SHELL=/bin/zsh`),所以 launchd 那点精简 PATH 不影响——
  会被 `~/.zshrc` 覆盖。但 codex/claude 的目录最好也写进 plist 的 `PATH` 兜底。

## 5. 纯信任提醒

P0 是纯信任:**谁知道 `HOST_ID` + 能连到 relay,谁就能开会话、烧你的 token、用你的 shell**。
所以现在只在可信网络(同 WiFi / Tailscale 自己的 tailnet)里用;上公网前先做 P2 的鉴权 + wss
(见 [roadmap](./roadmap.md))。
