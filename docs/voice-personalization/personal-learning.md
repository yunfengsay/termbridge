# 从“记住样本”到真正可撤销的个人控制

2026-09-08 · 代码实现与公开数据验证 · 不替代真机全天候验收

## 这一版做到了什么

手机保留云端 ASR。新增的是控制学习，不是训练另一个语音识别大模型：

```text
手机 ASR 原文 + 上一句 + 六个控制特征
    │ 独立授权；最多 250 个片段、30 天；不保存 PCM
    ▼
设置 → 个人语音控制 → 回看短句、分别确认两个标签
    │ 是不是对助手说？这个停顿是否说完？不确定可撤销
    │ 只上传明确确认的样本，不上传全部观察记录
    ▼
现有加密 Peer → tb serve / Host
    │ 按设备隔离、版本去重、原子替换、后台 worker 训练
    ├─ 六特征校准：仍是 shadow，不能屏蔽声音
    ├─ TF-IDF 相似案例：最多四个交给云端轮次判断
    └─ 个人规则：同样表达 + 同样非空前文
          + 至少 3 个不同通话组一致确认
          + 没有相反标签
          → 只允许 wait / ignore，绝不直接批准执行
    ▼
当前通话即时读取新版本；不必为反馈重启 Host
    │ 新语境仍用云模型；新的明确问题优先
    ▼
唯一提交点 → Omni / Execution Fork → 受控工具与 Agent

撤销 / 删除 → 新版本 → 删除样本与旧参数 → revoked/completed 回执
                        └→ 离线时显示待同步，不能假装远端已删除
```

Host 每次收到已确认快照都会训练。`tb serve` 自带训练后端，无额外端口或独立鉴权服务。
训练在单独的 Node worker 执行，全局串行、单个 worker 8 秒上限；避免堵塞实时音频事件循环。
500 条上限、最多 20 个分组/100 条留组评估。规则不是神经 DDSD，不识别人声身份。

```sh
tb serve
tb voice learning status
tb voice learning status --json
```

CLI 只输出计数、模型版本、训练时间与评估，不显示短句或设备完整身份；它显示的是落盘训练状态，不能证明某个服务当前在线。
版本回执经过正常协议传输，未收到回执不算训练成功。Android 每个 Host 独立保存已确认 revision；断网保留待同步，重连后重试。新反馈到达时旧训练不能覆盖新版本。

## 为什么不只是塞进 Prompt

先做了“无例子 / 相关例子 / 无关例子 / 撤销”的对照。明确游戏语境下，换成无关例子也得到相同结论——那部分改善来自新 Prompt，而不是学习到个人习惯。

增加 `nice`、`好耶` 等指向不明确的工程样本后，单纯提示个人例子仍有 2/11 不符合预期。这个失败被保留，没有作为成功结果掩盖。因此加入上面的严格个人规则：三个不同通话的明确确认才生效，完全相同的表达与前文才命中；删除一个关键样本、出现相反标签或换了语境都会失效。命中后不必再次付费问轮次模型。

最终 11 组受控闭环全部通过，包括训练回执、真实云调用对照、规则实际生效、撤销后的上下文消失。这是**记忆/控制通路验收**，不是“个人意图识别准确率 100%”。测试里的三组数据是明确标出的人工编写 fixture，未写入用户的真实 Host 目录。

## 用什么公开数据测了什么

| 数据 | 实际使用 | 结果和边界 |
| --- | --- | --- |
| [Open Yap 1K](https://huggingface.co/datasets/TheAgenticDataCompany/open-yap-1k) | 公开 16 段、8 位说话人、8.922 小时的逐词时间戳；89,677 词 | 找到 3,468 个对方没有转录讲话的同人续说停顿，其中 25 个至少 3 秒、1 个至少 8 秒；25 个时序回放全部通过 |
| [KE-Team SemanticVAD](https://huggingface.co/datasets/KE-Team/SemanticVAD-Dataset) | 固定版本测试集 4,400 条中按内容 hash 预选 80 条（完成/未完各 40），只作测试 | `qwen3.8-flash` 与发布方标签一致 68/80；4 次超时、8 次标签分歧。不是人类盲评 |
| 自编个人场景 | 11 组，无例子/相关规则/无关例子/删除四路对照 | 最终闭环 11/11；不算独立泛化测试 |

Open Yap 是数据集，不是可直接装到手机的模型；公开部分 CC-BY-4.0。这里通过 HTTP Range 跳过 FLAC，仅取约 11.9 MB 元数据，未下载约 1.9 GB 的整个音频 tar，更没有播放声音。时间戳回放的 WAIT 判定是脚本控制，只证明拼接、一次提交和资源释放，不证明云模型能准确理解全部录音，也不是车内噪声测试。

SemanticVAD 发布页标为 Apache-2.0，标签经过 Qwen2.5-72B 校验；本批没有训练其测试集、没有分发原文/音频或使用其混合来源训练集。数据集标注的一些“未完”样本其实已经可以当完整口语问题使用，不能盲目追求满分去教坏控制器。

[TEN 的 LICENSE](https://github.com/TEN-framework/ten-turn-detection/blob/ea9a167ca9d656e590682d73ff87347869fc9dd6/LICENSE) 还有端侧部署等附加限制，不能只看到 Apache 字样就打包进 APP。本批未引入其权重或测试样本。

固定版本、文件校验和、原始失败计数和最终消融摘要见 [机器证据](qa/public-learning.json)。公开测试数据始终与个人训练集分开。

## 用户实际怎么用

1. 全局设置 → 个人语音控制。数值采集和“学习我的表达习惯”独立授权；默认不保存语音原文、不开启个人语境学习。
2. 开启语境学习后，通话片段会带短句及上一句，方便明确选择“对它说 / 不是”“说完 / 未完”。选不确定不会猜标签。无录音文件。
3. 标注后自动同步当前 Host。页面显示语境标签数、学会的规则数及训练耗时；在线正常时下一次判断即可读取。
4. 改标签或删除会完整重放训练，避免旧梯度残留。关闭语境授权会清除短句；关闭全部学习清除本地数据并同步撤销。其他曾用 Host 下次连接再同步。

Host 数据在 `~/.termbridge/voice-personalization-v1/<SHA256(peerId)>.json`，目录/文件权限 0700/0600；启动与每小时执行 30 天清理。手机在 `noBackupFilesDir/voice-control-v1.json`。不会备份个人数据。云端已经处理过的提示不能靠删除本机文件撤回，这一点不能做虚假保证。

## 仍然不能声称完成的部分

- 没有你的真实确认标签时是冷启动，不会把公开英语电话或模型自猜当成“你的习惯”。
- 个人规则能节省重复轮次检查；语义相似案例会增加一些提示 tokens，没有宣称总体账单降低多少。
- 唤醒词模式才是长时间待命的本地上传边界；自然通话仍是云端 ASR，这一版没有把连续通话伪装成零上传。
- 车内风噪、电视中的人声、本人音色、24 小时电量/流量都没有用本批文本与时间戳测试证明。
- 新代码通过工程自测不代表已经部署到你手机和运行中的 Host；必须另核对实际安装物和服务版本。

## 重跑

```sh
pnpm test
pnpm build
pnpm exec tsx scripts/voice-public-data.ts /tmp/tb-public-evaluation
pnpm exec tsx scripts/voice-personalization-eval.ts /tmp/tb-public-evaluation --live
pnpm exec tsx scripts/test-personal-learning-live.ts --live
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
```

`--live` 使用现有云模型配置，产生有限测试用量；不会调用麦克风、播放器或真实家电/Agent。Android `PersonalControlStoreTest` 在显式选择的模拟器运行，使用独立目录和 SharedPreferences，不改用户的数据与授权。协议解析另通过 iOS core 测试。

## 本批工程验证记录

- Node 类型检查、37 个语音/学习专项测试、全套单测和 30 个真实 Relay/Host 集成场景通过。一次复跑的两项服务启动失败是 `EADDRINUSE`，只读确认旧测试 Relay 占用端口；未终止那些进程。加入 `TB_TEST_PORT` 后在空闲的隔离端口重跑，保留最初失败日志。
- Android：223 个 JVM 单测，lint、debug APK 和 instrumentation APK 构建通过；隔离模拟器中的真实数据存储、撤销与重启测试通过。
- iOS：24 个 core 测试通过，包含 v2 协议兼容解析；不是 iPhone 真机验收。
- 打包的 `voice-learning-worker.js` 单独实跑：3 个已确认 fixture → 1 条个人规则，成功返回 JSON-safe 训练结果。`tb voice learning status --json` 实跑正常。
- 文章：96 个本地资源/链接检查、3 张图，1440/390/320 宽度、键盘、无 JavaScript 和打印模式通过；无外部请求、运行错误或页面水平溢出。
- 最终构建的 APK 尚未安装到三星，运行中的正式 Host 尚未被本批重启。没有提交、推送、发布或创建备份。
