"""Publish aggregate evidence only. Calibration is explicitly dev-only and not a release gate."""

import argparse
import importlib.metadata
import json
from pathlib import Path

from checkpoint import write_json
from evaluate import metrics


def calibrated_diagnostic(scores: list[dict]) -> dict:
    # Diagnostic threshold chosen only on development scores, not claimed out-of-sample accuracy.
    candidates = sorted({r["probability"] for r in scores})
    candidates = [1e-9] + [(a + b) / 2 for a, b in zip(candidates, candidates[1:])] + [1 - 1e-9]
    measured = [metrics(scores, threshold) for threshold in candidates]
    # Early interruption has priority, then avoid leaving a finished user waiting indefinitely.
    eligible = [m for m in measured if m["earlyResponseRate"] <= 0.02]
    if not eligible:
        return {"enabled": False, "reason": "No threshold satisfies the early-response limit"}
    best = min(eligible, key=lambda m: (m["wrongWaitRate"], -m["threshold"]))
    return best | {"scope": "same-dev calibration only; NOT deployment authorization"}


def compare(reports: list[Path], trainings: list[Path], output: Path, verification: Path | None = None):
    evaluations = [json.loads(p.read_text()) for p in reports]
    if len({r["datasetSha256"] for r in evaluations}) != 1:
        raise ValueError("Comparisons must use the identical development set")
    summary = []
    for report in evaluations:
        item = {k: report[k] for k in ("artifact", "backend", "device", "binaryHalf", "latencyMs")}
        item["binaryHalf"] = metrics(report["scores"], 0.5)
        item["byLanguage"] = {
            lang: {name: metrics([s for s in report["scores"] if s["lang"] == lang], m["threshold"])
                   for name, m in values.items()}
            for lang, values in report["byLanguage"].items()
        }
        item["devCalibration"] = {
            lang: calibrated_diagnostic([s for s in report["scores"] if s["lang"] == lang])
            for lang in report["byLanguage"]
        }
        summary.append(item)
    fits = []
    for path in trainings:
        receipt = json.loads(path.read_text())
        fits.append({k: v for k, v in receipt.items()
                     if k not in ("losses", "stepSeconds", "probeRowId")})
    verified = json.loads(verification.read_text()) if verification else None
    if verified:
        for item in verified["inference"]:
            item.pop("cancelledWorkerPid", None)
    write_json(output, {"productionEnabled": False, "status": "diagnostic-only",
                        "software": {name: importlib.metadata.version(name) for name in
                                     ("torch", "transformers", "peft", "livekit-agents",
                                      "livekit-plugins-turn-detector", "onnxruntime")},
                        "verification": verified,
                        "datasetSha256": evaluations[0]["datasetSha256"],
                        "evaluations": summary, "training": fits,
                        "limits": ["128 known public dev samples, not a new blind test",
                                   "Calibration scores are in-sample and optimistic",
                                   "No personal audio or real phone turn-taking acceptance",
                                   "Latency was measured with other local work, not an idle benchmark"]})


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, action="append", required=True)
    parser.add_argument("--training", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--verification", type=Path)
    args = parser.parse_args()
    compare(args.report, args.training, args.output, args.verification)
