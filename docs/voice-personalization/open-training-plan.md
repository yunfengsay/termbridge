# 开源轮次控制训练：预注册目标与循环

2026-09-08，在首次训练前冻结。不是部署许可，也不是 DDSD/声纹验收。

## 目标

云端 ASR 不变。用开源文本训练一个 Host CPU 上可运行的轻量“完成/未完”估计器，
不确定时交给既有云端 judge。公开基座与用户主动确认的个人样本分库，绝不伪装成人工反馈。
通用模型不能授权工具、改写 ASR、认定说话者身份或自动忽略旁人。

## 数据与隔离

- KE-Team/SemanticVAD-Dataset，固定 revision `b5b536e96076a156e79b7e6db9ca8fd100d3f976`。
  发布者标注 Apache-2.0。仅使用 `Ke-多轮/Ke-EN` 的完成/未完合成文本，预期 6,000 条。
  不使用 RAMC/CANDOR 实录类别；不下载音频、不分发数据集或预训练第三方权重。
- 训练文件 SHA256 `c43efde49c8a2d632095bc0e7dcd47080a5f0ea198d34a7c3b24a117cfc0eb3d`。
- 训练文件按对话/相同文本/长前缀连通组确定性切分 80% fit / 20% dev。
  official test 的输入与 train 有分组重叠时，剔除 train 组。
- official test 上一轮已查看的 80 条及同组项排除；剩余项封存为最终 check。
  训练/选择候选期间不计算这部分的预测指标。final check 后不得再用它调参。
- 只解析 Human/Agent 发言。system/instruction 模板、VAD 标签、source、lang 均不作为模型特征。
  去除标点，避免把 ASR 自动标点当语义完成的答案。
- 数据标签经过发布者的大模型修正，不等同独立人工真值。相同标签缺陷会影响结论。

## 先验验收线

拒判算云端 fallback，不算成功，也不算错误。

| 指标 | 门槛 |
| --- | --- |
| unfinished 中提前 respond | ≤2% |
| 本地 respond 中错误比例 | ≤2% |
| finished 中错误 wait | ≤5% |
| 本地 wait 中错误比例 | ≤5% |
| 本地覆盖率 (respond + wait) / 全部 | ≥30% |
| 每个被启用方向的 dev 样本数 | ≥50 |
| 本地推理 P95 | <10 ms，单样本，预热后，报告本机环境 |
| 权重制品 | ≤2 MiB |

额外报告 95% Wilson 区间、中文/英文分层、无上下文消融、无 suffix 消融、
always-respond / always-wait / 标点基线；不把宽区间或单一数据源的通过解释成产品可靠性。
长停顿拼接、取消过期判断、个人撤销、工具权限仍需既有回归通过。

## Loop

prepare（哈希/来源/隔离清单）→ fit（固定 seed）→ dev（校准拒判门限）
→ 排序/失败分类 → 下一候选 → 冻结最佳候选 → 一次独立 check → accepted/rejected。

首轮预先固定 3 类特征（正文、正文+末尾、正文+末尾+上下文），
每类 2 个训练轮数（8/20），最多 6 次，固定学习率、种子和维度。
可在 dev 失败分析后开启新轮次，但必须记录理由与修改，不能降低以上门槛。
最终 check 失败就保留 rejected；再改必须另找独立测试集。

所有训练/评估文件位于显式指定实验目录，不读取 live 个性化目录，不启动播放器，
不调用麦克风、云端付费教师或真实工具，不自动替换线上模型。训练在独立 worker，
有截止时间与 abort；训练日志仅记录计数、哈希和指标。

当前线程有一个旧的 paused goal，目标工具不允许覆盖未完成 goal。
因此本文件是这次新循环的可审计目标，不把旧任务谎报完成来清空槽位。

来源：[数据集卡](https://huggingface.co/datasets/KE-Team/SemanticVAD-Dataset/blob/b5b536e96076a156e79b7e6db9ca8fd100d3f976/README.md)。

## Round 2 预注册（Round 1 check 后，第二个测试集预测前）

Round 1 最佳候选 `context-8` 在 KE 封存集误等 109/1043 = 10.45%，拒绝。
另发现该测试集根本没有历史上下文，不能用它证明上下文学习；标点基线竟有
98.97% 标签一致率，说明公开文字标签有很强的标点捷径。模型仍不得使用标点。

第二轮保持六种训练配置、权重训练来源和验收门槛不变，改变校准依据：
上一轮 KE 已揭盲测试永久降级为 calibration，和原 dev 合并；
必须同时检查中文/英文以及无历史场景的错误比例，不让总体均值遮住某一场景。
仍不拿 calibration 更新梯度。通过新的来源隔离检查后重新训练六个候选。

新的独立 check：ASLP-lab/Easy-Turn-Testset，revision
`5812651dbab429b9a4fab293de7127bfb9a56650`，发布者 Apache-2.0，
人工标注的 complete/incomplete 文本，真实录音与合成来源分层报告。
只下载两个 `.list` 转录元数据文件，不下载音频；去掉行内 `<COMPLETE>` 等答案 token。
按源 key 标记，剔除与已有 fit/calibration 相同文本/长前缀/上下文的组。
它只有中文，不能替代英文或你的真实个人场景验收。最多再六次候选和一次新 check；
若仍失败保留拒绝结论，不反复试探这份 check 来刷通过。

来源：[Easy-Turn 数据集卡](https://huggingface.co/datasets/ASLP-lab/Easy-Turn-Testset/blob/5812651dbab429b9a4fab293de7127bfb9a56650/README.md)。

Round 2 的 dev-only 第一次校准发现：强迫中英文共用一个门限，会因英文方向
支持样本不足把中文响应也禁用，最大覆盖率只有 17.51%。保留该失败实验，
**在 Easy Turn check 仍未读取时**新增语言分层校准迭代：由输入是否含汉字路由
两套标量门限（不是读取数据集 lang 来作弊），每套仍检查无历史场景。
再跑同六种训练配置；门槛不变、Easy Turn 仍只允许一次最终 check。
