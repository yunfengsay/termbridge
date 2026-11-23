"""Frequent small LoRA updates, infrequent consolidation; no learning inside a call."""

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Cadence:
    lora_new: int = 32
    lora_interval: int = 600
    lora_steps: int = 32
    full_new: int = 200
    full_interval: int = 7 * 86400
    full_steps: int = 512
    failure_backoff: int = 1800
    train_seconds: int = 900

    def __post_init__(self):
        for value in asdict(self).values():
            if type(value) is not int or value <= 0:
                raise ValueError("Cadence values must be positive integers")
        if self.train_seconds > 3600 or max(self.lora_steps, self.full_steps) > 4096:
            raise ValueError("Training budget too large")


def decide(policy: Cadence, state: dict, counts: dict, now: float,
           *, idle: bool, call_active: bool) -> dict:
    def wait(reason):
        return {"mode": None, "reason": reason}

    if not state.get("consent"):
        return wait("consent_required")
    if call_active or not idle:
        return wait("host_busy")
    if state.get("pending"):
        return wait("candidate_awaiting_check")
    if now < state.get("retryAfter", 0):
        return wait("failure_backoff")
    if (counts["full"] >= policy.full_new and
            now - state.get("lastFull", state["createdAt"]) >= policy.full_interval):
        return {"mode": "full", "steps": policy.full_steps, "reason": "periodic_consolidation"}
    if (counts["lora"] >= policy.lora_new and
            now - state.get("lastLora", 0) >= policy.lora_interval):
        return {"mode": "lora", "steps": policy.lora_steps, "reason": "incremental_feedback"}
    return wait("insufficient_new_feedback_or_cooldown")
