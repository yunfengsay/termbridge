# ADR-0012: 火山引擎 Seeduplex 并行实时语音 Provider

- 状态: 采纳
- 日期: 2026-09-04

## 背景

TermBridge 的 Call 体验依赖连续语音会话、服务端判停、自然打断和流式语音输出，不能退化为三次相互
独立的 ASR、文本 LLM、TTS 请求。生产默认使用火山引擎，并保留百炼
`qwen3.5-omni-flash-realtime` 作为可按 Call 切换的并行链路，用同一 Android、Relay、Global
时间线和工具 Harness 做真实 A/B。

火山官方 RealtimeAPI 文档提供了直接 WebSocket 接入。新版默认采用豆包实时语音模型 3.0
（Seeduplex）：

- 地址为 `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`；
- 使用当前语音控制台生成的统一 API Key 和 `X-Api-Key` 请求头；
- 输入为单声道 16 kHz PCM s16le，推荐每 20 ms（640 字节）一包；
- 标准 Realtime JSON 事件覆盖流式 ASR、文本、TTS、Function Calling、Usage 与取消；
- `response.cancel` 用于自然打断，工具结果按相同 `call_id` 回传；
- 模型版本固定为 `1.2.6.1`，上下文上限为 12K。

旧版 O2.0 二进制协议（`1.2.1.1`，App ID + Access Token）继续兼容，但不再作为新配置默认值。

参考：

- [端到端实时语音大模型 API](https://www.volcengine.com/docs/6561/1594356?lang=zh)
- [端到端实时语音全双工版本](https://docs.volcengine.com/docs/6561/2549778)
- [全双工接入必读](https://docs.volcengine.com/docs/6561/2549732)
- [在 RTC 对话方案中接入端到端模型](https://www.volcengine.com/docs/6348/1902994?lang=zh)
- [端到端实时语音模型简介](https://www.volcengine.com/docs/6561/1594360?lang=zh)

## 决策

1. 保留 `VoiceService`/`RealtimeConversation` 作为 Provider 中立边界。未设置
   `TB_VOICE_PROVIDER` 时等同 `auto`：火山配置可用则优先火山，否则回退百炼；显式设置 `bailian`
   可只把实时 Call 切回百炼。
2. Host 直接连接火山 RealtimeAPI，不让手机持有密钥，也不引入 RTC 房间、额外 Relay 协议或另一套
   Android 音频生命周期。
3. Seeduplex 负责持续收音、ASR/VAD、自然打断和流式声音，并使用同一个 TermBridge 工具注册表。工具调用
   继续进入现有 `fork_execution` / Phone Action Harness，结果通过 `conversation.item.create(role=tool)` 回给模型，
   不复制第二套执行逻辑。
4. 用户插话时立即发送 `response.cancel`；`response.canceled` 和 `response.done` 都会关闭上一轮 UI 状态。
5. 沿用现有端侧 GTCRN/Silero 门控和 Host 回声保护。火山 `end_smooth_window_ms` 默认 1400 ms，可在
   500–50000 ms 范围配置；技术词作为 `context.hotwords` 发送。
6. 凭据只来自 Host 环境或 `0600` 的 Host 设置文件。新版优先读取 `VOLCENGINE_S2S_API_KEY`；旧版仍支持
   `VOLCENGINE_S2S_APP_ID` + `VOLCENGINE_S2S_ACCESS_TOKEN`。构造 Provider 后立即从可继承环境中删除秘密。
7. `TB_VOICE_PROVIDER=auto` 在火山配置存在时可选择火山，否则保持百炼；显式选择但缺少完整凭据时明确
   失败，不静默回退。
8. 独立听写、普通消息朗读和 Web Search 暂时复用已配置的百炼服务；Global 文字及
   `fork_execution` 也继续使用百炼 `qwen3.8-flash`。这保证此次变更只比较实时语音通道，不同时更换
   编排模型。
9. Android Voice settings 提供 `自动 / 阿里云百炼 / 火山引擎` 三档，首次使用默认火山引擎；每次 Call 在
   `brain_voice_start.provider` 中选择，Host 无需重启。就绪回执显示实际 Provider、模型与连接耗时；
   回复状态显示最终转写到首响的耗时。
10. Host 与 Android 都写脱敏 JSONL 诊断事件。Host 文件为
    `~/.termbridge/logs/voice-events.jsonl`；Android 文件为应用私有目录
    `files/diagnostics/voice-events.jsonl`，并使用 `TermBridgeVoice` Logcat 标签实时输出。日志只含
    状态、字节数、VAD 概率、延迟和工具名，不含音频、转写正文、Prompt、图片或凭据。

## 配置

```bash
export DASHSCOPE_API_KEY='现有百炼 Key'
export TB_VOICE_PROVIDER=auto
export VOLCENGINE_S2S_API_KEY='新版语音控制台 API Key'

# 可选
export TB_VOICE_VOLCENGINE_MODEL=1.2.6.1
export TB_VOICE_VOLCENGINE_SPEAKER=zh_female_vv_jupiter_bigtts
export TB_VOICE_VOLCENGINE_END_SMOOTH_WINDOW_MS=1400
```

新版 API Key 是“豆包语音”控制台的 Speech SaaS Key，并不是方舟 ARK Key。若配置旧版
`APP ID + Access Token`，TermBridge 会自动使用旧 O2.0 协议兼容运行。

Host 也可把火山凭据放入权限为 `0600` 的 `~/.termbridge/settings.json` 的
`voice.volcengine` 节点；环境变量优先。凭据只在 Host 启动时读取，不会进入 Relay 或手机客户端。

Android 真机排障：

```bash
adb logcat -s TermBridgeVoice
adb shell run-as com.termbridge.android cat files/diagnostics/voice-events.jsonl
```

## 后果

- Android 不需要为 Provider 增加分支，原有悬浮球、外放、静音、离线缓冲、工具卡与 Global 历史继续
  使用同一协议。
- 火山二进制帧编码、事件生命周期和 20 ms PCM 分包可离线回归测试；未配置真实凭据时不能声称云端
  模型、听感或自然打断已验收。
- 火山 `UsageResponse` 会进入本地 usage ledger。官方当前公开计费概述只说明语音/文本 Token 计费，
  没有稳定公开单价，因此不生成虚假的本地费用值，最终费用以火山账单为准。
- 直接 RealtimeAPI 没有暴露与 TermBridge Harness 等价的原生工具循环，所以由 Provider 自动桥接
  `fork_execution`。如果以后迁移到火山 RTC 混合编排，需要额外的 RTC App、房间、服务端
  `StartVoiceChat` 生命周期和可回调的 Function Calling 通道，应另立 ADR。
