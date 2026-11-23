# 开源数据训练闭环：有结果，也有明确拒绝

2026-09-08 · 以[预注册目标](open-training-plan.md)为门槛，
[聚合实验结果](qa/open-training.json)为证据。**没有部署到正在使用的 Host 或手机。**

## 结论

已经实际训练，而非只拿公共例子问一次云模型：6 种权重配置，3 次拟合/校准循环（18 次确定性 CPU 拟合，重复权重哈希一致），
两轮独立 check。训练权重 32,768 个 float32（128 KiB），JSON 制品约 799 KiB。
它是字词/句尾/上下文特征的逻辑回归控制器，不是 ASR、声纹模型、DDSD 或大语言模型。

**两次 check 都拒绝启用。主要缺陷不是抢答，而是把已完整的口语继续判成“没说完”。**
这会重现“我已经问完了，它还在等”的体验。没有用调松门槛或重测同一份测试集掩盖问题。

| 独立 check | 样本 | 本地覆盖 | 提前抢答 / 未完 | 错误等待 / 完整 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| SemanticVAD，已排除上轮看过的样本 | 2,045 | 60.88% | 1/1002，0.10% | 109/1043，10.45% | rejected |
| Easy Turn，重新找的独立人工标注集 | 600 | 31.33% | 0/300 | 19/300，6.33% | rejected |

门槛要求错误等待 ≤5%；第二轮本地 WAIT 的 136 条里也有 19 条不该等（13.97%），
超过 WAIT 错误率 ≤5% 的另一项约束。零抢答不是“保证不抢答”：第二轮仅有 52 条
本地 RESPOND，错误比例的 95% Wilson 上界仍为 6.88%。

**不可把两份不同测试集的 10.45% → 6.33% 当作同口径改进量。**
Easy Turn 真实录音来源文本的错误等待为 14/150，合成来源为 5/150。
没有播放/重采音频，这只是文本标注验证，不是实车噪声或 ASR 验收。

## 数据到底怎么用了

1. [SemanticVAD](https://huggingface.co/datasets/KE-Team/SemanticVAD-Dataset)：
   发布者 Apache-2.0，取 Ke 合成来源 6,000 条完成/未完文本。
   剔除与测试重叠组和重复后，4,731 条用于梯度训练，1,056 条用于开发/门限校准。
   不使用 RAMC/CANDOR 实录类别，不下载音频。标签是发布者经模型辅助修正的标签。
2. Round 1 的测试已被揭盲，**永久降级为 Round 2 calibration**，不再算盲测；
   Round 2 梯度训练仍是原 4,731 条，校准为 3,101 条。
3. [Easy Turn](https://huggingface.co/datasets/ASLP-lab/Easy-Turn-Testset)：
   发布者 Apache-2.0、人工标注，只下载两份转录 `.list`，共 600 条中文；
   去掉文本内 `<COMPLETE>/<INCOMPLETE>` 答案标签。与 fit/calibration 分组检查无重叠。
4. Open Yap 仍只提供长停顿/续说时序证据；没有个人指向标签，未用于这个分类器拟合。

严格去掉 system/任务模板/VAD 答案/source/标点等捷径。模型不接收数据集语言标签；
第二轮中英文门限由输入中的汉字检测路由。代码混合语言场景仍需单独验收。
训练/开发/测试按重复文本、相同历史和长前缀连通组隔离；不能保证不存在语义转述泄漏。

## Loop 真正改变了什么

```text
冻结数据/门槛 → 6 个候选拟合 → dev 选型 → 独立 check 1
                                                │
                                        误等超标：拒绝
                                                ↓
旧 test 降为校准 → 加无历史/语言检查 → 6 个候选
                                                │
                                 共用阈值覆盖不足：不读新 test
                                                ↓
         按语言分别校准 → 6 个候选 → 独立 check 2 → 拒绝启用
```

- 只用正文，Round 1 dev 覆盖率约 21%；加入句尾达到约 46–49%。
- 简单多训到 20 epochs 没有稳定收益；最佳候选仍为 context-8。
- KE test **没有历史上下文**，无上下文消融自然没有区别，不能据此说 History 无用。
- 标点基线在 KE test 有 98.97% 标签一致率，在 Easy Turn 仅 70.33%。
  说明单看一个数据集高分会严重误导产品判断；生产 ASR 的 final/句号不能代替用户说完。
- 共同门限被英文分布和不足的本地决策样本拖累；分层门限解决校准问题，
  但没有补足这个极小统计模型对口语省略的语义理解能力。

## 工程交付与用法

当前 `tb serve` 的私人反馈训练后台不变：手机明确授权并确认标签后，独立 worker
重训个人层，revision 回执/撤销/TTL 生效。本次公共实验**不写那个私人样本库**。
新增本机实验命令，使用同样的隔离 worker 模式，但它不是生产 Host 内的自动公共训练任务：

本批未更新全局安装的 CLI；在当前仓库先 `pnpm build`，以下命令的 `tb` 用
`node dist/cli.js` 代替。环境没有 `paseo` 命令，本次是已经执行完的有限实验循环，
**没有谎称另有一个常驻训练 Agent 在运行**。

```sh
# 事先按预注册文档的固定 revision 下载两个 KE JSON。
tb voice learning experiment prepare /tmp/my-turn-run \
  --train-file /path/trainset_15000.json --test-file /path/testset_4400.json
tb voice learning experiment train /tmp/my-turn-run
tb voice learning experiment check /tmp/my-turn-run
# 循环的重复 verifier 读已有回执，不再次推理测试集；未达标退出码 2。
tb voice learning experiment verify /tmp/my-turn-run

# 第一轮失败后，使用新的独立 Easy Turn 测试集。
tb voice learning experiment prepare-second /tmp/my-turn-round2 \
  --previous /tmp/my-turn-run \
  --train-file /path/complete_test.list --test-file /path/incomplete_real_test.list
tb voice learning experiment train /tmp/my-turn-round2
tb voice learning experiment check /tmp/my-turn-round2
```

每项开始即返回 `voice-train:<UUID>`，有 `running/completed/failed/cancelled/timed-out`
任务状态文件。Ctrl+C/SIGTERM 终止 worker 后写 cancelled；120 秒截止。
任务 completed 只表示训练/评测执行完成，模型是否通过看 check.status。
check 拒绝退出码 2；错误/重复执行退出码 1；手动取消 130。
同一实验不能覆盖训练，也不能第二次消费 holdout。跨目录复制仍需要操作者遵守
测试集已消费的谱系约束；文件标记不是防作弊安全边界。

实验文件只在显式输出目录，0600；不自动加载模型，不发布公共数据，不替换 live Host，
不访问麦克风/播放器、付费教师或真实设备工具。耗时、机器信息、制品哈希见 JSON；
128 KiB 是权重，不是训练进程内存。第一轮进程 RSS 约 466 MiB。
Mac CPU 预热推理 P95 约 0.02 ms，不含 I/O/worker 启动，不代表 Android 实测。

### 代码验证

- `TB_TEST_PORT=31200 pnpm test`：全套通过，含 30 个集成场景；普通 unit 中一个既有场景 skipped。
- 最终 `pnpm test:voice-control`：45/45 通过，涵盖真实 worker 在首个拟合候选后取消、
  cancelled 终态、无数据内容泄漏、缺失 holdout 时仍可训练、禁止重复 check、可重复 verify。
- 最终 `pnpm typecheck`、`pnpm build`、`git diff --check` 通过。
- 构建后的 CLI `experiment verify` 对拒绝候选返回退出码 2；重复 `check` 被保护拒绝。
- 文章链接检查通过：97 个链接、3 张既有图。没有本批 Android 代码变更或装机宣称。

关键模块：`turnTextModel.ts`（参数拟合/评分）、`turnTrainingData.ts`（标签去泄漏/分组），
`turnTrainingMetrics.ts`（安全门槛/校准），`turnTraining.ts`（有限循环/封存/check），
`turnTrainingWorker.ts` 与 CLI `voiceTraining.ts`（后台隔离/取消/回执）。

## 后续必须补的，而不是再刷同一个测试集

目前不能声称“已越来越懂你”。需要基于本人主动确认的短上下文样本，
覆盖停顿补词、口语省略、改口与旁人对话；公开语料只能启动通用层。
下一种候选需要真正的上下文语义表示，而不只是把 History 的字词混进袋模型。
WAIT 在产品里也只能暂缓，不能成为无上限的阻塞；是否启用必须通过新留出集与
真实通话影子记录。保留既有云端 judge 和原文轮次账本，不让本轮失败候选影响用户。
