# JAEC Host 实验模块

状态：**真实原生库/离线回放已验证；未接入 Android/Global Call，不改变当前通话行为。**

采用官方 [JAEC 16K](https://modelscope.cn/models/iic/speech_jaec_aec_16k)，ABI 参照
[ModelScope JAEC wrapper](https://github.com/modelscope/modelscope/blob/master/modelscope/models/audio/aec/jaec.py)。
模型仓库固定 revision `d8726e8b2b743a9f9093ae77bc6dcd317c78ea33`，各下载文件独立校验 SHA-256。
原生库、权重、LICENSE 和 THIRD_PARTY_NOTICES 缓存在用户的 `.termbridge/models/jaec/`；不进入 Git，不下载到手机。
运行时不下载模型，不依赖 torch/NumPy，不上传或播放测试音频。

## 使用与验证

在仓库根目录执行（需要 Python 3）：

```sh
python3 packages/voice/native/jaec.py install
python3 packages/voice/native/jaec.py process \
  --mic /path/to/mic.wav --reference /path/to/render-reference.wav \
  --output /path/to/new-cleaned.wav
python3 -m unittest discover -s packages/voice/native -p 'test_*.py' -v
python3 packages/voice/native/benchmark_jaec.py
```

`install` 是信任官方原生代码的显式操作。自定义缓存使用 `--model-dir`；不支持的平台直接拒绝。
打开真实原生回归测试时，将 `TB_JAEC_MODEL_DIR` 设为 install 的缓存目录
（默认 `.termbridge/models/jaec/40234f7abea8`，使用绝对路径）。否则原生测试明确 skipped。

`serve` 是独立子进程实验接口：stdout 首先发出 `JAECv1\r\n`，随后 stdin 每次接收
320 字节 mic + 320 字节 render-reference，stdout 返回 320 字节清理后的 PCM。
两路均为 16 kHz、mono、signed PCM16 little-endian、160 samples/10ms。
每个进程只对应一条流，不能混用多个电话；处理途中不 reset；EOF 释放 native handle。
调用方必须管理进程取消/超时；目前尚无生产 Host 调用方。

## 2026-09-10 Mac ARM64 实测

- 9 项测试（含真实原生运行、管道进程、状态 reset、哈希拒绝、截断帧、格式拒绝和合成回声）通过。
- 官方 10 秒样本处理用时约 **15.8 ms**，RTF **0.00158**；这是 native+ctypes 处理时间，不含下载、进程启动或网络。
- 固定 seed=42 的 10 秒宽带线性回声：50 ms 延迟、0.65 回声增益，后 5 秒 ERLE **42.18 dB**，0 个削波样本。
- 每个 10 ms 帧处理耗时 P50 **0.0139 ms**，P95 **0.0211 ms**（单次本机测量，不是跨设备承诺）。
- 官方声明的 **22 ms 算法延迟**未在本实验中独立测量，不可当作端到端通话延迟。
- 官方样本 sha256：mic `16434a4af7678d349a2aeb0c29217eb74e95122f426c484360ad4266b9f53ef3`；ref `d2f042d8b5e063938528a1b25e8aba8b8b75b5fb7e1bf4f7f4da01285cea7a80`。
- 官方样本来源：[mic](https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/jaec/nearend_mic.wav)、[ref](https://dashscope.oss-cn-beijing.aliyuncs.com/samples/audio/jaec/farend_speech.wav)。

合成 ERLE 仅证明线性回声路径可工作，不代表真实手机双讲、蓝牙、风噪或主人识别验收。
官方样本没有干净近端真值，本次不虚报 PESQ/STOI 或真人听感。

## 生产接入前必须补齐

1. 官方二进制只支持 macOS ARM64、Linux x86-64、Windows x86-64；`jaec_arm.so` 实为 Mach-O，不能放进 Android APK。
2. Android 需要提供**实际送往播放设备**的参考 PCM、单调时间戳和流序号。云端生成但尚未播放/已被打断丢弃的音频不是合法参考。
3. Host 按时间配对 mic/reference，有界缓冲、参考缺失/断流检测、独立子进程隔离和取消；协议变更须同步 Android/iOS/文档。
4. 与现有系统 AEC 的先后顺序做消融，避免未经验证叠加两套 AEC；保留 GTCRN 等现有路径。
5. 蓝牙切换、扬声器、双讲和语音打断需要真机采集/回放验收；不自动将实验模块设为生产默认。
