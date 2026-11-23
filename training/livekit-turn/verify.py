"""Real-weight reload and cancellation evidence, no audio devices or paid services."""

import argparse
import asyncio
import json
import signal
import subprocess
import sys
import time
from pathlib import Path

from adapter import FineTunedTurnDetector, chat_context
from checkpoint import write_json
from model import device_name


async def verify(base: Path, data: Path, artifacts: list[Path], output: Path):
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    rows = json.loads(data.read_text())
    results = []
    for artifact in artifacts:
        receipt = json.loads((artifact / "receipt.json").read_text())
        row = next(r for r in rows if r["id"] == receipt["probeRowId"])
        detector = FineTunedTurnDetector(base, artifact, thresholds={"zh": 0.5, "en": 0.5})
        try:
            await detector.start()
            context = chat_context(row["messages"])
            probability = await detector.predict_end_of_turn(context)
            error = abs(probability - receipt["probeProbabilityBeforeSave"])
            if error > 1e-4:
                raise AssertionError(f"Save/reload probability drift: {error}")
            pid = detector.local_executor.process.pid
            task = asyncio.create_task(detector.predict_end_of_turn(context))
            await asyncio.sleep(0.01)
            if task.done():
                raise AssertionError("Prediction finished before cancellation experiment")
            task.cancel()
            try:
                await task
                raise AssertionError("Cancelled inference produced a result")
            except asyncio.CancelledError:
                pass
            if detector.local_executor.process is not None:
                raise AssertionError("Cancelled native inference worker not reaped")
            await detector.start()
            recovered = await detector.predict_end_of_turn(context)
            if abs(probability - recovered) > 1e-6:
                raise AssertionError("Recreated inference worker changed prediction")
            results.append({"artifact": artifact.name, "status": "verified",
                            "reloadAbsoluteError": error, "cancelledWorkerPid": pid,
                            "cancelReceipt": "cancelled", "workerReaped": True,
                            "subsequentInference": "completed"})
        finally:
            detector.close()
    # Real training reaches an optimizer step, then receives SIGTERM (no mock sleep worker).
    cancellation = output / "cancel-training"
    command = [sys.executable, "run.py", "train", "--base", str(base), "--data", str(data),
               "--output", str(cancellation), "--mode", "lora", "--device", device_name("auto"),
               "--steps", "100000", "--seconds", "120"]
    with (output / "cancel-training.log").open("w") as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 60
        try:
            while time.monotonic() < deadline and process.poll() is None:
                receipt_file = cancellation / "receipt.json"
                if receipt_file.exists() and json.loads(receipt_file.read_text()).get("steps", 0) >= 1:
                    process.send_signal(signal.SIGTERM)
                    break
                await asyncio.sleep(0.05)
            code = await asyncio.to_thread(process.wait, timeout=15)
            receipt = json.loads((cancellation / "receipt.json").read_text())
            if code != 130 or receipt["status"] != "cancelled" or receipt["steps"] < 1:
                raise AssertionError("Training cancellation did not reach a terminal receipt")
            write_json(output / "report.json", {
                "status": "verified", "inference": results,
                "trainingCancel": {"status": receipt["status"], "steps": receipt["steps"],
                                   "exitCode": code, "processReaped": process.poll() is not None},
                "audioDevicesOpened": False,
            })
        finally:
            if process.poll() is None:
                process.kill()
                process.wait(timeout=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--artifact", type=Path, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = vars(parser.parse_args())
    args["artifacts"] = args.pop("artifact")
    asyncio.run(verify(**args))
