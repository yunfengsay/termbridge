# Voice 产品消融评测

状态：独立评测已实现；不修改线上默认策略。实测结果见 `voice-ablation-results.md`。

## 产品目标与边界

不是把 ASR 字符分数刷高，而是让用户一句话被正确接收、理解、委派，并得到真实回执。
保留联网 Omni 的连续对话、打断和音频输出；本轮不把通话改成串行 ASR → LLM → TTS。
语音前端负责交互，Execution Fork 负责理解/执行；不能因为两者内部文字不同就假定已执行成功。

分开观察五层：

1. 麦克风原音、实际上传的处理后音频：是否丢词头、轻声、否定词。
2. 云端流式/最终转录：字幕是否忠实。
3. 应用处理后的用户文字：是否出现无证据纠错。
4. `fork_execution.arguments.text`：是否漏派、重复派、改变用户原意。
5. 实际任务目标与结果：路由到哪个稳定 ID、是否 received/running/completed/failed。

当前 runner 覆盖第 2–4 层；Android replay 仅覆盖第 1 层中的 GTCRN。
工具返回固定测试结果，禁止启动真实 Agent、修改日历/图片或把测试结果当作 completed。
第 5 层必须后续用隔离的执行工作区验证，当前不能宣称委派端到端正确。

## 一次只改变一个因素

| 实验 | 固定因素 | 自变量 |
|---|---|---|
| 术语 × 语境 2×2 | 同一音频、Omni 模型、工具 schema、断句参数 | 默认 10 个术语有/无；有界场景语境有/无 |
| 降噪 | 同一原音、提示词、模型、工具 | 原音 vs 生产模型/AAR 的 256ms 分块输出 |
| 分块 | 同一 GTCRN 模型、原音和其余参数 | 每 4096 样本调用一次 vs 整句一次 |
| 门控（待测） | 同一音频与降噪策略 | 无门控 vs 当前 Silero/平滑/预卷/强制静音 |
| 对话状态（待测） | 同一用户语句 | 正确/缺失/陈旧/矛盾的近期语境 |

`baseline` 是当前语音前端提示词 + 10 个默认术语，不是空白 ASR。
`no-vocabulary` 去掉术语提示及本地英文 reconciliation；`context` 在 baseline 上仅加语境；
`context-only` 无默认术语但有场景语境。语境内自然包含当前实体名称，评测的是
“默认通用词表”相对于“相关场景语境”的贡献，不是让后者刻意丢失实体。

仍需将「提示词术语」和「应用 reconciliation」再拆开，才能归因到具体机制。
不要把 prompt 术语称为已经接通供应商专用 ASR 热词 API。

每个条件至少重复，反转执行次序降低时间漂移；正式验收要跨天、多说话人、随机区组。
API 非确定性必须按分布呈现，不能因为某次成功就选型，也不能只挑有利句子。

## 指标

- 原始转录、应用文字、Fork 输入分别计算字符编辑距离；仅忽略大小写、空格和标点。
- 技术词遗漏、普通中文被强改为技术词的次数分别统计。
- 无转录、无工具调用、重复工具、非预期工具、超时分别统计；失败不能被重试隐藏。
- 首字、语音末尾到工具调用时间、实际 usage 逐次保存。不将模型 token 数臆算成账单金额。
- 真实端到端路由另外检查任务动作、目标 ID、否定词、时间、数量、用户确认与终态。

完整失败样本的空字符串编辑距离不是“供应商听写准确率”；比较 ASR 时只比较拿到
最终转录的配对样本，同时单列缺失率。不混合 raw/processed，也不丢弃失败来美化成功率。

## 执行

入口 `scripts/voice-ablation/run.ts`，不会自动进常规 CI，不带 `--execute` 不发付费请求。

```sh
pnpm exec tsx --test scripts/voice-ablation/metrics.test.ts
pnpm exec tsx scripts/voice-ablation/run.ts \
  --manifest /absolute/private/fixtures.json \
  --output /absolute/private/results --repeat 2
# 确认是授权样本、模型与预算后，加 --execute 执行真实云端调用。
```

需 Host 环境中的 `DASHSCOPE_API_KEY`；可沿用 `TB_VOICE_OMNI_MODEL` 和 `TB_VOICE_OMNI_URL`。
密钥不进入文件、手机客户端或输出。manifest 路径和结果应留本机私有目录，音频不进仓库。

manifest 格式（路径相对 manifest 文件）：

```json
[
  {
    "id": "ordinary-photo-request",
    "pcm": "original.pcm",
    "processedPcm": "denoised.pcm",
    "reference": "请把图片缩放到一半，不要修改颜色。",
    "context": "用户正在查看照片；项目名 TermBridge；此前讨论过 Skill 配置。",
    "expectedTerms": [],
    "forbiddenTerms": ["Skill", "Codex"],
    "provenance": "human"
  }
]
```

输入必须是 PCM16LE、单声道、16kHz，单句最多 30 秒。`processedPcm` 可省略。
runner 实时节奏上送，尾部补 4 秒静音，由生产 semantic VAD 判停，工具使用 mock 回执。
每个条件新建会话。最多等待 55 秒，失败保留证据。输出 JSONL 权限 0600、目录 0700。
只记录授权测试文本及精选事件，不记录原始 session/header、AK 或 base64 音频。

`DenoiseReplay.java` 使用项目 AAR 和 GTCRN 模型，在独立 Android 模拟器 app_process
中运行：参数为 `model input.pcm output.pcm [blockSamples]`，默认 4096，0 代表整句。
编译时需要 AAR 的 classes.jar、Android SDK；用 d8 合并探针、AAR classes 和 Kotlin stdlib，
设备同目录放两份 AAR 原生库，再设置 CLASSPATH 和 LD_LIBRARY_PATH 启动。
不安装 APK，不触发录音，不读应用私有数据。探针刻意排除 Silero gate 和系统 AEC/NS。
整句处理仅用于定位分块影响，不能替代低延迟生产流式实现。

## 产品落地取舍

- 必需：保真输入、稳定 turn ID、字幕与执行输入可追溯、exactly-once 派发、明确超时恢复。
- 有界语境候选：当前页面/照片句柄、当前 Agent 名和稳定 ID、最近话题与少量实体；动态更新并带来源和时效。
- 不默认全量注入 Memory/History；需要解决当前歧义时再取相关片段。文本上下文不能修复被剪掉的声学信息。
- 不把 SKU→Skill、缩放→Skill 做全局替换。保留原始识别；校正需有音频/近期语境依据；高风险歧义要确认。
- 不因干净合成语音表现就移除抗噪或自动开新 ASR 服务。先验证流式前处理，再评估并行 ASR 校正的增益、延迟、重复计费与打断影响。
- 低成本常驻流程、复杂歧义按需增强，比堆多个无实测收益的模型更可控。

## 尚缺的真实验收

用户口音、中英混读、轻声、连续长句、停顿后续说、纠错、否定词、风噪、路噪、旁人讲话、
媒体外放、蓝牙车载麦克风、回声打断；每类需真实授权样本及原意标注。
尤其单测/模拟器不等于三星或车载音频路由验收。门控最长语音强制静音等策略要用长句单独回放。
