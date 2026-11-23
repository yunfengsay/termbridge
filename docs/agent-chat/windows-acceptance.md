# Windows 对话模式验收清单

首批交付的是同一个已运行 Agent 的第二个视图。下面把"已在本机验证"和"必须在 Windows
真机验证"分开写，避免把构建成功当成功能验收。

## 主 Agent 独立复核（2026-09-14）

环境：Windows 11 ARM64 QEMU，x64 仿真，.NET SDK 10.0.400，800×600 桌面；连接隔离的本地 TLS Host/Relay，生产 Host 未重启。源码在共享工作区中，未提交、推送或发布。

| 检查 | 当前证据 |
| --- | --- |
| 测试安装包 | 最终 NSIS 安装 exit 0；安装后 App/Core/Chat/Host/CLI 的 SHA 与验证产物全部相同；`tb --version` 和 `tb ls` 均 exit 0，后者能发现测试会话；旧安装保留备份 |
| Windows 构建 | WinUI self-contained publish 与 CLI shim publish 成功；20 项原生核心检查通过 |
| Host/CLI | `pnpm test` 成功：unit 344 / 343 pass / 1 skip，Cloudflare 5 tests，31 个集成场景；`pnpm build` 成功。后续 UI 保留历史调整再次通过 UI 14 tests 和 typecheck |
| 初次选会话 | 直接显示 Chat，UI Automation 读取到 `ComposerBox` 已启用并持有键盘焦点 |
| 原生输入 | 中文剪贴板粘贴成功；Shift+Enter 保留换行、不发送；Enter 经 PreviewKeyDown 后实际提交并清空草稿 |
| 两次相同发送 | Windows 两次都显示 observed；真实 transcript 展示出 2 条不同 ID 的同文 user 记录；不是使用旧同文确认 |
| 草稿隔离 | A/B 来回恢复各自文字；A 投递后，B 仍可编辑和发送；测试草稿已清空 |
| 真实历史翻页 | 收到 Host 更早记录，行数 109→157；锚定位置变化 0.140625 px，展开的工具卡保留 |
| 主题 | WebView2 实际 `data-theme=dark`，计算背景为 `rgb(22,22,24)`；与深色外壳一致 |
| 断线重连 | 隔离 Host/Relay 中断并经历多个重试周期后，自动回到原 Chat 并聚焦；同文记录仍为 2 条，无自动重发；恢复后翻页锚定误差 -0.40625 px |
| 主机选择 | Windows 来回选会话期间，Herdr workspace 的 `active_tab_id` 与 `focused` 未变；这不替代两个实体客户端的完整并发验收 |

修复了实际复核发现的编译错误、Enter 被多行 TextBox 吞掉、初始焦点、旧视图异步切换竞态、失联 pending、连续重试丢失原会话与旧连接错误提示、跨会话草稿、分页 generation、工具结果先到产生重复卡、工具展开和滚动位置丢失、显式主题未生效。界面窗口默认 400 条；主动加载历史后最多保留 4000 条，达到上限会提示转到终端查看。

证据摘要：[windows-vm-20260914.json](./windows-vm-20260914.json)。完整测试/构建日志及 VM 交互回报保留在本机 `windows/evidence/agent-chat-20260914/`（ignored，不包含配对凭据或其他 Agent 正文）。

## 尚未完成的验收与能力

- Claude 当前提示 session limit，19:00 恢复。真实发送已经被 transcript 确认，但当前这轮没有正常助手回复；不能把首次报告当成本轮独立回复证据。
- 中文 IME 候选词 Enter 尚未实测；中文粘贴、换行与发送的结果不能替代 IME 验收。
- 实体 Windows PC、宽屏、两个实体客户端同时选择/滚动、实体网络切换、blocked 审批降级和全部 Terminal 切换场景仍需补验。
- 附件、停止、审批、提问、新建受管 provider 会话仍未提供；手机/macOS UI 未接线。

## 打包与许可（收尾核验结论，2026-09-14）

`pnpm build` 通过（exit 0）。新模块确实进入了运行时产物，且分层正确：

| 产物 | agent-chat 内容 | 说明 |
| --- | --- | --- |
| `dist/host.js` | 服务全量（定位、回执、增量读取、两个 decoder、状态 latch） | Host 才需要读记录 |
| `dist/cli.js` | 只有 wire 类型与 `chat-*` 转发 | CLI 是哑转发，不含任何记录解析 |
| `dist/relay.js` / `cloudflare/worker.js` | 只有协议 schema | Relay 只做校验 |

六个 bundle 均 `node --check` 通过，未混入测试代码。`cloudflare/worker.js` 重新生成后相对
构建前只有 **150 行新增、0 行删除**，全部是 `agent_chat_*` schema，没有覆盖他人改动。
`pnpm install --frozen-lockfile` 通过，13 个 workspace 工程，lockfile 只增 15 行无删除。

### 收尾期间修掉的两个真问题（主 Agent 验收发现）

1. **`agent_chat_earlier` 缺 `generation`，导致「加载更早」全被客户端丢弃。** 协议、
   `routes.ts`、CLI `chatControl` 三处都没带这个字段，而 Windows 用 generation 过滤事件。
   现在请求携带 generation，Host 核验它是不是**该连接当前的**订阅，并把**请求里的那个**
   原样回带（不是当前的），于是过期请求的结果被客户端按同一条规则丢弃；退订后、以及
   订阅释放又重建后的请求一律被拒绝并带原因。补了 `routes.test.ts`（走真实 router 与真实
   编码帧）和 `packages/cli/src/desktop.test.ts`（桥接映射 + schema 拒绝），不只 service 单测。
   Windows 端在 earlier 请求里带上 generation 由主 Agent 负责。
2. **失去确认能力的发送会静默消失，客户端可能永远停在「发送中」。** `expire()` 与
   `resetForRewind()` 原先直接丢弃 pending 而不发终态。现在两者都返回 `uncertain` 回执
   并说明原因（确认窗口过期 / 记录被轮转截断），客户端据此结束等待；`uncertain` 依旧
   `mayResend=false`，不提供重试按钮，也不自动重发。已退订的连接仍然静默丢弃——没有人
   在等这条回执。边界测试覆盖窗口内/窗口外、只报一次、以及断开客户端不产生回执。

### 安装缓存与许可已补齐

重新 `npm pack` 本地 CLI 并执行 `windows/scripts/prepare-runtime.py --cli <tarball>`；缓存中的 Host、CLI 和根许可与当前打包源逐字节相同。`prepare-runtime.py` 会更新 `native-cli.json`，记录本地构建标识、实际包版本和 SHA，避免沿用旧缓存的版本标签。此本地包未发布到 npm。

`windows/THIRD_PARTY_NOTICES.md` 已补全 Orca 归属、固定 revision 与 MIT 许可，包含 `Copyright (c) 2026 Lovecast Inc.`；安装目录顶层与 `runtime/tb/` 均带声明。

## 构建对话组件

```
pnpm build:agent-chat-ui          # 等价于 npx tsx packages/agent-chat-ui/scripts/build-webview.mjs
pnpm build:agent-chat-ui -- <dir> # 输出到别的外壳目录
```

它刻意不挂在 `pnpm build` 下：默认输出目录在原生 Windows 外壳里，重新生成应当是一次
明确的动作，而不是构建 Node 运行时的副作用。

产物写入 `windows/TermBridge.App/Chat/`（`chat.js` / `chat.css` / `index.html`），由
`TermBridge.App.csproj` 的 `Content Include="Chat/**"` 复制到输出目录。macOS 与手机接线时
指定另一个输出目录即可复用同一份组件。

## 当前测试包

本机产物：`windows/dist/TermBridge-AgentChat-Preview-20260914-x64.exe`。已安装并打开到 Windows VM，App 与 CLI 使用现有加密配对配置，连接隔离的 QA Host。尚未发布到官网或 npm。安装目录的 Chrome Native Messaging 组件已注册；本机协助仍关闭。验收结束时 QA WebView 调试端口数量为 0。

本轮保留隔离 QA Host 供 VM 查看；控制/传输服务与临时引导凭据会在验收结束时清理。生产 Host 未重启。
