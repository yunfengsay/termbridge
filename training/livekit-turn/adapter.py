"""LiveKit Agents EOU component. Isolated inference can actually be killed on timeout."""

import asyncio
import json
import multiprocessing as mp
import time
from pathlib import Path

from livekit.agents import llm
from livekit.plugins.turn_detector.base import EOUModelBase


def inference_worker(connection, base: str, artifact: str | None, backend: str, device: str):
    try:
        import torch
        from model import Format, batch_tokens, forward, load, tokenizer_for
        torch.set_num_threads(4)
        tokenizer = tokenizer_for(Path(base))
        if backend == "onnx":
            import onnxruntime as ort
            from checkpoint import validate
            validate(Path(base), require_onnx=True)
            options = ort.SessionOptions()
            options.intra_op_num_threads = 4
            options.inter_op_num_threads = 1
            model = ort.InferenceSession(str(Path(base) / "onnx/model_q8.onnx"),
                                        sess_options=options, providers=["CPUExecutionProvider"])
        else:
            model = load(Path(base), "baseline", device, Path(artifact) if artifact else None)
            model.eval()
        connection.send({"status": "ready"})
        while True:
            request = connection.recv()
            if request is None:
                break
            start = time.perf_counter()
            messages = json.loads(request)["chat_ctx"]
            if backend == "onnx":
                text = Format(tokenizer).text(messages)
                ids = tokenizer(text, add_special_tokens=False, max_length=128,
                                truncation=True, return_tensors="np")["input_ids"]
                probability = float(model.run(None, {"input_ids": ids})[0].flatten()[-1])
            else:
                with torch.inference_mode():
                    probability = float(forward(model, batch_tokens(tokenizer, [messages], device))
                                        .sigmoid().item())
            # Deliberately omit input text: upstream plugin otherwise puts it in debug logs.
            connection.send({"eou_probability": probability,
                             "duration": time.perf_counter() - start})
    except EOFError:
        pass
    except Exception as error:
        # No model input, local credentials, or exception bodies in IPC/log receipts.
        connection.send({"error": type(error).__name__})
    finally:
        connection.close()


class LocalExecutor:
    def __init__(self, base: Path, artifact: Path | None, backend: str, device: str):
        self.args = (str(base), str(artifact) if artifact else None, backend, device)
        self.process = None
        self.connection = None
        self.lock = asyncio.Lock()

    async def receive(self):
        while self.connection and not self.connection.poll():
            if not self.process.is_alive():
                raise RuntimeError("LiveKit inference worker exited")
            await asyncio.sleep(0.005)
        if self.connection is None:
            raise RuntimeError("LiveKit inference worker closed")
        response = self.connection.recv()
        if "error" in response:
            raise RuntimeError(f"LiveKit inference failed: {response['error']}")
        return response

    async def start(self):
        if self.process:
            return
        context = mp.get_context("spawn")
        self.connection, child = context.Pipe()
        self.process = context.Process(target=inference_worker, args=(child, *self.args), daemon=True)
        self.process.start()
        child.close()
        try:
            await asyncio.wait_for(self.receive(), 90)
        except BaseException:
            self.close()
            raise

    async def do_inference(self, method: str, data: bytes) -> bytes:
        if method != "termbridge_livekit_eou":
            raise ValueError("Unknown inference method")
        if len(data) > 100_000:
            raise ValueError("Oversized inference request")
        async with self.lock:
            try:
                await self.start()
                self.connection.send(data)
                return json.dumps(await self.receive(), allow_nan=False).encode()
            except BaseException:
                # asyncio.wait_for cancels this coroutine: stop native inference, not only wait.
                self.close()
                raise

    def close(self):
        if self.process:
            if self.process.is_alive():
                self.process.terminate()
            self.process.join(timeout=2)
            if self.process.is_alive():
                self.process.kill()
                self.process.join(timeout=2)
            self.process.close()
        if self.connection:
            self.connection.close()
        self.process = self.connection = None


class FineTunedTurnDetector(EOUModelBase):
    """Pass to AgentSession's turn_handling. No RTC/Cloud migration required.

    Fine-tuned probabilities need dev calibration; do not silently use stock thresholds.
    Instantiation without explicit derivative thresholds is intentionally rejected.
    """

    def __init__(self, base: Path, artifact: Path | None = None, *, backend: str = "torch",
                 device: str = "cpu", thresholds: dict[str, float] | None = None):
        if backend not in ("torch", "onnx") or (artifact and backend == "onnx"):
            raise ValueError("Unexported derivative cannot use original ONNX")
        if artifact and not thresholds:
            raise ValueError("Derivative requires explicit calibrated thresholds")
        self.local_executor = LocalExecutor(base, artifact, backend, device)
        super().__init__(model_type="multilingual", inference_executor=self.local_executor,
                         load_languages=False)
        self._languages = (json.loads((base / "languages.json").read_text()) if thresholds is None
                           else {lang: {"threshold": threshold} for lang, threshold in thresholds.items()})
        if any(not 0 < row["threshold"] < 1 for row in self._languages.values()):
            raise ValueError("Thresholds must be between 0 and 1")

    def _inference_method(self) -> str:
        return "termbridge_livekit_eou"

    async def start(self):
        await self.local_executor.start()

    def close(self):
        self.local_executor.close()


def chat_context(messages: list[dict]) -> llm.ChatContext:
    context = llm.ChatContext()
    for message in messages:
        if message["role"] not in ("user", "assistant"):
            raise ValueError("Only transcript roles are allowed")
        context.add_message(role=message["role"], content=message["content"])
    return context
