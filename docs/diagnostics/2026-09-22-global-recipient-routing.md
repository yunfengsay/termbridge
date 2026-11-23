# Global 收件人归属与执行模型修复

## 结论与证据

2026-09-22 只读检查本机 Global History、Agent 消息索引和语音事件日志。没有修改历史、发送真实 Agent 指令或读取/输出密钥。

- 9 月 21 日 22:02（UTC+8），消息索引已经保存了用户发给 Canvas Agent 的原文、名称、稳定 session ID 和时间。
- 22:03 用户问“我刚才发了个任务，那个任务内容是啥”，Global 却把那条消息解释成用户要求 Global 自己不要提问。
- 用户纠正收件人后，Global 声称重新查询并已转发；对应时间段没有查记录或转发的工具回执。
- 该段会话实际使用 `qwen3.5-omni-flash-realtime`，不是 Max 执行模型。没有进入执行 Fork，所以仅替换后台模型不能修复这次误解。

本机证据源为 `~/.termbridge/brain.json`、`context.json` 和 `logs/voice-events.jsonl`；这些私有文件不纳入仓库。

## 原因与改动

1. **检索排名被用成收件人判断。** 旧上下文指令允许优先按活跃/高排名 Agent 解析指代。改为明确收件人和带地址的消息记录优先；排名、页面来源、同名不能授权选择对象。
2. **有记录但没有可调用的查询入口。** `inspect_workspace(view="messages", target?, limit?)` 现在返回只读原文、收件人、时间和来源，不会重新派发。覆盖范围仅为已捕获的用户直接发给 Agent 的消息；Global 新建任务仍查 `tasks`。记录缺失表示未知，不代表没有发送。
3. **引用、历史询问、纠正和执行混为一谈。** 共享 Prompt 区分“问助手”“让助手转告 A”“查询之前发了什么”“纠正之前归属”。引用中的命令不作为 Global 的新指令或长期偏好；纠正本身不授权重发。
4. **工具执行成功被误解为发送成功。** Fork 向 Omni 单独提供 `agentDeliveries`，从本轮实际 `continue_agent` / `dispatch_agent` 工具输出提取，不能从模型答复或旧 History 生成。历史查询回执不算新发送回执；queued/failed/unknown 不宣称送达。历史回答显式使用“记录里，你当时发给……”的表述。
5. **重复注入旧模型判断。** 执行 Fork 已有标准 user/assistant 历史，不再同时把同一段历史嵌入 Host 权威上下文，避免放大之前错误的归属结论。旧历史保留，不伪造或删除证据。

关键模块：`contextIndex.ts`、`voiceTools.ts`、`voicePrompt.ts`、`voiceDelivery.ts` 和 Host `index.ts`。

## 模型配置

共享默认值位于 `packages/brain/src/models.ts`：`deepseek-v4.1-flash`。普通 Global 文字、文字静音执行、语音 Fork 和规划器使用该默认值，关闭思考；显式 Host 环境变量覆盖保留。官方接口名称见[百炼 DeepSeek 文档](https://help.aliyun.com/zh/model-studio/deepseek-v4-1-flash)。

实时 Omni、ASR、停顿判断、图片预解析和独立网页搜索模型不在这次切换范围内。

## 对照验证

真实百炼接口，合成对话；工具处理器全部是 fixture，不会发出真实任务。每组仅 6 条，属于小规模回归，不是总体准确率评测。

| 配置 | 原始 6 条路由断言 |
|---|---:|
| 旧默认 Qwen Flash + 旧 Prompt/工具 | 4/6 |
| 仅替换 DeepSeek + 旧 Prompt/工具 | 4/6 |
| DeepSeek + 收件人策略/消息查询 | 6/6 |

真实 Omni → DeepSeek 的追加回放发现：查询路径正确时，Omni 仍可能说“好的，发给 A 了”。因此补上结构化发送回执，并加严历史时态断言。最终该链路 6/6 通过，两条历史查询都实际调用 `inspect_workspace(messages)`；纠正和直接对助手说话都没有派发；两条明确转告都只发给指定 fixture Agent。端到端合成文本回放约 0.9–5.2 秒，其中工具查询/派发约 4.4–5.2 秒。

复现入口：

```sh
pnpm exec tsx scripts/test-global-recipient-live.ts --live
pnpm exec tsx scripts/test-global-recipient-live.ts --live --omni
pnpm test
pnpm build
```

需要调用者本地配置 `DASHSCOPE_API_KEY`，脚本不输出密钥。`--omni` 使用真实 realtime 连接注入合成文字，不采麦克风、不播放声音；它不验证 ASR、扬声器、真实手机交互或自然语音延迟。

最终验证：加严历史时态断言后，DeepSeek 文字与 Omni → DeepSeek 各 6/6 通过；`pnpm test` 通过（包含 typecheck、单元测试、Worker 测试及 31 个集成场景），`pnpm build` 通过。独立聚焦运行的 43 条上下文、Prompt、消息查询、回执和静音模型测试全部通过。临时日志在本机 `/tmp/tb-recipient-{text-final,omni-final,all-final,build-final}.log`，不作为线上部署证据。

## 交付边界

本次修改在 Host 侧，不改变客户端协议，无需仅为该修复重装 APK。运行中的 Host 必须更新/重启才能生效。本轮未重启服务、未安装设备、未提交推送。Prompt 与结构化回执降低混淆风险，但不是消息派发正确性的形式化保证；后续应持续增加真实误路由的脱敏回放用例。
