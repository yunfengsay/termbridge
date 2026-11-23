# ADR-0007: 锁屏语音通话的 Android 边界与暂缓方案

- 状态: 提议（暂缓实施）
- 日期: 2026-08-30

## 背景

TermBridge 的 Global Call 在手机已解锁、应用位于前台时可以使用，但三星手机锁屏或熄屏后，普通应用
入口不能稳定地唤起界面、取得麦克风并维持实时通话。目标不是绕过 Android 锁屏，而是在平台允许的
安全边界内，评估以后能否像系统语音助手一样从锁屏进入一个受限的 Voice Brain 会话。

当前实现已经注册 `VoiceInteractionService`，并声明
`supportsLaunchVoiceAssistFromKeyguard=true`；`BrainActivity` 也声明了 `showWhenLocked` 和
`turnScreenOn`。但现有录音、Realtime WebSocket 和通话状态仍由 Activity 持有，普通的
`GlobalCallEntryActivity` 只是一个启动跳板。这不足以保证从锁屏启动，也无法保证熄屏后持续录音和联网。

## 平台边界

1. Android 只会把锁屏语音助手回调交给当前系统 Voice Interaction Service。服务声明支持锁屏后，系统
   才会调用 `onLaunchVoiceAssistFromKeyguard()`；随后启动的界面还必须显式允许显示在锁屏上。
2. 三星侧键的“双击打开应用”是普通应用入口。具体机型、区域和安全策略可能要求先解锁，因此不能把它
   当作可靠的免解锁入口。长按侧键可分配给数字助理，但这会与 Bixby 的占用形成明确取舍。
3. Android 14 及以后限制后台创建使用麦克风的前台服务。可见 Activity、明确的用户操作以及当前
   `VoiceInteractionService` 属于可行入口；普通后台进程不能静默取得麦克风。
4. `showWhenLocked` 只允许受控界面显示在 Keyguard 上方，不代表应用获得了用户已解锁的身份。
5. 声纹只能用于降低环境误触发，不能替代系统认证；录音回放也可能通过声纹筛选。

## 决策

当前暂缓实现锁屏通话，继续支持已解锁或前台状态下的 Global Call。保留 Bixby 长按入口与 TermBridge
普通应用入口，不尝试使用 Accessibility、悬浮窗、非通话用途的全屏通知或其他方式绕过 Keyguard。

如果以后重新启动这项工作，采用系统支持的两段式架构：

1. **锁屏启动层**：用户将 TermBridge 设为当前数字助理，由
   `VoiceInteractionService.onLaunchVoiceAssistFromKeyguard()` 直接打开专用的
   `LockscreenCallActivity`，而不是依赖普通应用跳板。该 Activity 只呈现锁屏安全的 Call UI，并使用
   `showWhenLocked` / `turnScreenOn`。
2. **持续通话层**：把 `AudioRecord`、Realtime WebSocket、回声抑制和通话状态移入
   `VoiceCallForegroundService`。服务声明 microphone 前台服务类型，只能由可见 Activity、系统助理
   回调或其他明确用户操作启动，并显示持续通知。Activity 只负责渲染并绑定服务；锁屏、熄屏和旋转不再
   销毁通话。通知提供静音、文字模式和挂断操作，挂断后立即释放麦克风、音频焦点与网络连接。

这不是“双击侧键即可免解锁”的透明增强。要获得稳定的锁屏入口，用户必须主动把 TermBridge 设为当前
数字助理；若优先保留 Bixby 为默认助理，则 TermBridge 只能接受三星系统允许的普通应用启动行为。

## 锁屏安全边界

锁屏界面只允许显示语音动画、当前轮的可选脱敏字幕、静音/文字模式和挂断。默认不显示 Global 历史、
Agent 详情、Terminal 输出、文件内容或凭据，也不允许从工具卡进入 Terminal。

只读状态查询可以在锁屏策略允许时开放。继续 Agent、派发任务、运行命令、修改文件等有副作用的操作，
默认应排队并要求解锁确认；未来若增加免解锁白名单，也必须按工具逐项定义范围，不能把声纹当作授权。

## 重新实施时的验收条件

- 在目标三星设备锁屏且熄屏时，通过系统助理入口进入受限 Call，无需先打开普通应用。
- Android 16 / One UI 上录音和 Realtime 连接正常；通话中再次锁屏或熄屏不会中断。
- 解锁后能无缝转入完整 Global 页面，锁屏期间不能进入 Agent 或 Terminal 详情。
- 明确展示并测试“TermBridge 默认助理”与“保留 Bixby 默认助理”两种配置的能力差异。
- 前台服务通知、麦克风指示、音频路由、回声抑制、打断和挂断后的资源释放均可验证。
- 记录持续通话的电量与发热数据；仅在活跃 Call 期间按需持有唤醒锁。
- 在当前目标机型 Samsung SM-S9180 上完成真机验收，安装成功不等于锁屏场景验收通过。

## 后果

- 当前版本不会承诺锁屏或熄屏下可用，避免把机型相关的普通应用入口误称为系统助手能力。
- 将来实现需要新增前台服务、锁屏专用 UI、认证策略和真机测试，工作量高于为现有 Activity 添加窗口标志。
- 选择可靠的免解锁入口会要求 TermBridge 成为默认数字助理；保留 Bixby 时只能接受功能受限。
- 不采用任何绕过锁屏的 Hack，Terminal 与文件能力继续受系统解锁边界保护。

## 参考

- [Android `VoiceInteractionService`](https://developer.android.com/reference/android/service/voice/VoiceInteractionService.html)
- [Android 后台启动前台服务的限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)
- [Android `Activity.setTurnScreenOn`](https://developer.android.com/reference/android/app/Activity#setTurnScreenOn(boolean))
- [Samsung：自定义侧键](https://www.samsung.com/uk/support/mobile-devices/how-to-customise-the-side-button-with-new-features-on-your-galaxy-phone-and-tablet/)
- [Samsung：锁屏快捷方式](https://www.samsung.com/us/support/answer/ANS10001362/)
