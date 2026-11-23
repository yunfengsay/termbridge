"""Trainable LiveKit derivative and its official text preprocessing contract."""

from pathlib import Path

import torch
from livekit.plugins.turn_detector.base import MAX_HISTORY_TOKENS, MAX_HISTORY_TURNS
from livekit.plugins.turn_detector.multilingual import _EUORunnerMultilingual
from peft import LoraConfig, PeftModel, TaskType, get_peft_model
from transformers import AutoModelForCausalLM, AutoTokenizer

from checkpoint import validate
from lineage import receipt, resolve_foundation, foundation_id

TARGET_MODULES = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


class Format(_EUORunnerMultilingual):
    """Reuse pinned plugin normalization/template, not a hand-written approximation."""

    def __init__(self, tokenizer):
        self._tokenizer = tokenizer

    def text(self, messages: list[dict]) -> str:
        selected = [{"role": m["role"], "content": m["content"]} for m in messages
                    if m["role"] in ("user", "assistant") and m["content"]][-MAX_HISTORY_TURNS:]
        if not selected or selected[-1]["role"] != "user":
            raise ValueError("Turn detection needs current user speech")
        if any(not isinstance(m["content"], str) or len(m["content"]) > 16000 for m in selected):
            raise ValueError("Invalid or oversized turn text")
        if any("<|" in m["content"] or "<完成>" in m["content"] or "<未完>" in m["content"]
               for m in selected):
            raise ValueError("Dataset labels/control tokens must not enter model input")
        return self._format_chat_ctx(selected)


def tokenizer_for(base: Path):
    tokenizer = AutoTokenizer.from_pretrained(
        base, local_files_only=True, trust_remote_code=False,
        truncation_side="left", padding_side="left",
    )
    if tokenizer.convert_tokens_to_ids("<|im_end|>") != 151645:
        raise ValueError("Unexpected end-of-turn token")
    return tokenizer


def batch_tokens(tokenizer, messages: list[list[dict]], device: str, *, fixed_length: bool = False) -> dict:
    formatter = Format(tokenizer)
    return tokenizer([formatter.text(dialog) for dialog in messages],
                     add_special_tokens=False, truncation=True, max_length=MAX_HISTORY_TOKENS,
                     padding="max_length" if fixed_length else True, return_tensors="pt").to(device)


def load(base: Path, mode: str, device: str, artifact: Path | None = None, *,
         trainable: bool = False, foundation: Path | None = None):
    validate(base)
    source = base
    if artifact:
        manifest = receipt(artifact)
        if trainable and mode != manifest["mode"]:
            raise ValueError("Resume mode mismatch")
        mode = manifest["mode"]
        if mode == "lora":
            inherited = resolve_foundation(artifact, manifest)
            if foundation is not None and foundation_id(foundation) != foundation_id(inherited):
                raise ValueError("Adapter/foundation mismatch")
            foundation = inherited
        if mode == "full":
            source = artifact / "weights"
    if foundation and not (artifact and mode == "full"):
        foundation_id(foundation)  # Verify full checkpoint before using it as a new base.
        source = foundation / "weights"
    model = AutoModelForCausalLM.from_pretrained(
        source, local_files_only=True, trust_remote_code=False, use_safetensors=True,
        dtype=torch.float32, attn_implementation="sdpa",
    )
    model.config.use_cache = False
    if mode == "lora":
        if artifact:
            model = PeftModel.from_pretrained(model, artifact / "weights", is_trainable=trainable)
        else:
            model = get_peft_model(model, LoraConfig(
                task_type=TaskType.CAUSAL_LM, r=8, lora_alpha=16, lora_dropout=0,
                target_modules=TARGET_MODULES, bias="none",
            ))
    elif mode not in ("full", "baseline"):
        raise ValueError("Mode must be baseline/full/lora")
    return model.to(device)


def eou_logit(logits: torch.Tensor, eou: int) -> torch.Tensor:
    """Exact binary log odds, stable even when p(EOU) is tiny; full vocab negatives."""
    logits = logits.float()
    end = logits[:, eou]
    others = logits.clone()
    others[:, eou] = -torch.inf
    return end - torch.logsumexp(others, dim=-1)


def forward(model, tokens: dict) -> torch.Tensor:
    # Explicit positions keep left-padded training equivalent to unpadded plugin inference.
    positions = tokens["attention_mask"].long().cumsum(-1) - 1
    positions.masked_fill_(tokens["attention_mask"] == 0, 0)
    logits = model(**tokens, position_ids=positions, logits_to_keep=1).logits[:, -1, :]
    return eou_logit(logits, model.config.eos_token_id)


def device_name(requested: str) -> str:
    if requested != "auto":
        return requested
    if torch.cuda.is_available():
        return "cuda"
    return "mps" if torch.backends.mps.is_available() else "cpu"


def parameter_probe(model) -> dict:
    """Sample every tensor to audit scope without duplicating 1 GiB of base weights."""
    return {name: parameter.detach().flatten()[::max(1, parameter.numel() // 8)][:8].cpu().clone()
            for name, parameter in model.named_parameters()}
