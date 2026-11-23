# 通话内静音执行

输入框口述继续保留。Voice Brain 通话界面的「静音执行」按钮和底部静音图标切换执行通道，不退出通话、不跳回输入框。

| 通道 | 用户输入 | AI 执行 | 输出 |
|---|---|---|---|
| 普通通话 | 持续语音 | 原有 Omni / Doubao → DeepSeek 执行 + Pi 工具 Harness | 语音、文字、卡片 |
| 静音执行 | 持续语音 | 百炼 ASR → deepseek-v4.1-flash + Pi 工具 Harness | 文字、工具进度、卡片；无 TTS |
| 输入框口述 | 语音输入草稿，明确发送 | 高级文字执行 | 原有文字 timeline |

## 路由和生命周期

通话执行模型由 Host `voiceExecutionModels.ts` 独立选择，默认百炼 `deepseek-v4.1-flash`，可用 `TB_VOICE_EXECUTION_MODEL` 覆盖；凭据与端点沿用 `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL`。所有通话档位显式 `enable_thinking: false`；普通通话执行上限 45 秒，静音 advanced / deep 分别 180 / 300 秒。超时与取消仍由 Pi 的 AbortSignal 链路处理，不降级到本地 Agent 或其他云模型。

仅切换执行模型：实时音频模型、ASR、停顿判断和图片预解析不变。纯文字 Global 和纯文字 silent 仍分别读取 `TB_BRAIN_MODEL` / `TB_SILENT_MODEL` / `TB_SILENT_DEEP_MODEL`；未显式配置时也统一使用 `deepseek-v4.1-flash`，不再默认选择千问 Max。上下文、工具、历史和执行进度继续走同一个 `runGlobalExecutionFork`。需更新运行中的 Host 才生效，无协议变更，无需为此重装客户端。启动日志输出实际 `Voice execution` 模型，工具进度事件携带实际模型 ID。

`brain_voice_start.workflow=silent` 和 `modelTier` 使用原有语音帧协议，Host 创建 `SilentCall`，不创建 Omni 会话。客户端先检查 `brain_snapshot_result.silentCall`，旧 Host 明确要求升级。

手机保留 Call ownership、音频路由、防息屏和后台悬浮球保护；静音通道改用本地 VAD 分段，ASR 只识别。每段结束 ASR 会话，避免持续通话撞上单个 ASR 会话累计音频限制。片段按采集顺序收齐，额外等待 1 秒合并短暂停顿后自动执行，不要求“发送”。这是工程分段窗口，不宣称具备智能语义判停。

执行中继续收音，后续完整请求顺序排队（最多 8 条），复用最新 Global 历史、Agent roster、工具审批、附件和执行事件。高级模型思考关闭。代码任务通过原有工具委派 Codex/Claude Worker，不把普通发言直接交给本地 Codex。

永不输出音频；执行失败显示文字，不自动切到有声模型。挂断或切换时释放 ASR 和定时器、中止当前模型编排，忽略迟到回复；已派发 Worker 独立运行，挂断不能撤销已执行动作。按 fork/request ID 的 `cancel_tool` 仍可取消当前编排。

切回普通通话需要用户明确点击。切换停止正在收取的旧语音片段；已写入 Global 的历史和附件保留。后台无可见圆球则沿原有隐私保护停止通话。

## 验证

- `pnpm test:silent-call`：第二句、执行中收音排队、挂断 abort、迟到结果、ASR 失败与资源释放。
- `pnpm test:integration` 的 19sc：隔离 Relay/Host + 合成 ASR/模型服务，验证两轮语音进入 DeepSeek、thinking=false、文字和历史、无音频、挂断回执；19s 验证纯文字 silent 同样默认使用 DeepSeek。
- Android 构建/lint/单测；真实手机仍需验收切换、持续讲话、悬浮球和听感。测试替身不证明真实云端识别精度或语义判停。
