# TermBridge Watch companion

TermBridge Android can pair with a supported watch and act as its local,
authenticated gateway. Pairing lives under **Connection settings → TermBridge
Watch**. It is deliberately a normal global setting rather than a separate
Cloudflare flow.

## What pairing does

- The watch receives the phone's exact active connection profile: relay URL,
  host ID, shared secret, TLS fingerprint and profile identity.
- Switching the active Mac profile in the phone app automatically provisions
  the new profile to the paired watch.
- **Auto** prefers the bonded Bluetooth link and falls back to direct Wi-Fi when
  the phone is unavailable or its voice gateway does not become ready.
  **Bluetooth** and **Wi-Fi** can also be forced.
- Pairing and Bluetooth voice become available during boot even if Wi-Fi is
  missing or still connecting; Wi-Fi association runs in the background.
- Both Bluetooth and Wi-Fi voice use lossless signed 16-bit PCM (16 kHz
  microphone input and 24 kHz assistant output). Wi-Fi uses the existing authenticated
  `brain_voice_*` protocol at the exact `ws://` or `wss://` address in the
  profile; Cloudflare is optional.
- The watch gateway opens a relay connection only for an active voice turn.
  The separate Agent monitor polls every 3 seconds while work is active and
  backs off to 30 seconds while idle; no audio is uploaded outside a voice turn.
- The watch sends one one-byte battery report when the encrypted BLE link
  becomes ready and then every five minutes while connected. Android shows the
  last percentage and report time on the paired-watch page. Timekeeping and
  calendar synchronization stay entirely on-watch; Android sends no periodic
  clock-management traffic.
- With optional phone permissions enabled, the phone supplies GPS ride metrics,
  weather cached for at least 30 minutes and the next calendar event. Weather
  uses only a phone location fix newer than six hours and sends its coordinates
  to Open-Meteo as disclosed in the settings UI. A ride is written as GPX
  to the app's private `files/rides` directory even without network access. Standard
  BLE Heart Rate (`0x180D`) and Cycling Speed/Cadence (`0x1816`) sensors are
  discovered only while a ride is active. The S3A3 board has no onboard
  heart-rate or SpO2 sensor.
- The QMI8658C accelerometer provides step/activity estimates and wrist wake;
  the optional GPIO9 motor provides short notification, navigation and timer
  haptics. Both degrade cleanly when the optional part is absent.

On the S3A3 watch, a short power-button press wakes the clock face. Hold for at
least 650 ms to start an AI turn and release to commit it. Microphone, codec
output and speaker amplifier remain off outside an active turn.

## Pairing

1. Install a watch-enabled TermBridge Android build.
2. Keep the watch awake and open **Connection settings → TermBridge Watch**.
3. Tap **Pair watch**, choose `TermBridge Watch`, and accept Android's Bluetooth
   pairing dialog if it appears.
4. Select **Auto**, **Bluetooth**, or **Wi-Fi**. The active phone profile is
   shown below the selector. The foreground notification names it only after
   the watch acknowledges that exact profile identity.

Choosing **Forget watch** stops the phone gateway and removes TermBridge's
association. Android may retain the operating-system bond until it is removed
from Bluetooth settings.

## Security boundary

Android uses `CompanionDeviceManager`, an operating-system bond, and encrypted
GATT characteristics. The profile secret is copied only across that local
encrypted link, then stored in the watch's private NVS partition. A Just Works
BLE bond protects against passive radio capture but does not provide a
human-verified passkey, so the first pairing should be performed with the watch
physically beside the phone in a trusted place.

The relay connection keeps the normal TermBridge HMAC authentication. A
`wss://` profile validates the certificate chain and hostname; a configured
certificate fingerprint is an additional leaf pin, not a replacement for CA
validation. BLE is a
transport hop to the phone; it does not weaken or replace relay authentication.
Plain `ws://` provisioning is accepted only for localhost, `.local` names and
RFC1918 private IPv4 development endpoints; Internet relays must use `wss://`.
Removing the phone profile or forgetting the watch should be treated like
revoking another client that possessed the pairing secret.

## Watch link protocol

The companion link has a small ordered message layer over two GATT
characteristics. A nine-byte `TB` header contains version, message type,
  sequence, flags and total length. It supports MTUs from 20 through
517 bytes and carries provisioning, a one-byte battery status, voice lifecycle, PCM, transcript and status
messages. The UUIDs and message identifiers are mirrored by Android's
`WatchBleContract`/`WatchLinkCodec` and the S3A3 firmware's
`termbridge_ble_transport`/`termbridge_watch_link` implementations.

Link framing version 1 reserves these additional message types without changing the existing
voice or notification messages:

| ID | Direction | Meaning |
| --- | --- | --- |
| `0x05` | watch → phone | Reserved on-demand motion diagnostics; not emitted during normal idle use |
| `0x30` | phone → watch | Ride snapshot with scaled integer GPS and optional external-sensor metrics |
| `0x31` | phone → watch | Navigation cue/distance or a typed timer completion; never mislabeled as navigation |
| `0x32` | phone → watch | Weather, next agenda item and DND state |
| `0x33` | phone → watch | Highest-priority Agent task with exact host/session identity |
| `0x34` | watch → phone | Start, pause, resume, lap or end ride |
| `0x35` | watch → phone | Phone/work action such as find phone, timer, DND, media, camera, continue or later |

All distances, speeds, elevations and temperatures use documented scaled
integers; neither endpoint depends on MessagePack floating-point behavior.
Activity payload version 2 encodes signed elevation as decimeters plus 100,000,
so rides below sea level remain valid. Work actions echo both `hostId` and
`sessionId`; an empty work title/session is the explicit stale-card clear signal.

The complete UUIDs are part of the wire contract; both the leading message
number and trailing product number differ between characteristics:

- service: `7f510001-5a7d-4b79-9c2e-7b4e54420001`
- watch notify: `7f510002-5a7d-4b79-9c2e-7b4e54420002`
- phone write: `7f510003-5a7d-4b79-9c2e-7b4e54420003`

## Completion notifications and detail routing

The Android Agent monitor posts a high-priority phone notification when a Herdr
session transitions from working to done. Its immutable content intent includes
both the originating Mac host and session ID, so tapping it switches to the
saved profile for that Mac and opens the Terminal detail directly. Monitoring
is restored after reboot and a data-preserving app update when notification
permission remains granted.

The same completion is sent over the bonded BLE link as message `0x20`. Android
retains the latest eight encoded notifications and the latest priority task in
private app storage, then replays them after a gateway or watch reconnect. The watch's
**通知** card opens the latest detail. **在手机查看详情** sends message `0x21`
with the original host/session route; Android opens that conversation, or leaves
an actionable notification if the operating system blocks a background launch.
This flow is event-driven and does not create idle Cloudflare traffic.

## On-watch controls

- Tap the battery/activity card for the ride dashboard; start, pause/resume and
  end are executed by the phone GPS recorder. A long end press discards the
  current private ride journal.
- Tap the date for weather, next agenda, stopwatch, timer, find-phone and DND;
  long-press the date for the local month calendar. Tap the tool content to
  switch to alarm, media play/pause and camera remote controls.
- Tap notifications for completion details; long-press the notification card
  for the priority task. `继续` opens the exact Agent session on the phone and
  `稍后` snoozes it for 30 minutes. Approval-like actions intentionally open the
  exact session instead of silently approving a consequential operation.

The companion adds no fall, collision, emergency-contact, SOS or check-in
behavior.
