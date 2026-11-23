# Global / Voice 图片理解

## 已定位的断点

Android 已有图片选择、一次性 MediaProjection 截屏、私有附件存储和加密 Peer 读取。
`brain_voice_start` / `brain_voice_image_attachment` 传输的是附件元数据，不是像素。
此前 Host 只更新附件 Map，Voice 不知道选图变化；Execution Fork 的提示词又要求把所有识图都派给 Worker，没有直接识图工具。因此不能从文件名判断图片内容，也不能把这个问题简单归因于缺少相册权限。

## 链路

1. 用户在 Global / Call 附件入口选图，或在悬浮入口明确同意一次性截屏。
2. 手机通过现有协议发送 actionId、deviceId、assetId、MIME、大小、SHA-256。
3. 千问实时会话通过 `session.update` 被动替换当前附件上下文；选图本身不会建立用户消息、调用 `response.create` 或触发朗读。通话初始附件也走这一入口。其他 Voice provider 保留共享的“视觉问题必须进入 fork_execution”路由提示，Fork 每次读取 Host 当前附件；不对未经验证的厂商会话更新 API 作兼容承诺。
4. Global 文字和 Voice Execution Fork 共用 `inspect_images(question, assetIds?)`。
5. Host 从本次附件白名单决定 device/action/asset，调用 `phone.asset.read`。复用 CLI 的 P-256 ECDH / HKDF / AES-GCM，按 96 KiB 分块，校验偏移、大小与 SHA-256。
6. Host 把实际图像以 `image_url` data URI 送入百炼视觉模型，返回文字识别结果。工具进度、结果卡片和 History 复用已有注册体系；Voice 再按当前语音/静音设置输出答案。
7. 修图仍通过 `dispatch_agent` 委派，Worker 复用原有精确图片拉取和批量发布命令。

## 配置与边界

- Host 使用现有 `DASHSCOPE_API_KEY`、`DASHSCOPE_BASE_URL`；可选 `TB_VISION_MODEL`，默认 `qwen-vl-plus`。凭据在清理 Worker 子进程环境前捕获，不下发客户端。
- 单次最多 3 张 JPEG / PNG / WebP，每张最多 8 MiB。超限或不支持的格式明确失败，不能猜图。当前不自动压缩或转换。
- 分块协议允许安全的 number/string/BigInt 整数，拒绝失真的整数；工具结果不带 BigInt、图片字节或 data URI。
- 图片只在 Host 内存中处理，不写临时图片文件或像素日志。识图意味着用户所选内容会发送至百炼，不是端侧推理，也不声称云端零留存。
- 开始、每次分块前后、模型调用前后检查当前会话/附件。换图、撤销、挂断或 Global 会话重置后的旧结果不可回流。已发往云端的请求无法“撤回已上传字节”。
- 使用 35 秒操作 deadline，Peer 单次读取最长 15 秒，模型 HTTP 使用 AbortSignal。未返回的 Peer 请求最多等当前读取超时，不声称原生读取可立即取消。
- 失败不自动重复上传；用户可重新连接、选择或明确重试。
- `inspect_images` 的 approval=none 仅意味着复用本轮已经主动附加的图片授权，不代表相册全量授权。没有任意 URL/path 参数，不能通过工具去抓取其他媒体。
- 图片里的文字是非可信内容，不作为指令、脚本或扩大权限的依据。
- 不新增 Android 权限。悬浮窗授权不是截图授权；MediaProjection 仍需系统确认，受保护画面可能无法捕获。Photo Picker 不等于 READ_MEDIA_IMAGES 全库权限。

## 实现与验证

- Host：`packages/host/src/imageInspection.ts`、`brainImageAttachments.ts`、`voiceTools.ts`、`voicePrompt.ts`、`index.ts`。
- 千问被动上下文：`packages/voice/src/omni-realtime.ts`。
- 共用加密实现：`packages/settings/src/artifactCrypto.ts`；原 CLI `androidArtifact.ts` 保留原有导出，避免 Host 依赖 CLI。
- 回归：`imageInspection.test.ts` 覆盖加密读取到模型输入、结果 JSON-safe、无附件/越权 ID/撤销/超限/完整性错误、厂商错误脱敏；工具注册和被动更新分别有测试。
- `scripts/test.ts` 的 19b 场景覆盖真实 Relay/Host/Execution Fork + 模拟加密手机 + 模拟视觉 API，验证结果卡片落入 History、像素不落入 History、简单识图不派发 Worker。所有测试 Host 使用隔离 socket，不覆盖部署服务。
- `pnpm exec tsx scripts/test-image-inspection.ts` 是显式调用真实百炼的测试：程序生成红/蓝 PNG → 模拟加密 Phone Peer → 实际 qwen-vl-plus，断言返回红、蓝。不会读取私人照片。
- 2026-09-05 该探针返回 completed，正确识别左右红蓝，单次 674 ms。仅说明小型合成图的真实云端链路成功；不等于真实手机选图、截屏、语音朗读或大图性能验收。
- 本改动无 Android wire schema 变化，已有附件协议可复用；需要运行新 Host 才会启用新工具。

## 手机验收清单（尚待实际交互）

1. 已选图后开始通话，说“这是什么”，得到与图像一致的回答和识图卡片。
2. 通话中换图，再问相同问题，不能沿用上一张图的答案。
3. 撤销附件后再问，提示选图而非虚构内容；挂断中途识图不应继续朗读。
4. 悬浮状态明确截取当前页面，询问截图中的文字/代码。
5. 要求修图则派给 Worker，并等待真实发布回执，不把识图完成当成修图完成。

## 参考

- [百炼视觉理解与 Base64 图片输入](https://help.aliyun.com/zh/model-studio/vision/)
- [百炼实时会话客户端事件](https://help.aliyun.com/zh/model-studio/client-events)
- 本机百炼知识库参考：`raw/model-api-reference/qwen-api-reference.md`、`models/groups/qwen-vl-plus.json`（bailian-docs-llm-wiki）。
