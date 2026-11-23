"""One Host-local personal pipeline. No credentials, audio, or automatic data collection.

sync consumes a complete consented snapshot. run performs one bounded idle cycle;
the Host invokes it periodically and cancels it as soon as a call starts.
"""

import argparse
import contextlib
import fcntl
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path

from cadence import Cadence, decide
from checkpoint import sha256, write_json
from data import digest


def read(path: Path):
    return json.loads(path.read_text())


@contextlib.contextmanager
def locked(path: Path, *, blocking: bool = True):
    with path.open("a+") as stream:
        path.chmod(0o600)
        fcntl.flock(stream, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def checked_rows(rows: object) -> list[dict]:
    if not isinstance(rows, list) or len(rows) > 20_000:
        raise ValueError("Invalid training snapshot")
    ids = set()
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get("id"), str)
                or row["id"] in ids or type(row.get("label")) is not int
                or row["label"] not in (0, 1) or not isinstance(row.get("group"), str)
                or row.get("lang") not in ("zh", "en")):
            raise ValueError("Invalid or duplicate feedback row")
        ids.add(row["id"])
        messages = row.get("messages")
        if (not isinstance(messages, list) or not 1 <= len(messages) <= 20
                or messages[-1].get("role") != "user"):
            raise ValueError("Missing current user transcript")
        if any(m.get("role") not in ("user", "assistant") or not isinstance(m.get("content"), str)
               or not 1 <= len(m["content"]) <= 16000 for m in messages):
            raise ValueError("Invalid transcript")
    return rows


def fingerprints(rows: list[dict]) -> dict:
    return {r["id"]: digest(r) for r in rows}


def init(root: Path, base: Path, replay: Path, dev: Path, *, peer: str | None = None,
         policy: dict | None = None):
    from dataclasses import asdict
    from checkpoint import validate
    validate(base)
    replay_rows, dev_rows = checked_rows(read(replay)), checked_rows(read(dev))
    assert_disjoint(replay_rows, dev_rows)
    root.mkdir(parents=True, exist_ok=False, mode=0o700)
    (root / "jobs").mkdir(mode=0o700)
    config = {"schema": 1, "base": str(base.resolve()), "replay": str(replay.resolve()),
              "dev": str(dev.resolve()), "replaySha": sha256(replay), "devSha": sha256(dev),
              "peerHash": peer, "policy": asdict(Cadence(**(policy or {})))}
    write_json(root / "config.json", config)
    write_json(root / "state.json", {"schema": 1, "createdAt": time.time(), "revision": -1,
                                    "epoch": 0, "consent": False, "seenLora": {}, "seenFull": {},
                                    "active": None, "foundation": None, "pending": None,
                                    "consumedChecks": [], "checkGroups": []})
    write_json(root / "snapshot.json", [])
    write_json(root / "check-pool.json", [])


def assert_disjoint(left: list[dict], right: list[dict]):
    def keys(rows):
        # Group IDs plus normalized exact message content catch changed IDs of the same example.
        return {key for row in rows for key in ("id:" + row["id"], "group:" + row["group"],
                                                "text:" + digest(row["messages"]))}
    if keys(left) & keys(right):
        raise ValueError("Fit/calibration/check leakage")


def purge(root: Path):
    """Only generated UUID job directories, never caller-supplied base/data paths."""
    for path in (root / "jobs").iterdir():
        try:
            if str(uuid.UUID(path.name)) != path.name or path.is_symlink():
                continue
        except ValueError:
            continue
        if path.is_dir():
            shutil.rmtree(path)


def sync(root: Path, revision: int, consent: bool, rows: list[dict],
         check_rows: list[dict] | None = None) -> dict:
    if type(revision) is not int or revision < 0 or type(consent) is not bool:
        raise ValueError("Invalid consent/revision")
    checked_rows(rows)
    check_rows = checked_rows(check_rows or [])
    assert_disjoint(rows, check_rows)
    if not consent and (rows or check_rows):
        raise ValueError("Revocation must not contain text")
    with locked(root / ".state.lock"):
        state = read(root / "state.json")
        old = read(root / "snapshot.json")
        old_checks = read(root / "check-pool.json")
        if revision <= state["revision"]:
            if revision == state["revision"] and consent == state["consent"] and rows == old and check_rows == old_checks:
                return {"status": "unchanged", "revision": revision}
            return {"status": "stale", "revision": state["revision"]}
        previous, current = fingerprints(old + old_checks), fingerprints(rows + check_rows)
        invalidated = not consent or any(current.get(key) != value for key, value in previous.items())
        if invalidated:
            state.update(epoch=state["epoch"] + 1, active=None, foundation=None, pending=None,
                         seenLora={}, seenFull={}, purgeNeeded=True)
        state.update(revision=revision, consent=consent)
        write_json(root / "snapshot.json", rows)
        write_json(root / "check-pool.json", check_rows)
        write_json(root / "state.json", state)
    if invalidated:
        try:
            with locked(root / ".run.lock", blocking=False):
                purge(root)
                with locked(root / ".state.lock"):
                    latest = read(root / "state.json")
                    latest["purgeNeeded"] = False
                    write_json(root / "state.json", latest)
        except BlockingIOError:
            pass  # Running supervisor observes changed epoch, kills child, then purges.
    return {"status": "revoked" if not consent else "queued", "revision": revision,
            "rows": len(rows), "invalidated": invalidated}


def plan(root: Path, *, idle: bool, call_active: bool = False, now: float | None = None) -> dict:
    with locked(root / ".state.lock"):
        state, rows, config = read(root / "state.json"), read(root / "snapshot.json"), read(root / "config.json")
    current = fingerprints(rows)
    counts = {mode: sum(state["seen" + mode.title()].get(key) != value for key, value in current.items())
              for mode in ("lora", "full")}
    choice = decide(Cadence(**config["policy"]), state, counts, now if now is not None else time.time(),
                    idle=idle, call_active=call_active)
    return choice | {"newSamples": counts, "revision": state["revision"], "epoch": state["epoch"]}


class Interrupted(Exception):
    pass


def child(root: Path, epoch: int, args: list[str], timeout: int, log: Path):
    """A process group watchdog also reaps nested LiveKit inference subprocesses."""
    with log.open("w") as stream:
        log.chmod(0o600)
        process = subprocess.Popen([sys.executable, *args], cwd=Path(__file__).parent,
                                   stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        write_json(log.with_suffix(".worker.json"), {"pid": process.pid, "status": "running"})
        started = time.monotonic()
        try:
            while process.poll() is None:
                state = read(root / "state.json")
                if state["epoch"] != epoch or not state["consent"]:
                    raise Interrupted("snapshot_invalidated")
                if time.monotonic() - started >= timeout:
                    raise TimeoutError("worker_deadline")
                time.sleep(0.1)
            if process.returncode:
                raise RuntimeError("worker_failed")
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=3)
            # Descendants may outlive a parent that handled SIGTERM first, or crashed.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            write_json(log.with_suffix(".worker.json"), {"pid": process.pid, "status": "reaped",
                                                        "exitCode": process.returncode})


def batches(root: Path, mode: str, max_rows: int) -> tuple[list[dict], dict]:
    state, config, current = read(root / "state.json"), read(root / "config.json"), read(root / "snapshot.json")
    if sha256(Path(config["replay"])) != config["replaySha"] or sha256(Path(config["dev"])) != config["devSha"]:
        raise ValueError("Configured public replay/dev changed")
    seen = state["seen" + mode.title()]
    fresh = [r for r in current if seen.get(r["id"]) != digest(r)]
    fresh.sort(key=lambda r: digest([state["epoch"], r["id"]]))
    fresh = fresh[:max(1, max_rows // 2)]
    new_keys = {r["id"] for r in fresh} | {r["group"] for r in fresh}
    replay = checked_rows(read(Path(config["replay"]))) + [r for r in current if r not in fresh]
    replay = [r for r in replay if r["id"] not in new_keys and r["group"] not in new_keys]
    replay.sort(key=lambda r: digest([state["epoch"], r["id"]]))
    # New examples interleaved with reviewed history/public replay to limit forgetting.
    result = []
    for index, row in enumerate(fresh):
        result.append(row)
        if replay:
            result.append(replay[index % len(replay)])
    dev = checked_rows(read(Path(config["dev"])))
    assert_disjoint(result, dev)
    if any(r["group"] in state["checkGroups"] for r in result):
        raise ValueError("Previously consumed check group cannot enter training")
    return result, fingerprints(fresh)


def calibration(scores: list[dict]) -> dict:
    from compare import calibrated_diagnostic
    thresholds = {}
    for language in sorted({r["lang"] for r in scores}):
        result = calibrated_diagnostic([r for r in scores if r["lang"] == language])
        if result.get("enabled") is False:
            return {}
        thresholds[language] = result["threshold"]
    return thresholds


def check_gate(scores: list[dict], thresholds: dict) -> dict:
    from evaluate import metrics
    results = {}
    for language in thresholds:
        subset = [r for r in scores if r["lang"] == language]
        if not subset:
            return {"passed": False, "reason": "missing_check_language"}
        result = metrics(subset, thresholds[language])
        responded = result["finished"] - result["wrongWaits"] + result["earlyResponses"]
        waited = result["unfinished"] - result["earlyResponses"] + result["wrongWaits"]
        result["passed"] = (min(result["finished"], result["unfinished"], responded, waited) >= 50
                            and result["earlyResponseRate"] <= 0.02 and result["wrongWaitRate"] <= 0.05
                            and result["earlyResponses"] / max(1, responded) <= 0.02
                            and result["wrongWaits"] / max(1, waited) <= 0.05)
        results[language] = result
    return {"passed": bool(results) and all(r["passed"] for r in results.values()),
            "byLanguage": results, "note": "point gates plus reported confidence intervals, not live acceptance"}


def non_regression(candidate: list[dict], reference: list[dict], thresholds: dict,
                   reference_thresholds: dict) -> dict:
    """Paired, frozen-threshold comparison; never tune on this once-only fresh check."""
    from evaluate import metrics
    def keys(scores):
        return [(s["id"], s["lang"], s["label"]) for s in scores]
    if keys(candidate) != keys(reference) or not candidate:
        raise ValueError("Comparison requires the same check rows and order")
    for score in candidate + reference:
        if (not math.isfinite(score["probability"]) or not 0 <= score["probability"] <= 1
                or not math.isfinite(score.get("ms", -1)) or score.get("ms", -1) < 0):
            raise ValueError("Invalid probability/latency evidence")
    results = {}
    for language, threshold in thresholds.items():
        if language not in reference_thresholds:
            return {"passed": False, "reason": "missing_reference_threshold"}
        a = metrics([r for r in candidate if r["lang"] == language], threshold)
        b = metrics([r for r in reference if r["lang"] == language], reference_thresholds[language])
        results[language] = {"earlyDelta": a["earlyResponses"] - b["earlyResponses"],
                             "wrongWaitDelta": a["wrongWaits"] - b["wrongWaits"]}
    def p95(scores):
        return sorted(s["ms"] for s in scores)[math.ceil(len(scores) * 0.95) - 1]
    candidate_ms, reference_ms = p95(candidate), p95(reference)
    latency_ok = candidate_ms <= 500 and candidate_ms <= max(100, reference_ms * 1.5)
    return {"passed": bool(results) and latency_ok and
            all(r["earlyDelta"] <= 0 and r["wrongWaitDelta"] <= 0 for r in results.values()),
            "byLanguage": results, "latencyMs": {"candidateP95": candidate_ms, "referenceP95": reference_ms},
            "latencyPassed": latency_ok, "note": "zero tolerated observed regression; not statistical superiority"}


def cycle(root: Path, *, idle: bool, check: Path | None = None) -> dict:
    root = root.resolve()
    try:
        with locked(root / ".run.lock", blocking=False):
            return run_cycle(root, idle=idle, check=check)
    except BlockingIOError:
        return {"status": "busy"}


def run_cycle(root: Path, *, idle: bool, check: Path | None) -> dict:
    decision = plan(root, idle=idle)
    state, config = read(root / "state.json"), read(root / "config.json")
    pending = state.get("pending")
    pool = [r for r in read(root / "check-pool.json") if r["group"] not in state["checkGroups"]]
    required_languages = {r["lang"] for r in read(Path(config["dev"]))}
    counts = {(lang, label): sum(r["lang"] == lang and r["label"] == label for r in pool)
              for lang in required_languages for label in (0, 1)}
    automatic_check = bool(counts) and min(counts.values()) >= 50
    if automatic_check and check is None:
        check = root / "fresh-check.json"
        write_json(check, pool)
    if (pending and not check) or (not pending and not decision["mode"]) or not idle:
        return {"status": "waiting", **decision}
    policy = Cadence(**config["policy"])
    identifier = pending if pending else str(uuid.uuid4())
    job = root / "jobs" / identifier
    if not pending:
        job.mkdir(mode=0o700)
    record = read(job / "job.json") if pending else {
        "id": f"voice-fit:{identifier}", "status": "training", "mode": decision["mode"],
        "epoch": state["epoch"], "revision": state["revision"], "startedAt": time.time()}
    epoch = state["epoch"]

    def stop(_signal, _frame):
        raise Interrupted("cancelled_by_host")

    old = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
    for sig in old:
        signal.signal(sig, stop)
    try:
        write_json(job / "job.json", record)
        if not pending:
            rows, consumed = batches(root, record["mode"], decision["steps"] * 2)
            if not rows:
                raise ValueError("No new samples")
            write_json(job / "fit.json", rows)
            record["consumed"] = consumed
            args = ["run.py", "train", "--base", config["base"], "--data", str(job / "fit.json"),
                    "--output", str(job / "candidate"), "--mode", record["mode"],
                    "--steps", str(min(decision["steps"], max(1, len(rows) // 2))),
                    "--seconds", str(policy.train_seconds), "--device", "auto"]
            if state.get("foundation"):
                args += ["--foundation", str(root / state["foundation"])]
            if record["mode"] == "lora" and state.get("active") and state["active"]["mode"] == "lora":
                args += ["--resume", str(root / state["active"]["artifact"])]
            child(root, epoch, args, policy.train_seconds + 10, job / "train.log")
            record["status"] = "calibrating"
            write_json(job / "job.json", record)
            child(root, epoch, ["run.py", "evaluate", "--base", config["base"], "--data", config["dev"],
                                "--artifact", str(job / "candidate"), "--output", str(job / "dev")],
                  180, job / "dev.log")
            record["thresholds"] = calibration(read(job / "dev/report.json")["scores"])
            if not record["thresholds"]:
                record["status"] = "rejected"
            else:
                record["status"] = "awaiting_check"
        if record["status"] == "awaiting_check" and check:
            check_rows = checked_rows(read(check))
            assert_disjoint(read(job / "fit.json"), check_rows)
            assert_disjoint(read(Path(config["dev"])), check_rows)
            # Quarantine against ALL possible replay/personal fit, not just this small batch.
            assert_disjoint(read(Path(config["replay"])) + read(root / "snapshot.json"), check_rows)
            # Freeze reference thresholds BEFORE opening the held-out labels for any scoring.
            reference_args = ["--artifact", str(root / state["active"]["artifact"])] if state.get("active") else []
            if state.get("active"):
                reference_thresholds = state["active"]["thresholds"]
                record["reference"] = state["active"]["receiptSha"]
            else:
                child(root, epoch, ["run.py", "evaluate", "--base", config["base"], "--data", config["dev"],
                                    "--output", str(job / "reference-dev")], 180, job / "reference-dev.log")
                reference_thresholds = calibration(read(job / "reference-dev/report.json")["scores"])
                record["reference"] = "official_fp32_calibrated_on_dev"
            record["referenceThresholds"] = reference_thresholds
            check_sha = sha256(check)
            with locked(root / ".state.lock"):
                latest = read(root / "state.json")
                if (check_sha in latest["consumedChecks"] or
                        any(r["group"] in latest["checkGroups"] for r in check_rows)):
                    raise ValueError("Check was already consumed")
                latest["consumedChecks"].append(check_sha)
                latest["checkGroups"] += sorted({r["group"] for r in check_rows})
                write_json(root / "state.json", latest)  # Consume BEFORE inference, even if interrupted.
            child(root, epoch, ["run.py", "evaluate", "--base", config["base"], "--data", str(check.resolve()),
                                "--artifact", str(job / "candidate"), "--output", str(job / "check")],
                  300, job / "check.log")
            record["gate"] = check_gate(read(job / "check/report.json")["scores"], record["thresholds"])
            record["status"] = "rejected"
            if record["gate"]["passed"]:
                child(root, epoch, ["run.py", "evaluate", "--base", config["base"], "--data", str(check.resolve()),
                                    "--output", str(job / "reference-check"), *reference_args],
                      300, job / "reference-check.log")
                record["nonRegression"] = non_regression(read(job / "check/report.json")["scores"],
                    read(job / "reference-check/report.json")["scores"], record["thresholds"], reference_thresholds)
                if record["nonRegression"]["passed"]:
                    record["status"] = "accepted"
        with locked(root / ".state.lock"):
            latest = read(root / "state.json")
            if latest["epoch"] != epoch or not latest["consent"]:
                raise Interrupted("snapshot_invalidated")
            mode = record["mode"].title()
            latest["seen" + mode].update(record["consumed"])
            latest["last" + mode] = time.time()
            latest["pending"] = identifier if record["status"] == "awaiting_check" else None
            if record["status"] == "accepted":
                artifact = str((job / "candidate").relative_to(root))
                latest["active"] = {"artifact": artifact, "mode": record["mode"],
                                    "thresholds": record["thresholds"], "epoch": epoch,
                                    "receiptSha": sha256(job / "candidate/receipt.json")}
                if record["mode"] == "full":
                    latest["foundation"] = artifact  # Never carry an old adapter onto this new base.
                    latest["seenLora"] = {}
            latest["lastJob"] = {"id": record["id"], "status": record["status"]}
            write_json(root / "state.json", latest)
    except Exception as error:
        record["status"] = ("cancelled" if isinstance(error, Interrupted) else
                            "timed-out" if isinstance(error, TimeoutError) else "failed")
        record["errorKind"] = type(error).__name__  # Never private input or exception body.
        with locked(root / ".state.lock"):
            latest = read(root / "state.json")
            latest["lastJob"] = {"id": record["id"], "status": record["status"]}
            latest["retryAfter"] = time.time() + (30 if record["status"] == "cancelled" else policy.failure_backoff)
            latest["pending"] = None
            write_json(root / "state.json", latest)
    finally:
        record["finishedAt"] = time.time()
        write_json(job / "job.json", record)
        # Fit rows are needed only while a candidate awaits a fresh check; no per-run text log.
        if record["status"] != "awaiting_check":
            (job / "fit.json").unlink(missing_ok=True)
        if record["status"] in ("failed", "cancelled", "timed-out", "rejected"):
            weights = job / "candidate/weights"
            if weights.is_dir() and not weights.is_symlink():
                shutil.rmtree(weights)  # Non-selected generated weights; retain metadata receipt only.
        if automatic_check:
            (root / "fresh-check.json").unlink(missing_ok=True)
        for sig, handler in old.items():
            signal.signal(sig, handler)
        with locked(root / ".state.lock"):
            latest = read(root / "state.json")
            if latest.get("purgeNeeded"):
                purge(root)
                latest["purgeNeeded"] = False
                write_json(root / "state.json", latest)
    return {key: record[key] for key in ("id", "status", "mode", "revision")}


def status(root: Path) -> dict:
    with locked(root / ".state.lock"):
        state = read(root / "state.json")
        return {key: state.get(key) for key in ("revision", "epoch", "consent", "active", "pending", "lastJob")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("init", "sync", "plan", "run", "status"))
    parser.add_argument("directory", type=Path)
    parser.add_argument("--base", type=Path)
    parser.add_argument("--replay", type=Path)
    parser.add_argument("--dev", type=Path)
    parser.add_argument("--peer-hash")
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--check", type=Path)
    parser.add_argument("--idle", action="store_true")
    args = parser.parse_args()
    if args.action == "init":
        if not all((args.base, args.replay, args.dev)):
            parser.error("init requires --base, --replay and --dev")
        init(args.directory, args.base, args.replay, args.dev, peer=args.peer_hash,
             policy=read(args.policy) if args.policy else None)
        result = {"status": "initialized"}
    elif args.action == "sync":
        snapshot = json.loads(sys.stdin.buffer.read(4_000_001))
        result = sync(args.directory, snapshot["revision"], snapshot["consent"], snapshot["rows"],
                      snapshot.get("checkRows"))
    elif args.action == "plan":
        result = plan(args.directory, idle=args.idle)
    elif args.action == "run":
        result = cycle(args.directory, idle=args.idle, check=args.check)
    else:
        result = status(args.directory)
    print(json.dumps(result), flush=True)
    return {"failed": 1, "rejected": 2, "cancelled": 130, "timed-out": 124}.get(result["status"], 0) if "status" in result else 0


if __name__ == "__main__":
    raise SystemExit(main())
