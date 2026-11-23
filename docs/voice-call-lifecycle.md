# 可见、可退出、单实例的 Voice Call

## 2026-09-05 后台手表播报旁路

三星日志复现：22:29:35 `ZeppVoice` 收到手表 Opus；22:29:46 收到 Global 答案；22:30:11 收到合成音频。此时没有 VoiceCallOverlayService。该证据证明存在手表请求完成后的后台自动播报，不证明手机麦克风持续录音。

`ZeppGlobalVoiceController` 原先无条件合成并播放回复，失败还回退本机 TTS，绕过了通话所有权和可见性约束。现在手表通道只返回文字完成回执，不再构造播放器、请求合成或处理迟到音频。需要说话时用户显式进入有可见界面的 Call。

`WatchReplyPrivacyTest` 重放手表录音 → ASR 结果 → Global 结果（全部合成数据、不采音不联网），修复前得到 synthesizing 而非 done；回归要求 done、完整文字、无合成请求且迟到音频无效。

另外清除退后台的旧 Activity surface 标记；Application 层每 500ms 独立检查活动通话的可见表面，避免只让悬浮 Service 监督自身是否存在。悬浮服务销毁即停通话，不能因为旧页面标记而保留。

验证：手表重放测试修复前失败（synthesizing），修复后完成文字回执且不请求合成；与三项既有悬浮窗口测试一起通过（4/4）。测试未申请实际采音，模拟器 RECORD_AUDIO 无访问记录。Android 207 条单测、lint 和构建通过。三星已执行过紧急停止；随后检查 app-op 没有正在录音条目，最后录音为一小时前约两秒。修复包尚未覆盖安装，不把模拟器验证当成三星实际通话验收。

## 产品约束

后台通话是用户选择的能力，不是隐形监听。只有以下任一表面实际存在时才能继续：

- Global 通话页面；
- Terminal 详情内的小球；
- 系统悬浮球（收起时只有随声音变化的圆球，不附状态文字或挂断按钮）。

轻点圆球直接回到通话页面，在页面内挂断；长按可展开已有的截屏与选图快捷操作。
Android 前台服务通知仍保留状态和停止入口，不占用悬浮球空间。

“APP 在前台”不代表通话可见：例如首页、设置和图片选择页面，需要系统悬浮球。
缺少悬浮权限时只允许在可见通话页面使用；离开后停止通话。
窗口添加失败、服务退出、窗口脱离，立即结束后台通话；另每秒检查一次权限与窗口可见性，
防止没有新的音量事件时漏掉权限撤销。选择截屏时不隐藏麦克风标识。

数字助理注册只提供启动入口，不是开始录音的依据。只有用户进入 Call 才申请通话所有权。
退出页面（Back）结束该通话；Home/进入详情可以继续，但必须有小球。

## 双声音根因及隔离

真机系统音频记录曾显示同一 UID 的两个录音 session、两个 24kHz speech AudioTrack 重叠，
应用日志同时存在两个远程 Call requestId；关闭其中一个，另一个仍回复。
原因是默认 `singleTop` 只复用栈顶页面，而旧 `onStop` 无条件保留活动通话。

- 所有 Brain 入口统一 `REORDER_TO_FRONT | SINGLE_TOP`，复用被其他页面覆盖的实例。
- `VoiceCallOwnership` 是主线程单所有者 lease；若出现另一实例，先清理旧通话再获取新所有权。
  旧实例延迟销毁不能清空新通话的全局状态。
- `VoiceCallUiState` 跟踪真实通话表面与系统球状态，不以应用整体前台状态决定是否展示。
- 挂断先发送 `brain_voice_stop` 再断连接；清理录音、PCM/TTS、待合成回复、路由和悬浮服务。
- PCM 中断立即静音硬件缓冲，再由播放器线程释放 AudioTrack，不再 flush 后空播放重启。
- 停止原因写入现有私有 `files/diagnostics/voice-events.jsonl`（`call_stopped.reason`），不记录音频或转录。

## 不采音验证

`VoiceCallPresentationTest` 使用仅用于测试的 presentation lease，**不调用 startVoiceInput、
不构造 AudioRecord、不连接云端语音、不执行 Agent 工具**。
它验证真实 WindowManager 小球不带状态/挂断控件、轻点返回但不挂断、权限撤销，
以及首页返回时 Activity 复用。

模拟器需为测试包的宿主授予 `SYSTEM_ALERT_WINDOW` 和 foreground-service 所需的录音权限；
权限存在不等于实际采音。运行后以 `cmd appops get com.termbridge.android RECORD_AUDIO`
核对没有录音访问时间。测试 APK 不随普通 APP 发布。

单测覆盖所有权交接、旧 owner 释放、重复进入幂等、表面交接与不可见后台的禁止规则。
构建入口：`./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest`。
真实语音、耳机路由和三星系统特殊覆盖窗口仍需用户主动发起通话后验收；不以模拟器 UI 测试冒充听感验证。

2026-09-05 验证：182 条 Android 单测及 lint/build 通过；三项不采音仪器测试连续三轮通过。
复跑发现的测试首页恢复时序问题改为等待真实 Activity resumed 回调后消失。
模拟器 `RECORD_AUDIO` app-op 未记录访问；三星只覆盖安装并保持应用停止，未自动恢复数字助理入口或启动录音。

同日圆球简化后，重新通过单测、lint、APK 构建与三项不采音仪器测试。
新增验证：收起态无状态文字/挂断按钮，轻点圆球进入 BrainActivity 且不触发挂断。
此轮圆球简化尚未覆盖安装到三星。
