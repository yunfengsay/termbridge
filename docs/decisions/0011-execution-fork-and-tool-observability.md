# ADR-0011: Execution Fork 与工具可观测性

- 状态: 采纳
- 日期: 2026-09-04

## 背景

Global 文字对话和实时语音曾分别把同一批工具直接注册给不同模型，形成两套工具循环。这样会让上下文、
路由、状态卡和错误处理逐渐分叉，也无法在客户端完整展示 Qwen 编排多个工具的过程。

## 决策

实时 Omni 只承担低延迟听说，并且每个有效 utterance 只调用 `fork_execution`。Host 随即创建一个逻辑
Execution Fork，把当前对话、Agent roster、最近完成时间、任务、来源 Session、Memory 与完整 Tool Catalog
交给 Pi + Qwen3.8 Flash。Global 文字请求直接进入同一个 Fork 路径。

Host 的单一工具注册表同时提供模型 definition、执行 Implementation、进度摘要、原生 UI 映射和公开 Tool
Catalog。Pi 只依赖 Brain 内部的中立 Tool Interface，不依赖 Voice 包。每次 Fork 产生结构化 Execution Event，
Host 持久化后实时推送；Android 和 iOS 按 Fork 聚合成一张紧凑卡片，显示内部工具的 started/completed/failed。

Execution Fork 不是一次性的 function call。Pi 保持 Qwen 的模型—工具循环：每次工具结果都返回结构化的
`ok`、`retryable` 与 `failureKind`。可恢复失败时，Qwen 可以修正参数、刷新实时状态或改用另一项已注册工具；
成功、不可重试失败、同一调用连续失败两次，或达到 10 轮/40 次调用的熔断上限时才结束。已成功的 mutation
不得重放，`dispatched` 也不得冒充 `completed`。

事件只公开工具名、模型名和安全摘要，不公开 chain-of-thought、凭据、完整参数、命令或无界结果。

## 后果

文字与语音共享一个编排入口和一份上下文规则；工具实现彼此不引用，新增工具只需注册一次。客户端可以看见
Qwen3.8 Flash 正在调用哪些工具及其结果状态。代价是一次语音回合会经过 Omni 与 Qwen 两个模型，增加少量
延迟和调用成本；后续可在不改变 Tool Interface 的情况下替换任一模型 Adapter。
