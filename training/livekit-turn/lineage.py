"""Immutable foundation identity: an adapter is meaningful only on its trained base."""

import os
from pathlib import Path
import json

from checkpoint import REVISION, WEIGHTS_SHA, sha256


def receipt(path: Path) -> dict:
    value = json.loads((path / "receipt.json").read_text())
    if value.get("status") != "completed" or value.get("mode") not in ("full", "lora"):
        raise ValueError("Incomplete derivative")
    if value.get("revision") != REVISION or value.get("baseSha256") != WEIGHTS_SHA:
        raise ValueError("Wrong upstream lineage")
    files = value.get("weightFiles", {})
    if not files or any(Path(name).name != name or not name.endswith(".safetensors")
                        or sha256(path / "weights" / name) != info["sha256"]
                        for name, info in files.items()):
        raise ValueError("Derivative checksum mismatch")
    return value


def foundation_id(path: Path | None) -> str:
    if path is None:
        return WEIGHTS_SHA
    value = receipt(path)
    if value["mode"] != "full":
        raise ValueError("Foundation must be full weights, not another LoRA")
    return sha256(path / "receipt.json")


def resolve_foundation(artifact: Path, value: dict) -> Path | None:
    reference = value.get("foundation")
    if reference is None:
        return None  # Compatible with first-round official-base derivatives.
    path = (artifact / reference["path"]).resolve()
    if foundation_id(path) != reference["sha256"]:
        raise ValueError("Adapter foundation changed; rebuild the adapter")
    return path


def training_lineage(mode: str, output: Path, foundation: Path | None,
                     resume: Path | None) -> tuple[Path | None, dict]:
    inherited = None
    if resume:
        prior = receipt(resume)
        if prior["mode"] != mode:
            raise ValueError("Resume must use the same training mode")
        inherited = resolve_foundation(resume, prior) if mode == "lora" else None
        if mode == "lora" and foundation is not None and foundation_id(foundation) != foundation_id(inherited):
            raise ValueError("Cannot move old LoRA to a new foundation; start a fresh adapter")
    effective = inherited if resume and mode == "lora" else foundation
    if mode == "full" and resume and foundation:
        raise ValueError("Choose either full resume or foundation")
    metadata = {"foundation": None, "resume": None, "optimizerResumed": False}
    if effective:
        metadata["foundation"] = {"path": os.path.relpath(effective.resolve(), output.resolve()),
                                  "sha256": foundation_id(effective)}
    if resume:
        metadata["resume"] = {"sha256": sha256(resume / "receipt.json")}
    return effective, metadata
