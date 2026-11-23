# 验证记录

> 最新状态见[长停顿修复与装机验证](pause-repair.md)。下列为本日第一轮快照，保留当时的失败及尚未部署边界，不代表当前安装状态。

日期：2026-09-08 · 本批扩展到 Android / Host / 协议 / 无声云管道。完整解释见 [实现报告](implementation.md)。

## 本批代码与实验验证

| 验证 | 结果与边界 |
| --- | --- |
| `pnpm test` | typecheck 通过；259 基础单测 + 18 HA + 4 silent-call + 17 voice-control + 5 Cloudflare 通过；独立 Relay / Host 的 30 个场景通过 |
| `pnpm build` | CLI、Host、Relay、Cloudflare bundle 构建通过，没有部署 |
| Android `testDebugUnitTest lintDebug assembleDebug` | 69 suites / 223 单测，失败 0；lint errors 0、warnings 156；APK 成功生成，非零警告未掩盖 |
| iOS `swift test` | 23 测试通过，覆盖新增协议回执；不是 iOS UI / 真机验收 |
| [音频管道严格成功](qa/pipe-replay/candidate-strict-pass.json) | 2.6 秒停顿：完整输入一次、工具 completed 一次、回答正确，进程退出 0 |
| [音频管道严格反例](qa/pipe-replay/long-pause-strict-fail.json) | 4.5 秒停顿：工具 0 次、回答 Agent 概念，严格脚本实际退出 1；实验开关因此默认关闭 |
| [32 次云教师对照](qa/teacher/report.json) | 8 个作者编写场景的 2×2 消融；标签仅 advisory，不注入个人训练 |
| [160 条本地合成数据](qa/control-lab/report.json) | 分组留出与参数重放完成；50% 反证标量特征不足，不能声称 DDSD 达标 |
| 网页 | 90 个链接/资源引用、3 张 SVG 与浏览器检查通过；320 / 390 / 1440 px、离线、无 JS 与打印样式检查 |

运行环境 Node `v24.2.0`。无声云实验与最后的安全性单测是不同层次：最近的音频实测之后又加了取消迟到 ASR / 过期窗口 / 无许可音频帧保护，这些最后改动有自动化回归，尚未追加真实手机 Call 验收。本文不把 mock 日历/图片/Herdr 场景误写为用户真实设备操作。

### 已生成 APK

- 文件：`android/app/build/outputs/apk/debug/app-debug.apk`
- 大小：71,715,829 bytes
- SHA-256：`90180b54feb68f92538705a4fad469972fd4611fd81ff3415a41f35bdd688218`
- 未安装、未启动手机麦克风；已有 Host 服务未重启。无需误以为当前手机上已经出现新页面。

Host 本地产物 `dist/host.js` SHA-256：`c232a6086e7b7bc5be1e5012a7c19bc73cbccbeb372a22185bf21e6f6a349616`。生成 bundle 不是更新已运行服务。

## 不能由本批验证推出的结论

- 完整语义 DDSD、CAM++ 本人识别、车内抗风噪与 24 小时耗电未验收。
- 校准层已实现、能训练/撤销，但只有影子评分权限，没有擅自开放音频准入。
- 没有播放器调用、没有房间录音、没有真实手机/家电动作。付费调用仅为明示的合成文件实验和有界文本判断。
- 新闭环不自动上传个人训练样本；也不能声称离线的其它 Host 已收到删除。
- 没有 commit / push / publish / APK 安装 / 已部署 Host 更新。

## 初期仅文档阶段的历史边界

以下条目仅描述本次实现之前的设计阶段，不再代表当前代码状态：

- 没有实现或训练生产 DDSD，没有验证主人/旁人/电视的识别准确率。
- 没有采集车内录音、访问麦克风、调用云模型、重启 Host 或安装 APK。
- 没有修复 CAM++ 或工具续答竞态；方案明确将它们列为前置工作。
- 页面演示只是有界的小步参数更新，不能作为真实意图识别改善的证据。
- `master@9cd9241` 的各端构建与测试属于此前集成工作，本目录不将其当作新学习链路验收。

## 本目录检查

```sh
node docs/voice-personalization/check.mjs
```

结果：通过。3 张 SVG、HTML ID、离线约束、脚本语法与合成学习断言通过；资源与文档链接数量以最后一次脚本输出为准。

独立校验的一步负反馈公式为 `z' = 0.4 - 0.25 × sigmoid(0.4) × 2.09`；合成分数从 `0.598687660112452` 变为 `0.5217826280381015`。正反馈提高分数，更新不修改旧状态，重置恢复基线，8 次预算后不再更新。检查过程中修正了测试中手录黄金值的小数错误，没有据此改动学习公式。

## 已完成的浏览器验证

环境：独立无账号的 Chrome `152.0.7977.82`，Playwright 启动新的临时浏览器上下文，直接读取 `file://` 文章；没有连接、刷新或操作用户的 Chrome 页面。

| 检查 | 实际结果 |
| --- | --- |
| 桌面 1440 px | 页面宽 1440 px；全部图解加载 |
| 手机 390 / 320 px | 页面分别宽 390 / 320 px；没有页面级横向溢出 |
| 手机图解 | 680 px 内容在独立、带名称的滚动区域内浏览；横向滚动操作生效 |
| 演示操作 | 负反馈 59.9% → 52.2%；正反馈提高；撤销、重置、刷新清除、8 次上限通过 |
| CSP 与隐私 | 页面发起的 HTTP(S) 请求 0；运行时/控制台错误 0；分数条样式实际变化 |
| 无 JavaScript | 正文和全部图解可见，演示显示不可用说明 |
| 减少动态效果 | 布局、图解、按钮均正常；未依赖入场动画展示正文 |
| 普通动态效果 | 滚动进入图解时 IntersectionObserver 揭示内容通过 |
| 打印媒体样式 | 图解可见，交互按钮隐藏，无页面横向溢出；未做逐页纸张分页验收 |

完整机器结果：[browser-report.json](qa/browser-report.json)。这些是桌面浏览器的窄视口测试，不是 Android WebView 或三星真机验收。

已查看实际渲染截图：

- [桌面首屏](qa/desktop-top.png)、[320 px 首屏](qa/mobile-320-top.png)。发现并修正窄屏标题孤字断行。
- [交互状态图](qa/desktop-interaction.png)、[两条学习路径](qa/desktop-learning-paths.png)、[整体架构图](qa/desktop-architecture.png)。节点、箭头与文字没有观察到遮挡。
- [学习演示](qa/desktop-learning.png)、[设置页草图](qa/desktop-settings.png)。草图与合成演示的未实现说明保留可见。
- [桌面实验结果](qa/desktop-evidence.png)、[320 px 实验结果](qa/mobile-320-evidence.png)。完整保留长停顿失败项；图表在带名称的独立区域内横向滚动。

### 重跑方式

校验脚本不增加或安装项目依赖。复用已有 Playwright 与 Chrome/Chromium，以自己的实际路径替换示例参数：

```sh
node docs/voice-personalization/browser-check.mjs \
  --playwright /path/to/playwright/index.mjs \
  --browser /path/to/chrome \
  --out docs/voice-personalization/qa
```

若当前环境可直接解析 `playwright`，并有其匹配的 Chromium，可省略前两个参数。脚本生成截图与机器报告，不修改生产代码、不启动训练。
