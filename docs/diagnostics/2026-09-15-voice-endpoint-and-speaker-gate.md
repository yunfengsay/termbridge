# Global Voice 停顿与背景人声：候选修复

## 已确认的实现问题

- `packages/voice/src/control/turnCoordinator.ts`：`speechStart` 留下空占位，
  `transcript` 却忽略空的 completed；`schedule` 因任何空占位停止。
  已终结的空识别会阻塞后续完整问题。不是将尚未返回的识别擅自丢掉。
- `packages/voice/src/omni-realtime.ts`：开启 Host judge 时声学切段默认等 3000 ms；
  语义判断另有超时重试。声学切段慢不等于模型参数量不够。
- `BrainActivity.startVoiceCapture` 写死 `verifySpeaker=false`；
  `OnDeviceVoiceCapture.processFrame` 的 realtime passthrough 提前返回，
  本来就没进入旧的分段声纹分支。因此仅恢复布尔值不够。

## 候选改动

1. 明确空 completed 清除对应占位并重新调度。晚到的空结果不能结束另一段正在说的话。
   未返回 final 的前半句继续保留；取消后迟到的文本不能复活任务。
2. 声学切段默认 1400 ms；Host 仍按 1800 / 3000 ms 的累计静音安排判断，
   不是在 1400 ms 后再完整等待 1800 / 3000 ms。未说完继续 wait，语义模型超时不授权工具。
   这些数字不包括端侧门控、模型推理、ASR 或网络，不是端到端响应承诺。
3. 实时模式按用户设置启用 `StreamingSpeakerGate`，使用已有 CAM++ 对录入音色比对。
   每 32 个 512-sample 帧（16 kHz 下 1.024 s）重新验一次，保留 VAD 的起始回填和尾端平滑。
   合格 PCM 按采集速度排出，避免每块音频重复增加一秒静音导致时间轴膨胀。
   不通过的窗口不传人声音频、也不触发已授权打断。连续三次无有效模型测量会显示错误并结束采集，
   不会静默绕过验证或无限 WAITING。采用录入声纹，不在线吸收背景声作为新主人。
4. 启动日志包含过滤启用状态；测量日志只含窗口帧数、有无结果、耗时，不记录音频、声纹或对话内容。

## 豆包证据及边界

参考公开开源音频前端结构（系统 AEC/NS → 神经网络降噪 → NN VAD）。
可核验记录包括 `libaudioeffect.so`、`SAMICorePropertyId`、`FrameFeature_NNVAD`、
`TailVadProbeActor` 和动态资源 `/vad/encoder/vad_v4.pth.pthlite`（1,155,064 B）。
它支持“神经网络前端 + 人声判定 + 起止平滑”的实现证据，不能据此证明每次录音
都执行主人身份识别，更不能把组件存在当成所有场景真实调用顺序的证明。
本轮没有新跑豆包动态插桩，也没有复制其私有权重。

## 验证和未验收项

- 新增空 completed、迟到空 completed 的调度测试，修复前失败、修复后通过。
- 新增 provider 事件贯穿调度的测试，确认完整问题一次提交、声学等待 1400 ms。
- Voice/control 测试 58/58 通过；Node build 通过。
- 完整 `pnpm test` 未通过：`packages/host/src/voicePipeline.test.ts` 4 项因
  `Promise resolution is still pending but the event loop has already resolved` 被取消。
  此文件本批未修改；不能用定向通过替代全套通过。
- `StreamingSpeakerGateTest` 覆盖缓存起始、主人后换另一说话人、模型空值、短句尾部与 reset。
  使用注入分数，仅证明控制流，**不是实际 CAM++ 精度测试**。
- Android unit/lint/debug assemble 通过。同期输入快捷键改为共用有底色、描边、checked/pressed
  状态的 Material 样式，尚无本批截图验收。
- ADB 无设备，Peer 日志请求超时；没有本批真机/车内/电视录音结果，没有安装或重启 Host。

声纹窗口引入约一秒缓冲，短尾窗可能不够可靠；现有相似度阈值 0.30 / 0.25 较宽松且未在本轮校准。
主人与电视同时说话的混合窗口可能仍被放行，当前实现不是目标说话人分离。
真机验收必须比较：本人单说、电视单说、本人说完电视接话、两者重叠，记录漏拒/误拒、
首字完整性、停止说话至最终文本/首响应耗时以及 native 推理耗时。
未通过这些验证前，不应宣称达到豆包效果或已彻底解决背景对白。
