# Android 持续对话与本地唤醒词

## 交互

- **持续对话**：默认值，保留现有自然交流/打断链路。
- **唤醒词**：本地待机 → 匹配唤醒词 → 新建云端语音会话 → 回复播放结束 → 关闭云端会话并回到待机。

通话页顶部增加小尺寸模式入口，与模型切换、附件并列；全局设置可保存模式和唤醒词。
默认「你好小桥」，中文 3–8 字，与口述输入的「发送」关键字独立。Android 10+ 用系统 ICU
在本地生成带调拼音；更早版本仅支持默认词。多音字可能使用默认读音，建议选择发音明确的词。
自定义词不支持英文，这不是完整端侧 ASR。

后台仍只有圆球，点击回通话页挂断。待唤醒使用较慢、较弱波动，通知说明本地等待；
没有可见通话页/圆球仍应停止整个通话。默认数字助理、开机录音、解锁绕过均不在本功能范围。

## 隐私与状态边界

`VoiceWakeSession` 是本地权限状态机，`WakeWordCaptureGate` 拥有捕获线程上的关键词模型。
`OnDeviceVoiceCapture.onLocalFrame` 在 GTCRN/VAD/发送队列前判定，未唤醒的 PCM 不进入
`VoiceAudioOutbox`，不会因为断网后重连而补传。待机不发送静音 PCM，也不创建新的云端语音会话。
Host/Agent 状态连接可以保留，不等于语音会话仍在上传。

为避免「唤醒词+指令」连读丢掉开头，只在内存滚动保留 **384 ms** 预卷；
只有关键词接受后才连同当前帧通过处理管线。预卷不落盘、不进离线队列，旧数据覆盖。
关键词误触发仍可能打开上传窗口；这不是声纹认证，也不保证能区分主人和电视中的同一句唤醒词。

开始/挂断/模式切换/新唤醒轮次都有递增 generation。音频发送必须在同一 generation 且 ACTIVE；
挂断与模式切换先撤销权限，再清除队列、终止旧远端会话和本地播放。迟到的旧 requestId 事件丢弃。
模型加载/推理失败显式报错并停止，不回退为全量上传或系统联网语音识别。

## 一轮何时结束

普通说话的语义判停仍使用既有云端模型。额外的本地 ASR 只负责停止词/后续本地边界判定，不替代云端对话。
客户端仅在有答案的 `brain_voice_status:listening`、无工具进行中、播放已排空，并稳定 600 ms 后回待机。
空工具响应和用户短暂停顿不触发回待机。用户打断会推进 speech generation，旧回答迟到结束不能关闭新输入。
一轮回答后再次提问需要重新唤醒；不是模型主动判断整个聊天关系结束。

另有 **120 秒单次输入激活上限**，用于网络故障/模型卡住时关闭新输入；
这是隐私保底而非 AI 语义判断，不终止等待中的回答和工具。后台 Worker 不因此被宣称取消。
关闭云端会话不会撤回已发送的音频，也不会删除已有 History。

## 停止词与纠正样本（实现中）

停止词独立配置（默认 `Over`、`说完了`，最多 5 个中英文短语）。本地识别后：

1. 同步撤销录音帧的 generation 授权，进入 `DRAINING`。
2. 原来已授权的 outbox 仍可发送；追加 2 秒数字静音和 commit，帮助既有 semantic VAD 收口。
   数字静音没有环境声音；它仍可能计入提供商输入用量。当前停止词自身可能已部分上送，不能撤回。
3. 保留 requestId、远端会话、工具和播放。不能用 `brain_voice_stop` 代替停止输入。
4. 新声音只交给本地唤醒词检测；再唤醒可恢复同一在途远端会话。回答播放结束才释放该会话。

`LocalBoundaryAudioMonitor` 独立单线程执行 JNI ASR，最多一个推理、一个 5 秒 RAM 窗口；
最早 800 ms 开始，最多每 600 ms 再推理一次，慢推理不无限堆积。这些时间不是承诺的真机停止延迟。
当前匹配拒绝 `overflow` / `leftover` / `takeover` 等子串；模型误识别和说话中提到停止词仍可能误触发。
等待阶段不运行这个 ASR，只运行原有轻量 KWS。

额外模型为 FunAudioLLM / Alibaba 的 **SenseVoiceSmall**，由 sherpa-onnx 项目转换：
[转换仓库固定版本](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tree/2365baeacb507f821a0c8120fcee3d484dba7a07)，
[原始模型及作者](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)，
[FunASR Model License](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)。
它不是几 MB 的意图分类器；229 MiB 的本地 ASR 是目前英文停止词与后续上下文判定的候选前端。
不打进 APK，通过设置按钮或 Global 页面内准备入口下载到 `no_backup/boundary-sensevoice-2024`；固定 revision / 大小 / SHA-256，
校验成功才启用。首次缺少模型不弹模态拦截、不强制跳设置：显示下载大小、进度和重试入口，
也可明确选择“先用自然对话”。不自动下载、不静默切模式、不在下载结束后自行打开麦克风；
用户再次点击“开始唤醒通话”才开始通话，关闭页面取消本次下载。

```text
model.int8.onnx 239233841 bytes c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51
tokens.txt         315894 bytes f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc
```

学习开关默认关闭。启用后，人工停止词事件保存最近的少量文字上下文、边界标签、模型版本与时间，
不保存 PCM，不采集停止之后的旁人对话；每个字段最多 1000 字符，常见凭据/URL 做脱敏。
目录 `no_backup/voice-boundary-samples-v1`，不进入 Android Auto Backup，最多 10,000 条 / 30 天。
可在设置查看、单条删除或“停用并删除全部”；排队回调写入前再次检查持久化 consent。
样本一律 `reviewed=false`，Over 是弱边界标注，不能直接视作前后话语的意图真值。

**自动上下文分类仍未落地，不是已有停止词模型的另一种名称。** 后续需完成本地 DDSD 分类器、
候选话语上云前门控、提前结束/误响应反馈、审核导出和训练评估路径；不能以静音阈值冒充意图识别。

## 游戏、耳机与耗电限制

待机不持有独占音频焦点，唤醒后的云端交流才申请焦点，回待机释放；
麦克风/communication-device 路由仍保留，挂断后清理。蓝牙 SCO 可能影响媒体音质。
本方案是 CPU 本地采音推理，不是 DSP 热词，不能承诺全天零耗电。
Android 的普通应用并发采音有限制；游戏同时开麦时可能只有一方拿到音频。
默认数字助理角色本身不等于预装系统助手的录音特权。
参见 [Android 音频输入共享规则](https://developer.android.com/media/platform/sharing-audio-input)。

## 模型、来源与复现

复用现有 sherpa-onnx 1.13.6 AAR，模型为
`sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`，16 kHz mono、80 维特征、
chunk 16、int8 encoder/decoder/joiner、单 CPU 线程；阈值 0.35，score 1.5，trailing blanks 2。
权重和 tokens 在 `android/app/src/main/assets/wake-word-zh-3m/`，约 4.8 MiB，无运行时下载。
保留发布者 MODEL_README 和 Apache-2.0 LICENSE。空默认关键词文件很重要：原生 createStream
会把自定义词与默认表合并，不能意外保留旧词。

来源：[官方 KWS 文档](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html)、
[发布者模型卡](https://www.modelscope.cn/models/pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01)。
文件从该模型的 `resolve/master/` 下载；原始名称为对应的
`{encoder,decoder,joiner}-epoch-12-avg-2-chunk-16-left-64.int8.onnx`，打包时简称为 `{encoder,decoder,joiner}.onnx`。

SHA-256：

```text
encoder.onnx 017af32f2c0138f931d05fbc009ee864295e910aff304f77d2f563815fc834fb
decoder.onnx fe53b8d6a07bc5373d1770649025a5a985c8fb3dab70323386a1b73aacba0546
joiner.onnx  431de10b554f134ef8af320feea2db337e641290449a3d3f6cb6e5f5fd2c9c3d
tokens.txt   72316508d9119696145abc6f1f8cdc46287535c34e5ce7e595f845cb1499cf2e
```

## 自测

```sh
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

`VoiceWakeSessionTest` 验证待机 10,000 次发送均被拒绝、generation 过期、模式切换、
工具/播放未结束不回待机、打断旧回答迟到结束、120 秒保底。
`VoiceWakeWordTest` 在 Android ARM64 运行真实 JNI 模型和生产 gate，
不构造 AudioRecord、不播放、不接云端；验证无关键词的合成对话、默认/自定义词、
修改后旧词失效、两轮唤醒、待机零上传/零离线队列、挂断后旧音频拒绝及设置持久化。
另回放 60 秒静音和约 10 秒固定种子的合成噪声；这不代替车内录音或真实游戏声音。

androidTest/assets/wake 下的 PCM 是 macOS Tingting 本地合成、ffmpeg 转换的 16k mono PCM16LE：

- positive：「你好小桥，看看我的任务做完了吗。」（3.431 秒）
- negative：「我们往左边走，快点躲起来，今天下午有什么安排。」（5.136 秒）
- custom：「你好助手，看看我的任务做完了吗。」（3.303 秒）

仪器测试通过明确指定的模拟器运行，不自动安装/启动用户手机麦克风。
可读取 `VoiceWakeTest` 日志中的运行时间、native heap 增量和待机上传字节。
模拟器回放耗时不是三星实际续航/CPU/RSS测量；真实耳机、游戏并发、用户口音和云端回复闭环仍需验收。

### 本次验证记录（2026-09-05）

- `testDebugUnitTest`：190 项，0 failures / 0 errors（包含当前共享工作区的其他测试）。
- `lintDebug`、`assembleDebug`、`assembleDebugAndroidTest`：通过。
- ARM64 / API 36 模拟器：`VoiceWakeWordTest` 与 `VoiceCallPresentationTest` 共 7 项通过，耗时 11.539 秒。
- 最后一次真实 JNI 回放日志：`replayMs=706 nativeHeapDelta=29450352 wakeCount=2 standbyUploadBytes=0`。
  native heap 增量约 28.1 MiB，不代表应用总内存；零上传是生产 gate/outbox 测试计数，不是云端抓包结果。
- 测试不打开麦克风、不播放音频、不连接云端；结束后停止模拟器应用。未安装到三星手机，也未重启 Host。
