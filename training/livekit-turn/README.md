# TermBridge · LiveKit Turn Detector 微调

一个独立的、本地训练目录：**官方原版 / 全参数 / LoRA** 使用同一 LiveKit 文本契约。
云端 ASR、Omni 音频、既有 TurnCoordinator 和工具权限不变。提供显式启用的 Host 本地训练流水线，
不自动修改用户服务配置、不重启部署 Host。

这是 LiveKit `v0.4.1-intl` 文本 EOU 模型的派生训练，不是新音频 TurnDetector、
ASR、DDSD 或声纹模型。权重许可要求与 LiveKit Agents 一起使用；非商业也不豁免。
下载时保存原 LICENSE，派生制品也复制 LICENSE，不把权重重新托管或用于其他模型蒸馏。
数据与权重默认留在 gitignored `artifacts/`。不录音、不播放、不调用云端教师。

## 可复现运行

Python 3.12，Mac Apple Silicon / Linux CPU 或 CUDA。使用本目录 `uv.lock`：

```sh
cd training/livekit-turn
uv sync --frozen
uv run --frozen python checkpoint.py artifacts/base
uv run --frozen pytest -q
uv run --frozen ruff check .
```

首次 Python 包下载使用清华 PyPI 镜像（原 PyPI TLS 断连），lock 固定包版本与散列。
模型仅从官方 Hugging Face 固定 commit 下载，校验 safetensors 和 ONNX SHA256。
不下载 optimizer pickle 或自定义远程代码。不要把 `revision` 换成 `main`：main 权重
与官方 multilingual 插件使用的 tag 不同。

先用上一轮开源数据 prepare 产生的 group-safe splits，恢复原始 Human/Agent 角色：

```sh
uv run --frozen python run.py prepare \
  --original /path/to/trainset_15000.json \
  --splits /path/to/previous-prepared-experiment \
  --output artifacts/data

uv run --frozen python run.py train --base artifacts/base --data artifacts/data/train.json \
  --output artifacts/full-128 --mode full --steps 128 --device auto
uv run --frozen python run.py train --base artifacts/base --data artifacts/data/train.json \
  --output artifacts/lora-128 --mode lora --steps 128 --device auto

uv run --frozen python run.py evaluate --base artifacts/base --data artifacts/data/dev.json \
  --output artifacts/baseline-eval --backend torch
uv run --frozen python run.py evaluate --base artifacts/base --data artifacts/data/dev.json \
  --output artifacts/full-eval --artifact artifacts/full-128
uv run --frozen python run.py evaluate --base artifacts/base --data artifacts/data/dev.json \
  --output artifacts/lora-eval --artifact artifacts/lora-128
```

`--steps` 是真实 optimizer 更新次数；默认 batch=2，128 步只有 256 个样本，
是有界实验而不是完整语料收敛。训练按固定分层顺序取数据，耗尽后循环；
进一步完整训练可增加 steps，必须另建输出目录并重新评测。
默认全参 lr=1e-5，LoRA lr=1e-4，r=8/alpha=16；不是 QLoRA。
训练过程全参用 FP32，保存也保持 FP32，不偷换成量化再声称恢复一致。
训练固定 padding 到 128，避免 MPS 对变长 batch 反复缓存图；MPS 内存份额限制为
0.6。RSS、MPS tensor allocation 和 driver allocation 分别记录，不能相加后称为
物理内存。实测资源修正后的制品名为 `full-128-fixed` / `lora-128-fixed`。

`receipt.json` 记录稳定基座 SHA、输入 SHA、参数数量、真实步骤、loss、Tensor 更新探针、
时间、峰值 RSS、权重散列。SIGINT/SIGTERM 标记 `cancelled`，退出码 130；
`--seconds` 截止标记 `timed-out`、退出码 124。只允许 `completed` 制品加载。
Python 原生算子若阻塞，信号回调可能延迟；新增 pipeline 外层 watchdog 会先 TERM、
再 KILL 整个子进程组。这里不把旧 `tb serve` 的轻量个人规则训练偷偷换成大模型训练。

## LiveKit Agents 接入点

`FineTunedTurnDetector` 继承官方 `EOUModelBase`，使用官方 `ChatContext` 的 6 条
历史筛选及 `_EUORunnerMultilingual` 格式化。推理在独立子进程，timeout/cancel
会 terminate/kill 并回收它；不会只取消 Python future 留下后台运算。

```python
from pathlib import Path
from livekit.agents import AgentSession, TurnHandlingOptions
from adapter import FineTunedTurnDetector

detector = FineTunedTurnDetector(Path("artifacts/base"))  # 官方语言门限
await detector.start()  # 在通话前预热，不让首次加载占据 3 秒判定预算
session = AgentSession(turn_handling=TurnHandlingOptions(turn_detection=detector))
# 另注入你已有的 stt/llm/tts
# 结束 session 后，调用 detector.close()，回收本地推理进程。
```

加载 `artifact=Path("artifacts/lora-128")` / full 时必须显式提供已校准的
`thresholds={"zh": ..., "en": ...}`。测试中使用 0.5 只是诊断二分类 loss，
**不是生产推荐阈值**。微调会改变概率分布，不允许无声复用官方 0.0066 中文阈值。
推理日志不返回上游原插件的 `input` 文本，避免 debug 日志泄露会话。
模块依赖上游内部格式化 API，因此锁定插件版本，升级必须跑格式/截断/恢复回归。
LiveKit 1.8.0 已将这个**文本插件**标记 deprecated；不是我们忽略警告或误用新音频
模型。这里固定公开可训练检查点，后续升级到新音频模型须另验权重、训练接口与许可。

## 真实权重验证

```sh
uv run --frozen python verify.py --base artifacts/base --data artifacts/data/train.json \
  --artifact artifacts/full-128-fixed --artifact artifacts/lora-128-fixed \
  --output artifacts/verify-final
uv run --frozen python compare.py \
  --report artifacts/baseline-eval/report.json --report artifacts/onnx-eval/report.json \
  --report artifacts/full-fixed-eval/report.json --report artifacts/lora-fixed-eval/report.json \
  --training artifacts/full-128-fixed/receipt.json --training artifacts/lora-128-fixed/receipt.json \
  --verification artifacts/verify-final/report.json --output artifacts/comparison.json
```

verify 会加载真实权重，核对保存前后概率，再在真正推理途中取消、确认子进程回收、
重建后再次成功；另外启动一次 LoRA 训练，在第一个 optimizer step 后 SIGTERM，
必须有 cancelled/130 回执。它不启用麦克风或播放设备。

当前的实验与准入边界见 [PLAN.md](PLAN.md)。已揭盲的数据只用于诊断，不能用同一份
反复调参后给出“已解决长停顿”的结论。产品还要验证真实中文续说、噪声、打断、
工具并发和过期 revision 丢弃。此目录没有重启 Host，也没有安装 APK。

## 高频 LoRA / 周期全参 Pipeline

完整配置、数据分流、状态机、版本兼容与验收见
[流水线文档](../../docs/voice-personalization/livekit-pipeline.md)。
入口是 `tb voice learning pipeline init|plan|run|status <directory>`；Host 只在明确设置
`TB_VOICE_PIPELINE_DIR` 与专用 Python 环境后调度，不在 Call 内训练或切换候选。

```sh
uv run --frozen python verify_pipeline.py --base artifacts/base --data artifacts/data \
  --output artifacts/pipeline-verification
```

真实测试包含两种周期、full foundation → 新 LoRA → 适配器续训、取消整个 pipeline
及撤销派生权重；只使用公共数据，不伪造独立检查通过或选中测试模型。
