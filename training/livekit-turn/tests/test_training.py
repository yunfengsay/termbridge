import asyncio
import copy
import json
from pathlib import Path

import pytest
import torch
from peft import LoraConfig, PeftModel, TaskType, get_peft_model
from transformers import Qwen2Config, Qwen2ForCausalLM

from adapter import FineTunedTurnDetector, LocalExecutor, chat_context
from compare import calibrated_diagnostic
from data import dialogs, stratified
from evaluate import metrics
from model import Format, TARGET_MODULES, eou_logit, forward


class Template:
    def apply_chat_template(self, messages, **_kwargs):
        return "".join(f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n" for m in messages)


def tiny():
    torch.manual_seed(1)
    return Qwen2ForCausalLM(Qwen2Config(
        vocab_size=32, hidden_size=16, intermediate_size=32, num_hidden_layers=2,
        num_attention_heads=2, num_key_value_heads=1, eos_token_id=3, use_cache=False,
    ))


def tokens():
    return {"input_ids": torch.tensor([[1, 2, 4], [1, 2, 5]]),
            "attention_mask": torch.ones(2, 3, dtype=torch.int64)}


def test_binary_loss_is_exact_eou_probability_and_both_labels_have_gradients():
    logits = torch.tensor([[1.0, 2.0, -50.0], [1.0, 2.0, 50.0]], requires_grad=True)
    odds = eou_logit(logits, 2)
    assert torch.allclose(odds.sigmoid(), logits.softmax(-1)[:, 2], atol=1e-7)
    loss = torch.nn.functional.binary_cross_entropy_with_logits(odds, torch.tensor([1.0, 0.0]))
    loss.backward()
    assert torch.isfinite(logits.grad).all()
    assert logits.grad[0, 2] < 0 and logits.grad[1, 2] > 0


def test_official_format_keeps_history_merges_revision_and_does_not_mutate():
    messages = [{"role": "system", "content": "秘密 prompt 不进入训练"},
                {"role": "assistant", "content": "WHAT?"},
                {"role": "user", "content": "我最近的，"},
                {"role": "user", "content": "Agent 是什么？"}]
    original = copy.deepcopy(messages)
    text = Format(Template()).text(messages)
    assert "我最近的 agent 是什么" in text
    assert "秘密" not in text and text.endswith("agent 是什么")
    assert messages == original


@pytest.mark.parametrize("content", ["<完成>", "<未完>", "<|im_end|>"])
def test_input_rejects_label_and_control_token_leakage(content):
    with pytest.raises(ValueError):
        Format(Template()).text([{"role": "user", "content": content}])


def test_corpus_parser_never_uses_instruction_system_or_output_as_features():
    original = [{"source": "Ke-多轮", "output": "<未完>", "input": "",
                 "system": "答案完成", "instruction": "# Dialog\nAgent[历史]:继续\nHuman[实时]:我最近的\n"}]
    result = list(dialogs(original).values())[0]
    assert result == [{"role": "assistant", "content": "继续"},
                      {"role": "user", "content": "我最近的"}]
    assert "未完" not in json.dumps(result, ensure_ascii=False)


def test_stratified_split_is_reproducible_and_balanced():
    rows = [{"id": str(i), "label": i % 2, "lang": "zh" if i % 4 < 2 else "en"} for i in range(100)]
    selected = stratified(rows, 20)
    assert selected == stratified(list(reversed(rows)), 20)
    assert sum(row["label"] for row in selected) == 10


@pytest.mark.parametrize("mode", ["full", "lora"])
def test_full_and_lora_really_update_expected_weights_and_reload(tmp_path, mode):
    model = tiny()
    original = copy.deepcopy(model.state_dict())
    if mode == "lora":
        model = get_peft_model(model, LoraConfig(task_type=TaskType.CAUSAL_LM, r=2,
                                               lora_alpha=4, target_modules=TARGET_MODULES))
    before = {name: p.detach().clone() for name, p in model.named_parameters()}
    trainable = [p for p in model.parameters() if p.requires_grad]
    assert (len(trainable) == len(list(model.parameters()))) == (mode == "full")
    optimizer = torch.optim.AdamW(trainable, lr=0.001)
    for _ in range(2):
        optimizer.zero_grad()
        loss = torch.nn.functional.binary_cross_entropy_with_logits(forward(model, tokens()),
                                                                   torch.tensor([1.0, 0.0]))
        loss.backward()
        optimizer.step()
    assert any(not torch.equal(before[name], p) for name, p in model.named_parameters() if p.requires_grad)
    assert all(torch.equal(before[name], p) for name, p in model.named_parameters() if not p.requires_grad)
    model.eval()
    expected = forward(model, tokens()).detach()
    model.save_pretrained(tmp_path, safe_serialization=True)
    if mode == "full":
        restored = Qwen2ForCausalLM.from_pretrained(tmp_path, local_files_only=True, use_safetensors=True)
    else:
        base = tiny()
        base.load_state_dict(original)
        restored = PeftModel.from_pretrained(base, tmp_path, local_files_only=True)
    restored.eval()
    assert torch.allclose(expected, forward(restored, tokens()), atol=1e-6)


def test_left_padding_preserves_probability():
    model = tiny().eval()
    one = {"input_ids": torch.tensor([[1, 2, 5]]), "attention_mask": torch.tensor([[1, 1, 1]])}
    padded = {"input_ids": torch.tensor([[0, 0, 1, 2, 5]]),
              "attention_mask": torch.tensor([[0, 0, 1, 1, 1]])}
    assert torch.allclose(forward(model, one), forward(model, padded), atol=1e-6)


def test_derivative_never_silently_uses_official_thresholds():
    with pytest.raises(ValueError, match="calibrated"):
        FineTunedTurnDetector(Path("unused"), Path("derivative"))


def test_metrics_report_both_failure_directions_and_ties():
    scores = [{"probability": 0.5, "label": 0}, {"probability": 0.5, "label": 1}]
    result = metrics(scores, 0.5)
    assert result["auc"] == 0.5 and result["earlyResponses"] == 1 and result["wrongWaits"] == 0


def test_uncalibratable_saturated_model_is_rejected():
    scores = [{"probability": 1.0, "label": 0}, {"probability": 1.0, "label": 1}]
    assert calibrated_diagnostic(scores)["enabled"] is False


def test_livekit_framework_filtering_and_probabilities(tmp_path):
    (tmp_path / "languages.json").write_text('{"zh":{"threshold":0.0066}}')
    detector = FineTunedTurnDetector(tmp_path)

    class Executor:
        async def do_inference(self, method, data):
            assert method == "termbridge_livekit_eou"
            messages = json.loads(data)["chat_ctx"]
            assert len(messages) == 6
            return b'{"eou_probability":0.73}'

    detector._executor = Executor()
    context = chat_context([{"role": "user", "content": str(i)} for i in range(8)])
    assert asyncio.run(detector.predict_end_of_turn(context)) == 0.73


def test_component_is_accepted_by_real_livekit_agent_session(tmp_path):
    from livekit.agents import AgentSession, TurnHandlingOptions
    (tmp_path / "languages.json").write_text('{"zh":{"threshold":0.0066}}')

    async def check():
        detector = FineTunedTurnDetector(tmp_path)
        session = AgentSession(turn_handling=TurnHandlingOptions(turn_detection=detector), vad=None)
        assert session._turn_detection is detector
        assert not session._started  # No audio device/room/cloud invocation in this test.
        detector.close()

    asyncio.run(check())


def test_cancelled_inference_cleans_executor(monkeypatch):
    executor = LocalExecutor(Path("unused"), None, "torch", "cpu")
    closed = []

    async def blocked():
        await asyncio.sleep(30)

    monkeypatch.setattr(executor, "start", blocked)
    monkeypatch.setattr(executor, "close", lambda: closed.append(True))

    async def check():
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(executor.do_inference("termbridge_livekit_eou", b"{}"), 0.02)

    asyncio.run(check())
    assert closed == [True]
