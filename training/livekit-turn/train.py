"""Bounded full-parameter or LoRA training; raw text never appears in receipts."""

import json
import math
import resource
import shutil
import signal
import sys
import time
from pathlib import Path

import torch

from checkpoint import REVISION, WEIGHTS_SHA, sha256, write_json
from lineage import training_lineage
from model import batch_tokens, device_name, forward, load, parameter_probe, tokenizer_for


class Cancelled(Exception):
    pass


def train(base: Path, data: Path, output: Path, mode: str, steps: int,
          batch_size: int = 2, device: str = "auto", seconds: int = 1800,
          foundation: Path | None = None, resume: Path | None = None) -> dict:
    if mode not in ("full", "lora") or not 1 <= steps <= 100_000 or not 1 <= batch_size <= 32:
        raise ValueError("Invalid training recipe")
    if not 1 <= seconds <= 86400:
        raise ValueError("Deadline must be within one day")
    foundation, ancestry = training_lineage(mode, output, foundation, resume)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    started = time.monotonic()
    receipt = {"status": "running", "mode": mode, "revision": REVISION,
               "baseSha256": WEIGHTS_SHA, "trainSha256": sha256(data), "seed": 20260908,
               "requestedSteps": steps, "batchSize": batch_size, "steps": 0,
               "device": device_name(device), "lr": 1e-5 if mode == "full" else 1e-4,
               "maxTokens": 128, "fixedLengthPadding": True,
               "deadlineSeconds": seconds, "productionEnabled": False, **ancestry}
    write_json(output / "receipt.json", receipt)

    def cancel(_signum, _frame):
        raise Cancelled()

    def deadline(_signum, _frame):
        raise TimeoutError()

    old_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM)}
    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGALRM, deadline)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        torch.manual_seed(receipt["seed"])
        torch.set_num_threads(4)
        if receipt["device"] == "mps":
            # Leave headroom for the shared Host and desktop; fail rather than exhaust the Mac.
            torch.mps.set_per_process_memory_fraction(0.6)
        rows = json.loads(data.read_text())
        if not rows or any(row["label"] not in (0, 1) for row in rows):
            raise ValueError("Empty or invalid fit data")
        tokenizer = tokenizer_for(base)
        model = load(base, mode, receipt["device"], resume, trainable=True, foundation=foundation)
        model.train()
        parameters = [(name, p) for name, p in model.named_parameters()]
        trainable = [(name, p) for name, p in parameters if p.requires_grad]
        receipt |= {"parameters": sum(p.numel() for _, p in parameters),
                    "trainableParameters": sum(p.numel() for _, p in trainable),
                    "trainableTensors": len(trainable), "fitRows": len(rows)}
        if mode == "full" and len(trainable) != len(parameters):
            raise ValueError("Full tuning unexpectedly froze parameters")
        if mode == "lora" and any("lora_" not in name for name, _ in trainable):
            raise ValueError("LoRA unexpectedly trains base parameters")
        before = parameter_probe(model)
        optimizer = torch.optim.AdamW([p for _, p in trainable], lr=receipt["lr"], weight_decay=0.01)
        losses = []
        step_seconds = []
        mps_allocated = mps_driver = 0
        for step in range(steps):
            tick = time.monotonic()
            if tick - started >= seconds:
                raise TimeoutError()
            batch = [rows[(step * batch_size + i) % len(rows)] for i in range(batch_size)]
            tokens = batch_tokens(tokenizer, [row["messages"] for row in batch], receipt["device"],
                                  fixed_length=True)
            targets = torch.tensor([row["label"] for row in batch], device=receipt["device"],
                                   dtype=torch.float32)
            optimizer.zero_grad(set_to_none=True)
            loss = torch.nn.functional.binary_cross_entropy_with_logits(forward(model, tokens), targets)
            if not torch.isfinite(loss):
                raise ValueError("Non-finite training loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_([p for _, p in trainable], 1.0, error_if_nonfinite=True)
            optimizer.step()
            losses.append(float(loss.detach().item()))
            step_seconds.append(time.monotonic() - tick)
            receipt["steps"] = step + 1
            if receipt["device"] == "mps":
                mps_allocated = max(mps_allocated, torch.mps.current_allocated_memory())
                mps_driver = max(mps_driver, torch.mps.driver_allocated_memory())
            if step < 2 or (step + 1) % 16 == 0:
                print(json.dumps({"mode": mode, "step": step + 1, "loss": losses[-1],
                                  "seconds": step_seconds[-1]}), flush=True)
                write_json(output / "receipt.json", receipt)
        after = parameter_probe(model)
        changed = [name for name in before if not torch.equal(before[name], after[name])]
        frozen_changed = [name for name, p in parameters if not p.requires_grad and name in changed]
        if not changed or frozen_changed:
            raise ValueError("No observed weight update, or frozen base changed")
        model.eval()
        probe_tokens = batch_tokens(tokenizer, [rows[0]["messages"]], receipt["device"])
        with torch.inference_mode():
            saved_probability = float(forward(model, probe_tokens).sigmoid().item())
        weights = output / "weights"
        # Preserve trained FP32 exactly; quantization/export is a separate evaluated step.
        model.save_pretrained(weights, safe_serialization=True)
        shutil.copyfile(base / "LICENSE", output / "LICENSE")
        receipt |= {
            "status": "completed", "samplesSeen": steps * batch_size,
            "uniqueSamplesSeen": min(steps * batch_size, len(rows)),
            "epochsEquivalent": steps * batch_size / len(rows),
            "meanLoss": sum(losses) / len(losses), "losses": losses,
            "stepSeconds": step_seconds, "changedTensorProbes": len(changed),
            "unchangedFrozenProbes": len(parameters) - len(trainable),
            "frozenChanged": frozen_changed, "probeProbabilityBeforeSave": saved_probability,
            "mpsObservedPeakAllocatedBytes": mps_allocated,
            "mpsObservedPeakDriverBytes": mps_driver,
            "probeRowId": rows[0]["id"],
            "weightFiles": {p.name: {"bytes": p.stat().st_size, "sha256": sha256(p)}
                            for p in weights.iterdir() if p.suffix == ".safetensors"},
            "warning": "Bounded experiment, not converged, not product acceptance",
        }
        if not math.isfinite(receipt["meanLoss"]):
            raise ValueError("Invalid loss summary")
    except Cancelled:
        receipt["status"] = "cancelled"
    except TimeoutError:
        receipt["status"] = "timed-out"
    except Exception as error:
        receipt |= {"status": "failed", "errorKind": type(error).__name__}
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)
        receipt |= {"elapsedSeconds": time.monotonic() - started,
                    "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss *
                    (1 if sys.platform == "darwin" else 1024)}
        write_json(output / "receipt.json", receipt)
    return receipt
