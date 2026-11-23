# Voice: result ownership, history delivery, and Jev activation

## Evidence and diagnosis

The reported call had one calendar query but two identical final spoken answers.
The Host admitted both a phone-action event as a new user-role notification and
the execution fork's normal tool continuation. A test using the actual Omni
adapter reproduced the two independent continuation paths; this is not an ASR
text-normalization issue.

The same call's model response began 195 ms after the final transcript and its
first output chunk arrived at the Host after 506 ms. Matching Host status events
to Android handling timestamps showed increasing delay (roughly 5.6–30.4 s).
These are **control-message handling times, not audible playback latency**.
Repeated full-history broadcasts (~118 KB before catalog/usage metadata) shared
the transport with realtime events; partial-text persistence triggered them up
to every 250 ms. This is a concrete avoidable load, but the old logs cannot
separate relay/network delay from Android main-thread queueing.

Jev was implemented but disabled in the deployed Host. No enabled mode or
credential existed in that process. A standalone API test is not proof of Host
integration.

## New delivery responsibilities

```text
Native phone receipts ──> durable tool/UI states (all transitions)
                     └─> VoiceActionOutcomes, keyed by action ID
                          ├─ fork active: terminal result joins fork output
                          └─ fork finished: one terminal notification

Fork output ──> Omni continuation ──> spoken transcript ──> History
Text/silent workflow ──> text reply ──────────────────────> History

History persistence ──> unsolicited snapshot scheduler
                        ├─ in call: defer
                        └─ idle: coalesce; hangup flushes latest
Explicit history request ──> immediate snapshot (also works during a call)
Realtime audio/text/tool progress ──> existing realtime frames, unchanged
```

`VoiceActionOutcomes` waits up to 8 seconds for a **running** native operation's
terminal receipt, so fast native reads can finish within the tool turn.
`awaiting_user` never waits for a human in that turn. A timeout remains pending,
not completed. Results that race with the end of a fork are included in its
`phoneOutcomes`; terminal receipts take precedence over older pending prose.
No phone permission policy is weakened. Hangup releases waiters and prevents
late speech; it does not claim to undo native side effects.

The internal execution model's answer is no longer stored as a second assistant
message in a spoken call. The actual spoken transcript remains durable. Text
and silent-call answers retain their existing persistence.

The shared prompt forbids spoken progress filler, duplicate reading of receipt
and summary, and unsolicited follow-up offers. This influences generation;
programmatic ownership, not prompt compliance, handles duplicate phone events.

## Jev

The Host-only `TYPESAFE_API_KEY` and `TB_INTENT_HINTS=hint` settings persist across
managed Host restarts in the existing owner-readable launch configuration.
Explicitly clearing the key removes it; `off` disables classification. No key is
sent to phones, included in logs, or stored in the repository.

Classification remains nonblocking, with a 2.5-second deadline, bounded history,
candidate/tool sets and concurrency. An accepted turn's context can be reused
by its fork without treating the model's own acknowledgement as new user
context. Changed text, conversation scope, candidates or tools invalidate it.
`intent_config`, `intent_hint:ready` and `intent_hint:applied` distinguish
configuration, completed inference and actual prompt consumption. Logs omit
utterance text and credentials. Hints never grant permissions or execute tools.

## Verification

- `pnpm test`: type checks, unit suites, Cloudflare tests and all 31 integration
  scenarios pass. One unrelated existing unit test remains intentionally skipped.
- Seven delivery tests cover actual Omni continuation, either receipt order,
  asynchronous approval, pending timeout, hangup, duplicate terminal events,
  deferred history and burst coalescing.
- Production integration verifies in-call explicit history reads still work,
  while unsolicited full snapshots do not accompany streamed replies.
- Jev's live synthetic fixtures: 12/12 correct choices; p50 261 ms, p95 1779 ms
  in this run. This is a small fixture result, not population accuracy.
- Fixed a pre-existing isolated training test's event-loop lifetime: its fake
  process had no referenced handle for the production unref'ed cancellation
  monitor. Production training behavior is unchanged.
- `pnpm build` succeeds. Updated Host process reports Jev `hint` configured;
  a live voice request recorded both `ready` and `applied`.
- The full live Host voice test is **not accepted**: an initial run received
  execution events/cards but the older harness expected per-tool voice-status
  frames and timed out. The harness now correlates execution events by call ID.
  Two subsequent state-query replays answered without calling the required tool,
  so their tool-receipt assertions correctly timed out. A stronger distinction
  between querying and delegating was added to the prompt, but the latter
  behavior still reproduced. Prompt-only enforcement is not a reliability
  guarantee; do not report this as a passed end-to-end tool-routing test.

Remaining acceptance: repeat the original calendar call on the Android device
and measure real end-of-speech-to-playback time. Host/cloud data-pipe testing
does not establish Android speaker, Bluetooth, microphone or perceptual latency.
