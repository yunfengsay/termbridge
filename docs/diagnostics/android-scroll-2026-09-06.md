# Android 会话滚动诊断（2026-09-06）

结论：确认两类渲染路径不同，并复现 PTY 全屏模式的滚动输入断链；尚未确认用户报告发生在此模式，不能宣称已找到原报告的根因。本次未修改生产代码、未安装 APK、未提交或 push。

## 入口与差异

- `android/app/src/main/java/com/termbridge/android/MainActivity.kt:603` 的右下角入口列出 Shell / Claude Code / Codex，经 `openNewSession`（:650）进入 `TerminalActivity.createIntent`，不是 Global 云端模型对话。
- Global 入口在 MainActivity :93；Global 的“新建对话”由 `brain/BrainActivity.kt:344` 的顶部菜单触发，:863 发送 `brain_new`。
- Global：`BrainActivity.kt:338` 使用 RecyclerView / LinearLayoutManager（stackFromEnd=true），`BrainTimelineAdapter` 使用 ListAdapter。`res/layout/activity_brain.xml:119` 的外层 FrameLayout 为 0dp + weight=1，RecyclerView 为 match_parent；没有外层 ScrollView 或禁用滚动配置。消息 TextView 为 wrap_content + textIsSelectable（`item_brain_message.xml:30`），未设置行数截断。代码审查未证明普通拖动被 TextView 拦截；未做 Android 原生触摸复现。
- Global 自动定位：`BrainActivity.kt:733-743` 与 `BrainTimelineAdapter.kt:114`。首次渲染，或原先位于底部且最后条目 ID 改变时，才定位尾项；同 ID 流式更新不持续调用 scrollToPosition。异步提交与手势竞争仍可能存在，未证实为此次故障。
- 终端：`TerminalActivity.kt:301` 只在 Herdr + mobilePresentation 时请求结构化 mobile 阅读视图。普通新建 PTY 使用 xterm。`res/layout/activity_terminal.xml` 包含原生 TerminalWebView，没有 RecyclerView。
- Herdr 阅读视图：`android/app/src/main/assets/terminal.html:20` 使用独立 DOM 的 overflow-y:auto / touch-action:pan-y；前端有滚动期间延迟更新和视口保持，不依赖 xterm 全屏应用的滚动输入。

## 已复现的独立缺陷

`android/web/src/terminal.ts:40` 设置 disableStdin=true；:98 把拖动转成 xterm wheel，但 :99 附近没有 terminal.onData 转发，`terminal/TerminalWebView.kt` 的 NativeBridge / Listener 也没有相应输入出口。

xterm 的普通 buffer 有本地 scrollback，因此只移动视口即可。alternate buffer 没有历史回滚，需要 wheel 生成方向键或应用启用的鼠标协议事件，交由远端全屏应用滚动。当前 disableStdin 会抑制这些数据；只关闭开关仍然缺少到 Host 的桥接。因此它专门影响这类 PTY 交互，不能用增加 RecyclerView 高度或取消自动锁底修复。

隔离试验使用实际 Android terminal.ts 及依赖，临时增加只读探针，在独立 headless Chrome 中测试，没有操作用户浏览器或连接 Host：

- 120 行普通输出，向下拖动后 viewportY 从 83 降到 78；中段从 40 降到 35，正常回滚。
- 切换 ESC[?1049h alternate buffer 后，相同拖动产生 0 条 onData 事件。
- 唯一改变 disableStdin=false 后，相同拖动产生 3 条 ESC[B 事件；实际应用没有这些事件的 Host 转发链路。
- 重复运行两次，结果一致。测试只证明模式相关断链，不证明用户正在该模式，也不证明完整修复。

## 改动与验证

只新增本报告。未更改任何原有生产文件，保留共享工作区全部既有改动。

- `node /tmp/tb-scroll-diagnosis/repro.mjs`：上述差分试验成功；脚本和 JSON 在 `/tmp/tb-scroll-diagnosis/`。
- `cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug`：BUILD SUCCESSFUL，55 tasks，1 executed / 54 up-to-date。本次属于未改代码的基线检查，不能称为修复后验证。
- 当前单测 XML：213 tests，0 failures / errors / skipped。单测任务使用既有 up-to-date 结果。
- 构建日志：`/tmp/tb-scroll-diagnosis/android-checks.log`。
- ADB 只读检查：手机安装版本 0.1.24 / versionCode 9，更新时间 2026-09-06 10:39；未核对 APK 内容哈希，因此不能证明与当前源码一致。手机前台为其他 App，未切换、注入手势或覆盖安装。

## 尚需确认与验收

需确认故障入口：右下角选 Claude Code / Codex，还是顶部 Global 新建对话。如果是前者，需要复现实际会话的 alternate buffer / 鼠标模式；若是后者，需要原生 RecyclerView 的真机长回复拖动证据。

PTY 输入桥接涉及 JS → Kotlin → Host，超出纯布局/滚动配置小改动，且必须确保原生 composer 继续独占 IME、避免把终端响应误发成用户输入。本次不在入口尚未确定时盲改。

真机验收仍必需：长回复静止/流式更新时，上下拖动、快甩、回到底部；区分普通 PTY、全屏 PTY、Herdr 阅读视图与 Global，并验证中文输入和终端输入没有回归。
