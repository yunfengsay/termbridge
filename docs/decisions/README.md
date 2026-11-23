# 决策记录 (ADR)

这里放**真实的技术方案、修改方案、修复方案**——每做一个有取舍的决定（架构、协议、依赖、
修一个坑的根因与对策），写一篇，编号递增，不删旧的（被推翻就新写一篇 supersede 它）。

命名：`NNNN-短标题.md`。模板：

```markdown
# ADR-NNNN: 标题

- 状态: 提议 | 采纳 | 被 ADR-XXXX 取代
- 日期: YYYY-MM-DD

## 背景
要解决什么问题 / 约束。

## 决策
选了什么，怎么做。

## 后果
好处、代价、留下的待办。
```

现有：

- [0001 — P0 基线：relay 拓扑 / 纯信任 / dev-mode](./0001-p0-baseline.md)
- [0002 — 反向工具通道](./0002-reverse-tool-channel.md)
- [0003 — Herdr 原生 API 会话](./0003-herdr-native-api.md)
- [0004 — MiniCPM-o 4.5 本地语音节点备选链路](./0004-local-omni-voice-fallback.md)
- [0005 — NemotronLabs VoiceChat 11B 实验性本地语音候选](./0005-nemotronlabs-voicechat-11b-local-option.md)
- [0006 — Voice Brain 使用 Host 权威上下文与显式工具过程](./0006-voice-brain-context-and-tools.md)
- [0007 — 锁屏语音通话的 Android 边界与暂缓方案](./0007-lockscreen-voice-call.md)
- [0008 — 独立的手机 Git Diff 与项目源码浏览能力](./0008-mobile-git-review.md)
- [0009 — Agent Registry 与控制平面账本](./0009-control-plane-ledger.md)
- [0010 — 手机作为受限原生 Action Peer](./0010-phone-peer-actions.md)
- [0011 — Execution Fork 与工具可观测性](./0011-execution-fork-and-tool-observability.md)
- [0012 — 火山引擎 S2S-O 并行实时语音 Provider](./0012-volcengine-s2s-provider.md)
- [0013 — 手表作为低风险 Action Remote](./0013-watch-action-remote.md)
- [0023 — macOS 会话导航窗口（Herdr 布局）](./0023-macos-session-navigator.md)
- [0024 — 对话涉及的仓库与 macOS 文件与改动窗口](./0024-conversation-repositories-and-file-inspector.md)
- [0025 — 内网中转与连接拓扑](./0025-lan-relay-and-topology.md)
