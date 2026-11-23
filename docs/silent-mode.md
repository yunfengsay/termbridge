# 静音模式：同一 Global 会话的高能力文字通道

> 2026-09-06 纠正：用户要求保留输入框口述，并在通话内提供「静音执行」。通话内的高级模型无声回复以 [voice-silent-call.md](voice-silent-call.md) 为准。下文是原有纯文字 silent 路由，不代表通话内要关闭采音或跳回输入框。

## 语义与入口

静音模式不是现有的“仅文字回复”：后者仍保持实时采音，只关闭播报。新模式关闭采音、播放与 realtime 会话，以纯文字调用高级模型，通过原有工具 Harness 委派终端 Agent。普通讨论不强制创建 Worker，代码修改仍交给执行 Agent。

“离线”仅表示离开实时通话，不表示离线模型：依然需要百炼网络与 Host。不会自动回退到 Flash、本地 Codex 聊天或录音。

全局设置提供独立开关和高级/长任务档位；通话顶部及文字输入区提供紧凑切换入口。切入静音结束实时会话，保留历史和已选附件，展示原生输入框；再次点通话入口才明确恢复语音。

## 实现接点

- Android `brain/BrainActivity.kt`：`startVoiceInput` / `sendBrainRequest` 决定语音或文字路由；`voiceTextOnly` 保留旧的仅关闭播报能力。
- Host `packages/host/src/index.ts`：`brain_voice_start` 启动实时前端；`brain_send` 用 `workflow` 选择模型，仍调用同一个 `runGlobalExecutionFork`。
- `packages/host/src/silentExecution.ts`：独立模型工厂与运行中 ID 索引，不复制工具 Harness。
- `packages/brain/src/piConversation.ts`：Pi 工具循环，负责模型请求、取消、超时与执行进度。
- `VoiceSettingsStore.kt`：SharedPreferences 中 `silent_mode` / `silent_model_tier`，默认关闭，持久化最后选择；手机客户端不保存 AK 或模型端点。

## 状态、模型与上下文

```text
文字待输入 → accepted(requestId) → 模型编排 ⇄ 工具进度 → completed
                                  ├─ 超时/异常 → failed
                                  └─ 明确停止 → cancelled
已派发 Worker：独立 taskId → Terminal 旁观 / 后台运行 → 结果卡片与通知
```

| 档位 | 默认模型 | enable_thinking | 编排时限 |
|---|---|---|---|
| advanced | qwen3.8-max | false | 180 秒 |
| deep（长任务，保留兼容 wire 值） | qwen3.8-max | false | 300 秒 |

用户要求关闭 3.8 思考：两个档位均显式发送 `enable_thinking: false`，普通 Global / Execution Fork 的 Pi 默认同样关闭。长任务档位仅保留更长时限及 Host 模型配置，不会重新启用思考。此前深度思考探针记录仅为历史验通，不代表当前配置。

Host 通过 `TB_SILENT_MODEL` / `TB_SILENT_DEEP_MODEL` 配置允许的模型，共用 `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL`。客户端只提交枚举档位。账户或网络失败明确展示，不暗中降级；模型档位不是智能程度的实验保证。

选型及参数参考百炼文档 skill 的 `models/index.md`、`models/groups/qwen3.8-max.json`、`raw/model-api-reference/qwen-api-reference.md`，账户可用性以真实 probe 为准。

模式切换不创建新对话、不清空历史或 roster、不改变工具审批。使用原有有界历史、记忆、权威 Agent 快照和工具目录；恢复通话后继续同一上下文。SSE 文本推理流不等于 realtime 语音流。

## 中断与失败

- 稳定执行 ID 是 `brain_send.requestId`，展示跟踪 ID 为 `fork-<requestId>`。`brain_cancel` 按 requestId 停止编排；`cancel_tool` 同样识别静音请求 ID。
- 取消中止模型 HTTP 流，阻止后续推理和工具调用，并发送终态。工具回调收到联合 AbortSignal；已进入执行的原生动作不保证撤销，已派发 Worker 需按自己的 taskId 停止。UI 必须明确这个边界。
- 关闭页面或切后台不取消 Host 任务；重连从持久化 executionEvents 恢复。Host 重启将残留 silent 请求标记 failed，并保留提示，不自动重放副作用。
- 专用 `brain_text_result` 不走语音断网积攒音频分支。失败保留文本/历史，由用户明确重试或切回通话，绝不自动录音。
- 前台执行复用防息屏设置；静音 idle 和后台不持有屏幕常亮。通知由已有 AgentMonitorService 发出，不新建录音服务。
- 通知需要系统权限和在线管理通道；管理通道离线时仍保留历史，但本轮未新增跨设备通知重投队列。Worker 完成沿用原通知链路。

## 兼容与验证

Host 快照声明支持的 workflows；旧 Host 不支持时 Android 提示升级，禁止静默作为 Flash 请求。iOS 同步字段与 cancelled 终态解析，本轮快捷切换 UI 范围是 Android。

- `pnpm test`：协议枚举、取消/超时、迟到结果、重启恢复；真实隔离 Relay/Host/Worker 下的两档分发、后台结果与中途取消。云端使用测试替身。
- `pnpm exec tsx scripts/test-silent-mode.ts`：显式联网计费的两档百炼 probe，只用合成文本和固定返回值内存工具，无手机/文件/Agent 权限。
- `cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug`：包含状态恢复与前后台防息屏策略。
- 真机待验：通话切换后麦克风指示消失、历史附件保留、Worker 卡片跳转、后台通知、旋转和重连不重开录音。本轮不安装、不重启部署 Host。

2026-09-05 真实百炼合成探针：advanced 1832ms、deep 2410ms，均使用 qwen3.8-max，调用一次内存工具后返回正确 marker，终态 fork_completed。这是单次小请求链路验通，不代表长任务速度或智能评测。
