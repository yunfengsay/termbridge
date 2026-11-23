# TermBridge for Windows

原生 C# / WinUI 3 客户端。电脑列表、会话列表、配对、设置和授权按钮均使用 Windows 原生控件；只有终端画面使用 WebView2 + xterm.js。

## 架构

- `TermBridge.App/`：WinUI 3 界面、WebView2 终端与停止协助快捷键。
- `TermBridge.Core/`：DPAPI 配对存储、CLI 子进程、Windows-MCP 受控工具连接。
- `TermBridge.Cli/`：`tb.exe` 启动入口，与 App 使用同一份加密配对。
- `../packages/cli/src/desktop.ts`：本地 JSON-lines 桥接；现有 CLI 负责 Relay 鉴权、证书指纹、Host 选择和 PTY 传输。
- `installer/`：普通用户安装包；安装 App、离线 CLI/电脑工具、快捷方式和用户 PATH。

配对密钥在 `%APPDATA%\TermBridge\connections.json` 中以当前 Windows 用户 DPAPI 加密保存。App 不导出明文 CLI 配置。电脑协助必须手动开启，切换电脑、断线、关闭 App 或按 Ctrl+Alt+Esc 会停止；重启不自动授权。Host 上的终端会话在关闭窗口后保留。

## 构建

Windows 11 x64、.NET 10 SDK；WebView2 Runtime 用于终端。Windows ARM64 可使用此 x64 包的系统兼容层，目前不发布原生 ARM64 运行时包。

1. 在仓库中构建并打包经过审核、包含 `tb desktop` 的 CLI。
2. `python scripts/prepare-runtime.py --cli <reviewed-cli.tgz>`（需要 `uv`，安装锁定版本的电脑工具依赖）。
3. 在 Windows 运行 `powershell -ExecutionPolicy Bypass -File scripts/build.ps1`。
4. 在 `installer/` 运行 NSIS `makensis TermBridge.nsi`，产物为 `dist/TermBridge-Setup-0.2.4-x64.exe`。

`python scripts/source-archive.py <output.zip>` 只导出原生源码，便于在 Windows 构建。不会包含虚拟机、配对或本地运行数据。

## 验证

- Windows：`dotnet run --project TermBridge.Tests -c Release`。
- Node 24：`TB_TEST_DIST=<reviewed-dist> node tests/desktop-acceptance.mjs`，启动隔离 Relay/Host 验证真实 PTY 输入、尺寸、切换和生命周期。
- 安装后另行验证 GUI、新建会话、实际 Mac mini 连接、终端输入和滚动、电脑协助撤销、CLI PATH；构建成功不等同于交互验收。

旧 Electron 界面已移除。测试虚拟机和缓存保留在被 Git 忽略的目录中。

安装目录为 `%LOCALAPPDATA%\Programs\TermBridge Native`，不需要管理员权限。安装器将该目录加入用户 PATH；已有终端需重新打开。WebView2 缺失时，安装器校验微软签名后安装官方 Runtime。

Windows-MCP 的 Unicode/多行输入使用可重现的兼容补丁，防止 ARM 虚拟机上的逐键输入丢字或重复字。该修改只影响 `Type` 的文本输入，快捷键仍由 `Shortcut` 工具处理。

Chrome integration is bundled with both desktop apps. Windows setup registers the native host; Settings contains installation, the extension folder, Chrome extension management and connection checks. The extension is a development build pending Chrome Web Store publication. See [the shared extension documentation](../browser-extension/README.md).
