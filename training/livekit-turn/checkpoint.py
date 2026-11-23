"""Pin the actual multilingual weights, not the incompatible HF main branch."""

import hashlib
import json
import subprocess
from pathlib import Path

REPO = "livekit/turn-detector"
TAG = "v0.4.1-intl"
REVISION = "87e35fcb1e60a569bea70346191c4886ea92e281"
WEIGHTS_SHA = "a5d992655d207afeb1fd7ec0538300561d406c0d29c4471418f79e4a3250c2c3"
ONNX_SHA = "bd2c30776882138a1d95a07faddc13756fe1a35bef6323505f1124fca349bc9c"
FILES = (
    "config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
    "added_tokens.json", "merges.txt", "vocab.json", "languages.json", "LICENSE",
    "model.safetensors", "onnx/model_q8.onnx",
)


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path: Path, value: object) -> None:
    """Private, atomic output; never use for credentials or model input logging."""
    temporary = path.with_suffix(path.suffix + ".partial")
    with temporary.open("w", encoding="utf-8") as stream:
        temporary.chmod(0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    temporary.replace(path)


def validate(path: Path, *, require_onnx: bool = False) -> None:
    config = json.loads((path / "config.json").read_text())
    expected = {"model_type": "qwen2", "hidden_size": 896, "num_hidden_layers": 24,
                "intermediate_size": 1216, "vocab_size": 151936, "eos_token_id": 151645}
    if any(config.get(key) != value for key, value in expected.items()):
        raise ValueError("Not the pinned LiveKit multilingual checkpoint; do not use main")
    if sha256(path / "model.safetensors") != WEIGHTS_SHA:
        raise ValueError("LiveKit safetensors checksum mismatch")
    if require_onnx and sha256(path / "onnx/model_q8.onnx") != ONNX_SHA:
        raise ValueError("LiveKit ONNX checksum mismatch")


def download(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    manifest = {"repo": REPO, "tag": TAG, "revision": REVISION, "files": {}}
    for name in FILES:
        target = path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            partial = target.with_suffix(target.suffix + ".partial")
            # No pickle checkpoints, custom model code, browser state or cloud credentials.
            subprocess.run([
                "curl", "--fail", "--silent", "--show-error", "--location",
                "--retry", "3", "--retry-all-errors", "--connect-timeout", "30",
                "--max-time", "1800", "--continue-at", "-", "--output", str(partial),
                f"https://huggingface.co/{REPO}/resolve/{REVISION}/{name}",
            ], check=True)
            partial.chmod(0o600)
            partial.replace(target)
        manifest["files"][name] = {"sha256": sha256(target), "bytes": target.stat().st_size}
        print(json.dumps({"downloaded": name, "bytes": target.stat().st_size}), flush=True)
    validate(path, require_onnx=True)
    write_json(path / "manifest.json", manifest)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    download(parser.parse_args().directory)
