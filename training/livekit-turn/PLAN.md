# LiveKit 全参数 / LoRA：训练前冻结的实验约定

2026-09-08。用户批准采用 LiveKit 并做全参数与 LoRA 微调。本目录不替换在线 Host。

## 基座与职责

- `livekit/turn-detector`，官方 multilingual `v0.4.1-intl`，commit
  `87e35fcb1e60a569bea70346191c4886ea92e281`，Qwen2ForCausalLM 裁剪架构。
- 仅 safetensors；禁用 remote code，不下载/加载 optimizer.pt、training_args.bin。
- 复用 LiveKit Agents 的 EOUModelBase、ChatContext、原插件格式化方法：最近 6 条
  user/assistant，NFKC/去标点，合并相邻同角色，去最后 im_end，左截断 128 token。
- 输出下一 token 为 `<|im_end|>` 的概率。训练 binary EOU loss，而不是教它生成
  “完成”两个字，更不修改 ASR 内容。本模型不能判断说话者身份或授权工具。
- 三组：原版 FP32（另测官方 INT8 ONNX 的量化差异）；全参数 AdamW；LoRA r=8，
  alpha=16，dropout=0，q/k/v/o/gate/up/down projections。LoRA 冻结基座和 embedding。
- 两种训练使用同一输入顺序、batch=2、max-length=128、seed=20260908、clip=1。
  全参 lr=1e-5，LoRA lr=1e-4。先各 2 步验证，再各 128 步有界实验；不把它叫收敛。
  完整 epoch 可复用命令增加 steps，但这次不循环试探最终数据刷分。

## 数据和比较

- 使用前轮已固定的 KE train/dev 分组清单，从原始 Alpaca 恢复真实角色序列。
  不把指令、system、完成标签、source/lang 字段放入输入。私有手机样本完全不读取。
- 训练只读 fit。开发集确定性分层抽取 128 条（各中英、完成/未完尽量均衡），
  三组完全相同。这里只做诊断，不用它宣称盲测通过。
- KE final / Easy Turn 600 已在前轮揭盲，永远标记 consumed diagnostic，不能再次
  宣称独立 check。扩大训练后，产品接受必须有新的、未调参的人工长停顿数据。
- 指标：binary loss、ROC-AUC、提前回答/错误等待、按语言分层、官方门限与 dev
  校准门限分开报告、CPU/MPS、P50/P95、训练时间、峰值 RSS、权重体积与可训练数。
- 暂不自动启用任何候选。原型工程门槛是权重真实更新、有限 loss、保存恢复一致、
  标签隔离、LiveKit 接口可调用、可取消；这些不是用户体验验收。
- 产品质量准入继续要求提前回答和回应错误比例 ≤2%，错误等待和 wait 错误比例
  ≤5%，覆盖率 ≥30%，方向支持 ≥50；还需真实中文停顿和低基率环境误触发测试。
  原散列小模型的 2 MiB / 10 ms 限制不适用这个 Transformer；新 Host 资源目标
  为权重 ≤1.2 GiB、预热单次 CPU P95 ≤500 ms、空闲不推理。目标不等于实测。

## 生命周期和许可

训练进程有 wall-clock 截止、SIGINT/SIGTERM → cancelled 回执。模型/数据留在
gitignored artifacts 或显式外部目录；只提交汇总统计，不提交权重/原文。
每次输出独立目录，保留基座 SHA、recipe、数据 SHA 与更新证据，不覆盖旧实验。
派生权重仅供 LiveKit Agents 使用，携带原 LICENSE。不是把模型导入后绕开框架，
也不将其输出用来训练非 LiveKit 模型。不自动升级服务、安装 APK 或上传数据。

官方依据：

- https://huggingface.co/livekit/turn-detector/tree/v0.4.1-intl
- https://huggingface.co/livekit/turn-detector/blob/v0.4.1-intl/LICENSE
- https://github.com/livekit/agents/tree/main/livekit-plugins/livekit-plugins-turn-detector

官方文档另有较新的音频 TurnDetector；本实验明确是**公开可训练文本检查点**，
不能把本实验结果写成新音频模型、ASR 或声纹抗噪性能。

## 工程修正（首次 full-128 后，未查看该候选的 dev 分数）

首次变长 batch 训练时，Apple MPS driver 报告的分配峰值达到约 38.8 GB（不等同
物理常驻 RAM），明显不适合共享 Mac。改为固定 padding=128，仍使用 attention mask
和正确 position IDs，语义输入不变；训练顺序/种子/loss/lr/步数不变。MPS 增加 0.6
per-process memory fraction，防止耗尽主机。两个模式统一重跑 `*-128-fixed`；
旧结果保留为资源反例，不作为正式对比候选，也不拿 dev 分数选择 padding 策略。
