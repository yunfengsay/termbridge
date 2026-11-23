# 长停顿与一次追问：修复及验收

2026-09-08 · 本文更新此前 `implementation.md` / `validation.md` 的停顿与部署结论，保留旧实验反例。

## 补充：追问以后，完整的沟通确认仍被判为 WAIT

9 月 8 日三星反馈：“你现在在听”→ 约 8 秒后助手问“您想让我做什么呢？”→“在听我说话吗？”，然后再次卡在等待。

该通话 Host 日志显示两次 `client_speech_accepted`、两次 `transcript_final`（6 / 7 字符）、两次 `turn_waiting: incomplete`。第二次转录后约 760 ms 返回 WAIT；没有进入工具执行。这证明第二句话已上行并进入判停，不是网络或手机没有听见。生产日志不记录原始转录，无法仅凭旧日志证明这次判断收到的片段数组；本次新增的 `turn_judged` 只记录片段数/长度、追问位置、决策及耗时，`turn_submitted` 记录提交字数，不记录音频/原话/意图。

使用用户描述编写合成输入，对旧规则做消融：同样的两段话，带一次追问、无旧 History 时真实 Qwen 返回 WAIT，并再次要求一个“任务”。加入先前 Agent 讨论则可返回 respond。它不是稳定的词语识别错误，而是“可以接话”和“任务完整/获准执行”混淆造成的上下文敏感误判。[原始对照](qa/pipe-replay/communication-judge-before.json)

修复：

- 判停只负责轮次是否可以回应。问候、沟通确认、纠正与完整查询都可以回应，不要求必须有任务；工具审批仍由执行端独立决定。
- 原始片段不改写、不去重。独立意图理解允许口语重复和自我修正。
- 追问携带 `clarificationAfterSegment`，明确它插在第几个片段后；从普通 History 尾部排除同一条重复追问。它不是前句结束标记，也不能把用户锁在回答助手的“任务问题”上。
- 非法模型输出不再伪装成“用户没说完”，而是走现有有限重试及 unavailable 状态。

验证边界：

| 对照 | 结果 |
| --- | --- |
| [修复后 13 个真实云端文本用例](qa/pipe-replay/communication-judge-after.json) | 全通过，[独立再跑一轮](qa/pipe-replay/communication-judge-repeat.json)仍 13/13：有/无 History、有/无追问、无标点、口语改口均能接话；明确“还没说完”和悬空动作仍等待。这是开发集，不是独立准确率。 |
| [复现现场的一次 WAIT → 追问 → 续说](qa/pipe-replay/communication-continuation-pass.json) | 首次 WAIT/追问用记录场景固定，以稳定进入失败分支；之后真实云端 ASR、判停、Fork 和音频均未 mock。两段原话只提交一次，判停约 819 ms，最终答“在听。你说，我在……”，0 次实际业务工具，音频结束。 |
| [完全不固定首次判断的对照](qa/pipe-replay/communication-early-reply-boundary.json) | 新规则把首句当完整陈述，两句各回答一次，没有卡住，但不满足“拼成一个提交”的严格断言，所以保留 accepted=false。没有把它包装成整句判停完全解决。 |
| [原 Agent 查询 12 秒停顿重验](qa/pipe-replay/agent-continuation-recheck.json) | 不固定任何判断；真实云端 ASR/判停/Fork，追问一次、原话合并提交一次、fixture 工具完成一次，答案及音频完成。 |

仍存在的边界：单独的“你现在在听”本身有歧义，可以是未完疑问，也可以是完整陈述；合成音频不能代替用户真实语气。此补丁修复的是**已经追问后，清楚的续说仍被判 WAIT**，不是承诺任何停顿或任何第一句话都能完美判定。

## 用户现在会遇到什么

- 千问自然通话默认启用“智能停顿与追问”，已有明确关闭的选择不被覆盖；下一次通话生效。
- 云端 ASR 的 final 只是一个分段。Host 按原始片段与最近上下文判断是否说完。
- 完整问题直接处理；未完成问题先等待。持续静默约 8 秒时只询问一次，仍未回答也不循环催促或执行任务。
- 续说立即撤销待播追问；新片段和前半句一起判断。澄清问题独立于原文，不能伪装成用户说过的话。
- 只询问一次不意味着一直调用判断模型。相同文本不轮询；单次判断 3.5 秒超时、最多重试一次，预算 12 次/分钟。不确定、预算不足或模型失败不授予执行权。
- 30 秒过期的未完成想法不会自动附加到一个新话题；取消、挂断会清理计时器和待播语音。

## 为什么以前只理解后半句

复现已区分“完整转录已提交”和“最终真的正确执行”。原实现把 Host 协调器叠在 Omni `semantic_vad` 上，并在 ASR 完成后补文本/系统提示。真实 4.5 秒回放中，Host 原文和判断意图均正确，但 Omni 仍解释 Agent 概念、工具执行次数为零。

单变量换为 `server_vad` 后通过：云端负责声学分段，Host 是唯一的语义提交点。接入的 `fork_execution` 参数绑定 Host 原始完整文本，不再信任语音前端可能截短的转述。

客户端事件文档明确 `conversation.item.create` 当前只支持 `function_call_output`。因此新提交路径移除了“伪造一条文本 user item 就能改写音频输入”的假设；服务端回 ACK 不代表模型已经按那段文字理解。[百炼官方客户端事件](https://help.aliyun.com/en/model-studio/client-events)

这些是配置组合的实测结果，不声称已经证明了服务商内部的预填充或缓存实现。

## 主动询问不消耗尚未完成的 Omni 输入

在未完成的 Omni 音频轮次上直接 `response.create` 追问，会影响后续接话；这个反例在开发过程中也出现了。因此追问只通过现有在线 TTS 播一句，主 Omni 音频输入继续保留。没有本地系统 TTS，没有第二条常驻录音链路。

追问使用已配置的在线 TTS 音色；常规回复仍使用 Omni 音色，两者未承诺音色完全一致。共用同一个 Android PCM 输出通道，续说/挂断会中止请求并丢弃迟到音频。关闭声音输出时不请求 TTS。追问 TTS 失败保留文字提示，不让通话永久进入离线或 running。

真实返回的 WAV 使用了流式长度占位符 `RIFF=0x7fffffbf`、`data=0x7fffff9b`。解析器识别这个特定组合，以实际下载长度为界，仍严格验证 PCM16LE、24 kHz、单声道及长度限制，不能把容器头当音频播放。

## 第二轮不能直接重复旧状态

重复提问的真实回放还暴露了另一个问题：Omni 有时复述上次结果，没有重新调用执行 Fork。

现在自适应模式会先抑制未经本轮执行验证的文字/音频。若前端结束响应但没有调用 Fork，Host 用完整原话走同一个授权/进度/工具调度入口，标注 `origin=host_control`，ID 为 `host-turn-<UUID>`。这是真实 Host 调用，不伪造服务商的 function-call ID 或回执。

兜底与迟到的语音工具调用共享同一个执行 Promise，防止一条用户指令重复执行。常规回答继续由 Omni 输出；只有这条兜底使用在线 TTS 简短播报真实结果，完整文本仍进入 History。续说会撤销旧结果的播报权，不把已经开始的工具任务假装撤销；显式取消工具仍走原有工具终止接口。

## 验证证据

所有声音来自作者编写的合成句子，经 `say -o` / ffmpeg 文件管道上行；云端回包只统计和丢弃，没有播放器、房间录音或真实 Agent/家电操作。采用生产 Voice Prompt、生产 Fork 工具定义与真实云端执行模型，执行端只开放隔离的 `inspect_fixture`。

| 回放 | 回执与结果 |
| --- | --- |
| [旧连续两轮反例](qa/pipe-replay/second-turn-before-fallback.json) | 两条完整输入，仅一次查询；旧状态被复述，严格脚本失败 |
| [4.5 秒停顿](qa/pipe-replay/server-vad-4500-pass.json) | 一条完整原话、一次真实 fixture 查询、正确答案 |
| [连续两轮](qa/pipe-replay/two-turns-fallback-pass.json) | 两条完整原话、两次独立查询、最终答案及音频完成；包含 Host 兜底 |
| [12 秒停顿与追问](qa/pipe-replay/long-pause-clarification-pass.json) | 一次追问且有真实 TTS PCM；续说后一次完整提交、一次查询、正确最终答案 |

测试脚本等待实际最终答案和音频生命周期，不把“工具返回了”或固定录音文件播放时间结束当成回答结束。它仍是小型开发集，不是独立准确率基准或真实车内测试。

- Node：全套 `pnpm test` 通过，包含 27 条 voice-control 回归与 30 个集成场景；`pnpm build` 通过。
- Android：223 单测、0 失败；`lintDebug` 与 `assembleDebug` 成功，现有 lint 警告仍存在。
- 回归覆盖：一次追问、超时、预算、续说/挂断、晚到 ASR/TTS、原文保留、无授权工具拒绝、兜底去重、WAV 参数与流式头。
- Host 在 10:05（UTC+8）更新并重启；安装产物与运行入口 bundle 的 SHA-256 均为 `70d30a603d120ef634cf3a0c499565c10276c0e713327a12e048428d89a9091b`，新 PID 26981，Relay 连接 established。9:38 的旧 Host hash 为 `0cd1b2a9838f2b242e246f21f32cc475fd6c69d3b2c7d66daefc08989ab2a65d`；不要混淆两次修复。现有 Call 需重新开始才能加载新规则。
- 三星通过无线 ADB 覆盖安装成功，设备 `base.apk` 与本地产物 SHA-256 一致：`108e33e6533b18a315efbad37c440a37c84ed446edfeebb83db46bece4abed55`。版本显示仍为 `0.1.24 / code 9`，这是同版本调试修复包，不是 npm/APK 正式发版。
- 没有备份、提交、推送、发布或自动启动通话。安装后前台为用户的 Chrome，未据此声称 TermBridge 设置页或实际麦克风/听感已验收。
- 本次追问续接补丁只影响 Host；没有重新安装 Android，仍是上面的 9:38 调试包。当前麦克风/听感验收仍待用户进行。

仍待用户真机试听：自然口音、实际播出期间的打断、蓝牙与外放环境。CAM++ 本人识别、完整 DDSD、电视/风噪和 24 小时待机不是本次已验收能力。

## 关键代码

- `packages/voice/src/control/turnCoordinator.ts`：原文账本、判停、一次追问与取消。
- `packages/host/src/voiceTurnJudge.ts`：零工具、有界上下文的云端判停器。
- `packages/voice/src/omni-realtime.ts`：声学分段、完整原话绑定、回执去重、独立控制语音生命周期。
- `packages/voice/src/control/wav.ts`、`packages/voice/src/index.ts`：可中止的在线朗读与格式校验。
- `packages/host/src/voicePrompt.ts`：生产与验收共用的 Fork 定义。
- `android/.../VoiceSettingsStore.kt`、`res/values*/voice_learning.xml`：默认值及中英文设置说明。
