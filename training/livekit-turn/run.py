"""Explicit offline commands. Does not read production settings or start an audio device."""

import argparse
import asyncio
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    prepare = commands.add_parser("prepare")
    prepare.add_argument("--original", type=Path, required=True)
    prepare.add_argument("--splits", type=Path, required=True)
    prepare.add_argument("--output", type=Path, required=True)
    prepare.add_argument("--dev-count", type=int, default=128)
    for command in ("train", "evaluate"):
        sub = commands.add_parser(command)
        sub.add_argument("--base", type=Path, required=True)
        sub.add_argument("--data", type=Path, required=True)
        sub.add_argument("--output", type=Path, required=True)
        sub.add_argument("--device", choices=("auto", "cpu", "mps", "cuda"), default="cpu")
        if command == "train":
            sub.add_argument("--mode", choices=("full", "lora"), required=True)
            sub.add_argument("--steps", type=int, default=128)
            sub.add_argument("--batch-size", type=int, default=2)
            sub.add_argument("--seconds", type=int, default=1800)
            sub.add_argument("--foundation", type=Path, help="verified full weights for a fresh adapter/base")
            sub.add_argument("--resume", type=Path, help="continue same-mode weights; fresh optimizer")
        else:
            sub.add_argument("--artifact", type=Path)
            sub.add_argument("--backend", choices=("torch", "onnx"), default="torch")
            sub.add_argument("--timeout", type=float, default=3)
    args = vars(parser.parse_args())
    command = args.pop("command")
    if command == "prepare":
        from data import prepare
        prepare(**args)
        return 0
    if command == "train":
        from train import train
        result = train(**args)
    else:
        from evaluate import evaluate
        from model import device_name
        args["device"] = device_name(args["device"])
        result = asyncio.run(evaluate(**args))
    print(json.dumps({key: value for key, value in result.items()
                      if key not in ("scores", "losses", "stepSeconds")}, ensure_ascii=False), flush=True)
    return {"completed": 0, "cancelled": 130, "timed-out": 124}.get(result["status"], 1)


if __name__ == "__main__":
    raise SystemExit(main())
