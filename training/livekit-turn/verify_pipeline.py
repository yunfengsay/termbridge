"""Real 0.259B pipeline smoke. Public data only; fresh-check promotion is NOT faked."""

import argparse
import asyncio
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pipeline
from adapter import FineTunedTurnDetector, chat_context
from checkpoint import sha256, write_json
from train import train


def verify(base: Path, data: Path, output: Path):
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    rows = pipeline.read(data / "train.json")
    lora = output / "lora-pipeline"
    full = output / "full-pipeline"
    pipeline.init(lora, base, data / "train.json", data / "dev.json",
                  policy={"lora_steps": 2, "lora_new": 4})
    assert pipeline.sync(lora, 1, True, rows[:40])["status"] == "queued"
    lora_result = pipeline.cycle(lora, idle=True)
    assert lora_result["status"] == "awaiting_check", lora_result
    assert pipeline.cycle(lora, idle=True)["reason"] == "candidate_awaiting_check"
    assert pipeline.status(lora)["active"] is None

    pipeline.init(full, base, data / "train.json", data / "dev.json",
                  policy={"full_new": 4, "full_interval": 1, "full_steps": 2})
    pipeline.sync(full, 1, True, rows[:40])
    time.sleep(1.1)  # Explicit compressed test cadence, NOT a week of real unattended operation.
    full_result = pipeline.cycle(full, idle=True)
    assert full_result["mode"] == "full" and full_result["status"] == "awaiting_check", full_result
    full_candidate = next((full / "jobs").iterdir()) / "candidate"

    # Exercise foundation → new adapter → incremental adapter weights outside production selection.
    adapter = output / "new-adapter"
    resumed = output / "resumed-adapter"
    created = train(base, data / "train.json", adapter, "lora", 2, device="auto", foundation=full_candidate)
    continued = train(base, data / "train.json", resumed, "lora", 2, device="auto", resume=adapter)
    assert continued["resume"]["sha256"] == sha256(adapter / "receipt.json")
    assert continued["foundation"]["sha256"] == sha256(full_candidate / "receipt.json")

    async def reload():
        detector = FineTunedTurnDetector(base, resumed, thresholds={"zh": 0.5, "en": 0.5})
        try:
            await detector.start()
            probability = await detector.predict_end_of_turn(chat_context(rows[0]["messages"]))
            error = abs(probability - continued["probeProbabilityBeforeSave"])
            assert error < 1e-4
            return error
        finally:
            detector.close()

    error = asyncio.run(reload())

    # Exercise the OUTER pipeline supervisor, not just train.py's signal handler.
    cancel_root = output / "cancel-pipeline"
    pipeline.init(cancel_root, base, data / "train.json", data / "dev.json",
                  policy={"lora_new": 4, "lora_steps": 512})
    pipeline.sync(cancel_root, 1, True, rows[:200])
    with (output / "pipeline-cancel.log").open("w") as log:
        process = subprocess.Popen([sys.executable, "pipeline.py", "run", str(cancel_root.resolve()), "--idle"],
                                   stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 60
            reached_step = False
            while time.monotonic() < deadline and process.poll() is None:
                for path in (cancel_root / "jobs").glob("*/candidate/receipt.json"):
                    if pipeline.read(path).get("steps", 0) >= 1:
                        reached_step = True
                        process.send_signal(signal.SIGTERM)
                        break
                if reached_step:
                    break
                time.sleep(0.05)
            assert reached_step, "Pipeline never reached a real optimizer update"
            code = process.wait(timeout=15)
            cancelled = pipeline.status(cancel_root)["lastJob"]
            worker = pipeline.read(next((cancel_root / "jobs").glob("*/train.worker.json")))
            assert code == 130 and cancelled["status"] == "cancelled"
            assert worker["status"] == "reaped"
            try:
                os.kill(worker["pid"], 0)
            except ProcessLookupError:
                pass
            else:
                raise AssertionError("Cancelled native training process is still alive")
        finally:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=15)

    revoked = pipeline.sync(lora, 2, False, [])
    assert revoked["status"] == "revoked" and not list((lora / "jobs").iterdir())
    report = {"status": "verified", "data": "public KE fixture, not phone/private data",
              "lora": lora_result, "full": full_result,
              "fullCadence": "compressed to one second for this test",
              "freshAdapterSteps": created["steps"], "resumedAdapterSteps": continued["steps"],
              "resumedReloadAbsoluteError": error, "revocationPurgedGeneratedWeights": True,
              "pipelineCancellation": {"id": cancelled["id"], "status": cancelled["status"],
                                       "exitCode": code, "realOptimizerStep": reached_step, "workerReaped": True},
              "activeModelPromoted": False, "audioDevicesOpened": False}
    write_json(output / "report.json", report)
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    verify(**vars(parser.parse_args()))
