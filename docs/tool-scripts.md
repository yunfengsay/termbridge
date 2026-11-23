# 可复用工具脚本

Global 可以把重复的工具步骤保存为一个工作流，再按名称、版本摘要和参数复用。
首版采用**声明式 JSON 工具步骤**，不是下载或执行模型生成的 Shell/JavaScript。
不新增照片整理功能，既有手机工具不删除。

```text
用户要求沉淀流程 → Agent/Global 生成 JSON → tool_script.save 草稿
                                              │
                          本机审阅 → tb script enable --digest … --reviewed
                                              │
新请求 → tool_script.list/show → 匹配参数 → tool_script.run
                                              │
                    原工具 Harness → 原权限检查 → 真实回执
                                              │
                      completed / pending / failed / cancelled / outcome_unknown
```

## 保存与启用

文件示例 `workspace-check.json`：

```json
{
  "formatVersion": 1,
  "id": "workspace-check",
  "version": 1,
  "description": "查看当前 Agent 状态和最近完成的任务",
  "inputs": {},
  "steps": [
    { "id": "status", "tool": "inspect_workspace", "arguments": { "view": "overview", "limit": 3 } },
    { "id": "recent", "tool": "inspect_workspace", "arguments": { "view": "recent", "limit": 3 } }
  ]
}
```

```sh
tb script check workspace-check.json
tb script save workspace-check.json
tb script show workspace-check
tb script enable workspace-check --digest <show返回的摘要> --reviewed
tb script list
tb script disable workspace-check
```

`check` 只验证结构和引用，不运行真实工具，也不代表业务验收。
Global 的 `tool_script` 动作只有 `list / show / save / run`，不能自批准。
list 每页 16 个摘要，使用返回的 nextOffset 继续查询；show 获取输入定义与完整步骤。
上述 CLI 操作的是**当前电脑本地**目录，不是 `-H` 指定的远程 Host；应在运行 Host 的机器上审阅。

存储位置默认 `~/.termbridge/tool-scripts/`；Host 与 CLI 可用相同的
`TB_TOOL_SCRIPTS_DIR` 覆盖。脚本和审批各一个 JSON，目录 0700、文件 0600。
只保留当前版本，不生成备份。每次 save 都撤销旧审批，文件内容改变也使旧摘要失效。
这是本机可信用户下的审核机制，**不是防止同一 Unix 用户恶意篡改的安全沙箱**。
脚本是普通文件，不应写入密钥、私有原文或过期的 Agent/图片句柄。

## 参数与结果引用

输入只支持 string / number / boolean，可选枚举；没有隐式类型转换：

```json
{
  "inputs": { "task": { "type": "string", "description": "本次独立任务" } },
  "steps": [
    { "id": "delegate", "tool": "dispatch_agent", "arguments": { "agent": "codex", "task": { "$input": "task" } } }
  ]
}
```

上面是参数片段，完整文件还需 formatVersion/id/version/description。
`{"$result":"earlier_step","path":["field",0]}` 可以读取之前**已完成**步骤的结果字段。
引用替换整个值，不使用表达式求值或字符串插值。缺失字段、向前引用、原型访问、未知输入均拒绝。
`continue_agent.sessionId` 必须来自本次输入或前一步结果，不能把旧 Pane ID 固化到脚本。

## 工具与权限

允许 inspect_workspace、workspace_files、search_web、inspect_images、continue_agent、
dispatch_agent、phone_action、home_assistant；禁止脚本递归、Shell、任意代码、循环和动态工具名。
家庭工具只允许静态声明的只读 inventory/states/state。
设备审批仍由原 phone_action 通道执行，启用脚本**不等于**授权手机动作。
Agent 委派仍只调用配置好的执行入口；执行 Worker 的权限与风险没有被脚本机制降低。

最多 12 步、16 个输入、64 KB 脚本、4 个并发运行。中间结果/回执共用有界预算；
超大结果停止后续步骤并标明省略，不截断 JSON。跨工具 BigInt 结果转换成字符串。
Global 工具进度可看到每个底层工具，最终结果以既有 receipt 卡片进入 timeline。

## 停止与失败语义

- 任何失败/拒绝：停止后续步骤，不自动重试，不回滚已经产生的效果。
- awaiting_user / dispatched / sent 等：返回 `pending`，保留 actionId/taskId 等原回执，
  **不会等同工作完成**；首版不自动续跑余下步骤。依赖异步任务结果的流程应分开沉淀。
- 每次执行 ID 为 `script-` 加调用键 SHA-256 的前 24 个十六进制字符；
  `tool_script.list` 的 activeRunIds 可查询，`cancel_execution(id)` 可停止继续编排。
- 取消是协作式：先返回 cancelling，当前工具返回后再给 cancelled；已经发出的手机动作和
  Worker 必须使用它们各自的 actionId/taskId 取消，不能声称撤销已发生的动作。
- 不提供跨 Host 重启的任务恢复、事务回滚或跨请求去重。不要重放部分成功的修改流程。
- 工具超时由现有工具适配器负责；脚本层不把一个无法确认的副作用虚报为成功。

## 验证

`pnpm test:tool-scripts` 覆盖持久化、摘要审批、修改失效、输入类型、引用、原型键、
大小上限、CLI、真实共享 Harness 的模拟执行、设备拒绝传递、pending、BigInt 和中途取消。
这些是隔离测试，不代表云端模型自主选中率、手机真机动作或部署 Host 验收。

实现：`packages/tool-scripts/`；Host 集成 `packages/host/src/toolScripts.ts`、`voiceTools.ts`、
`index.ts`；CLI `packages/cli/src/toolScripts.ts`。无需新增客户端协议或下载脚本到手机。
