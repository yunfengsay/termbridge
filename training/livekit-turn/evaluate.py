"""Score through the LiveKit Agents component, not a separate inference implementation."""

import asyncio
import json
import math
import statistics
import time
from pathlib import Path

from adapter import FineTunedTurnDetector, chat_context
from checkpoint import REVISION, sha256, write_json


def wilson(errors: int, count: int) -> list[float] | None:
    if not count:
        return None
    z = 1.959963984540054
    p = errors / count
    divisor = 1 + z * z / count
    center = (p + z * z / (2 * count)) / divisor
    margin = z * math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / divisor
    return [max(0, center - margin), min(1, center + margin)]


def metrics(scores: list[dict], threshold: float) -> dict:
    positives = [r for r in scores if r["label"] == 1]
    negatives = [r for r in scores if r["label"] == 0]
    early = sum(r["probability"] >= threshold for r in negatives)
    late = sum(r["probability"] < threshold for r in positives)
    # Pairwise AUC gives ties half credit; small diagnostic sets, no sklearn dependency.
    auc = (sum((p["probability"] > n["probability"]) +
               0.5 * (p["probability"] == n["probability"])
               for p in positives for n in negatives) / (len(positives) * len(negatives))
           if positives and negatives else None)
    return {"count": len(scores), "threshold": threshold,
            "unfinished": len(negatives), "finished": len(positives),
            "earlyResponses": early, "wrongWaits": late,
            "earlyResponseRate": early / len(negatives) if negatives else None,
            "wrongWaitRate": late / len(positives) if positives else None,
            "earlyResponseRate95": wilson(early, len(negatives)),
            "wrongWaitRate95": wilson(late, len(positives)),
            "accuracy": 1 - (early + late) / len(scores), "auc": auc,
            "binaryLoss": -sum(math.log(max(1e-12, r["probability"] if r["label"]
                                             else 1 - r["probability"])) for r in scores) / len(scores)}


async def evaluate(base: Path, data: Path, output: Path, artifact: Path | None = None,
                   backend: str = "torch", device: str = "cpu", timeout: float = 3) -> dict:
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    rows = json.loads(data.read_text())
    # Explicit 0.5 is for diagnostic binary loss evaluation, NOT a calibrated deployment value.
    detector = FineTunedTurnDetector(base, artifact, backend=backend, device=device,
                                    thresholds={"zh": 0.5, "en": 0.5} if artifact else None)
    scores = []
    started = time.monotonic()
    status = "failed"
    try:
        await detector.start()
        await detector.predict_end_of_turn(chat_context(rows[0]["messages"]), timeout=timeout)
        for row in rows:
            tick = time.perf_counter()
            probability = await detector.predict_end_of_turn(chat_context(row["messages"]), timeout=timeout)
            if not math.isfinite(probability) or not 0 <= probability <= 1:
                raise ValueError("Invalid model probability")
            scores.append({"id": row["id"], "label": row["label"], "lang": row["lang"],
                           "probability": probability, "ms": (time.perf_counter() - tick) * 1000})
            if len(scores) % 32 == 0:
                print(json.dumps({"evaluated": len(scores), "total": len(rows)}), flush=True)
        languages = json.loads((base / "languages.json").read_text())
        stratified = {}
        for language in sorted({r["lang"] for r in rows}):
            subset = [r for r in scores if r["lang"] == language]
            stratified[language] = {
                "binaryHalf": metrics(subset, 0.5),
                "originalThresholdDiagnostic": metrics(subset, languages[language]["threshold"]),
            }
        latency = sorted(r["ms"] for r in scores)
        report = {"status": "completed", "revision": REVISION,
                  "artifact": artifact.name if artifact else "baseline", "backend": backend,
                  "device": device, "datasetSha256": sha256(data),
                  "binaryHalf": metrics(scores, 0.5), "byLanguage": stratified,
                  "latencyMs": {"p50": statistics.median(latency),
                                "p95": latency[math.ceil(0.95 * len(latency)) - 1]},
                  "scores": scores, "elapsedSeconds": time.monotonic() - started,
                  "evaluation": "diagnostic dev; not a new blind test; not authorized for deployment"}
        write_json(output / "report.json", report)
        status = "completed"
        return report
    except asyncio.CancelledError:
        status = "cancelled"
        raise
    finally:
        detector.close()
        if status != "completed":
            write_json(output / "receipt.json", {"status": status, "evaluated": len(scores)})
