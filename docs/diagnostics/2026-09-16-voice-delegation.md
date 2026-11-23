# Voice delegation: concise replies backed by delivery receipts

## Observed failure

The reported call's local Global history identified a recently completed terminal
Agent, then asked it to commit and push. The voice frontend asked for project,
branch and commit details instead of forwarding. It incorrectly treated a worker
with `voice` in its display name as the voice frontend itself and invented a lack
of execution permissions. The associated call diagnostics contained no
`tool_started` event. This was not evidence of a failed Git operation: delegation
had never started.

## Changes

- `packages/host/src/voicePrompt.ts`: shared delegation policy for Global text,
  execution fork and realtime voice. Resolve recent recipients from context/tools;
  forward original requests; do not infer permissions from display names. A
  successful delivery earns one short acknowledgement, not a capability lecture.
  Pending approval and failures must remain explicit. Delivery is not task completion.
- Realtime tool description and final Chinese instructions specify the ordering:
  request → `fork_execution` → receipt → acknowledgement. Ordinary conversation
  still uses Omni directly; no extra model call is added to every spoken turn.
- Removed the execution prompt's hard-coded model identity. The Host selects the
  actual execution model.
- `voicePrompt.test.ts`: identity, routing and receipt-language regression checks.
- `scripts/test-voice-delegation-live.ts`: opt-in real Omni provider test using
  authored context and mocked delivery/offline receipts. It never connects to real
  workers, executes Git commands, records a microphone or plays audio.

## Evidence and limits

The earlier prompt failed the synthetic delivery assertion (zero tool calls).
An intermediate prompt was inconsistent: one run called the tool, another replied
that delivery succeeded without any tool call. Raw provider events confirmed that
the tool schema was accepted with `semantic_vad`; registration was not missing.

After the final Chinese execution contract, two consecutive runs passed both
delivery and offline scenarios: 4/4 fixture conversations, exactly one mock tool
invocation each. Success: `好的，已发给他了。` (9 characters). Offline:
`目标 Agent 已离线，无法发送。` (18 characters). Logs are local temporary
`/tmp/tb-dispatch-live-contract{,-repeat}.log`; they contain only authored fixtures.

Typecheck passed. Node unit suite: 379 tests, 378 passed, 1 skipped, 0 failed.
Production build passed. This is a bounded prompt improvement, not a mathematical
guarantee against model hallucination. The fixture uses text input to the realtime
provider and mock delivery: it does not establish phone audio/ASR accuracy or actual
worker delivery. Those require a new real call and matching tool receipts.

Run explicitly with a locally configured credential (never log or commit it):

```sh
pnpm exec tsx scripts/test-voice-delegation-live.ts --live
```

The realtime provider's documented nested tool schema and text input events are
described in [Bailian client events](https://help.aliyun.com/zh/model-studio/client-events).
