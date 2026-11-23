# ADR-0019: Jev 意图提示与统一工具选择实验

日期：2026-09-21。状态：Host 实验接点与隔离实测完成，默认关闭；未部署、未真机验收。

## 目标与职责

Global 既是 Agent 委派入口，也是受授权的手机管家。提醒、日历、选定照片处理、家庭设备与终端
Agent 都属于工具能力；不把所有请求强行交给 Codex。Jev 选择有限候选，生成模型负责开放式解释、
参数整理和复杂任务。代码仍掌握权限、生命周期和真实执行回执。

```text
原始用户输入 / 已接受的语音转录
       |
       +------------------------------> 原有 Omni / 文字执行链路
       |
       v
有界历史 + Agent 候选 + 注册工具目录
       |
       v
Jev 一次请求，四个独立 Choice
  意图 / 收件人 / 话题关系 / 第一个工具
       |
       +--> shadow：只记分类和耗时，不改变模型行为
       |
       +--> hint：执行模型准备请求时，仅取已就绪且仍有效的提示
                     |
                     v
          原话 + 原上下文 + 可忽略的提示
                     |
          主模型选择工具和参数 → 原有审批 → 执行 → 回执
```

这不是新的执行器，不覆盖用户原话，不伪造消息或 completed。没有额外串行等待。

## 首版实现

- `packages/host/src/intentHints.ts`：固定 `jev-1.13.0` 的 HTTP 适配和最新结果槽；无额外依赖。
- `packages/host/src/index.ts`：接受语音一轮时旁路启动；文字/语音工具 Fork 共用接点。
- `intentHints.test.ts`：默认关闭、超时、取消、串话、旧候选、目录变动、无匹配、低置信度、响应校验。
- `scripts/test-intent-hints-live.ts`：只发合成文本，不连接真实 Agent 或设备，不播放音频。

意图包括 delegate、inspect、cancel、phone、home、discuss、other。工具 Choice 直接来自
`GLOBAL_BRAIN_TOOLS`，不维护第二份工具名称目录。`continue_agent` 即现有 Agent 的工具入口；
`dispatch_agent` 是新任务入口。模型只能建议已注册工具，不能凭名称创造能力。

最多 24 个当前候选、6 条各 600 字符历史、4000 字符当前输入、32 项工具；不发送整个仓库、
Memory、终端全文、图片或音频。候选使用 agent_N 标签，返回后映射到 Host sessionId。
大于候选上限时可能漏掉真正目标，none/ambiguous 必须保留，不能把首选当唯一真相。

每个 Host 最多两个并发分类，最多 32 个结果槽，单请求 2.5 秒 deadline，不重试。
原话、会话 scope、候选、工具目录或有界历史变化时拒绝旧结果；结果最多保留使用 15 秒。
转录变化、挂断、断连、Global 新会话会使相应结果失效。失效结果永不追补到下一轮。
先验 0.8 confidence 只是提示门限，未经中文大样本校准，不是正确概率或执行许可。

### 实时链路边界

首版只在 **accepted turn** 发起，不对每个 ASR partial 请求一次。它不修改 VAD、不判断本人音色，
不决定用户是否说完。Omni 自主开始的响应不受阻塞；尚未把迟到提示通过 session.update 塞进正在
说话的 Omni，以免污染后一轮。hint 当前只供 Global 文字和 Voice Execution Fork 消费。
如果它准备请求时分类还没返回，本轮就没有提示；这是保延迟的明确取舍，不是完整的前置路由替换。

## 配置与隐私

Host 私有运行环境设置 `TYPESAFE_API_KEY`；`TB_INTENT_HINTS` 为：

| 值 | 行为 |
|---|---|
| off / 未设置 | 默认；不调用、不额外上传 |
| shadow | 外发上述有界上下文，记录判断；不注入 |
| hint | 同样调用，仅就绪且有效结果成为可忽略提示 |

无凭据仍走原链路。不要将 key 写进仓库、客户端或日志；启用意味着将有界对话上下文发送给
TypeSafe，而不只是原来的百炼。默认不自动启用、不擅自修改 LaunchAgent。
诊断沿用本机 voice-events.jsonl，仅 outcome、latencyMs、intent、confidence、inputUnits，
不记录原话、名称、prompt、凭据或上游错误正文。原工具日志仍是执行事实来源。
首版没有自动计算端到端错误委派率，也不把原模型选择当成真值；需要用户标注/授权回放。

## 手机管家与状态机：后续边界

借鉴用户给出的状态机方案，应由代码依据当前状态/权限给出可用事件，而不是把所有动作无限开放：

```text
照片整理
  待选图 --用户选择--> 已授权图片 --分类--> 分类预览
                                               |
                         取消 <---------------+--> 用户批准应用
                                                          |
                                                  执行 → 真实回执

提醒
  理解目标 → 缺参数则询问 → 审批策略校验 → 原生动作 → completed / failed
```

Jev 只能推荐当前状态下的合法事件。模型说“同意”不等于实际用户批准，低置信度不执行；
photo 分类预览不等于已移动/删除文件。当前批次只分类 phone，不实现相册扫描、分类/移动工作流。

Agent 能力也可沉淀为经审核的能力描述：稳定 capability ID、说明、输入 schema、权限、版本、
可取消性、验证用例；运行时再解析到当前 Host/Agent/任务 ID。不可长期缓存临时 pane ID，
不能让 Jev 高分绕过审批，也不能让生成的新脚本未经审核自动变成工具。

## 证据

第一轮仅意图/收件人/关系：12/12 中文合成用例符合预设，p50 326ms、p95 952ms。
加入实际注册工具目录后：12/12 意图/目标符合预设，前 10 个工具选择也符合预期；
p50 310ms、p95 752ms。包含否定、指代、双重同名、提醒、选图分类、日历、家居、取消。
重复一轮并对前 10 项工具名称增加硬断言后仍为 12/12，p50 331ms、p95 1120ms。
这是本机网络下的小规模合成冒烟，不是手机实测、中文泛化准确率、声学效果或已执行设备动作。

离线验证：新增 12 项测试通过；全项目 typecheck、Node unit（378 通过/1 跳过）、peer（34）、
home（18）、silent-call（4）通过，生产构建通过。`pnpm test` 在 voice-control 的
`voicePipeline.test.ts` 停止：4 项因 pending Promise 被取消，其余该组 50 项通过；这些用例
未在本批修改，因此全套测试不能声称全绿，后续 Cloudflare/integration 阶段未由该命令执行。

复现：`pnpm test:intent`；凭据已放入私有环境后 `pnpm test:intent-live`。
也支持测试脚本 `--key-file <私有文件>`；不要将真实凭据值作为命令行参数。

## 参考

- TypeSafe [HTTP API](https://docs.typesafe.ai/api)、[Choice](https://docs.typesafe.ai/primitives/choice)、
  [Function calling](https://docs.typesafe.ai/cookbooks/function_calling)：同一状态多问题，代码消费适用分支。
- [macbrow](https://github.com/timpratim/macbrow)：只读参考 registry/router 和安全边界，未安装运行。
  其 router 源码说明自由文本参数可能需要第二次请求；不能将宣传中的约 300ms 当完整任务耗时。
- 现有 ADR-0006、ADR-0010 及 `voiceTools.ts` 是实际权限、回执、UI 注册的权威实现。
