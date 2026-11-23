# 日常 LoRA，周期全参：个人轮次模型训练流水线

2026-09-08。本批完成 Host/CLI 的可选调度、真实权重训练、版本谱系、独立检查和取消回执。
**工程可运行，不等于模型已变聪明：没有候选通过本批真实新盲测，没有更新正在运行的 Host 或手机。**
前轮 128 步候选增加抢话，仍不启用。原始对照见 [微调实验](livekit-finetuning.md)。

## 两种速度，不在通话中修改权重

```text
手机明确确认的反馈 + 独立文本学习授权
                   |
          已鉴权 Peer / 完整 revision 快照
                   |
        Host 按对话 group 固定分流
            /                  \
       80% 训练池           20% 留出检查池
            |                  | 不参与梯度和阈值选择
       + 公共/历史回放          |
            |                  |
     空闲且无通话时调度          |
      /             \          |
   高频 LoRA      低频全参       |
      \             /          |
        开发集校准阈值 ----------+
                   |
          一次性新检查 + 当前版本对照
             /                  \
          不通过                通过
       保留现有版本         原子更新 active 指针
                                  |
                        下一次通话前预热并使用
```

“近实时”是**反馈及时入队、短周期训练**，不是每说一句就在线反向传播。
本模型只判断“这一轮是否完整”；ASR、任务理解仍走云端，DDSD/本人识别不是它的职责。
追问后的续说、指向他人的语境仍交给既有云端控制器处理。它不会直接调用工具或改写转录。

| 策略 | 默认门槛 | 本轮训练预算 |
| --- | --- | --- |
| LoRA | 新增 32 条有效训练反馈，距上次至少 10 分钟 | 最多 32 steps，batch 2，约一半新反馈、一半回放 |
| 全参数 | 新增 200 条反馈，距初始化/上次全参至少 7 天 | 最多 512 steps，batch 2，同样混入回放 |
| Host 巡检 | 每 30 秒 | 有通话/转录或高负载则跳过；新通话启动立即发出取消 |
| 失败重试 | 普通失败冷却 30 分钟 | 被通话取消冷却 30 秒；不推进未完成训练的样本游标 |

这些默认值是工程策略，不是已实测的最优学习频率。`--policy` JSON 可以覆盖
`lora_new/lora_interval/lora_steps/full_new/full_interval/full_steps/failure_backoff/train_seconds`。
时间单位秒；默认单次梯度训练截止 900 秒，上限 3600 秒。开发/检查各有额外独立截止，
Node 外层总截止 4800 秒。不会无限重试；无效配置、缺依赖或缺样本不回退成云端付费训练。
长期保持 Call 开启时，当前保守策略会一直推迟训练，不宣称已支持通话期间抢占 GPU 训练。

## 版本与样本管理

- 单个目录绑定一个手机 `SHA256(peerId)`，不把其他手机的私人例子混进来。
- 只用 `source=human`、`head=finished`、有明确文本授权的确认例子；不是把 ASR final、
  没有继续说话或模型自己的预测当真值。手机原始录音不进入这个流水线。
- Host 原授权存储是 `~/.termbridge/voice-personalization-v1/<peerHash>.json`，
  支持 `TB_VOICE_LEARNING_DIR` 覆盖。本批不读取真实用户文件；测试只用公共或合成夹具。
- 同一 group 固定在 fit 或 check，避免一段对话前半句训练、后半句测试。
  Check 同时检查 ID、group、完整 messages 散列，与全部 replay、当前 fit、dev 隔离。
  这是精确/分组去重，不保证能自动识别所有语义近似或外部曾经揭盲的数据。
- 检查集在推理前就登记已消耗；中断或失败也不能再次当新盲测。既有 KE final /
  Easy Turn 已揭盲，不能改 ID 再用于上线验收。
- 训练与全参各有独立的已消费样本指纹/时间游标；重连重复快照幂等。只标记本次实际
  取出的新反馈，剩余仍在队列。等待独立检查时暂停新训练，避免堆积未验收候选。
- 当前手机同步协议每份快照仍最多 500 条、保留 30 天；不是无限长期语料库。
  更大的个人历史归档需要另设授权与保留策略。本批没有扩大手机采集范围。
- 删除、纠正标签、过期或撤销授权：立即停用个人推理，epoch 失效，取消正在训练的进程，
  清理该流水线生成的私人样本/派生制品，从剩余有效数据重新训练；不会声称把旧权重
  “精确遗忘了一条数据”。公共基础权重和调用者提供的公共数据不删除。
- 接到较新手机修改后，必须等对应 revision 真正写入授权存储才重新启用；不能在保存
  失败/仍在处理中时用旧文件恢复此前的权限。Host 停止后，迟到的同步回调不能启动新任务。

本地目录为 0700，JSON/回执为 0600、原子替换。主要文件：

```text
<pipeline-directory>/
  config.json           固定基座、数据散列、Peer 绑定、调度策略
  state.json            epoch、同意状态、游标、active、foundation、pending
  snapshot.json         当前仍获授权的训练文本
  check-pool.json       留出文本，只用于检查
  jobs/<uuid>/
    job.json            voice-fit:<uuid> 稳定任务 ID、状态、门槛与版本信息
    fit.json            临时训练批次；等待 check 时保留，终态删除
    candidate/          receipt、LICENSE、safetensors
    *.worker.json       子进程 PID、reaped/exitCode（仅本机诊断）
    dev/, check/        分数和聚合指标，不写转录原文
```

拒绝/失败/取消的候选删除生成权重，只留诊断元数据；既有有效模型不受候选失败影响。
撤销清理不可恢复；这是删除派生私人数据，不是为模型制造备份。
已接受版本目前保留在本地，长期开启需监测磁盘；尚无跨设备发布或定额归档服务。

## LoRA 续训与全参更换基座

LoRA 延续上一次**已接受**的适配权重，不每次从零学习；优化器重新初始化，明确记录
`optimizerResumed=false`，不加载 optimizer pickle。未通过的候选不成为下一轮起点。

全参从当前完整基座、公共/仍获授权的反馈回放进行巩固；**不是把所有历史 LoRA 自动相加**。
全参通过后记录新的 foundation 散列，后续在该基座重新建立 LoRA。适配器记录相对
foundation 路径和 SHA，旧基座适配器套到新基座会直接拒绝。加载时验证上游 revision、
receipt 和每个 safetensors 文件；保存恢复仍通过 LiveKit Agents 组件检验。

## 发布门槛与回退

1. 在 dev 选阈值，冻结后再用新 check；不把官方 INT8 门限硬套到 FP32/微调模型。
2. 每个支持语言，已完成/未完成及预测 respond/wait 都至少 50 例；提前接话率与错误
   respond 比例 ≤2%，错误等待率与错误 wait 比例 ≤5%。同时报告 Wilson 95% 区间，
   不能把小样本点估计说成置信保证。
3. 与当前已接受模型在**同一份** check 比较：提前接话与错误等待数量均不得增加。
   没有已接受本地模型时，参考官方 FP32、在 dev 校准的版本；这不是与线上云模型对照。
4. CPU 预热推理 P95 ≤500ms，且不超过参考 P95 的 1.5 倍（低延迟参考下有 100ms 容差）。
   这是本机测试门槛，不能代替手机到 Host 的网络延迟。
5. 所有门槛通过后原子选择；模型在 Call 之间切换，撤销授权例外——立刻停用。

独立 check 不足时返回 `awaiting_check`，自动留出池必须覆盖 dev 所需全部语言。
中文不足、英文缺样本都不偷偷绕过。可针对中文场景显式准备中文 dev/replay，但不能
临时删掉失败语言后把已看过的检查继续当盲测。

推理进程在通话前预热。缺基座、没有已接受制品、尚未预热、推理超时/崩溃或授权变化，
均返回既有云端轮次判断；中断则丢弃旧 revision，不继续请求云端。这不是重启用户通话。
当前只在 Host 运行模型，不给手机下发 PyTorch/LoRA 权重，也不改变音频上传策略。

## 启用与排查

先按 [训练目录 README](../../training/livekit-turn/README.md) 准备 Python 3.12 环境、
官方固定检查点及互不重叠的数据。npm 构建携带 Python 源码/lock，不携带权重或 `.venv`，
也不替用户静默安装 PyTorch。

以下路径均是示例；`--peer-hash` 必须使用实际已注册手机的完整 SHA256，
不是 `tb voice learning status` 展示的 12 位缩写，也不是配对密钥。

```sh
tb voice learning pipeline init /path/to/personal-pipeline \
  --base /path/to/livekit-base \
  --replay /path/to/public-fit.json --dev /path/to/calibration.json \
  --peer-hash <64-hex-peer-sha256> \
  --python /path/to/livekit-turn/.venv/bin/python

tb voice learning pipeline plan /path/to/personal-pipeline --idle
tb voice learning pipeline status /path/to/personal-pipeline
```

启动 Host 时显式设置 `TB_VOICE_PIPELINE_DIR=/path/to/personal-pipeline` 与
`TB_VOICE_TRAINING_PYTHON=/path/to/livekit-turn/.venv/bin/python`。
不设置目录则完全关闭这条训练/个人模型推理链；已有云端 Call 与轻量规则学习不变。
手机仍需开启已有的个人学习及文本上下文授权，反馈通过既有鉴权通道同步。
本批没有把这些变量写进用户环境，也未重启部署服务。

```sh
# 手动运行一个已确认空闲的周期；Ctrl-C 会取消整个流水线。
tb voice learning pipeline run /path/to/personal-pipeline --idle \
  --python /path/to/livekit-turn/.venv/bin/python

# pending 候选补一次新的独立 check，不重新训练；此文件使用后即视为揭盲。
tb voice learning pipeline run /path/to/personal-pipeline --idle \
  --check /path/to/new-unseen-check.json \
  --python /path/to/livekit-turn/.venv/bin/python
```

手动 `--idle` 是操作者对空闲状态的声明；只有 Host 调度器会检查实际 Call/负载。
`status` 读取本地流水线文件，不等于部署 Host 已更新或手机已启用。
退出码：失败 1、拒绝 2、取消 130、超时 124。回执状态不是一直停在 running。

## 本批验证

详见 [聚合证据](qa/livekit-pipeline.json)。公开 KE 数据、不录音、不播放、不调用付费教师：

- Python 30 项测试：含 LoRA/全参实际参数更新、继承基座、串行调度、幂等、撤销、
  check 隔离、数据不足等待、双向回归/时延门槛。
- Node Host 流水线 6 项测试：权限/来源、分组留出、原始片段与云回退、模拟训练取消、
  停止后不复活、较新权限修改不能被旧 revision 恢复。这里的调度 worker 是 mock。
- **真实 0.259B 权重**：LoRA 和周期全参各执行 2 steps，均到 `awaiting_check`。
  全参周期仅在隔离实验中压缩为 1 秒，不是七天无人值守验收。
- 全参候选 → 新 LoRA 2 steps → 续训 2 steps：重新加载概率绝对误差 `1.67e-6`。
- 真实外层 pipeline 在第一个 optimizer step 后收到 SIGTERM，返回
  `cancelled/130`，原生训练 PID 已不存在；不是只取消 Promise。
- 构建后 CLI 能读取该真实取消回执；撤销隔离 LoRA pipeline 后，其生成制品已清理。
- `ruff`、`pnpm typecheck`、`pnpm build`、完整 `pnpm test` 均通过；主 unit 264 pass /
  1 skip、Voice Control 51 pass（包含上面 6 项）、集成 30 场景通过。重复测试端口曾
  被占用，已换核验空闲的端口全套重跑，没有停止其他服务。文档与 diff 检查通过。

没有候选被本批实验证明优于原版或云端，没有替用户启用模型。后续验收需要新中文
长停顿/续说/旁人讲话数据，以及实际手机通话体验；本实现不声称解决所有 Voice 意图问题。

关键代码：`training/livekit-turn/{cadence,pipeline,lineage,judge_service}.py`、
`packages/host/src/{voicePipeline,voicePipelineJudge,voiceTurnJudge}.ts`、
`packages/voice/src/pipeline-process.ts`、`packages/cli/src/voicePipeline.ts`。
