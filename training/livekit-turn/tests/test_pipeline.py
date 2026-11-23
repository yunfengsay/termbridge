import time
from pathlib import Path

import pytest

import checkpoint
import pipeline
from cadence import Cadence, decide
from checkpoint import REVISION, WEIGHTS_SHA, sha256, write_json
from lineage import resolve_foundation, training_lineage


def row(i, prefix="human"):
    return {"id": f"{prefix}-{i}", "group": f"{prefix}-group-{i}", "label": i % 2, "lang": "zh",
            "messages": [{"role": "user", "content": f"{prefix} 内容 {i}"}]}


@pytest.fixture
def root(tmp_path, monkeypatch):
    monkeypatch.setattr(checkpoint, "validate", lambda *_args, **_kwargs: None)
    write_json(tmp_path / "replay.json", [row(i, "replay") for i in range(100)])
    write_json(tmp_path / "dev.json", [row(i, "dev") for i in range(100)])
    base = tmp_path / "base"
    base.mkdir()
    root = tmp_path / "pipeline"
    pipeline.init(root, base, tmp_path / "replay.json", tmp_path / "dev.json")
    pipeline.sync(root, 1, True, [row(i) for i in range(40)])
    return root


def test_frequent_lora_and_weekly_full_have_independent_cursors_and_busy_guards():
    policy = Cadence()
    state = {"consent": True, "createdAt": 1000}
    counts = {"lora": 32, "full": 300}
    assert decide(policy, state, counts, 2000, idle=True, call_active=False)["mode"] == "lora"
    assert decide(policy, state, counts, 1000 + 7 * 86400, idle=True, call_active=False)["mode"] == "full"
    assert decide(policy, state, counts, 1e6, idle=True, call_active=True)["mode"] is None
    assert decide(policy, state, counts, 1e6, idle=False, call_active=False)["mode"] is None
    state["lastLora"] = 1999
    assert decide(policy, state, counts, 2000, idle=True, call_active=False)["mode"] is None


def test_sync_idempotency_and_stale_replay(root):
    assert pipeline.sync(root, 1, True, [row(i) for i in range(40)])["status"] == "unchanged"
    assert pipeline.sync(root, 1, False, [])["status"] == "stale"
    assert pipeline.plan(root, idle=True)["mode"] == "lora"
    assert pipeline.plan(root, idle=False)["mode"] is None


def test_revocation_removes_active_and_generated_private_artifacts(root):
    job = root / "jobs/11111111-1111-4111-8111-111111111111"
    job.mkdir()
    write_json(job / "fit.json", [row(1)])
    state = pipeline.read(root / "state.json")
    state["active"] = {"artifact": "jobs/private"}
    write_json(root / "state.json", state)
    result = pipeline.sync(root, 2, False, [])
    assert result["status"] == "revoked" and not job.exists()
    assert pipeline.status(root)["active"] is None
    assert pipeline.read(root / "snapshot.json") == []
    assert pipeline.plan(root, idle=True)["reason"] == "consent_required"


def test_correction_invalidates_weights_but_append_does_not(root):
    first = pipeline.status(root)["epoch"]
    pipeline.sync(root, 2, True, [row(i) for i in range(41)])
    assert pipeline.status(root)["epoch"] == first
    changed = [row(i) for i in range(41)]
    changed[0]["label"] = 1
    pipeline.sync(root, 3, True, changed)
    assert pipeline.status(root)["epoch"] == first + 1


def test_no_two_training_jobs_and_check_leak_rejected(root):
    with pipeline.locked(root / ".run.lock"):
        assert pipeline.cycle(root, idle=True)["status"] == "busy"
    with pytest.raises(ValueError, match="leakage"):
        pipeline.sync(root, 2, True, [row(1)], [row(1)])


def mock_worker(root, epoch, args, timeout, log):
    destination = Path(args[args.index("--output") + 1])
    destination.mkdir()
    if args[1] == "train":
        (destination / "weights").mkdir()
        (destination / "weights/model.safetensors").write_bytes(b"unit fixture, not a real model")
        write_json(destination / "receipt.json", {"status": "completed", "mode": "lora"})
    else:
        rows = pipeline.read(Path(args[args.index("--data") + 1]))
        scores = [{"id": r["id"], "lang": r["lang"], "label": r["label"],
                   "probability": 0.999 if r["label"] else 0.001, "ms": 50} for r in rows]
        write_json(destination / "report.json", {"scores": scores})


def test_pipeline_waits_for_new_check_then_accepts_and_never_reuses_check(root, monkeypatch):
    monkeypatch.setattr(pipeline, "child", mock_worker)
    result = pipeline.cycle(root, idle=True)
    assert result["status"] == "awaiting_check"
    assert pipeline.status(root)["active"] is None
    assert pipeline.cycle(root, idle=True)["status"] == "waiting"
    check = root.parent / "fresh.json"
    write_json(check, [row(i, "fresh-test") for i in range(120)])
    result = pipeline.cycle(root, idle=True, check=check)
    assert result["status"] == "accepted"
    state = pipeline.read(root / "state.json")
    assert state["active"]["mode"] == "lora" and state["pending"] is None
    assert sha256(check) in state["consumedChecks"]
    # New candidate, same check must be rejected BEFORE executing check inference.
    state["lastLora"] = 0
    write_json(root / "state.json", state)
    pipeline.sync(root, 2, True, [row(i) for i in range(100)])
    assert pipeline.cycle(root, idle=True, check=check)["status"] == "failed"


def test_failed_worker_backoff_does_not_advance_sample_cursor(root, monkeypatch):
    def fail(*_args):
        raise RuntimeError("do not log a private transcript")
    monkeypatch.setattr(pipeline, "child", fail)
    assert pipeline.cycle(root, idle=True)["status"] == "failed"
    state = pipeline.read(root / "state.json")
    assert state["seenLora"] == {} and state["active"] is None
    assert pipeline.plan(root, idle=True)["reason"] == "failure_backoff"
    assert "private transcript" not in (root / "state.json").read_text()


def test_new_call_cancellation_returns_terminal_state(root, monkeypatch):
    monkeypatch.setattr(pipeline, "child", lambda *_args: (_ for _ in ()).throw(pipeline.Interrupted()))
    assert pipeline.cycle(root, idle=True)["status"] == "cancelled"
    assert pipeline.status(root)["lastJob"]["status"] == "cancelled"


def fake_artifact(path: Path, mode: str):
    (path / "weights").mkdir(parents=True)
    weights = path / "weights/model.safetensors"
    weights.write_bytes(path.name.encode())
    write_json(path / "receipt.json", {"status": "completed", "mode": mode,
        "revision": REVISION, "baseSha256": WEIGHTS_SHA,
        "weightFiles": {"model.safetensors": {"sha256": sha256(weights)}}})


def test_old_adapter_cannot_be_applied_to_new_full_foundation(tmp_path):
    old, new, adapter = [tmp_path / name for name in ("old-base", "new-base", "adapter")]
    for path, mode in ((old, "full"), (new, "full"), (adapter, "lora")):
        fake_artifact(path, mode)
    _, metadata = training_lineage("lora", adapter, old, None)
    value = pipeline.read(adapter / "receipt.json") | metadata
    write_json(adapter / "receipt.json", value)
    assert resolve_foundation(adapter, value) == old
    effective, resumed = training_lineage("lora", tmp_path / "next", None, adapter)
    assert effective == old and resumed["resume"] and resumed["optimizerResumed"] is False
    with pytest.raises(ValueError, match="new foundation"):
        training_lineage("lora", tmp_path / "bad", new, adapter)


def test_full_public_check_cannot_be_replayed_into_fit(root):
    state = pipeline.read(root / "state.json")
    state["checkGroups"] = [row(0)["group"]]
    write_json(root / "state.json", state)
    with pytest.raises(ValueError, match="consumed check"):
        pipeline.batches(root, "full", 400)


def test_weekly_full_clears_old_adapter_when_new_base_is_accepted(root, monkeypatch):
    monkeypatch.setattr(pipeline, "child", mock_worker)
    state = pipeline.read(root / "state.json")
    state["createdAt"] = time.time() - 8 * 86400
    write_json(root / "state.json", state)
    pipeline.sync(root, 2, True, [row(i) for i in range(220)])
    check = root.parent / "check.json"
    write_json(check, [row(i, "fresh") for i in range(120)])
    assert pipeline.cycle(root, idle=True, check=check)["mode"] == "full"
    state = pipeline.read(root / "state.json")
    assert state["active"]["mode"] == "full"
    assert state["foundation"] == state["active"]["artifact"] and state["seenLora"] == {}


def test_absolute_pass_cannot_hide_regression_against_reference(root, monkeypatch):
    def regressed(*args):
        mock_worker(*args)
        call = args[2]
        destination = Path(call[call.index("--output") + 1])
        if destination.name == "check":
            report = pipeline.read(destination / "report.json")
            next(r for r in report["scores"] if r["label"] == 0)["probability"] = 0.999
            write_json(destination / "report.json", report)
    monkeypatch.setattr(pipeline, "child", regressed)
    check = root.parent / "fresh.json"
    write_json(check, [row(i, "fresh") for i in range(120)])
    result = pipeline.cycle(root, idle=True, check=check)
    record = pipeline.read(root / "jobs" / result["id"].split(":")[1] / "job.json")
    assert record["gate"]["passed"]  # 1/60 still passes a 2% absolute gate.
    assert not record["nonRegression"]["passed"]
    assert result["status"] == "rejected" and pipeline.status(root)["active"] is None


def test_model_latency_and_pairing_are_also_release_gates():
    scores = [{"id": str(i), "lang": "zh", "label": i % 2, "probability": float(i % 2), "ms": 50}
              for i in range(120)]
    thresholds = {"zh": 0.5}
    slow = [s | {"ms": 600} for s in scores]
    assert not pipeline.non_regression(slow, scores, thresholds, thresholds)["passed"]
    assert pipeline.non_regression(scores, scores, thresholds, thresholds)["passed"]
    with pytest.raises(ValueError, match="same check"):
        pipeline.non_regression(scores, scores[::-1], thresholds, thresholds)


def test_partial_language_pool_is_not_prematurely_consumed(root, monkeypatch):
    monkeypatch.setattr(pipeline, "child", mock_worker)
    dev = root.parent / "dev.json"
    rows = pipeline.read(dev) + [row(i, "english-dev") | {"lang": "en"} for i in range(100)]
    write_json(dev, rows)
    config = pipeline.read(root / "config.json") | {"devSha": sha256(dev)}
    write_json(root / "config.json", config)
    pipeline.sync(root, 2, True, [row(i) for i in range(40)], [row(i, "zh-check") for i in range(120)])
    assert pipeline.cycle(root, idle=True)["status"] == "awaiting_check"
    assert pipeline.cycle(root, idle=True)["status"] == "waiting"
    assert pipeline.read(root / "state.json")["consumedChecks"] == []
