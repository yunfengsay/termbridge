"""Deterministic echo-only pipe benchmark, not a human listening/road-noise test."""
import argparse
from array import array
import json
import math
from pathlib import Path
import random
import statistics
import time

import jaec


def run(root):
    rng = random.Random(42)
    length, delay = 16000 * 10, 800
    reference = array("h", (rng.randint(-6000, 6000) for _ in range(length)))
    microphone = array("h", (0 if i < delay else round(reference[i - delay] * 0.65)
                             for i in range(length)))
    engine = jaec.Jaec(root)
    output, timings = array("h"), []
    try:
        for offset in range(0, length, 160):
            started = time.perf_counter()
            frame = engine.process(microphone[offset:offset + 160].tobytes(),
                                   reference[offset:offset + 160].tobytes())
            timings.append(time.perf_counter() - started)
            output.frombytes(frame)
    finally:
        engine.close()
    # Exclude adaptation warmup; stationary synthetic echo only, no near-end speech.
    window = slice(16000 * 5, None)
    before = sum(x * x for x in microphone[window])
    after = sum(x * x for x in output[window])
    return {"fixture": "seed42-broadband-linear-echo-only", "audioSeconds": 10,
            "echoDelayMs": 50, "referenceGain": 0.65,
            "rtf": sum(timings) / 10, "frameP50Ms": statistics.median(timings) * 1000,
            "frameP95Ms": sorted(timings)[math.ceil(len(timings) * .95) - 1] * 1000,
            "steadyStateErleDb": 10 * math.log10((before + 1) / (after + 1)),
            "clippedSamples": sum(abs(x) >= 32767 for x in output),
            "samples": len(output)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", type=Path,
                        default=Path.home() / ".termbridge/models/jaec" / jaec.WEIGHTS[:12])
    print(json.dumps(run(parser.parse_args().model_dir), indent=2))
