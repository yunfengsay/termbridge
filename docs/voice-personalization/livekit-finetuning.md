# LiveKit 全参数与 LoRA：工程跑通，首轮候选不启用

2026-09-08。代码位于 [`training/livekit-turn`](../../training/livekit-turn/README.md)，
原始汇总数据见 [QA JSON](qa/livekit-finetuning.json)。未提交、推送、重启 Host 或安装 APK。

后续同日已新增 [LoRA / 全参 Host 训练流水线](livekit-pipeline.md)。本文保留首轮实验记录；
文末“尚未集成调度”是该实验结束时的状态，后续代码已补齐，但未启用部署服务或候选模型。

## 这次训练的究竟是什么

采用 [LiveKit 官方多语言文本检查点](https://huggingface.co/livekit/turn-detector/tree/v0.4.1-intl)，
commit `87e35fcb1e60a569bea70346191c4886ea92e281`，不是 HF `main` 上的另一套权重。
实际是裁剪的 **Qwen2ForCausalLM，258,692,992 参数，约 0.259B**：24 层、hidden 896、
MLP 1216、14 attention heads / 2 KV heads、词表 151936、共享 embedding/output。

它只估计当前上下文的结束概率：下一 token 是否为 `<|im_end|>`。不会替换云端 ASR，
不会纠正转录，也不负责声纹、风噪或“是不是在对我说话”的 DDSD。
原版和派生模型都通过 LiveKit Agents 的 EOUModelBase/ChatContext 使用，保留官方
最近 6 条历史、去标点、相邻同角色合并和 128 token 左截断；不训练新的聊天助手。

[模型许可](https://huggingface.co/livekit/turn-detector/blob/v0.4.1-intl/LICENSE)要求与
LiveKit Agents 一起使用，派生权重继续受约束。代码已提供真实 AgentSession 接点，
没有把“非商业”解释成可以忽略限制。只用 safetensors，不加载 pickle/remote code。
当前插件 1.8.0 已将文本插件标记 deprecated；固定版本是为了这批公开可训练权重，
不能把它包装成较新的音频 TurnDetector 性能。

## 真实训练记录

两组都从同一官方权重开始、相同 seed/输入顺序；KE 公共 fit 4,731 条可用，
这次各 **128 optimizer steps × batch 2 = 256 条，约 0.054 epoch**。
这是有界对比，**不是完整语料收敛，更不是已经学会用户习惯**。

| 项目 | 全参数 | LoRA |
| --- | ---: | ---: |
| 可训练参数 | 258,692,992 | 2,297,856 |
| 更新范围 | 全部 290 个参数 tensor | 336 个适配 tensor，基座冻结 |
| 配方 | AdamW，lr 1e-5 | r=8 / alpha=16，lr 1e-4 |
| 投影层 | 全部模型参数 | q/k/v/o + gate/up/down |
| 实测训练耗时 | 61.1 秒 | 23.8 秒 |
| 训练平均 binary loss | 0.1808 | 0.1791 |
| 制品大小 | 1,034,804,016 bytes | 9,234,808 bytes（另需基座） |
| 观察到的 MPS tensor 峰值 | 4.34 GB | 1.34 GB |
| 观察到的 MPS driver 峰值 | 6.43 GB | 1.61 GB |
| 进程峰值 RSS | 2.19 GB | 2.07 GB |

Mac mini，32 GiB 统一内存，PyTorch MPS FP32。RSS 与 driver/tensor allocation
不能相加当物理内存；driver 数字包含缓存/驱动分配。第一个变长 batch 实验的 driver
记录达 38.8 GB，已修正为固定 padding=128 + 0.6 内存份额，两个正式候选统一重跑。
相同 attention mask/position IDs 保持输入语义，没有为了省内存删掉历史。

## 对照结果：不能只看准确率

开发集按语言/标签分层固定抽取 128 条：中英各 64、完成/未完各 64。
该公开数据前轮已使用；本轮仍严格不做梯度更新，但它**不是新的独立盲测**。
以下统一用 0.5 阈值作诊断，**不是官方默认阈值，也不是生产建议**：

| 模型 | 准确率 | 未完却接话 / 64 | 已完却等待 / 64 | AUC |
| --- | ---: | ---: | ---: | ---: |
| 原始 safetensors FP32 | 90.63% | 1 | 11 | 0.9871 |
| 全参数 128 步 | 93.75% | 7 | 1 | 0.9631 |
| LoRA 128 步 | 92.19% | 6 | 4 | 0.9646 |

**虽然总准确率提高，两种微调都增加了抢话，概率排序与 binary loss 也变差。**
这批配方没有证明优于基座，不启用；不能用“loss 下降”“能够跑训练”替代用户体验。
在同一 dev 上重新校准到零抢话，全参会误等 21/64，LoRA 误等 23/64，原版误等
17/64；这仍是偏乐观的同集校准，不是准入依据。下一轮需要改进训练数据/正则化/
配方，并保留真正未调参的中文长停顿人工集，而不是反复刷旧 KE/Easy Turn check。

官方 INT8 ONNX 也实际测了：AUC 0.9832；同一 0.5 阈值下误等 31/64。
两个官方制品的分数分布并不相同，不能把 FP32 或 LoRA 的阈值直接移到 INT8。
使用官方 zh=0.0066/en=0.011 时，这批 dev 的 INT8 提前接话为 15/64；这是特定
开发数据上的结果，不是宣称 LiveKit 在真实通话中有同样的错误率。
插件接入派生模型时强制显式阈值，防止概率校准悄悄失效。

CPU 单样本预热后 P95：原 FP32 161ms、原 INT8 122ms、全参 112ms、LoRA 85ms。
测量时有其他本机任务，数据长度不同，**不能据此宣称 LoRA 比基座计算更快**。
这些说明本机可运行，不是空闲机器严格 benchmark 或手机性能测试。

## 验证证据与安全边界

- 新增 Python 测试 **16/16**：真实 LiveKit AgentSession 接收组件、官方格式/历史、
  标签不入特征、分层确定性、完整/LoRA 更新范围、冻结基座不变、padding 一致、
  保存恢复、极端概率梯度、不可校准模型拒绝、取消清理。
- **真实 0.259B 权重**保存恢复误差：全参 `8.03e-9`，LoRA `2.98e-7`。
  推理开始后取消，子进程被回收，重建后同一请求又成功；不是 mock Promise。
- 真实 LoRA 在第一个 optimizer step 后收到 SIGTERM，结果 `cancelled`、退出码 130，
  进程回收。训练有 deadline，未完成制品不可加载。
- `ruff check`、Python compile、`pnpm test`、`pnpm build` 通过；Node 主 unit
  264 pass / 1 skip，voice-control 45 pass，集成 30 场景 pass，其余测试套件也通过。
- 没有播放声音、打开麦克风、读取私人会话、调用付费教师或改动手机/Host 配置。

Android、iOS 与 Relay 协议未修改；没有为纯 Python 训练改动重装手机。
现有 `tb serve` 的个人规则 worker 仍是原实现，**尚未把大模型微调自动挂到后台**。
本批交付的是完整/LoRA 的可执行训练、LiveKit 组件、回执/中断/比较工具和证据；
上线仍缺新盲测通过、受控 Host 调度集成和真实通话验收。
