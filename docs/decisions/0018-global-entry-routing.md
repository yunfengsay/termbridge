# Global 按入口分流：通话实时，输入框执行

2026-09-16，用户确认。

- 彩色背景实时通话：Omni 原生 semantic VAD、流式语音、打断。
  不在每句话之前串 Host TurnJudge，也不在 Omni 回复后强制 fork + 整段 TTS。
- 输入框（打字或语音转文字后发送）：原有 `brain_send` → Global execution 模型。
  保留模型档位、工具编排、取消及结果卡片；不改为 Omni 文本对话。
- 已有显式“静音执行通话”是保留的独立选择（ASR → 执行模型），不是默认实时通话。
- 通话可直接回答沟通确认和技术讨论。实时状态、外部信息、图片、手机操作和任务执行
  仍通过 `fork_execution` 查询或委派；执行结果由原 Omni 会话继续流式播报。
  不读取旧状态冒充实时证据，不因收到完成通知就自动再次派任务。
- 两条入口延续 Global History/Memory/Agent 上下文。通话开始传有界快照，动态事实仍需工具。
  保留悬浮屏幕上下文、图像工具、原生审批和执行幂等性。

## 兼容与实现

Host 通过 `buildVoiceConversationInput` 统一生成实时配置，不接收客户端的额外模型判停开关。
旧客户端即使仍发 `turnControl=adaptive` 也走 provider 实时路线，无需先重新安装 APK。
Android 下次构建统一发送 `provider`。实验 TurnCoordinator、训练数据与测试保留，
但不进入默认电话模式关键路径；没有删除已有个性化数据或训练后台。

现有模型：通话 qwen3.5-omni-flash-realtime；默认输入框 qwen3.8-flash；
通话显式 fork/silent-call 的执行模型 deepseek-v4.1-flash。以 Host 配置为准，均不静默回退本地 Codex。

## 验证

生产配置 + 模拟 provider 事件回放断言：第一块 Omni 音频在 response.done 前立即交给客户端，
直接回复不调用 fork 或 HTTP TTS；显式工具请求保留真实回执和 Omni 续答。
输入框与静音执行模型选择维持已有测试。Host 日志新增 `route`、`endpointing` 和
`first_output_chunk.sinceFinalMs`，后者是 ASR final 至 Host 首音频块，不是物理播放延迟。
这些测试不能代替新版本真机延迟测量或语义准确率验收。
