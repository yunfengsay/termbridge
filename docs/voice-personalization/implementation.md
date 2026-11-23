# Voice 控制层：本批实现与无声实验

> 本文是本日第一轮实现快照。长停顿及部署结论已由[后续修复报告](pause-repair.md)更新：Host 已更新、三星已安装，新增一次追问及连续轮次兜底。下文原始失败与“未部署”仅描述当时状态。

2026-09-08 · `master@3610ee9` 上的未提交改动 · 未部署 Host、未安装手机

## 结论先说

**云端负责听懂和做事，手机负责智能工程控制。** 没有重训或替换云端 ASR。本批实现了可运行的数据/反馈/训练闭环，修复工具续答抢话竞态，并接入默认关闭的千问停顿协调实验。

不能把这一批叫作“完整个人 DDSD 已完成”：新个人层只有 6 个标量、两个线性分类头，当前只评分、不拦截声音；CAM++ 本人校验仍未启用。2.6 秒停顿的原始例子已在真实云音频管道答对，但 4.5 秒分句的完整意图交接仍失败。失败记录保留，实验开关默认关闭。

全部音频实验使用自己编写的文字、`say -o` 输出文件和 ffmpeg PCM 管道，**没有播放器、没有扬声器输出、没有读取麦克风**。云端返回音频只计数、丢弃。未读取个人历史、操作真实 Agent/家电、采集车内声音或安装手机。

## 1. 已落地的两条闭环

```text
运行中的 Call（原有可见性与唤醒约束不变）
  |
  +-- 手机：已有 Silero 等前处理 -> 6 个有界标量
  |       仅 opt-in / 当前活动交互，ASR final 时记录观察
  |       不保存 PCM，不另存转录正文
  |          |
  |       个人语音控制页面
  |       [对它说? 是/否/不确定] [说完? 是/否/不确定]
  |          |
  |       本机重放训练 -> 影子参数立即改变
  |          |
  |       用户显式同步当前 Host
  |          v
  |       已认证 Relay / Peer -> 完整快照 -> Host 训练
  |          |                    |
  |          |       completed / revoked / stale / failed
  |          +<-- 同 revision 且仍有授权才接受模型
  |
  +-- 音频：已有准入 -> Relay -> Host -> 云端 Omni / ASR
          |
          +-- 默认：继续 provider 实时模式
          |
          +-- 实验 adaptive：ASR item/revision 账本
                 -> 有界停顿检查 + 最近 History（云端小模型，零工具）
                 -> WAIT：保留字幕，不轮询付费模型
                 -> RESPOND：完整原话提交一次 -> Omni -> 原有 Fork
                   ^ 新讲话/取消让旧检查和旧续答权失效
```

个人头的输出和云端判停是独立能力：前者没有音频上传或执行权限，后者不训练个人参数。云端判断也不能撤回已经上传的音频，不能把它说成本地隐私过滤。

## 2. 用户实际看到的入口

全局设置 → 语音设置 → **个人语音控制**，是独立页面，不是弹窗。

- 采集开关：默认关闭，沿用既有明确授权。最多 250 条特征观察、每条最多两个独立标签。
- 时间与影子评分：只保留数字，因此应在还记得当时语境时确认；记不清选“不确定”，不要猜标签。
- 点“是/不是”后，本机参数立即重算；“不确定/撤销”删除这一标签的学习贡献；删除片段同时移除其两个标签。
- “同步已确认特征 / 删除到当前 Host”：仅发已确认特征，真实回执后才显示确认。15 秒超时不等于已完成。
- “关闭并清除本地控制数据”：清除本批特征与参数。对每个曾同步的 Host 还需再同步删除，离线时不会假称已远程清除。
- “实验：千问通话停顿判断”：默认关闭，下次通话生效；只适用于千问自然 Call，不适用于静音执行或豆包。旧 Host 明确提示更新，不能静默忽略开关。

没有自动开启录音、改变数字助理角色、打开云端教师训练或把参数变成生产 gate。原有 History 与旧 `VoiceBoundaryLearningStore` 弱标签文件不是新控制数据，本页清除不表示把整个对话历史抹掉。

## 3. 数据、学习与撤销

| 项目 | 本批实际值 |
| --- | --- |
| 特征顺序 | `speech, duration, pause, playback, recent, wake`，各在 `[0,1]` |
| 两个头 | `addressed` / `finished`，各 1 个 bias + 6 个权重 |
| 训练 | 标签 ID 去重、确定顺序、12 轮、有界梯度、权重限制 `[-4,4]` |
| 删除 / 改标签 | 从剩余完整快照重放，不叠加旧梯度；重试同版本不重复学习 |
| 本机 | 私有 `noBackupFilesDir/voice-control-v1.json`，30 天按访问清理；不写公共相册/下载目录 |
| Host | `~/.termbridge/voice-personalization-v1/<Peer ID 的 SHA256>.json`，目录 0700 / 文件 0600 |
| 最大同步 | 500 个人工确认标签；JSON-safe 时间/版本；不接收 PCM、文本、教师输出或额外字段 |
| 版本 | 同 revision + 内容幂等；低版本/冲突 `stale`；撤销留下版本墓碑，重启后旧包也不能复活数据 |
| 下发 | 只允许 `mode: shadow`，客户端再次验证整数、数组长度、有限权重、版本和本地授权 |

设置页短连接声明 `peer.control-only`，设备工具路由忽略它，避免比正式手机连接更新的临时连接抢走 `phone.action` / 安装请求。

安全边界：Peer ID 来自认证连接的注册信息，不是硬件远程证明；文件哈希用于路径隔离，不代表同一 Host 凭据持有者之间的密码学隔离。Host 暂无离线保留期清扫器，跨 Host 删除必须逐个拿到回执。重装造成身份/版本重置需要明确恢复，不能自动降低删除墓碑。

数据覆盖边界：目前观察来自活动交互且收到了 ASR final 的片段，不覆盖所有被本地拒绝的声音，存在选择偏差；未保存录音/语义 embedding，也无法事后证明某句是谁说的。此数据能启动控制校准闭环，不能直接训练可靠的声纹、抗风噪或语义 DDSD。

## 4. 实际修复的竞态

旧路径：工具 A 等待结果 → 用户开始下一句话 → A 返回 → 无条件 `response.create`，可能打断用户或产生重复续答。

新路径：工具回执始终返回，但续答必须持有当前 `continuationGeneration`；新语音/显式取消使旧代次失效。多个同刻回执合并为一次续答，正在回答时等待响应结束，不能抢占新讲话。真实 provider 可能把口头前言和 function call 放在不同 `response.created` 中，所以许可按整轮管理，不在第一条 created 后误撤销。

先加入的四个回归全部在旧代码失败，修复后通过。又增加多响应授权、超时取消、被拒绝的“我还没说完”保留前半句、判断预算和遗留检查清理等测试。这里修复的是状态竞态，不宣称已经解决扬声器回声或所有长句理解。

## 5. 三组实验与证据

### A. 声音直接走文件/管道，不播放

固定合成文本：“我最近的” → 停顿 → “Agent 是什么”。输入 PCM16LE、16 kHz、单声道；云端 `qwen3.5-omni-flash-realtime`；工具仅 `inspect_fixture`，返回写死的 TermBridge 测试任务，绝不访问真实 Agent。

| 消融 | 观测 | 验收 |
| --- | --- | --- |
| 初始 1.4 秒 provider | 两条用户提交，出现提前答复，最终解释 Agent 概念 | 失败 |
| 1.4 秒 + 完整字幕 / 上下文 | 提交可合为一条，仍可能只理解末句 | 失败 |
| 换成确定性判停器 | 仍解释 Agent；不是只有云端 judge 才造成错误 | 失败 |
| 仅 provider 改 3 秒 | 该次工具与答案正确，但没有用户 final 字幕/History 提交 | 不满足完整链路 |
| adaptive + 3 秒窗口，2.6 秒停顿 | 两次独立运行均提交一次、工具一次、答案正确，无提前回答 | 原始复现通过 |
| adaptive + 3 秒窗口，4.5 秒停顿 | 两次均拼好文字但工具 0 次，回答 Agent 概念 | 明确失败 |

最新严格通过的回答：**“你最近的 Agent 是 TermBridge，当前正在执行语音控制验证任务。”** 独立云端判停 765 ms，工具 completed；音频输出 253,440 字节，仅计数丢弃。Omni 两个阶段记录 916 + 1129 tokens；没有完整教师计费账单，不能据此承诺费用或省流比例。

证据：[严格通过](qa/pipe-replay/candidate-strict-pass.json)、[严格失败](qa/pipe-replay/long-pause-strict-fail.json)、[全部 11 份实验索引](qa/pipe-replay/manifest.json)。历史试验是不同中间版本，索引保留来源哈希；它们不是一次固定版本的统计重复试验。最终严格脚本通过返回 0，长停顿反例实际返回 **1**，不能把“WS 没报错”算成功。

根因边界：应用合并 ASR final，不等于 provider 合并多个已提交音频 item 的语义。额外 user text / session context 在这些实验中不足以弥补。[官方 Function Calling 文档](https://help.aliyun.com/en/model-studio/qwen-function-calling)明确 Omni-Realtime 不支持 `tool_choice`；本批未伪造工具调用、未使用其它模型的未证实参数。原始音频协议依据 [Client events](https://help.aliyun.com/en/model-studio/client-events)。

### B. 启动数据：上下文与分句，分别消融

固定当前 Prompt 后，新写 8 个未用于调 Prompt 的场景，做 `最近 History × 是否保留前半句` 的 2×2 对照，共 **32 次真实 `qwen3.8-flash` 文本调用**，零工具。样本包含悬空指代、条件句、两个任务、确认、等待补充与查询步骤。

| 输入提供什么 | 与完整语境下作者标注的决策一致 |
| --- | --- |
| 只有最后一句 | 4 / 8 |
| 全部分句，无 History | 6 / 8 |
| 最后一句 + History | 8 / 8 |
| 全部分句 + History | 8 / 8 |

完整输入组延迟 413–705 ms。去掉语境之后模型保守等待可能是正确的保守行为，这里比较的是能否满足**原始完整意图**，不是模型智商排名。样本很小、标签由作者编写而非真实用户确认；相同场景跨四个实验组，不是 32 个独立人类场景。未根据这些新结果再调 Prompt。

结论：不能只把最后一句送给模型；保留原文片段和有界 History 值得保留。这个集合未证明“把整个 History 全塞进去”更好，也未证明用一个判断模型解决了所有轮次问题。[完整标注与返回值](qa/teacher/report.json)的来源是 `cloud-advisory`，不进入 `source:human` 个人训练接口。

### C. 为什么个人小层先保持影子模式

160 个合成对照样本，40 个会话组；按整组划分 96 训练 / 32 验证 / 32 测试。故意构造相同 6 个特征、相反意图的成对场景，检查特征的信息边界。

结果：留出集 50%，高置信覆盖 0。一次 Mac 训练 5.92 ms，20,000 次评分的 P95 约 0.21 μs，累计评分校验和防止无用计算被消除；这是纯函数的本机计时，不含 Android、特征提取、存储、传输或云请求，也没有做独立 GC 归因。14 个参数若以 Float32 裸存为 56 字节，这个算术值不是完整模型/运行库体积。

这不是模型变聪明的成绩，而是**现有特征无法区分相反语义**的反证。[样本与机器报告](qa/control-lab/report.json)保留。后续需要获准的语义/声学表征、真实反馈与独立评测，不能直接把 50% 的头上线去拒绝主人。

## 6. 关键代码

| 模块 | 文件 |
| --- | --- |
| 轮次、代次与工具续答 | [omni-realtime.ts](../../packages/voice/src/omni-realtime.ts)、[turnCoordinator.ts](../../packages/voice/src/control/turnCoordinator.ts) |
| 个人训练核心 | [personalization.ts](../../packages/voice/src/control/personalization.ts)、[PersonalControl.kt](../../android/app/src/main/java/com/termbridge/android/brain/personalization/PersonalControl.kt) |
| Host 训练 / 判停 | [voiceLearning.ts](../../packages/host/src/voiceLearning.ts)、[voiceTurnJudge.ts](../../packages/host/src/voiceTurnJudge.ts)、[index.ts](../../packages/host/src/index.ts) |
| 手机采集 / 设置 / 私有存储 | [BrainActivity.kt](../../android/app/src/main/java/com/termbridge/android/brain/BrainActivity.kt)、[PersonalControlActivity.kt](../../android/app/src/main/java/com/termbridge/android/brain/personalization/PersonalControlActivity.kt)、[PersonalControlStore.kt](../../android/app/src/main/java/com/termbridge/android/brain/personalization/PersonalControlStore.kt) |
| 短连接路由 | [peerRouting.ts](../../packages/host/src/peerRouting.ts) |
| 跨端契约 | [voiceLearning.ts](../../packages/protocol/src/voiceLearning.ts)、[协议说明](../protocol.md)、Android `Models.kt`、iOS `SessionInfo.swift` |
| 实验与独立 Relay / Host 验证 | [test.ts](../../scripts/test.ts)、[管道脚本](../../scripts/test-voice-control-live.ts)、[教师消融](../../scripts/voice-control-teacher.ts)、[本地对照](../../scripts/voice-control-lab.ts) |

## 7. 可重复验证

```sh
pnpm test
pnpm build
pnpm test:voice-control-lab
cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug
cd ../ios && swift test
```

以下命令仅在主动允许少量付费调用、Host 环境已配置 AK 时运行；没有播放器：

```sh
pnpm exec tsx scripts/test-voice-control-live.ts --live --adaptive-only
# 已知失败的负向验收，应退出 1；--measure-only 才是刻意忽略验收的测量运行。
pnpm exec tsx scripts/test-voice-control-live.ts --live --adaptive-only --long-pause
pnpm exec tsx scripts/voice-control-teacher.ts --live --out docs/voice-personalization/qa/teacher
```

测试结果、APK 指纹与网页验收见 [validation.md](validation.md)。本批没有商业模型权重、训练许可的假设或“蒸馏了豆包”的宣称。

## 8. 明早可验收的范围

当前已生成本地 APK，但手机与已部署 Host **没有更新**；需在明确允许后更新这两个端，才能验收新页面和新同步协议。

1. 页面默认不采集，不打开实验停顿。进入 Call 后再自愿开启，结束后看到有限数字片段。
2. 当场给一个片段两类独立反馈；确认本地版本/标签数/分数变化，撤销恢复贡献，未修改云端字幕。
3. 同步后必须收到本版本 Host 回执；再次重试幂等。关闭并同步得到 revoked；旧版本不得恢复。
4. 可选开启实验停顿，测试 2.6 秒原始例子。4.5 秒反例仍是已知不通过项目，不能把它算已修好。
5. 真机麦克风、车内噪声、主人/旁人、蓝牙、后台小球与全天耗电需要另外采样验收；本批无这些 live 证据，不自动开启相关实验。
