"""Recover lossless roles from the public corpus; consume existing group-safe splits."""

import hashlib
import json
import re
from collections import defaultdict
from pathlib import Path

from checkpoint import sha256, write_json

TRAIN_SHA = "c43efde49c8a2d632095bc0e7dcd47080a5f0ea198d34a7c3b24a117cfc0eb3d"
TURN = re.compile(
    r"^(Human|Agent)\[(?:历史|实时)\]:([\s\S]*?)(?=^(?:Human|Agent)\[(?:历史|实时)\]:|\Z)",
    re.MULTILINE,
)


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":"))
                          .encode()).hexdigest()


def dialogs(raw: list[dict]) -> dict[str, list[dict]]:
    output = {}
    for row in raw:
        if row["source"] not in ("Ke-多轮", "Ke-EN") or row["output"] not in ("<完成>", "<未完>"):
            continue
        if row["input"] != "":
            raise ValueError("Unexpected corpus input field")
        messages = [{"role": "user" if role == "Human" else "assistant", "content": text.strip()}
                    for role, text in TURN.findall(row["instruction"])]
        if not messages or messages[-1]["role"] != "user":
            raise ValueError("Expected final human turn")
        output[digest(messages)] = messages
    return output


def stratified(rows: list[dict], count: int) -> list[dict]:
    """Deterministic balanced prefix by language/label; never score before selecting."""
    groups = defaultdict(list)
    for row in sorted(rows, key=lambda row: digest([20260908, row["id"]])):
        groups[(row["lang"], row["label"])].append(row)
    result = []
    while len(result) < min(count, len(rows)):
        for key in sorted(groups):
            if groups[key] and len(result) < count:
                result.append(groups[key].pop())
    return result


def prepare(original: Path, splits: Path, output: Path, dev_count: int = 128) -> None:
    if sha256(original) != TRAIN_SHA:
        raise ValueError("Unexpected public corpus hash")
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    lookup = dialogs(json.loads(original.read_text()))
    parts = {}
    for part in ("train", "dev"):
        raw = json.loads((splits / f"{part}.json").read_text())
        parts[part] = []
        for row in raw:
            messages = lookup[row["id"]]
            if messages[-1]["content"] != row["text"]:
                raise ValueError("Split no longer matches original dialogue")
            parts[part].append({key: row[key] for key in ("id", "group", "label", "lang")} |
                               {"messages": messages})
    if {r["group"] for r in parts["train"]} & {r["group"] for r in parts["dev"]}:
        raise ValueError("Train/dev group leakage")
    parts["dev"] = stratified(parts["dev"], dev_count)
    # Balanced order is shared across both training modes; full corpus remains available.
    parts["train"] = stratified(parts["train"], len(parts["train"]))
    for part, rows in parts.items():
        write_json(output / f"{part}.json", rows)
    write_json(output / "manifest.json", {
        "sourceSha256": TRAIN_SHA, "source": "KE-Team/SemanticVAD-Dataset",
        "revision": "b5b536e96076a156e79b7e6db9ca8fd100d3f976",
        "splits": {name: {"count": len(rows), "sha256": sha256(output / f"{name}.json")}
                   for name, rows in parts.items()},
        "evaluation": "previously-used public dev, diagnostic only, not blind acceptance",
        "privateData": False,
    })
