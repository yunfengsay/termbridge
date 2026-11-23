# ADR-0009: Agent Registry 与控制平面账本

- 状态: 采纳
- 日期: 2026-09-03

## 背景

Global 已经能够通过百炼工具直接回答、继续现有 Agent 或派发新的 Codex/Claude，但生命周期事实分散在
`BrainTask`、工具卡片、Context Index 完成事件和客户端通知中。Agent 配置仍只是名称到命令的映射，
模型缺少稳定的用途与能力描述。最终结果主要是自然语言，手机无法可靠区分 Preview、Report 或文件。

## 决策

1. 将 `BrainCoordinator` 深化为控制平面账本。它以一个接口持久化 Route Decision、Run Event 与
   Deliverable，并继续生成向后兼容的 `messages`、`tasks` 和 `toolResults` 快照。
2. Route Decision 只记录 Brain 已经做出的决定，不另建规划模型。动作限定为直接回答、继续精确 Session
   或派发 Agent；Host 记录目标、结果、权威时间，以及模型提供的简短 reason/confidence。
3. 当前 `taskId` 保持线协议兼容并同时作为 `runId`。Run Event 为追加式事实，第一阶段限定 queued、
   dispatched、completed、failed；通知和客户端后续逐步改为消费该事件，不在本 ADR 中改变既有完成语义。
4. Agent Registry 只暴露稳定 `agentId`、显示名、runtime、purpose、capabilities 和可选默认 workspace。
   完整 shell command 留在 Host config。旧的 `agents: Record<string,string>` 继续可用，新增可选 profile 元数据。
5. 本地执行 Agent 的最终回复可用受限 `<termbridge_deliverable .../>` 标签声明 Deliverable。Host 只接受固定
   kind、HTTPS URL 或安全相对路径，忽略任意布局、脚本、绝对路径和目录穿越。客户端使用固定原生 Adapter。
6. TermBridge 只管理 Run；Agent 内部是否并行、fork 子 Agent 或如何规划不进入控制平面账本。

## 后果

- Global 文字与 Voice 共用同一份可审计路由和 Run 生命周期，不再靠 UI 文案反推发生了什么。
- 旧客户端仍可读取原字段；新字段均为可选扩展，历史 Brain state 在读取时迁移并保持有界。
- Agent Registry 为后续路由准确率评估提供稳定目标，但第一阶段不增加 Marketplace 或重型配置 UI。
- Deliverable 只有在 Agent 显式按契约声明且 Host 校验通过时才出现；普通回复中的 URL 不会被猜测成成果。
- 本 ADR 不改变 ADR-0003 的 Herdr 生命周期所有权，也不放宽 ADR-0002/0006 的工具与文件安全约束。
