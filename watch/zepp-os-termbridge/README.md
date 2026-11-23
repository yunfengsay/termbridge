# TermBridge for Amazfit T-Rex 3

This Zepp OS mini app shows recent TermBridge alerts and a short push-to-talk
Global voice entry point on its compact home screen. The full Agent list is a
secondary screen, and alert or Agent details can start a contextual voice turn. It is
an additional target alongside the custom S3A3 firmware companion; it does not
replace that BLE implementation.

## Architecture

```text
T-Rex 3 Device App
  <-> Zepp OS app/side messaging over BLE
Zepp Side Service on the phone
  <-> authenticated HTTP on 127.0.0.1:47391
TermBridge Android AgentMonitorService
  <-> existing authenticated TermBridge relay/Host connection
```

The loopback server exposes bounded status, voice, action, and handoff endpoints. The bearer is a
separate random companion token; it is not the TermBridge relay secret. Status
responses are capped at 24 Agents and 16 recent alerts, and trim names and previews. Voice uploads
are capped at 1 MB of Opus and 12 seconds in the watch UI. No terminal bytes,
pairing QR, files, or relay credentials are returned.

The watch records Opus and Zepp carries it to the phone. TermBridge decodes and
resamples it locally before using the existing Host ASR and `brain_send` flow.
The answer text returns to the watch; synthesized audio plays on the phone.
Android posts deduplicated high-priority notifications when an Agent needs
approval, becomes blocked, fails, or completes. Zepp can mirror those phone
notifications, while the Mini Program keeps the latest 16 events in private
Android app storage and shows the newest two on its home screen.

## Product flow

- Home shows the two newest notifications first, ordered by attention priority
  and then occurrence time. Global voice is the other primary action.
- The full paged Agent list is a secondary screen so the 480 px round display
  never tries to render a desktop dashboard.
- A notification detail opens fixed actions appropriate to its real state:
  summary, checked retry, continue, stop, snooze for 30 minutes, or phone
  handoff. Each remote action gets its own ID and displays the phone/Host receipt.
- Waiting/approval items never expose an approve button. They can be summarized,
  snoozed, stopped, or opened at the exact session on the phone, where the user
  can inspect the full context.
- **Stop waiting** only stops watch-side polling and says that the requested
  action may still be running; it never fabricates cancellation.

The Android Watch Hub exposes the local bridge state, Agent counts, last update,
notification routing switches, Android notification settings, and the latest
watch action/voice receipts. Completion, attention, and failure use separate
Android channels and vibration patterns so Zepp notification mirroring can
preserve their urgency.

The Recorder API returns an audio file and lifecycle state, but not live input
amplitude. The watch therefore shows honest recording/progress states rather
than a decorative random waveform. The original T-Rex 3 has no speaker, so a
successful voice reply is rendered as text on-watch and played by the phone.

## Safety boundary

The phone accepts only the fixed action names `summarize`, `retry`, `continue`,
`stop`, and `snooze`. It creates bounded Global requests that include the exact
source session ID; the watch cannot submit shell text, deployment approval,
deletion approval, credentials, or an arbitrary Brain prompt. The loopback
server still requires both the companion token and the per-install session
header. Snooze is local and cancels the matching Android notification while
hiding the session from the watch inbox until its deadline.

## Build

Use Node 24 and the checked package versions:

```sh
npm install
npm run build
```

The published Zeus CLI currently resolves one of its bundled private modules
through a top-level package name. `postinstall` creates only that local
`node_modules` symlink; it does not patch global npm state.

`app.json` currently contains a local development app ID. Replace it with the
ID assigned by the Zepp developer console before publishing or generating a
real-device preview QR.

## Pair

1. Install a TermBridge Android build containing `ZeppLocalBridge`.
2. Keep Agent monitoring enabled.
3. Open **Connection settings → TermBridge Watch** and copy the Zepp pairing
   code.
4. In Zepp, open the TermBridge mini app settings and paste the code.
5. Open TermBridge on the watch. It refreshes every five seconds while visible.
6. Tap **对 Global 说话**, speak for up to 12 seconds, then tap **结束并发送**.
7. Tap a recent notification for details. Open **更多操作** to request a summary,
   checked retry, continue, stop, 30-minute snooze, or phone handoff; action
   progress ends only when the phone returns a receipt.
8. Tap **语音处理** to speak to Global with that Agent session as context. Tap
   **Agent** to open the paged secondary list.

## Verification

```sh
npm run test:layout
npm run build
```

Version `0.6.0` is the first complete action-remote build. A successful Zeus
build proves packaging only; real-device acceptance still requires installing
the generated ZAB through Zepp developer preview and exercising the paired
Android bridge on the physical T-Rex 3.
