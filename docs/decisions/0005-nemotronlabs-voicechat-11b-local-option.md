# ADR 0005: NemotronLabs VoiceChat 11B 作为实验性本地语音候选

- 状态：备选，不进入当前运行依赖
- 日期：2026-08-29
- 当时的生产基线：百炼 `qwen3.5-omni-flash-realtime`（当前实时 Call 默认见 ADR-0012）

## 结论

`nvidia/NVIDIA-NemotronLabs-VoiceChat-11B` 很接近 TermBridge 长期想要的“原生电话大脑”：它把
流式语音理解、文本推理、语音生成和 Function Calling 放在同一条 80 ms 时间线上，模型卡公布的
平滑接话延迟约 448 ms，并原生展示了打断和工具调用。不过当前版本明确偏英语，官方实时部署以
Linux + 数据中心 GPU 为目标；单张 RTX 3090 24 GB 不能承载官方精度的完整实时栈。因此它只进入
本地方案库，不能替代当前百炼主链路。

## 已核实能力

- 11B、Hybrid Mamba/Transformer；Fast Conformer 编码 16 kHz 用户音频，Nemotron Nano V2 9B
  作为语言骨干，TTS/codec 输出 22.05 kHz 音频，并用独立通道生成工具脚本。
- 原生全双工、自然轮次、barge-in 和实时工具调用；官方模型卡给出的平滑接话约 448 ms、用户打断
  约 480 ms。工具调用平均分并不等于可靠执行：AU Harness BFCL-v3 平均 56.1%，FDB-v3 的
  Pass@1 为 33%，所以工具参数仍必须在 TermBridge Host 端校验。
- OpenMDW 1.1 许可，全球可部署；官方参考实现是 NVIDIA NeMo Speech，官方验证硬件为 H100。
- vLLM-Omni 已提供实验性 `/v1/realtime` 路线，但当前说明仍是单会话、batch=1；其原生 duplex
  路径明确标注尚不能保持墙钟实时，且暂不支持 barge-in。

## 3090 可行性

当前判断为“不适合作为可用部署端”：

1. vLLM-Omni 的 FP32 thinker 权重下限约 43 GB，完整链路还有 talker、codec 和运行时缓存；官方
   要求小于 80 GB 的卡切换 BF16 thinker，但并未给出 24 GB 卡可运行的配置。
2. 11B BF16 主体理论权重就接近 22 GB，留给语音编码器、TTS、KV/cache、CUDA graph 和缓冲区的
   空间不足。即便强行 offload，也很难达到电话所需的实时因子。
3. 社区已有 Q4/GGUF 和 DGX Spark 量化尝试，但不是 NVIDIA 的 3090 生产路径。DGX Spark 方案首次
   下载约 65 GiB、要求至少 90 GiB 磁盘；这只能证明量化方向存在，不能证明 24 GB 3090 能稳定
   实时全双工。

若以后要做实验，验收顺序应为：4/8 bit 单卡装载 → 连续 10 分钟 RTF ≤ 1 → 中文转录/回答质量 →
回声环境打断 → `dispatch_agent` 工具参数正确率。五项未同时通过前，不接入 APP 的 provider 切换。

## 与 TermBridge 的匹配度

| 维度 | NemotronLabs VoiceChat 11B | 当前百炼主链路 |
|---|---|---|
| 连续语音/打断 | 模型原生设计优秀，但公开 vLLM 实时实现仍有限制 | Qwen3.5 Omni Realtime 官方托管支持 |
| Function Calling | 原生独立通道，需 Host 校验参数 | 官方 Realtime 事件，已映射 `dispatch_agent` |
| 中文 | 模型卡标记 English，工具提示/响应还要求 ASCII-only | 支持中文，适合当前主要交互语言 |
| 3090 | 官方精度不适配 24 GB；量化路线待验证 | 无本地显存要求 |
| 运维/成本 | 无按 Token 费，但下载、GPU、电费和维护成本高 | 按量计费，接入最简单 |

## 未来接入边界

如果后续社区量化在 3090 上通过上述验收，它应实现与百炼相同的 Host 侧 provider 契约：

- 输入：16 kHz mono PCM16；
- 输出：增量文本、增量 PCM、响应开始/完成、打断、Function Call；
- 工具：只能发出 `dispatch_agent` 意图，真正执行仍由 Host 校验、限流和审计；
- 安全：模型服务不直接暴露公网，手机仍通过现有 TermBridge/Cloudflare relay 连接 Host。

这样 APP 和 Brain 协议无需为某个本地模型分叉。

## 资料

- [NVIDIA 官方模型卡](https://huggingface.co/nvidia/NVIDIA-NemotronLabs-VoiceChat-11B)
- [NVIDIA NeMo Speech 参考实现](https://github.com/NVIDIA-NeMo/Speech/tree/nemotron-labs-voicechat)
- [vLLM-Omni 的 VoiceChat 配方与实时限制](https://github.com/vllm-project/vllm-omni/blob/main/recipes/NVIDIA/NemotronLabs-VoiceChat.md)
- [MLX 社区实时协议实现（Apple Silicon 参考）](https://huggingface.co/mlx-community/NemotronLabs-VoiceChat-11B-8bit)
- [DGX Spark 社区量化部署](https://github.com/pipecat-ai/nemotron-voicechat-dgx-spark)
