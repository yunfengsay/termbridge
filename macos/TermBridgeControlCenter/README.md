# TermBridge for macOS

Native macOS session browser, menu-bar status, connection tabs, settings, and embedded interactive terminals.

## Codex terminal input and history (0.3.33, build 37)

Codex uses native terminal frames again, preserving its input cursor and window
size. The 0.3.32 compatible-snapshot workaround is superseded. Host 0.1.35 sends
wheel events at the current viewport center and preserves their count; missing
coordinates previously targeted Codex's fixed header instead of its transcript.
Both the viewing app and the serving Host need the fix. History comes from the
running application, rather than a small text snapshot. See the
[diagnosis and acceptance record](../../docs/diagnostics/2026-10-24-macos-codex-scroll.md).

## Session windows: standalone or directory navigation (0.3.26, build 30)

Settings → 连接与通知 → 通用 → **会话窗口** chooses how sessions open:

- **独立窗口** (default): each session in its own window, as before.
- **按目录导航**: one window in Herdr's layout. The sidebar lists the selected Host's
  Agents under their Herdr workspace (normally one project directory) with status and
  the latest summary. TB PTYs without a workspace share **其他会话**. Groups and rows
  keep their order when a status changes. Choosing a row shows that session on the right,
  in its terminal or conversation view as usual. The Host picker at the top of the sidebar
  is the same selection as the menu-bar tabs.

Only the session on screen and the most recently viewed ones stay attached, four in total,
so switching back is instant. Without the limit, every Agent ever opened would hold a Host
connection and, for native Herdr terminals, the pane's control lease. Older sessions only
detach: the Agent keeps running and reattaches when chosen again. Navigation never
detaches a session whose conversation send is still waiting for its receipt. Closing the
navigator window detaches everything, like closing a session window.

Changing the setting applies at once. Open session windows merge into the navigator with
their connection, draft and screen, and the front window stays on screen. Switching back
turns the session on screen into a window and detaches the rest. Nothing reconnects and no
Agent restarts.

Keyboard and routing:

- Click a row to type into its session. Arrow keys move through the list without leaving it.
- ⌥⌘↓ / ⌥⌘↑ (显示 → 下一个会话 / 上一个会话) switch sessions and focus the new one.
- ⇧⌘T / ⇧⌘D switch the session on screen between terminal and conversation.
- In this mode, notifications, 新建对话 and the menu-bar list open sessions in the navigator.

Grouping uses the workspace label the Host already sends, so there is no protocol change.
Herdr workspaces that share a label share a group.

Verification: `swift test` covers grouping, focus with real key events, the live limit, the
unconfirmed-send exception, and moving sessions between containers with the same process.
After building `dist`, `node scripts/test-session-navigator.mjs` checks the Host's own
viewer counts with a disposable Relay/Host: hidden recent sessions stay attached, at most
four are attached, the least recently viewed detaches, and closing the window detaches all.
Design: [ADR-0023](../../docs/decisions/0023-macos-session-navigator.md).

## Native Peer (0.3.12, build 16)

Settings → **Peer** lets each saved Host discover and, with explicit local grants,
use this Mac even with no terminal window open. It does not require Node or CLI.
Keep the App running; closing a window is fine, quitting disconnects Peer.
Choose the Host, enable access, add specific directories, then select **关闭 /
只读 / 读写**. Command execution has a separate, default-off switch and grants
the current user's full command privileges; the file directory is not a shell
sandbox. macOS privacy restrictions still apply. Revoke at any time on this Mac;
running commands stop, while already-written files are not rolled back.

Directory settings support manual absolute paths (including `~/`, spaces and
Chinese names), multi-selection in the folder picker, individual removal, and
**设为默认**. Up to 32 directories may be granted per Host; canonical duplicates
are merged. Relative file paths and the default command working directory use
the first entry; other roots are addressed with absolute paths. File tools
reject paths outside all granted roots, including symlink escapes. Removing
the last root turns off both file access and command execution. Legacy single
`root` settings migrate automatically; `info` exposes `roots` plus the compatible
default `root`. The multi-directory UI is available in 0.3.13 (build 17).

On the Host, use `tb peer list`, then `tb peer info --device <id>` or
`tb peer read <allowed-path> --device <id>`. Registration is independent of
notification settings and visible Host tabs. Multiple windows share a stable
`mac-app-<UUID>`; CLI has its own identity/permissions to avoid silently reusing
a CLI shell grant. Grants live in private `~/.termbridge/mac-peer.json`, scoped
to Host and credentials. No passwords are written there. File reads/writes are
limited to 1 MiB per call; exec to 60 seconds and 128 KiB stdout/stderr each.
Hosts no longer route tools to unregistered viewers as a legacy CLI fallback;
old CLI clients must upgrade/reconnect instead of silently timing out.

Verification: `swift test --filter MacPeerTests` and, after building repository
`dist`, `node scripts/test-mac-peer.mjs`. The latter starts disposable Relay/Hosts
and native App Peer services, not the installed App or user's running Host. It
verifies a real CLI file read, native writes/exec, multiple devices, independent
Host grants, cancelled receipt plus actual process death, and reconnect.
Remote user-machine acceptance still requires installing this newer App and
granting the specific diagnostic directory there.

Version 0.3.12 adds **新建对话** in the list header and empty state, plus **Cmd-N**.
Choose an Agent advertised by the selected Host or a plain Terminal, optionally
enter a working directory on that Host, then create and open its focused terminal.
Creation stays on the original Host if tabs change. Failed or timed-out creation
is never retried automatically; refresh that Host's list before trying again.
The terminal takes ownership of the already attached creation connection and
answers terminal queries immediately, before its window opens. Startup output
and exit codes stay visible if the command fails; an ended PTY is not reattached.
The existing **+** beside Host tabs still adds a connection source.
Run `node scripts/test-session-creation.mjs` with Node 24+ after building `dist`
(or set `TB_TEST_DIST` to a reviewed build). It uses two isolated Hosts to verify
Host selection, duplicate-submit protection, working directory, terminal focus/input,
startup query handoff, preserved failure output, and rejected credentials.

The current 0.3.13 (17) download is Developer ID signed and notarized by Apple. The
cloud-managed Xcode workflow and retained-archive resume commands are documented in
[SIGNING.md](SIGNING.md). Public distribution uses a ZIP containing the signed app
and its stapled ticket; unpack it and move TermBridge to Applications. The first
migration from an ad-hoc build may require macOS authorization to read the existing
TermBridge Keychain item. This does not expose the Mac login password to the app.

Version 0.3.9 adds Settings → 软件更新 and an application-menu update command.
Sparkle checks the signed release feed, supports manual install/relaunch, and offers
optional automatic download/install on quit. Automatic checks are enabled by
default; automatic installation and system profiling are off. The download-page
link remains available for manual installation. Host/CLI updates are independent.

Version 0.3.8 routes system notification clicks to their original connection and
session, including clicks received before launch finishes. Every saved Host has
an independent monitor while notifications are enabled; changing the visible tab
does not reset notification history. New connections establish a baseline before
alerting. Notification payloads contain a profile UUID, an endpoint digest, and a
session identity, without credentials or relay URLs. Deleted/retargeted profiles
and ended/reused PTY identities are rejected; repeated clicks reuse the terminal
window and validate the target again. Settings show OS permission and banner status.
The app must be running to observe transitions; quitting does not leave a service.
`MacNotificationTests` covers routing, independent monitors and remote preflight
with disposable Hosts. Actual Notification Center banner-click/cold-launch delivery
still requires manual macOS acceptance.

Version 0.3.7 unifies the terminal's dark title bar, attachment strip, and compact
footer. Connecting, missing Host capabilities, and failures are visible in the
viewport. A connection or native Herdr initial-screen wait times out after 15
seconds. Native terminal output dismisses its waiting surface; ordinary PTYs
can be ready without output. Older Hosts must still
be updated to support native Herdr terminal streams; listing sessions alone does
not establish that capability. Restarting a Host can terminate its owned PTYs,
so inspect those sessions before updating a running service.

Version 0.3.6 fixes the packaged app's ATS policy for user-configured WS and
self-signed WSS relays. Correctly pinned self-signed certificates are accepted;
wrong pins and untrusted certificates without a pin remain rejected. Connection
errors now identify TLS, timeout, and authentication failures without exposing
private endpoint URLs. This client fix does not change the image upload protocol.

Run `node scripts/test-packaged-connection.mjs` from this directory to exercise
the shipping Info.plist in a signed test app against a disposable TLS relay.
The test covers valid pin, wrong pin, and no pin; ordinary `swift test` alone
does not exercise app-level ATS restrictions.

Version 0.3.1 fixes local Agent opening when Herdr reports the requested pane
without a `terminal_id`: a confirmed live Agent can use `herdr agent attach <pane_id>`.
Missing panes, ambiguous IDs, malformed snapshots, and unsupported terminal metadata
produce separate errors. The optional context `paneId` can be recovered from its
stable `herdr:<pane_id>` session ID; conflicting IDs are rejected. Resolver and client
honor the same explicit Herdr socket/session/config settings, including `TB_HERDR_SOCKET`.

Version 0.3.0 adds a **本机** tab and saved remote Host tabs. The gear button, **+**,
or macOS **Settings / Cmd-,** opens connection settings. Add/edit a name, Relay URL,
Host ID (optional), shared password, and TLS fingerprint, or paste the same `tb1_`
code / pairing link used by the phone. Saving selects and connects the profile.
Leaving Host ID empty discovers the Relay's roster and adds each Host as a tab.
The first launch imports the CLI's configured Relay if present; **导入 TB 命令行配置**
refreshes that explicitly. Phone profiles are not automatically copied between devices.
Passwords and connection records live in the Mac app's own Keychain item. The last
selected tab survives relaunch. Names may be edited; duplicate display names receive
connection numbers. Removing a connection closes only its local attachment windows.
Notification preferences are available in the same settings window.

Remote terminals use the shared Apple WebSocket/HMAC/TLS-pin transport and SwiftTerm
in the app; they do not require a locally installed CLI. Remote Herdr requires TB Host
0.1.24+ and native Herdr stream support. Ctrl-C passes to the terminal; closing its
window only detaches. Reconnect is explicit. Host/session identities are scoped by
connection profile, so the same Host/session IDs at different endpoints never share a window.

The `Sources/TermBridgeControlCenter/Shared` symlinks compile the authoritative Apple
protocol, models, pairing parser, and transport from `ios/Termbridge` without copying
or changing those files. Mac persistence is separate (`MacConnectionStore`); the shared
iOS SettingsStore is not used by the Mac UI.
Click an Agent row or **Open Terminal** to attach in a TermBridge window. Type
normally, use Chinese input, select/copy, paste, and scroll inside the terminal.
The same session reuses its existing window; different sessions can stay open
side by side. **Ctrl-B, Q** detaches Herdr terminals; **Ctrl-]** detaches TB PTYs.
**Reconnect** attaches again. Closing a
terminal window or quitting the app disconnects its clients; the Host keeps the
Agent sessions running.

The terminal uses SwiftTerm's native view. For local Herdr sessions, the app
resolves the exact pane's terminal ID from `herdr api snapshot`, then runs
`herdr terminal attach <terminal_id>`. Herdr supplies the complete terminal
stream, including cursor position and input modes; no text snapshot redraw or
native message composer is used. Native attach manages its terminal viewport;
the app does not change the server's pane layout or focus, and never requests
`--takeover`. An existing control owner is reported in the terminal.

TB-owned PTYs use the installed `tb attach` client, including authentication,
TLS pinning, and reconnect behavior. The local Host's stable
`~/.termbridge/host-id` selects the exact TB Host. CLI discovery captures the user's
shell PATH and launches the resolved `tb` directly; Herdr is discovered in `~/.local/bin`, `/opt/homebrew/bin`, or
`/usr/local/bin`. The app reads `~/.termbridge/context.json`;
`TB_CONTEXT_STATE`, `HOST_ID`, and `TB_HOST_ID_FILE` overrides match the Host's
existing configuration.

The session browser prioritizes attention states, shows all present sessions,
and emits notifications for observed transitions. Phone / Watch Hub status is
separate from terminal connectivity; an unavailable Host bridge means its local
socket did not respond. Start the configured Host/relay to restore connectivity.
Global Brain chat and Call remain outside this macOS version's current feature set.

Build and test (Swift 6+):

```bash
swift test
./scripts/package-app.sh
```

The file inspector uses the MIT-licensed CodeEditTextView 0.12.1 native Swift/CoreText
component for read-only code and diffs, reusing the bounded syntax highlighter.
Its directory tree loads directly from the session's Host without a preceding
file-link click. ⌘⇧G opens changes; ⌘F finds text. Runtime dependency notices ship
in the resource bundle as `CodeEditor-LICENSES.txt`.

The package script includes the SwiftTerm license and verifies the signed app.
SwiftTerm is pinned, and its resources are included in `Contents/Resources` so
the packaged app does not depend on the build directory.

For terminal transport acceptance, provision a disposable Host and shell session,
then run (never target an active Agent):

```bash
TB_MACOS_TEST_HOST=<test-host> TB_MACOS_TEST_SESSION=<test-session> \
RELAY_URL=<test-relay> TB_SETTINGS=<isolated-settings-file> \
swift test --filter TerminalConnectionTests
```

This checks Unicode input/output, terminal dimensions, and detach through the
real installed TB client. Without those explicit test IDs the test is skipped.
Real graphical IME, selection, paste, and scrolling still require UI acceptance.

Install as a login item for the current user:

```bash
./scripts/install-launch-agent.sh
```

Installs into `~/Applications/TermBridge.app`, updates the login
item to that location, and restarts the Mac client. Previous installed apps and
login-item configuration are backed up under
`~/Library/Application Support/TermBridge/Backups/`.

Multi-source acceptance uses two disposable Relay endpoints (first has `mini` and
`office` Hosts, second has `mini`), with `TB_SECRET=macos-tabs-test-secret` on the
isolated fixtures. Set `TB_MACOS_TEST_RELAY_A` / `TB_MACOS_TEST_RELAY_B` when running
`swift test` to verify roster discovery, authentication, Unicode byte routing, resize,
and reconnect. The test creates and closes only its own `cat` sessions.
`TB_MACOS_TEST_KEYCHAIN=1` checks a unique disposable Keychain item;
`TB_MACOS_RENDER_DIR=/tmp/<directory>` exports layout snapshots. These do not replace
manual acceptance of macOS input methods or settings interactions.

## Distribution branding

Version 0.3.2 (build 6) ships as `TermBridge.app` with a full-resolution macOS icon.
`Resources/AppIcon.svg` is generated from the Android launcher paths and colors by `python3 scripts/sync-app-icons.py` at the repository root; `scripts/build-icon.sh` generates all standard and Retina ICNS sizes during packaging. The bundle identifier and Keychain service remain unchanged. The local installer backs up and migrates the old `TermBridge Control Center.app` bundle.

The download site packages a DMG containing `TermBridge.app` and an Applications shortcut, named `TermBridge-<version>-macOS-AppleSilicon.dmg`. This preview is ad-hoc signed and has not been notarized by Apple.

Version 0.3.3 (build 7) uses the existing Android logo across Mac, the DMG, website and iOS icon resources. Android launcher XML and brand colors are the source of truth; run the sync script after changing them. Only platform-required outer masks and margins differ.

Version 0.3.4 (build 8) selects and fills the imported CLI connection immediately and shows import feedback beside the action. CLI URL normalization and local defaults match the CLI. The automatic action reads `TB_SETTINGS` from the app process environment, otherwise `~/.termbridge/settings.json`; Finder launches do not inherit shell-only exports. Use **选择配置文件…** for custom files; an explicitly selected file is imported without environment overrides. Missing, unreadable, malformed and invalid configuration errors are reported separately.

The CLI import UI regression presses the real SwiftUI button through AppKit accessibility, verifies field population and Keychain persistence, and checks failure and repeated-import behavior using disposable files and a unique Keychain service (`TB_MACOS_TEST_KEYCHAIN=1`).

## Image attachments (0.3.5, build 9)

Use **添加图片**, **Paste**, or **Cmd-V** with a screenshot/image in the clipboard. Ordinary text paste remains unchanged. Finder file copies prefer the original image over the file icon. Attachments show previews and upload state; failed items can be retried or removed. **插入到终端** inserts all ready references at the terminal cursor without pressing Enter. Add your text and submit using the terminal normally.

The Mac reuses the Android `session_upload` / `session_upload_result` contract, without protocol changes. Remote images are accepted only after the exact session and request are acknowledged by the connected Host. Local images are copied under `~/Library/Application Support/TermBridge/Attachments` with private directory/file permissions. Inserted copies remain available for later Agent reads; removing a card does not delete an already persisted Host/local file. At most six images are queued, converted to PNG or JPEG with a 2048-pixel maximum dimension and the existing 4 MB upload limit. Clipboard TIFF and system-decodable image files are supported.

Delivery uses `[Image: /absolute/path]` references, matching the existing phone Terminal composer, and honors bracketed paste. It never guesses Agent-specific clipboard shortcuts or reads/writes the remote system clipboard. Agents with image-reading tools can inspect the file; arbitrary Agents/shells are not promised native image chips or vision capability. Claude documents image paths as a supported input: https://code.claude.com/docs/en/common-workflows#work-with-images .

`TerminalAttachmentTests` covers image conversion, clipboard/file selection, private local storage, request/session matching, disconnect/retry/timeout, and paste framing without Enter. `TerminalAttachmentRemoteTests` exercises the actual window, authenticated client, existing Host upload handler and real PTY output against disposable endpoints (`TB_MACOS_TEST_RELAY_A`, `TB_MACOS_TEST_UPLOAD_ROOT`). No production Agent is used for acceptance.

### Workspace file browser

Terminal file links open a single reusable browser. The left sidebar lazily lists
files from the selected Host/session workspace; another link reveals and selects
its file in this same window. The sidebar button collapses or restores the tree.
The right pane uses Quick Look after a bounded, version-checked transfer. Each
file is limited to 20 MiB. Files outside the workspace need an explicit
`TB_FILE_PREVIEW_ROOTS` root on the Host; credentials are never previewed. HTTP(S)
links still open in the browser, and HTML sibling assets are not proxied.

Remote Herdr terminals send wheel/trackpad input as native scrolling commands,
so history remains owned by Herdr instead of an empty local scrollback buffer.
Both features require a Host build containing `session_file_read`,
`session_directory_list`, and `session_scroll` support.

### CLI installation and pairing

Settings → 命令行与 Host detects the installed CLI, installs/repairs the latest
published `agent-termbridge`, copies the selected App connection to the CLI, and
can start the local Host with login startup. Packaged App launches automatically
install a confirmed-missing CLI once per launch; development executables/tests do
not bootstrap installations. Detection and installation run off the main thread.

Discovery prefers the user's configured zsh/bash, trying interactive login
(`-lic`), interactive (`-ic`) and login (`-lc`) startup, then the App's PATH.
This covers `.zshrc`, `.zprofile`, `.bashrc`, `.bash_profile`/`.bash_login`/`.profile`, custom
`ZDOTDIR`, and PATH-based version managers such as nvm/fnm/asdf. Each shell probe
is bounded; startup failures or a broken executable are **not** treated as absence
and suppress automatic installation. Settings show the detected CLI/Node paths.
Only PATH is captured from shell startup; unrelated shell secrets are not imported.
Host and CLI-backed terminal launches reuse that PATH and exact executable.

Existing working CLIs are reused without writing files. When CLI is missing,
installation reuses an existing compatible Node (`>=22.19.0`, including an actual
`node:sqlite` capability check) and its npm. Missing npm is reported separately,
without downloading another Node. Only a missing/incompatible runtime needs the
checksummed official Node.js 24 archive. Installations use an isolated npm prefix under
`~/Library/Application Support/TermBridge/CLI/releases/<id>`. Each candidate must
pass `tb --version` and a real node-pty spawn before the `current` symlink changes.
`~/.local/bin/tb` points at its launcher; unrelated commands are not overwritten.
Previous releases remain available for Hosts still using their runtime. The
installer appends a marked PATH entry to zsh/bash startup files, preserving their
contents and symlinks without making backup copies. It respects `ZDOTDIR` and
Bash's existing login-profile precedence rather than shadowing `.profile` with a
new `.bash_profile`. New terminals pick it up.
No admin password, global Node replacement, or automatic Host restart is needed.

`CLIDiscoveryTests` covers startup-file compatibility, noisy output, failed probes,
runtime selection and the Settings auto-install gate. Opt-in read-only real-user
discovery uses `TB_MACOS_DETECTION_TEST=1`; isolated real npm/PTY installation with
an existing Node uses `TB_MACOS_REUSE_NODE_TEST=1 TB_MACOS_TEST_NODE=/path/to/node`.

Connection export changes only `middle`, `secret` and `tlsPin` in the CLI's
settings JSON, with a private backup and atomic replacement. Multi-Host selection
still uses `tb --host <id>`; a running Host picks up changed connection settings
on its next restart. Host startup is an explicit Settings button and is optional
for remote-only use. CLI installation does not create pairing credentials.
The separate **创建新配对并配置本机…** action generates a cryptographically random
32-byte official pairing key, saves its profile to the App and CLI, and presents
a QR code for the phone. **重启 Host 并应用配置** explicitly applies changed pairing
to an already running Host. Keys never appear in install output or logs.

Validation: `TB_MACOS_INSTALL_TEST=1 swift test --filter
CLIInstallationTests.testRealCleanMachineInstallAndLoginShellDetection` downloads
and installs into a disposable home with spaces/apostrophes, tests a real PTY,
and verifies the command from a new login shell. `node --import tsx
scripts/test-desktop-files.ts --ui` runs an isolated Relay/Host and drives the
actual file browser, repeated selection and sidebar controls.

### 内网中转与拓扑

设置 → 内网服务提供两项可同时开启的能力：

- **共享本机会话**：允许其他设备访问这台 Mac；选择使用本机中转或另一台中转机。外部中转填写 IP / 主机名、端口和密码，本机无需固定 IP。
- **为其他设备提供中转**：独立配置监听 IP、端口和密码；即使本机会话通过另一台中转共享，也可以同时开启。

客户端连接仍在主窗口管理。停止共享不关闭中转；通过外部中转共享时，停止本机中转不影响共享。共享使用本机中转时，需先停止共享或换用其他中转，才能关闭依赖的入口。

每个区块提供自己的配对入口。下方拓扑分别显示本机提供的中转与共享路径；使用同一个入口时合并展示，蓝框标记本机。客户端「连接拓扑」显示自己与当前目标的路径。Android/iOS 拓扑界面尚未实现。

已有 `tb serve` 不被接管。端口冲突会立即提示；Host 重复注册会拒绝新实例并保留原连接。使用新版中转可防止并发注册互相替换。
旧配置自动迁移，保留密码和原 Host 数据；启动失败不覆盖最后成功配置。打开 App 可恢复上次已开启的服务，退出仅停止 App 自己拥有的服务。架构与兼容边界见 [ADR-0025](../../docs/decisions/0025-lan-relay-and-topology.md)。

设置分类页按需创建并保留，重复切换复用原生表单与草稿；CLI/Chrome 自动检测只在首次进入执行，之后可手动检测。
