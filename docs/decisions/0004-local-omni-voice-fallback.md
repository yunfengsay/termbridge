# ADR-0004: 以 MiniCPM-o 4.5 本地语音节点作为成本可控的备选链路

- 状态: 已接受为文档备选，不进入当前运行依赖
- 日期: 2026-08-29
- 当时的生产基线: 百炼 `qwen3.5-omni-flash-realtime`（当前实时 Call 默认见 ADR-0012）

## 背景

TermBridge Brain 需要支持可以持续收听、说话、被用户打断并调用本地 Codex 的电话式交互。百炼
Qwen3.5-Omni-Realtime 能直接提供实时全模态对话和 Function Calling，但按输入、输出 Token
持续计费；长时间个人通话的成本不容易仅凭连接时长判断。

用户已有一台 24 GB RTX 3090。MiniCPM-o 4.5 是 Apache-2.0 的 9B 端到端全模态模型，支持
中文、英文实时语音、语音克隆和全双工音视频输入输出。官方关联的 `llama.cpp-omni` Q4_K_M
方案模型文件约 8.3 GB、运行时约占 10 GB 显存，并将 RTX 3090 列为可舒适运行全双工模式的
显卡。因此可以把这台机器注册为独立 `voice-node`，为 TermBridge 提供无 Token 费用的本地语音
入口。

## 云端计费基线

以下价格是 2026-08-29 华北 2（北京）的公开原价快照，未计优惠、免费额度、联网搜索、网络、
RTC/AOQ 或 Cloudflare 费用。实施前必须重新读取模型价格，并以服务端 `usage` 为最终账单依据。

Qwen3.5-Omni 的音频 Token 换算为：

```text
输入音频 Token = 输入音频秒数 * 7
输出音频 Token = 输出音频秒数 * 12.5
```

| 模型 | 输入音频 | 输出文本+音频 | 连续上传 1 小时输入 | 模型说话 1 小时输出 |
| --- | ---: | ---: | ---: | ---: |
| `qwen3.5-omni-flash-realtime` | 27 元/百万 Token | 107 元/百万 Token | 0.6804 元 | 4.815 元 |
| `qwen3.5-omni-plus-realtime` | 80 元/百万 Token | 300 元/百万 Token | 2.016 元 | 13.5 元 |

因此，一小时全双工会话若手机整段持续上传麦克风音频，估算为：

| 一小时会话 | Flash | Plus |
| --- | ---: | ---: |
| 模型说话 15 分钟 | 约 1.88 元 | 约 5.39 元 |
| 模型说话 30 分钟 | 约 3.09 元 | 约 8.77 元 |

公式只覆盖音频。文本、图片、累计上下文、工具和可能使用的媒体传输服务应分别计量。仅保持
WebSocket 连接而不发送音频不是上述音频费用；若持续发送包含静音的麦克风流，输入音频时长仍可能
接近整个通话时长。输出语音成本明显高于输入，应该优先控制无效播报和冗长回答。

当前 TermBridge 的拆分链路也应保留为低成本云端模式：

- `qwen3-asr-flash-realtime` 按上传音频 0.00033 元/秒计费，即连续上传一小时为 1.188 元；本地
  VAD/声纹只上传实际本人语音时，通常低于这个上限。
- `qwen3-tts-flash` 按输入文本 0.8 元/万字符计费，输出音频不另收费。
- Brain 文本模型另按输入、输出 Token 计费。

这条拆分链路不具备端到端 Omni 的全部语义打断能力，但在短回合和低使用量下可能比 Omni
Realtime 更便宜，实际差值必须用线上 `usage` 统计确认。

## 本地成本基线

MiniCPM-o 4.5 本地推理不产生模型 Token 费用，边际成本主要是电费、设备折旧和维护。RTX 3090
公版显卡功率上限是 350 W；只按显卡上限估算，每个满载小时消耗 0.35 kWh：

```text
本地每小时电费 = 实测整机功率（kW） * 当地电价（元/kWh）
```

若仅用 350 W 显卡上限举例，电价为 0.6～1.0 元/kWh 时，显卡部分约 0.21～0.35 元/小时；CPU、
内存、风扇、空闲待机和网络设备还要另计。这个数字不是实测值，部署后必须记录墙上功耗或至少记录
`nvidia-smi` 的 GPU 功耗。若 3090 本来就持续开机，本地链路的边际价格优势明显；若每天只使用几
分钟却为它保持 24 小时开机，空闲成本可能抵消优势，因此语音节点应支持按需唤醒和空闲卸载模型。

## 决策

1. 保持 Brain Runtime 为唯一可信编排层。无论语音来自百炼还是 MiniCPM，都只能调用受控的
   `inspect_workspace`、`continue_agent`、`dispatch_agent` 等工具，不直接拥有 shell。
2. 将语音模型抽象成可切换 Provider，产品提供三档：
   - `Cloud · Fast`：`qwen3.5-omni-flash-realtime`，作为端到端云端默认。
   - `Local · Private`：3090 上的 MiniCPM-o 4.5 Q4_K_M，作为成本和隐私优先的备选。
   - `Cloud · Quality`：`qwen3.5-omni-plus-realtime`，仅在复杂意图或质量优先时使用。
3. 在完成端到端 Omni 迁移前，继续保留现有 ASR + Brain + TTS 拆分链路作为第四种低成本兼容模式。
4. 不根据文档估算自动切换 Provider。先记录每次云端响应返回的实际 `input_tokens`、
   `output_tokens`、`audio_tokens`、模型、时长和估算金额，形成按会话、按天、按月的成本账本。
5. MiniCPM 首次接入只作为语音前台。它的官方资料没有提供与百炼等价的原生 Function Calling
   可靠性承诺；其工具意图必须经过 Brain 校验，完成结构化调用准确率测试后才能成为默认入口。

## 验证与启用条件

1. 在现有百炼链路增加 `usage` 采集，连续记录至少 7 天个人真实使用量，得到真实每小时成本。
2. 在 3090 上部署 `llama.cpp-omni` Q4_K_M，记录显存、整机功耗、首次出声延迟、实时系数和 30
   分钟会话稳定性。
3. 用同一组中文任务对比 Cloud Fast 和 Local Private：本人语音识别、TTS 自触发、随时打断、
   Agent 选择、工具参数准确性及完成通知。
4. 只有本地链路满足打断小于 1 秒、连续 30 分钟无崩溃、工具路由无越权，并且实测月成本低于
   Cloud Fast，才允许用户将其设为默认。

## 后果

- 长时间语音使用有本地成本上限，敏感音频可以不离开自有设备。
- Brain 与 Codex 的职责不变，云端和本地语音模型可以独立升级或回退。
- 系统新增一个需要监控、升级和远程访问的 GPU 服务；断电、GPU 占用和弱网时仍需要云端回退。
- 在获得真实账单前，不把理论 Token 换算当成最终成本，也不承诺 MiniCPM 一定比短时云端调用便宜。

## 参考

- [百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)
- [Qwen-Omni 音频 Token 换算](https://help.aliyun.com/zh/model-studio/qwen-omni)
- [Qwen3.5-Omni-Flash-Realtime 规格](https://help.aliyun.com/zh/model-studio/qwen3-5-omni-flash-realtime)
- [MiniCPM-o 4.5 模型卡](https://huggingface.co/openbmb/MiniCPM-o-4_5)
- [MiniCPM-o 4.5 WebRTC 本地部署](https://github.com/OpenSQZ/MiniCPM-V-CookBook/blob/main/demo/web_demo/WebRTC_Demo/README.md)
- [NVIDIA RTX 3090 规格](https://www.nvidia.com/en-eu/geforce/graphics-cards/30-series/rtx-3090/)
