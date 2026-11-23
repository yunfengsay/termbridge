# 完成事件校验与手机成果查看

## 职责

Agent 自述完成不等于验收通过。Jev 选择下一步与固定 UI 模板，不生成任意布局、链接、执行权限。沿 typesafe-ai 的 Choice 模式，把判断和代码执行分开。

```text
完成事件（sessionId + completedAt + revision）
  → 持久化去重 → Jev（3 秒截止）
      ├─ notify          → 简短结果卡
      ├─ gather_evidence → 独立只读证据复核
      ├─ review          → 独立只读证据复核
      └─ ask_user        → 用户决策卡
                           │
        同工作区空闲校验 Agent 候选（可选）
                           │
             点击卡片 → 明确确认委派
                           │
             校验 Agent 回执 → 更新原卡
```

稳定 ID：`completion-<32 位小写十六进制>`，由 sessionId 和完成时间生成。派发前重新检查源版本、完成时间与目标忙闲状态。Jev 置信度 <0.85、目标缺失、源版本变化、服务失败或并发满时不自动派发。0.85 是保守工程初值，不是经过全场景标定的正确率保证。

独立 Pi 会话最多并发 2 个、45 秒、6 次文件工具调用。只提供 `review_files(list|read)`，绑定原工作区，拒绝私密文件和符号链接越界；没有 shell、写文件、手机动作或委派工具。模型不会在实时音频线程里等待完成队列。

终端校验 Agent 的只读指令不是 OS 沙箱，所以必须由用户确认，不宣称代码已强制沙箱化。候选提供最近任务、运行时及工作区；不能只凭名称证明能力。校验返回关联父任务，不递归派发；没有自动修复/合并/发布循环。

## 状态与配置

Host 私有文件 `~/.termbridge/completion-reviews.json`，权限 0600。历史卡片同 ID 更新。重启后未确认发送不会自动重放。`completion_reviews` 查询有界回执；`cancel_execution(completion-id)` 取消尚未派发的复核，不代表撤销已发终端任务。

Host 有 `TYPESAFE_API_KEY` 时启用，`TB_COMPLETION_REVIEW=off` 可关闭。Key 不进入客户端、Relay 或日志。证据复核使用已配置执行模型，缺少服务时显示需决策，不回退成本地 Agent。Jev/复核是额外的独立调用成本。

## 手机查看

Global 时间线、通话字幕与卡片摘要复用 Markwon。Markdown 图片异步读取，点击图片/Markdown 文档进入原生预览；普通网页链接进入浏览器；长按复制解析后的地址。AgentChat 继续使用 marked AST 与原生导航桥，图片以可点击链接打开同一预览器，不在 WebView 执行任意 HTML。

本地成果沿已认证 `session_file_read` 读取，128 KiB 分块、稳定版本、20 MiB 文件上限。`@global` 仅允许项目根目录（默认 `~/code`），成果卡自身 sessionId 则绑定原工作区。Global 文本引用必须是工具返回的真实绝对工作区路径或项目根相对路径。

远程预览只用 HTTPS，不携带 Host 凭据/浏览器 cookie，不自动跟随重定向，超时 20 秒。Markdown 最大 256 KiB，图片解码长边降采样至 2048 px。危险 scheme、URL 内账密、协议相对 URL 被拒绝；错误可见。不是通用浏览器或任意文件执行器。

## 验证与边界

- 自动化：去重、取消与晚结果竞争、重启、不确定发送、源过期、校验 Agent 占用、不递归派发、只读工具权限、ID 校验、WebView 链接/复制桥。
- 真实 Jev：四条合成中文用例（简单查询、缺测试、产品决策、无目标且带注入指令），4/4 通过，单次 255–859 ms；不是总体准确率基准。
- Node 测试/构建、Android 单测/lint/APK 与真机验收分开。没有实际派发生产校验任务，没有真机点击验收，不以 mock 测试声称通过。
- 本轮 `pnpm test` 全部通过（31 个集成场景），`pnpm build` 通过；`swift test` 55 项通过。Android `testDebugUnitTest lintDebug assembleDebug` 已通过。设备安装与运行中 Host 更新不在本轮操作范围。
- 完成检测依赖现有 Host 事件覆盖；没有完成事件的 PTY 不会凭空变得可检测。原目标未知时仍需用户判断。

参考：https://docs.typesafe.ai/api 、https://docs.typesafe.ai/primitives/choice 、https://noties.io/Markwon/docs/v4/
