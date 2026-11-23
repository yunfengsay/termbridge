# TermBridge · 语音轮次与流式改写调研

日期：2026-09-07 · 范围：macOS 豆包输入法、Codex Desktop 包体、TermBridge 源码与端点模型公开资料。

## 图解入口

[打开 Canvas 调研报告](https://app.bytespost.com/design/1ef82078-e6f4-4fd6-a3ab-f7e03934cb69)。四张图已同时补到原文字报告所在画布（Page 1）的右侧，无需切换页面；另外保留四个独立图解页便于单独查看。均使用可编辑的原生节点与绑定连线，不是截图或文字卡片。

| Canvas 页面 | 可复现图源 | 内容 |
| --- | --- | --- |
| 图 1 · 三方语音链路 | [01-comparison.d2](voice-diagrams/01-comparison.d2) | 豆包、Codex 与 TermBridge 目标方案对照 |
| 图 2 · 动态判停流程 | [02-endpointing.d2](voice-diagrams/02-endpointing.d2) | 停顿候选、上下文判定、续说与过期结果丢弃 |
| 图 3 · 轮次状态机 | [03-state-machine.d2](voice-diagrams/03-state-machine.d2) | 倾听、检查、提交、打断、挂断与终态隔离 |
| 图 4 · 实施架构 | [04-architecture.d2](voice-diagrams/04-architecture.d2) | 手机、Host、Omni、字幕账本与执行工具的边界 |

图 2–4 是拟议设计，不代表已部署验收；图 1 的静态实现证据也不等于线上通话效果。0.5–0.8 秒为实验起始区间，不是已经验证的最佳阈值。

## 01 / 结论：字幕会改，不代表用户说完了

核心判断：TermBridge 不应把 ASR 的分段结束、文字稳定、用户话轮结束和业务任务提交当成同一个事件。流式改写改善“听到了什么”；轮次协调决定“现在该不该回答或执行”。

- 豆包 macOS：已确认结果包含 completeResult、recentVADResult、tbdResult 与 vadModifyPairs；存在输入上下文、热词、用户修改记录，以及尾包等待和迟到结果隔离。证据来自已安装签名应用的符号和字符串，不是本轮真实网络抓包。
- Codex Desktop：已确认流式听写以 utterance_id 和 revision 更新 segment/final；另有可选的最终文本清理链路。实时通话走独立 WebRTC 媒体通道，并有 transcript、handoff、closed 事件。
- TermBridge：已有按 item_id 保存字幕预览和 final 的能力，但既有续说实验显示“字幕正确”仍可能“工具交接失败”。不能只优化 ASR 或换模型。
- 推荐：先建立单一 TurnCoordinator、可修订 TranscriptLedger、可靠的取消/恢复，再引入有界上下文判断器；音频端点小模型作为可消融组件。

证据等级：A＝本轮本地包体/源码直接复核；B＝抽取纯函数的合成事件测试；C＝官方文档或此前实验记录；D＝拟议架构，尚未部署验收。A 不等于账号功能已开启，B 不等于真机通话通过。

本轮没有采集用户真实录音、读取账号凭据、修改输入法、修改 TermBridge 生产代码、重启 Host 或安装手机 APK。

## 02 / 豆包 macOS：可修订文本与提交生命周期

样本：/Library/Input Methods/DoubaoIme.app，版本 0.9.2，build 1；Bundle ID com.bytedance.inputmethod.doubaoime。通过 codesign 元数据核对开发者签名。没有找到原始豆包 DMG，本轮分析的是本机已安装包，不能称为重新验证了某个 DMG 的来源。

ASRResult 的 Swift 导出签名包含：完整结果 completeResult、最近 VAD 结果 recentVADResult、待定结果 tbdResult、isFullVAD、isOfflineResult、taskId、vadModifyPairs。VADModifyPair 明确有 src/dst 两个字符串属性。[A]

输入上下文线索：ASRContext 下存在 ImeContext、ChatContext、HotwordContext、ModifyPairContext；另有 precedingText/followingText、hotwordsCount、contextBefore.count。说明实现具备利用输入环境和修正记录的接口；实际上传字段、开启条件和长度尚未动态验证。[A]

客户端合并线索：applyTextWindowDiff(deleteCount:insertText:)、streaming_diff_applied、text_window_partial_update、text_window_full_vad_update。说明字幕不是只能 append；但不能仅凭这些符号断言“所有变化都来自 LLM 流式改写”。普通 ASR 修订也会改字。[A]

收尾状态线索：stop_and_enter_waiting、shouldAcceptTrailingASRResultWhileWaiting、waitingTimeoutGeneration、flushPendingASRResultIfNeeded、drop_late_result、full_vad_commit。可借鉴“停止采音后等尾包、按代次屏蔽旧结果、最后统一提交”的边界。[A]

LLM 线索：enableFuseLLM、llmExpected、llmCost、llmLen。只能证明有融合/统计代码；没有确认其模型名、Prompt、是否云端及每轮实际启用情况。

历史 Android 纪要中的 KalmanFilterActor 属于音频前端候选组件；不能推导为语义停顿判断。旧纪要把多个库组件画成确定执行顺序，证据不足，本报告不沿用该强结论。

## 03 / Codex 听写：分段修订与最终清理是两步

样本：本机 /Applications/ChatGPT.app，Bundle ID com.openai.codex，版本 26.901.51231。官方 Codex.dmg 当前也包含这个显示名的应用；本机与 DMG 的 app.asar SHA-256 完全一致。不能只按应用文件名判断是不是 Codex。[A]

流式协议：speech.started/stopped；transcript.delta/segment/final/failed；每段带 utterance_id、revision、sequence_no。纯 reducer 用 utterance_id 建账，接受较新的 segment/final；final 清空 partial，之后的 partial 不覆盖 final。它不是把全部 delta 盲目拼起来。[A]

隔离测试：抽取纯 reducer，在无文件/网络能力的 VM 中输入合成事件。初始 partial、较新修订、旧修订拒绝、final 清 partial、迟到 partial/旧 final 拒绝，共 5 条断言通过。这验证的是该函数，不是真实 ASR 效果。[B]

最终文本清理：qRs → JRs → FRs，threadSource=dictation_cleanup。输入为转录文本、周边文本和字典；本版本上限分别为 4,000 字符、2,000 字符、100 条字典。清理指令约束修正识别错误、标点和明确的自我纠正，不回答、不新增事实；失败保留原转录。[A]

重要开关：发现 composer 包装器显式 cleanupEnabled=false；全局听写路径接收 cleanupEnabled。证明“具备清理能力”不等于“所有入口默认清理”。该辅助请求禁止工具，且指定低推理强度。[A]

可借鉴：raw transcript、显示修订、可选 cleaned transcript 分开保存；保护否定词、数字、文件路径、代码标识符。用户已经手工编辑时，不让迟到的模型清理覆盖用户的新内容。[D]

## 04 / Codex 通话：独立媒体通道与工作交接

包体中同时存在 global-dictation-page 与 realtime-voice-* 页面。实时媒体代码创建 RTCPeerConnection、oai-events DataChannel、音频输出元素，并交换 SDP；不是“录完上传文件，再 TTS”的同一条听写链路。[A]

启动阶段有 buffering → replaying → live 的 AudioWorklet。当前实现可缓存 30 秒，保留首个信号前 100ms，leadingSilenceThreshold=0.003。用途是连接准备期间保留开头，不是已经证实的语义 VAD 或本人识别。不能照抄为我们的车内抗噪参数。[A]

挂断清理：stop 置终止状态、关闭 DataChannel 和 PeerConnection、暂停并解绑音频输出、停止麦克风。它把媒体释放放在明确的会话生命周期里，而不是仅隐藏 UI。[A]

转录与任务：thread/realtime/transcript/delta、transcript/done、closed；启动参数有 flushTranscriptTailOnSessionEnd=true。handoff_request 包含 handoff_id、input_transcript、active_transcript；另有 voice-work-terminal 状态接口。可借鉴“通话文本收尾”和“Worker 终态”分别可观测。[A]

边界：未确认该版本服务端的实际端点模型、停顿阈值、抢话策略、账号开关及线上时延。没有证据证明 Desktop 每次停顿都额外调用一个文本模型，也不能凭 WebRTC 就声称打断体验优于 TermBridge。

结论：借鉴 revision、尾包刷新、媒体资源所有权和显式 handoff；不要尝试复用其私有认证或把内部 RPC 当公开集成契约。

## 05 / TermBridge 新架构：三层判断，一个提交点

保留 Omni 连续音频主链；旁路只提供证据，不另起多套互相抢占的自动回复器。[D]

音频通道：麦克风 → AEC/降噪/目标人声门控 → 持续音频上行 → Omni。端侧拒绝音频时，静音/时间轴规则必须一致；等待语义判断不能停止有效音频采集。

文字通道：ASR 更新 → TranscriptLedger → 有界上下文判断器 → TurnCoordinator → 唯一的回答/工具派发门。界面可以展示 partial，但 partial 不产生业务副作用。

第一层判断“有没有有效人声”；第二层判断“这句话是否完整”；第三层判断“是不是对助手说、是否需要回应”。端点模型不能替代本人声纹，文字模型也无法总能识别转头对别人讲话。

Ledger 建议字段：callId、turnId、utteranceId、revision、rawText、displayText、committedText、status、source、timestamps。每次续说增加 revision；旧模型结果只能丢弃，不能触发新回答。

协调状态：LISTENING → PAUSE_CANDIDATE → CHECKING → WAITING 或 COMMITTED。新语音在提交前返回 LISTENING 并取消旧检查；用户插话优先让出播放，继续采集，之后再协调任务取消与续说。

上下文最小化：最近相关几轮 + 尚未提交的用户原话 + 当前是否等待补充 + 少量相关术语。不发送全盘 History/全部 Agent 日志。改写、判停和执行 Prompt 分开；判停器不得回答问题或调用工具。

集成前置门槛：确认百炼实时接口能在需要的时点提供字幕，并支持我们实际控制响应创建。若做不到，只能声明辅助判定/工具门控，不能声称已接管整条话轮。

## 06 / 动态等待、卡尔曼与学习边界

不要固定“沉默 3 秒后才调用模型”。建议在首个有意义停顿时提前做一次检查，和等待并行；同一 revision 去重，字幕变化才重新判断，长时间不确定再有限复查。时间只是证据，不是自动执行命令。[D]

案例：我最近的…… → 保留未完成前句；稍后 Agent 是什么？ → 作为同一用户话语再判断。语义完整的短问句可更快回应；明显缺宾语的指令即使停了 3 秒也不能猜测执行。

第一版参数是产品策略而非模型权重：最小等待、最长等待/澄清策略、模型预算、完整性门限、续说恢复窗口、去重规则。约 0.5–0.8 秒启动候选检查仅为实验起点，不是已验证最佳值。

卡尔曼适合估计连续变化的说话节奏，不直接理解语义。Q 表示节奏变化的不确定性，R 表示观测噪声。第一版用 EMA 或滚动分位数更容易审计；LiveKit 已提供按停顿统计进行 EMA 动态端点调节的实现参考。[C/S1]

可选音频小模型：Smart Turn v3.2，约 8M 参数、INT8 约 8MB、支持中文，以最多约 8 秒的 16kHz mono 音频做端点判断。只在 VAD 静音候选时运行；手机耗时、内存和准确率待实测。它不是带 History 的通用文本模型。[C/S2]

学习路线：先调策略并评测，再用授权样本校准分类器，最后考虑微调。Over、我还没说完、明确纠正是弱反馈，不是自动真值；不能把“用户没投诉”标成正确。按说话人/场景隔离训练测试集，保留原话和可撤销授权。[D]

Open Yap 1K 是英语双通道数据集，不是端点模型。可补充插话/附和样例，但中文技术词和车内本人识别仍需要我们的授权数据。[C/S3]

## 07 / 验证计划与交付边界

现有记录：TermBridge 的“我最近的”＋2.6 秒停顿＋“Agent 是什么”实验中，最后两组字幕 CER=0，但工具交接 0/4；这是小规模合成样本，不是总体成功率。证明文字正确并不足以保证任务正确。[C/S4]

消融组：A 现状；B 固定 3 秒；C 动态等待；D 动态等待＋上下文判断；E 在 D 上增加音频端点模型；F 单独开关文本清理。复用相同录音和网络条件，不能一次改多项再归因。[D]

验收指标：提前提交率、用户真实结束到首回复 P50/P95、打断后漏词率、旁人/媒体误响应率、否定词/数字/路径改写错误率、每分钟额外模型请求/费用、端侧 CPU/内存/功耗。检查取消后无重复工具派发、关闭后无采音播放。[D]

推进顺序：P0 TranscriptLedger/生命周期/唯一提交点；P1 有界上下文判断器及影子评测；P2 音频小模型真机对照；P3 经授权反馈的数据标注与微调。改写不能先偷偷影响工具参数。[D]

本轮完成：两款 macOS 包体只读复核、Codex 本机/官方 DMG 哈希一致性检查、5 条纯 reducer 合成断言、Canvas 调研报告。未完成：真实麦克风抓包、豆包 LLM 开关和 Prompt 还原、两家服务端模型/收费对比、车内样本验收、TermBridge 新架构实施。

公开参考：
- S1 https://docs.livekit.io/agents/logic/turns/turn-detector/
- S2 https://github.com/pipecat-ai/smart-turn
- S3 https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k
- S4 docs/voice-stream-architecture.md:89–104（本仓库此前实验）
- 旧 Android 证据边界：早期 Android 端侧链路评估（不可直接当 macOS 实测）

本地复核定位：
- 豆包主程序 Contents/MacOS/DoubaoIme；OimeCommon.framework/Versions/A/OimeCommon。VADModifyPair.src/dst 导出地址 0xa67c/0xa6ac；ASRResult.init 0xb668（arm64 切片）。
- Codex app.asar 内 webview/assets/app-initial-cadb12d4a15e.js：_Rs（修订）、qRs/JRs（清理）、FRs（无工具辅助请求）；realtime-buffered-audio-worklet-4c405a7523cd.js（启动缓存）。
- 豆包主程序 SHA-256：8366c808fc0cd83b5e87a41c06c9c567e1cf291d9edb95e0a10f46abbc57d0b9。
- Codex app.asar SHA-256：64fc2f27d2dddfa968acfacbe5e4e0328071bdc406351ff4a7d18f0b4692c83d。

公开资料只说明其公开能力；本报告的代码结论以指定版本本地包体为准。没有将其私有接口或模型权重复制进 TermBridge。
