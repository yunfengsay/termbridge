# Android device tools over `tb peer`

The native Android client registers a long-lived, app-level management peer through its Agent monitor connection. It does not expose ADB, port 5037, a shell, or the phone filesystem. Instead it implements a small allowlisted tool surface over the existing authenticated WebSocket relay.

## Agent commands

Run these from a local shell on the Host, inside a TermBridge-hosted Codex or Claude session, or directly inside an identified Herdr pane. The Android Agent monitor must be online, but no Terminal page has to remain open:

```bash
tb peer info
tb peer logcat --lines 400
tb peer logcat --system --lines 1000 --level W
tb peer apk install ./android/app/build/outputs/apk/debug/app-debug.apk
tb peer apk retry <artifact-id>
tb peer apk status <artifact-id>
tb peer apk delete <artifact-id>
tb peer photo pull <action-id> <asset-id> ./selected.jpg
tb peer photo publish <action-id> ./edited-1.jpg ./edited-2.jpg
tb peer photo delete <action-id>
```

`tb peer list` discovers connected devices. `tb peer info --device <phone-id>` reports `platform: android` and the exact capabilities offered by that phone. With both a desktop and phone attached, unqualified `info` prefers the associated desktop; native phone operations still select only phone executors. Multiple eligible devices require an explicit ID. `exec` and `fs.*` route to registered desktop CLI or native Mac App peers and remain denied on Android. Mac App permissions are configured locally in Settings → Peer, independently of CLI `tb expose`; an unregistered viewer is not a Peer executor.

## Log access

The default `logcat` scope is the TermBridge application process only. It requires no elevated permission.

Full system logcat is optional and needs one local bootstrap while ADB is available:

```bash
adb shell pm grant com.termbridge.android android.permission.READ_LOGS
```

After that grant, system snapshots work across networks through `tb peer logcat --system`. Current Android/Samsung builds may additionally show the system **Allow access once** log dialog when a full-device snapshot starts; app-only logcat never triggers that dialog. Reinstalling the app may require the ADB grant again.

## APK transport and installation

`tb peer apk install` performs the following sequence:

1. Computes the local file size and SHA-256 before upload.
2. Establishes an ephemeral P-256 ECDH key directly between the CLI process and Android app.
3. Encrypts each 96 KiB plaintext chunk with AES-256-GCM and authenticated offsets.
4. Sends chunks through the existing Cloudflare WebSocket relay. The relay forwards them but does not persist an APK object.
5. The phone enforces a 256 MiB limit, decrypts in order, and verifies the final size and SHA-256.
6. Android's `PackageInstaller` stages the verified APK and requires approval in the system install UI.

The CLI keeps the same encrypted upload alive for up to 10 minutes when the screen turns off or the mobile network reconnects. Closing a Terminal does not affect an upload because the app-level Agent monitor owns the management connection. If the phone received a chunk but its response was lost, the authenticated next-offset check prevents writing it twice.

On Android 8 and newer, the first request produces a notification leading to **Allow from this source** for TermBridge. The verified artifact remains in the private cache at this point, so grant the permission and run `tb peer apk retry <artifact-id>` without uploading it again. A normal application cannot silently install arbitrary APKs; silent installs require a managed Device Owner or equivalent privileged deployment and are intentionally outside this peer tool.

Temporary artifacts live only in the TermBridge application cache. Partial uploads are deleted after failures, stale files expire after 24 hours, and successful installs remove the verified APK.

## Native phone actions and selected photos

Global text chat and Voice Call expose one fixed `phone_action` tool for alarms, bounded calendar reads/mutations,
TermBridge-local to-dos, and photo editing requests. Global Settings stores one of four app-level policies for each
exact action: approve every time, approve once per conversation, allow, or deny. Per-conversation approval uses an
opaque app-private grant keyed by the Host-provided conversation ID; changing policy or starting/switching a Global
conversation invalidates reuse. Approval uses a TermBridge confirmation page (or a notification that opens it), while
Android runtime permissions are granted ahead of time in the separate Permission Center. A missing system permission
returns an explicit denial instead of opening another permission prompt during tool execution.

Native completion updates both the tool receipt and a new Global text message. If confirmation arrives while the
model is replying, the outcome follows that reply; reconnect recovery deduplicates it in the originating conversation.
On Android, tapping a receipt uses the exact local action record: pending approval opens its confirmation page,
completed alarms open the system alarm list, and calendar results open the event or calendar app. Other stored outcomes
show their details. Opening a result never repeats the mutation. Alarm completion confirms handoff to the clock app;
it does not prove that the clock saved an alarm.

`call.speaker.set(enabled)` defaults to allow and changes the active Voice Call route through Android's communication
device API (legacy devices use `isSpeakerphoneOn`). The last choice is persisted for the next call; ending the call
clears TermBridge's communication route and audio focus. `cancel_execution(id)` can cancel a pending approval/photo
picker by its `phone-*` action ID and can interrupt a dispatched worker by task/session ID. A running `calendar.list`
query also carries a cancellable `CancellationSignal`; already committed calendar/alarm mutations are intentionally
reported as not cancellable rather than pretending they were undone.

Photo access has three deliberately different surfaces:

- `photo.count(startsAt, endsAt, collection)` runs inside Android and returns only an aggregate count. The time window is
  limited to 31 days and no photo bytes, MediaStore ids, paths, EXIF, or locations leave the phone.
- `photo.fetch(startsAt, endsAt, collection, instructions, maxItems)` grants the newest matching content as opaque handles.
  It is hard-capped at 3 photos, has a 60-second cooldown, and allows at most 12 automatically granted photos per rolling
  hour. Android 14 selected-photo permission is reported as `accessScope=selected`, never as a complete-library result.
- `photo.edit(instructions, maxItems)` always launches Android's system Photo Picker and lets the user explicitly select at
  most 3 images. This user-driven path does not consume the automatic fetch budget.

Global text and realtime Call register the same actions. Chosen images are copied into an app-private directory scoped by
`actionId`, with random `assetId` values and SHA-256 metadata. A dispatched Codex/Claude worker receives exact encrypted
pull/publish commands and cannot enumerate additional gallery media.
An Agent pulls every selected asset with the exact IDs shown in the phone-action result, edits local copies, then publishes
all output JPEG/PNG/WebP files as one batch. Pull and publish each establish ephemeral P-256 ECDH keys and AES-256-GCM
authenticated chunks, so the Relay never receives photo plaintext. Android 10+ saves new app-owned copies under
`Pictures/TermBridge`; it does not overwrite the originals. Selected assets expire after 24 hours and are removed after
a completed output batch.

Photo selection is deliberately reported as `running`, not edited. Only after the entire published output batch passes
size and SHA-256 verification and reaches MediaStore does the original Global tool card become `completed`.

During an active Voice Call, tapping the floating orb opens a compact action stack: capture the current screen, select
one or more original images, or return to the call. Screen capture uses Android MediaProjection and therefore shows the
platform consent UI; overlay permission alone never grants screen access. TermBridge hides its own orb, captures one
user-approved frame, stops MediaProjection, and imports the PNG into the same opaque `actionId`/`assetId` store used by
Photo Picker. Selecting images uses the system multi-picker and preserves the originals rather than taking a screenshot
of the gallery preview. In both cases the active realtime call receives only bounded metadata; a dispatched worker pulls
the exact encrypted assets to inspect code visible on screen or edit selected photos. TermBridge does not continuously
record the display and does not use an accessibility service to scrape other apps.

## Security boundary

- Room authentication gates relay routing. Normal TermBridge sessions also require the host's per-boot peer bridge token.
- Local-shell and Herdr native device calls use the owner-only (`0600`) Host bridge socket and can call only this document's allowlist.
- Shell/filesystem operations still require a token and an exact attached session; app-level registration never widens that boundary.
- APK content is application-layer encrypted before it reaches the host bridge or Cloudflare Worker.
- Photo content access is capability-scoped to at most 3 opaque handles from one picker or bounded fetch. Aggregate count never exposes content, and both transfer directions add application-layer ECDH/AES-GCM protection.
- Chunk order, length, and artifact identity are authenticated with AES-GCM associated data.
- The Android executor rejects unknown operations and all arbitrary shell/filesystem requests.
- Installation always passes through Android package validation and user confirmation.
