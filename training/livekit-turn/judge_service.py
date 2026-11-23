"""Private stdio worker for the Host. A call leases one immutable, evaluated version."""

import asyncio
import json
import re
import sys
from pathlib import Path

from adapter import FineTunedTurnDetector, chat_context
from checkpoint import sha256


async def serve(root: Path):
    state = json.loads((root / "state.json").read_text())
    active = state.get("active")
    if not active or not state["consent"]:
        raise ValueError("No accepted personal model")
    artifact = root / active["artifact"]
    if sha256(artifact / "receipt.json") != active["receiptSha"]:
        raise ValueError("Active receipt changed")
    config = json.loads((root / "config.json").read_text())
    detector = FineTunedTurnDetector(Path(config["base"]), artifact, thresholds=active["thresholds"])
    try:
        await detector.start()
        print(json.dumps({"ready": True, "version": active["receiptSha"]}), flush=True)
        while line := await asyncio.to_thread(sys.stdin.readline):
            if len(line) > 100_000:
                raise ValueError("Oversized request")
            request = json.loads(line)
            latest = json.loads((root / "state.json").read_text())
            decision = None
            if latest["consent"] and latest["epoch"] == active["epoch"]:
                messages = request["messages"]
                language = "zh" if re.search(r"[\u3400-\u9fff]", messages[-1]["content"]) else "en"
                threshold = active["thresholds"].get(language)
                if threshold is not None:
                    probability = await detector.predict_end_of_turn(chat_context(messages), timeout=2)
                    # Re-check consent AFTER native computation as well.
                    latest = json.loads((root / "state.json").read_text())
                    if latest["consent"] and latest["epoch"] == active["epoch"]:
                        decision = "respond" if probability >= threshold else "wait"
            print(json.dumps({"id": request["id"], "decision": decision}), flush=True)
    finally:
        detector.close()


if __name__ == "__main__":
    asyncio.run(serve(Path(sys.argv[1])))
