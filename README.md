# TermBridge

Cross-machine terminal, coding-agent, and remote-automation bridge. Run Claude Code, Codex, or any shell on one host (macOS / Linux / WSL2) and control it from another terminal, desktop app, mobile app, or AI agent through your own relay (LAN, self-hosted VPS, or self-hosted Cloudflare Worker).

- **Works out of the box with native PTY** (`node-pty` + WebSocket) — no tmux or external multiplexer required.
- **Optional Herdr integration** — automatically discovers local Herdr workspaces/panes when `~/.config/herdr/herdr.sock` exists, and runs purely with native PTY when Herdr is absent.
- **Zero hardcoded third-party cloud relay** — every user owns their own relay (Cloudflare Worker, VPS, or LAN).
- **Agent-ready** — give this `README.md` to your AI coding agent (Claude Code, Codex, Cursor, OpenClaw, etc.) and ask it to install, configure, and verify TermBridge for you automatically.

> **想让你的 AI Agent 自动帮你装好？** 直接对你的 Agent 说：
> *"阅读这个仓库的 README.md，按里面的 Agent 自动安装与配置协议帮我安装并配置好 TermBridge。"*

---

## 🤖 Agent 自动安装与配置协议（AI Agent Setup Protocol）

If you are an AI Agent setting up TermBridge for a user, follow Steps 1 → 5 in order. Do not skip Step 2 (asking the user for decisions) or Step 5 (end-to-end verification).

### 硬性规则（Hard Rules for Agents）

1. **禁止盲猜隐私或网络参数**：不要臆造用户的 VPS IP、共享密码、Cloudflare 账号或 API Key；必须先通过 Step 2 询问用户。
2. **禁止泄露凭据**：绝不把 `TB_SECRET`、`termbridge://pair?...`、`tb1_...`、`DASHSCOPE_API_KEY`、`VOLCENGINE_S2S_API_KEY` 写入代码库、日志或公开文档；建议密码和 API Key 由用户在自己的终端里输入或导出。
3. **禁止在非 TTY 工具调用里直接跑阻塞命令**：不要直接执行 `tb`、`tb surf`、`tb serve`、`tb host`（前台常驻）、`tb attach`、`tb <id>`、无参 `tb new`、无参 `tb secret set`；一律使用下方非阻塞替代方式。
4. **禁止擅自放宽权限**：未经用户明确要求，不要启用 `tb expose on`（反向设备控制），也不要把 Agent 预设改成 `--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`。

---

### Step 1：自动探测本机环境（直接执行，无需询问）

Run this read-only probe first to detect OS, Node version, existing TermBridge install, and local tools:

```bash
uname -sm
node -v 2>/dev/null || echo "node: MISSING"
which tb 2>/dev/null && tb --version || echo "tb: NOT_INSTALLED"
which claude codex 2>/dev/null || true
test -S "$HOME/.config/herdr/herdr.sock" && echo "herdr: FOUND" || echo "herdr: NOT_FOUND"
test -f "$HOME/.termbridge/settings.json" && echo "settings.json: EXISTS" || echo "settings.json: NONE"
test -f "$HOME/.termbridge/config.json" && echo "config.json: EXISTS" || echo "config.json: NONE"
```

**判定条件**：
- **Node.js 必须 ≥ `22.19.0`**（见 `package.json` `engines.node`）。如果缺失或版本偏低，先告知用户并征得同意后再通过 `nvm` / `fnm` / `brew` 升级。
- **Windows 宿主机**：Host 建议在 **WSL2** 中运行；原生 Windows 客户端见 [`windows/`](./windows)。

---

### Step 2：一次性询问用户所需决策（Required Intake Questions）

Before modifying system config or starting services, ask the user these 4 concise questions in one message (provide the defaults in bold so they can reply quickly):

1. **跨设备连接方式（选一个）**：
   - **A. 自建 Cloudflare 中继（推荐，跨公网免公网 IP/VPN）** — 需用户有一个免费 Cloudflare 账号并完成一次浏览器登录。
   - **B. 自建 VPS 中继** — 需用户提供一台公网服务器的 IP/域名，并决定是否开启自签 WSS 证书加密（公网强烈推荐开启）。
   - **C. 局域网 / Tailscale 直连** — 适合同一内网或已组网 Tailscale 的设备，免云端中继。
   - **D. 仅本机体验 / 验证** — 只在本机跑通 `tb serve` + `tb exec` / `tb ls`。
2. **需要接入哪些客户端？**
   - 另一台电脑的 `tb` CLI / macOS 桌面 App（仅 Apple Silicon macOS 13+）/ Android / iOS / Windows。
3. **后台运行与 Agent 预设**：
   - **后台常驻**：macOS 推荐开机自启（`tb host enable`）或仅当前登录会话后台（`tb host start`）；Linux/WSL2 推荐后台进程或 `systemd --user`。
   - **Agent 预设**：默认使用纯净 `claude` / `codex`；询问用户是否需要通过 `tb set` 添加代理环境变量（如 `HTTPS_PROXY=...`）或自定义启动参数。
4. **是否需要可选的 Global Brain / 云端语音？**
   - **默认关闭**（纯终端、Agent 对话、远程执行 `tb exec` 和文件传输**不需要任何 API Key**）。
   - 如需开启，告知用户自行在本地 shell 导出 `DASHSCOPE_API_KEY`（及可选 `VOLCENGINE_S2S_API_KEY`），不要发在对话里。

---

### Step 3：自动安装 CLI（及可选 macOS App）

After the user confirms, run the non-interactive installation:

```bash
# Option 1 (recommended): install published CLI globally
npm install -g agent-termbridge

# Verify binary and fix node-pty spawn-helper permissions if needed
tb --version
tb host doctor --fix
```

*(If installing from a cloned local repository instead of npm: run `pnpm install && pnpm build && npm link` inside the repo directory.)*

If the user is on **Apple Silicon macOS 13+** and also wants the desktop App:

```bash
tb app install   # downloads, verifies Sparkle + Apple notarization, installs to ~/Applications
tb app status
tb app open
```

If the user requested custom agent presets (only apply what the user explicitly asked for):

```bash
tb set claude "claude"   # or user-specified command, e.g. "HTTPS_PROXY=http://127.0.0.1:7890 claude"
tb set codex "codex"
```

---

### Step 4：按用户选择的连接方式执行配置

Follow **only** the path the user chose in Step 2:

#### Path A：自建 Cloudflare 中继（推荐跨公网）

1. **`[PAUSE FOR USER]`** 请用户在**自己的本地终端**运行浏览器登录（Agent 不要在无浏览器/非交互环境代跑）：
   ```bash
   tb cloudflare login
   ```
   等用户确认登录完成后继续。
2. **Agent 自动部署私有 Worker 并生成共享密钥**：
   ```bash
   tb cloudflare deploy
   ```
   *(自动部署 `cloudflare/wrangler.jsonc` 到用户的 Cloudflare 账号，生成 256-bit 密钥写入 Worker encrypted secret `TB_SECRET`，并把 `wss://<worker>.<subdomain>.workers.dev` 写入 `~/.termbridge/settings.json`。)*
3. **Agent 启动后台 Host**：
   - **macOS**：
     ```bash
     tb host enable    # 或仅当前会话：tb host start；若已运行则 tb host restart
     tb host status
     ```
   - **Linux / WSL2**（`tb host enable` 仅支持 macOS LaunchAgent，Linux/WSL2 请后台常驻）：
     ```bash
     mkdir -p "$HOME/.termbridge"
     nohup tb host > "$HOME/.termbridge/host.log" 2>&1 &
     ```
4. **Agent 生成配对二维码 / URI**：
   ```bash
   tb cloudflare pair
   ```
5. **`[PAUSE FOR USER]`** 引导用户完成其他设备配对：
   - **Android / iOS / macOS / Windows App**：扫描终端二维码，或粘贴输出的 `termbridge://pair?v=1&...` 配对链接。
   - **另一台电脑 CLI**：在目标电脑装好 `agent-termbridge` 后运行：
     ```bash
     tb cloudflare use '<termbridge://pair?v=1&...>'
     ```

#### Path B：自建 VPS 中继

1. **`[PAUSE FOR USER]`** 引导用户在 VPS 上部署并启动 Relay（默认端口 `8001`，需放行 TCP `8001`）：
   ```bash
   # 在 VPS 上执行：
   npm install -g agent-termbridge
   tb middle cert <vps-ip>                     # 可选但公网强烈推荐：生成自签 TLS 证书并打印 SHA-256 指纹
   TB_SECRET='<高强度共享密码>' tb middle serve  # 建议配合 systemd / tmux 常驻
   ```
   等用户提供 `<vps-ip>`（及可选 TLS 指纹 `<sha256-pin>`）。
2. **Agent 在本机配置中继地址与证书指纹**：
   ```bash
   # 若开启自签 wss：
   tb middle set wss://<vps-ip>:8001
   tb middle pin <sha256-pin>
   # 若未开 TLS（仅受信任网络）：
   # tb middle set <vps-ip>
   ```
3. **`[PAUSE FOR USER]`** 为避免密码进入聊天记录，请用户在本地终端执行（或在自动化环境由用户提供后传入）：
   ```bash
   tb secret set
   ```
4. **Agent 启动后台 Host 并打印配对二维码**：
   - macOS：`tb host enable`（或 `tb host restart`）
   - Linux/WSL2：`nohup tb host > "$HOME/.termbridge/host.log" 2>&1 &`
   - 打印手机/其他端配对二维码：`tb cloudflare pair`（会自动基于当前配置的自建 Relay 与密码生成 `termbridge://pair` 二维码，带 TLS 指纹）。

#### Path C：局域网 / Tailscale 直连

1. **在宿主机（Host）后台启动 `tb serve`**（同时提供本地 Relay 端口 `7400` + Host）：
   - macOS / Linux / WSL2：
     ```bash
     mkdir -p "$HOME/.termbridge"
     nohup tb serve > "$HOME/.termbridge/serve.log" 2>&1 &
     ```
   - *(如果希望内网也有密码鉴权，请先在宿主机与客户端都运行 `tb secret set`，再重启 `tb serve`。)*
2. **在客户端机器配置指向宿主机的局域网或 Tailscale IP**：
   ```bash
   tb middle set ws://<host-ip>:7400
   # 如果宿主机或客户端开了全局代理导致内网走代理失败：
   tb network direct
   ```
   *(若使用 macOS App，也可以在「设置 → 局域网服务」图形化一键开启，详见 [docs/cli-automation.md](./docs/cli-automation.md)。)*

#### Path D：仅本机体验 / 验证

```bash
mkdir -p "$HOME/.termbridge"
nohup tb serve > "$HOME/.termbridge/serve.log" 2>&1 &
sleep 2
```

---

### Step 5：端到端自动验收（必须全部通过再告知用户完成）

Run these verification checks and confirm every item passes:

```bash
tb --version
tb info
tb topology
tb ls
tb exec --json -- echo termbridge-ready
```

*(如果拓扑中连接了多台 Host，先从 `tb topology` 读取目标 `<hostId>`，再执行 `tb -H <hostId> exec --json -- echo termbridge-ready`。)*

**通过判据**：
- `tb info` 显示正确的 `relay` 地址与 `auth: on`（公网模式必须为 `on`）。
- `tb topology` 显示目标 Host 在线。
- `tb exec --json -- echo termbridge-ready` 返回退出码 `0` 且 JSON 中包含 `"exitCode":0` 和 `"stdout":"termbridge-ready\n"`。

**验收通过后向用户汇报**：当前 Host ID、Relay 地址（**切勿回显密码或 pairing URI 原文**）、Host 运行状态，以及后续手机/其他电脑的接入方式。

---

## 🎮 Agent 远程控制速查（Ongoing Control）

完成安装与配对后，任何 AI Agent 都可以通过以下**非交互命令**安全地观察和控制远端主机：

```bash
# 1. 拓扑与状态查询
tb info                                               # 本机 host / shell / relay / auth / presets
tb topology                                           # 当前中转在线的全部 Host 与客户端
tb ls                                                 # 列出所有 PTY 会话与 Herdr pane
tb host status                                        # 检查 macOS 后台 Host 状态

# 2. 远端无 PTY 命令执行（精确保留 argv、stdout/stderr、退出码）
tb -H <host> exec --json -- uname -a
tb -H <host> exec --cwd /path/to/repo -- git status --short
tb -H <host> exec --env MODE=ci --timeout 60 -- make check
tb -H <host> exec --stdin -- bash -s < script.sh

# 3. 远端文件流式传输（SHA-256 校验 + 原子 rename）
tb -H <host> push --mkdir ./artifact.bin /tmp/build/artifact.bin
tb -H <host> pull /tmp/build/artifact.bin ./artifact.bin
tb -H <host> push -r ./local-dir /tmp/new-remote-dir
tb -H <host> pull -r /tmp/remote-dir ./new-local-dir
tb -H <host> cat /tmp/build/output.txt
tb -H <host> audit --tail 20

# 4. 读取宿主机上其他 Coding Agent 的持久上下文
tb context list
tb context search "<关键词>"
tb context show <session-id>

# 5. 已授权 Peer 设备控制（目标设备需先由用户明确授权 `tb expose on` 或在 App 设置开启）
tb -H <host> peer list
tb -H <host> peer topology
tb -H <host> peer exec --device <device-id> -- /usr/bin/uname -a
```

*(单 Host 环境下 `-H <host>` 可省略，也可用环境变量 `TB_HOST=<host>` 指定默认目标。)*

### 非 TTY 环境下 Agent 禁止直接调用的命令

| 禁止直接运行 | 原因 | 正确替代 |
|---|---|---|
| `tb` / `tb surf` / `tb serve` / `tb host` | 前台常驻进程，会一直阻塞直到超时 | macOS 用 `tb host enable` / `tb host start`；Linux/WSL2 用 `nohup ... &` 或 `systemd` |
| `tb attach <id>` / `tb 1` / `tb 'herdr:...'` | 接管交互式全屏 TTY | 用 `tb -H <host> exec -- ...` 或 `tb context show <id>` |
| 无参 `tb new` | 弹出交互式终端菜单 | 用 `tb -H <host> exec -- ...` |
| 无参 `tb secret set` | 等待隐藏密码输入 | 请用户在自己的终端运行 `tb secret set` |
| `tb cloudflare login` | 需打开浏览器完成 OAuth | 暂停并请用户在自己的终端执行 |

### 常见排错表（Agent 自动恢复参考）

| 报错现象 | 原因 | 修复命令 / 处理方式 |
|---|---|---|
| `posix_spawnp failed` | `node-pty` 的 `spawn-helper` 缺少可执行权限 | `tb host doctor --fix`（源码仓库可用 `node scripts/fix-pty-perms.mjs`） |
| `No relay and password are configured` | 尚未部署或配置中继 | 引导用户走 Step 4（推荐 `tb cloudflare login` → `tb cloudflare deploy`） |
| `authentication failed` | Relay 与 Host/Client 的 `TB_SECRET` 不一致 | 确认各端密码一致后重启 Host（`tb host restart`） |
| `host not found` | Host 未启动、未连上同一 Relay，或 `-H` 填错 | 先查 `tb topology` 与 `tb host status` / `tb host logs` |
| `tb host enable` 在 Linux 报错 | LaunchAgent 服务管理仅限 macOS | Linux/WSL2 改用 `nohup tb host > ~/.termbridge/host.log 2>&1 &` 或 `systemd --user` |
| 内网直连被公司代理拦截 | 命中了 `HTTP(S)_PROXY` 环境变量 | `tb network direct && tb host restart` |
| `remoteAutomation` 被拒绝 | 宿主机配置关闭了远程执行 | 检查宿主机 `~/.termbridge/config.json` 中的 `"remoteAutomation"` |

---

## 人类用户快速上手（Quick Reference）

### 1. 安装

- **前置**：Node.js ≥ `22.19.0`（macOS 源码构建需 Xcode Command Line Tools）。
- **全局 CLI**：
  ```bash
  npm install -g agent-termbridge
  ```
- **macOS 桌面 App（Apple Silicon, macOS 13+）**：
  ```bash
  tb app install && tb app open
  ```
- **从源码开发**：
  ```bash
  pnpm install   # postinstall 自动修复 node-pty spawn-helper 权限
  pnpm build
  pnpm test
  ```

### 2. 常用命令一览

```bash
# 本地一分钟体验（终端 A 起服务，终端 B 开会话）
tb serve                       # 启动本地 relay (7400) + host
tb new claude                  # 新建预设会话（Ctrl-] 打开连接菜单，按 d 断开且保留会话）
tb ls                          # 列出所有 TB PTY 与 Herdr 会话
tb 1                           # 按序号重新接入
tb kill 1                      # 结束会话

# 跨公网（自建 Cloudflare Worker，推荐）
tb cloudflare login            # 浏览器登录你的 Cloudflare 账号
tb cloudflare deploy           # 部署私有 Worker + 自动写入加密 TB_SECRET
tb host enable                 # macOS 开机自启后台 Host
tb cloudflare pair             # 打印配对二维码与 termbridge://pair URI

# 后台 Host 管理（macOS LaunchAgent）
tb host start | stop | restart | enable | disable | status | logs -f | doctor --fix

# 预设与配置（~/.termbridge/config.json）
tb info
tb set claude "claude"
tb rm claude

# 网络策略与更新
tb network                     # 查看当前路由策略与代理命中状态
tb network system | direct     # 跟随系统代理 / 直连忽略应用层代理
tb update --check              # 检查更新
tb update                      # 安全更新并保留备份
```

默认首次生成的 `~/.termbridge/config.json`：

```json
{
  "shell": "/bin/zsh",
  "agents": {
    "claude": "claude",
    "codex": "codex"
  }
}
```

### 3. 可选：自动接管本地 `codex` / `claude`（Herdr）

如果本机安装了 Herdr，`tb init` 会在 PATH 中放置透明 shim，让交互式 `codex` / `claude` 自动在 Herdr workspace 中启动并被 TermBridge 发现：

```bash
tb init            # 安装 PATH shim 并刷新 Herdr integration
tb init status     # 查看状态
tb init uninstall  # 卸载并恢复 shell rc
```

未安装 Herdr 时 shim 会自动直通原命令，TermBridge 纯 PTY 模式完全可用。也可用 `TB_HERDR=off` 显式关闭发现，或用 `TB_HERDR_SOCKET=/path/to/herdr.sock` 指定路径。

---

## 可选：Global Brain 与实时语音（BYOK 云端）

Global Brain（文字与持续语音通话）是完全可选功能。**所有 API Key 仅保留在宿主机本地环境或 `0600` 配置中，绝不发送到手机客户端或中继。**

- **文字对话与 Voice Execution Fork**：默认使用阿里云百炼 `deepseek-v4.1-flash`（关闭思考，`packages/brain/src/models.ts`），通过 `DASHSCOPE_API_KEY` 启用，可用 `TB_BRAIN_MODEL` 覆盖。未配置 Key 时明确提示不可用，不静默回退到本地 Agent。
- **实时语音前端**：支持百炼 Qwen Omni (`qwen3.5-omni-flash-realtime`) 与火山引擎豆包 Seeduplex (`1.2.6.1`)，共用同一工具链（`inspect_workspace`、`continue_agent`、`dispatch_agent`、只读 `workspace_files`，默认项目根目录 `TB_BRAIN_FILES_ROOT` = `~/code`）。
- **Android 端侧语音保护**：arm64 `sherpa-onnx` + Silero VAD + GTCRN 降噪 + 3D-Speaker CAMPPlus 声纹校验（声纹向量仅用 Android Keystore 加密保存在本机私有存储，禁止备份）。
- **宿主机 Memory**：本地 `~/.termbridge/memory.md`（可用 `TB_BRAIN_MEMORY` 覆盖），禁止保存凭据。

```bash
# 百炼（Global 文字 / Execution Fork / Qwen Omni 语音）
export DASHSCOPE_API_KEY='your-dashscope-api-key'

# 可选覆盖项
export TB_BRAIN_MODEL=deepseek-v4.1-flash
export DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
export TB_BRAIN_ASR_MODEL=qwen3-asr-flash
export TB_VOICE_TTS_MODEL=qwen3-tts-flash
export TB_VOICE_TTS_VOICE=Cherry
export TB_VOICE_OMNI_MODEL=qwen3.5-omni-flash-realtime
export TB_BRAIN_FILES_ROOT="$HOME/projects"

# 可选：火山引擎 Seeduplex 实时语音前端
export TB_VOICE_PROVIDER=auto   # auto | bailian | volcengine
export VOLCENGINE_S2S_API_KEY='your-volcengine-s2s-api-key'
export TB_VOICE_VOLCENGINE_MODEL=1.2.6.1
export TB_VOICE_VOLCENGINE_SPEAKER=zh_female_vv_jupiter_bigtts
```

详见 [ADR-0006](./docs/decisions/0006-voice-brain-context-and-tools.md) 与 [ADR-0012](./docs/decisions/0012-volcengine-s2s-provider.md)。

---

## 远程自动化安全与审计语义（`tb exec` / `push` / `pull` / `cat`）

- 复用现有配对中继、HMAC 挑战应答与 TLS 指纹校验，无需更改中继。
- `exec` 直接 spawn（无 PTY），保留精确 argv、stdout/stderr 字节与退出码（信号退出 = `128 + signal`），默认工作目录为 Host 用户 HOME 并加载登录环境（`--login`）；超时、Ctrl-C 或断开会终止远端进程组，永不自动重发。传输错误仅写 stderr（`tb:` 前缀）并退出 `255`。
- `--json` 输出 `{exitCode,signal,stdout,stderr,encoding,durationMs}`（任一路含非 UTF-8 字节时自动切换 base64）。
- `push` / `pull` 分块流式传输并校验 SHA-256，校验通过后原子 `rename`；`-r` 使用 `tar` 原子提交到尚不存在的新目录；`--mkdir` 仅在 push 时创建父目录。
- 控制复用 socket 位于 `~/.termbridge/control/`（目录 `0700`、socket `0600`），空闲 10 分钟自动退出（`TB_NO_CONTROL=1` 可绕过）。
- 在宿主机 `~/.termbridge/config.json` 中设置 `"remoteAutomation": false` 并重启 Host 可彻底禁用远程 exec/fs。元数据审计日志追加至 `~/.termbridge/audit.log`（绝不记录 stdin、文件内容、stdout/stderr 或环境变量值）。

---

## 多端客户端

- **macOS Control Center** ([`macos/TermBridgeControlCenter/`](./macos/TermBridgeControlCenter))：菜单栏与会话导航、原生终端 + Agent Chat、Git 差异与文件预览（`⌘⇧G`）、Sparkle 自动更新、内置 CLI 导出。
- **Android** ([`android/`](./android))：会话列表、xterm.js 终端 + 原生 IME 输入条、Agent Chat、Global Brain 与语音通话、加密远程桌面、Watch Hub、Phone Peer Actions。构建见 [android/README.md](./android/README.md)。
- **iOS** ([`ios/`](./ios))：SwiftUI 客户端、Keychain 凭据存储、xterm.js 终端、Agent Chat、Git 审查、远程桌面。构建见 [ios/README.md](./ios/README.md)。
- **Windows** ([`windows/`](./windows))：原生 WinUI 3 + WebView2 客户端，支持 Terminal、Agent Chat 与可选本机/浏览器协助。见 [windows/README.md](./windows/README.md)。
- **Zepp OS 手表** ([`watch/zepp-os-termbridge/`](./watch/zepp-os-termbridge))：Amazfit 伴侣应用，支持优先级通知收件箱与 Global 语音。
- **Chrome 扩展** ([`browser-extension/`](./browser-extension))：可选 Manifest V3 Native Messaging 浏览器协助桥接。

---

## 开发与测试

```bash
pnpm surf       # 从源码启动本地 relay + host
pnpm tb …       # 从源码运行 CLI（例如 pnpm tb ls）
pnpm relay      # 单独运行 relay
pnpm host       # 单独运行 host
pnpm test       # typecheck + 单元测试 + Cloudflare Workers + 端到端集成测试
pnpm build      # 打包 dist/cli.js、host.js、relay.js 与 macOS desktop helper
```

各端验证命令：

- **Node & Cloudflare**：`pnpm test && pnpm build`
- **远程自动化旁路验收**：`pnpm build && node scripts/test-automation.mjs`
- **Android**：`cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug`
- **iOS**：`cd ios && swift test`
- **macOS**：`cd macos/TermBridgeControlCenter && swift test`

---

## 包结构

| 包 / 目录 | 作用 |
|---|---|
| `@termbridge/protocol` | 二进制分帧、relay 信封、Zod 消息 schema、桌面加密 |
| `@termbridge/settings` | 本地设置（`~/.termbridge/settings.json`）、中继解析、HMAC、自签 TLS 指纹固定 |
| `@termbridge/brain` | 全局对话状态、百炼规划与 coding agent 安全路由 |
| `@termbridge/voice` | BYOK 云端 ASR / TTS / Realtime Omni / 火山 Seeduplex |
| `@termbridge/review` | Git 仓库改动与私密文件过滤（`isPrivatePath`） |
| `@termbridge/agent-chat` | 无 UI 依赖的 Agent 对话状态、去重、Claude/Codex transcript 解码 |
| `@termbridge/agent-chat-ui` | 无框架 WebView 对话组件（打包进各原生端） |
| `@termbridge/desktop-ui` | 加密远程桌面视口（内嵌未修改的 MPL-2.0 noVNC） |
| `@termbridge/relay` | Node WebSocket 会合/转发服务器（`tb middle serve`） |
| `@termbridge/cloudflare-relay` | Cloudflare Worker + Durable Object Hibernation 中继 |
| `@termbridge/host` | PTY 会话管理、Herdr socket 适配、Brain/Voice/AgentChat/Desktop/Automation 服务 |
| `@termbridge/cli` | 统一 `tb` / `termbridge` CLI、attach 客户端、远程自动化、服务管理 |
| `android/` / `ios/` / `macos/` / `windows/` / `watch/` / `browser-extension/` | 各平台原生客户端与伴侣应用 |

---

## 文档索引

- [架构设计](./docs/architecture.md) — 三角色、拓扑、安全边界与技术栈
- [线协议](./docs/protocol.md) — 二进制帧、relay 信封、控制消息与不变量
- [App 内置 CLI 与自动配置](./docs/cli-automation.md) — PATH 导出、拓扑、Peer 执行、内网自动配置与更新
- [Cloudflare 中继](./docs/cloudflare.md) — 自建部署、认证模型、多房间 `TB_CLOUDFLARE_RELAY`
- [部署指南](./docs/deploy.md) — launchd、VPS 中继、Tailscale 与预设配置
- [测试说明](./docs/testing.md) — 测试套件与新增场景
- [故障排查](./docs/troubleshooting.md) — 常见错误与修复
- [架构决策记录](./docs/decisions) — ADR 目录
- [第三方开源声明](./THIRD_PARTY_NOTICES.md) — 内嵌开源组件与许可证

## License

[MIT](./LICENSE)
