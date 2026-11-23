# Remote desktop delivery gates

Keep this checklist aligned with the full requested feature. A component test does not close a device or release gate.

- [x] Embedded open-source viewer built with notices/source attribution; no external desktop app required on mobile.
- [ ] Mac native capture, display enumeration and pointer/key/text/scroll control verified against a test application.
- [ ] macOS multi-display selection and previous/next Space / Mission Control interaction verified.
- [ ] `tb screen` CLI commands operate through the same Host desktop service; help, failures and JSON receipts verified.
- [ ] AI inspect/capture and attention/highlight usable; authorized action followed by state verification; no implicit approval.
- [ ] Authenticated, encrypted desktop stream/input; malformed input, replay, reconnect and revoked sessions covered.
- [ ] Backpressure bounded; no growing frame queue; disconnect releases held keys/buttons and stops capture.
- [ ] Android entry, live desktop, click/drag/right-click, keyboard/Chinese text, scroll, pinch zoom/pan and display navigation.
- [ ] iPhone/iPad entry and equivalent controls, including landscape and external keyboard.
- [ ] Attention can show the relevant desktop region on mobile and survive foreground/background transitions.
- [ ] Node tests/build, Android unit/lint/build, iOS tests/build and protocol/Relay integration checks pass.
- [ ] Actual Mac + Android interaction evidence, including popup confirmation with observed result.
- [ ] Actual iOS/iPad interaction evidence, or explicitly outstanding if no device/signing access.
- [ ] Running Host and `tb serve` updated and verified; existing Terminal/AgentChat routes still work.
- [ ] App artifacts distributed/installed with installed hashes and runtime verification; backups retained.

## Evidence

Implementation and candidate acceptance are in progress. No complete remote-desktop release or physical-device acceptance has been claimed.

2026-09-24 acceptance evidence summary:

- `node-tests.log`: full Node suite, Cloudflare tests and all 31 existing integration scenarios passed. Desktop-specific tests cover encryption, replay, packet fragmentation, backpressure, mouse/key mapping, cancellation and device ambiguity.
- `swift-tests.log`: 3 native geometry/validation tests passed. The helper builds as a universal arm64/x86_64 executable.
- `cli-proof.json`: real CLI → owner-only socket → Host desktop service → native helper status and display enumeration, with JSON receipts. Initial real Mac screenshot succeeded before the machine locked; live input acceptance stopped when the fixture reported loginwindow as the foreground application.
- `browser.png`, `mobile-zoom.png`, `attention.png`: actual noVNC rendering, phone viewport zoom and highlighted region inspected visually. A browser fixture confirmed Chinese/emoji text and pointer down/up reached the decrypted Host input handler. This fixture never operates the real Mac.
- `android-build.log`: final Android 0.1.28 (versionCode 13) unit tests, lint and debug build passed after the last shared-viewer changes. APK signature verified; SHA-256 `363cd86734bd0dccb69dd78bec87c206e42efc7a600f907cdc6c59785008281b`. This exact candidate is published in the existing Android test update channel; it has not been installed on a physical device.
- `ios-core.log`: 55 core tests passed. `ios-target-build.log`: simulator SDK target build passed. Xcode's scheme destination discovery rejects installed iOS runtimes with “iOS 26.5 is not installed”, so the new XCTest UI case has not run. The installed isolated iPad simulator app shows the new desktop entry; system dialogs prevented the viewer interaction gate.
- Latest device discovery: Android ADB/mDNS have no connected phone; iPhone is unavailable. iPad is now paired/reachable but locked. App inventory and installation preparation fail because the system rejects mounting the developer disk image with `kAMDMobileImageMounterDeviceLocked`. Physical installation and interaction remain outstanding. Unlocking the Mac is also required for native input, Spaces and live capture verification.

- `serve-proof.json`: actual global `tb serve` started an isolated Relay and Host, then `tb screen status` and `displays` completed through its socket/native helper. This terminal-owned test process had desktop permissions. The normal launchd Host was rebuilt/restarted; its distinct identity reports both permissions false in `running-host-status.json`. It still needs macOS authorization.
- `final-viewer.png` and `browser-proof.json`: final shared bundle visually checked at 412×820; highlighted region and keyboard fit the phone viewport, and encrypted Chinese/emoji and scaled pointer events reached the fixture. This is browser/component evidence only.

- `production-release-proof.json`: Android 0.1.28 (13) published at `https://termbridge-a0k.pages.dev/` via deployment `f58af9ab`. Production manifest matches the staged release. Both complete HTTP download and real browser download returned the exact APK SHA-256 above. Signature matches the previous production APK; Mac/Windows/CLI metadata and signed Mac appcast remained unchanged. This proves distribution, not installation or remote-desktop device acceptance.

- `ios-device-build.log` and `ios-development-proof.json`: iOS device SDK build succeeded using the existing development signing identity and provisioning profile. Strict code signature validation passed, and every bundled desktop resource matches the reviewed source bundle. `TermBridge-iOS-desktop-development.ipa` is retained beside the acceptance evidence for provisioned devices; it is not an App Store/TestFlight release or proof of installation.

## Native controls and lock-screen transport update

2026-09-24 follow-up acceptance summary:

- Android 0.1.29 (14) replaces embedded HTML controls with native Material controls, themed display menus and a native keyboard composer. The Activity owns translucent system bars and insets. `android-ui-build.log` records passing unit tests, lint and assembly. `android-ui-instrumentation.log` records two passing opt-in emulator cases: encrypted desktop controls/text input and the real Mac screen-sharing authentication prompt. No credentials were entered and no physical Android interaction is claimed.
- `desktop-native-connected.png`, `desktop-native-displays.png`, `desktop-native-disconnected.png` and `desktop-system-login.png` were visually inspected. The shared viewport, header and controls follow the existing paper/green palette; login uses a native secure password field.
- iPhone/iPad use native SwiftUI menus, toolbars and text fields, system materials and system appearance. `iphone-native-light.png`, `ipad-native-light.png` and `ipad-native-dark.png` show the same source view running in an isolated simulator harness against the encrypted fixture. Live appearance switching updates the WebView too. This is view-level evidence, not full app navigation or physical-device acceptance.
- `ui-ios-core.log`: all 55 core tests passed. `ios-native-ui-device-build.log` and `ui-ios-development-proof.json`: final signed device build and strict signature validation passed; all 70 desktop resources match source. The new development IPA is archived. Installation remains blocked by the locked physical iPad.
- `ui-node-tests.log`, `ui-system-tests.log`, `ui-typecheck.log` and `ui-build.log`: full Node/Cloudflare/integration tests, 14 focused desktop tests, type checking and universal helper build passed. The running Host was rebuilt/restarted. Global `tb` resolves this same build.
- System-sharing mode tunnels authenticated encrypted RFB to macOS's own loopback service. The real Mac advertises ARD authentication, and the Android native login dialog was reached through this transport. Direct capture/input permissions still report false for the launchd Host. Neither a reachable service nor an authentication prompt proves lock-screen unlock: real account authentication, screen rendering and unlock remain outstanding. FileVault pre-boot remains outside the Host lifecycle. Region highlighting still requires direct mode; system mode rejects it explicitly.
- `ui-production-release-proof.json`: deployment `c6b53abe` publishes Android 0.1.29 (14). Complete HTTP and actual browser downloads both match SHA-256 `ff3f908f116b882c42deaae2045090ca302b3899fadbd8691b75086dcdeee311` (72,432,484 bytes). The APK signer matches the previous release. Other platform metadata and signed Mac appcast are unchanged. Local site output now matches this published candidate.

## Authentication input gating and remembered Android login

- Authentication is a distinct lifecycle phase. The shared viewer suppresses pointer, key and focus-loss release messages until RFB authentication and ServerInit finish. Previously, opening the native login dialog could send a six-byte pointer packet while macOS was waiting for an authentication method; the system log reported `viewerDesiredAuthMethod 5` / `unknown authentication`.
- Android can remember a successful screen-sharing login in Android Keystore-encrypted, no-backup storage, scoped to the paired endpoint and Host. Failed submissions are never saved; explicitly rejected saved credentials are removed; network failures do not erase the saved login. The desktop menu provides a forget action. Passwords never enter protocol metadata, AI tools or logs.
- The viewer shows authentication progress and a bounded timeout. Native authentication outcomes carry the viewer request ID so retired sessions cannot save credentials or dismiss a newer login.
- The regression test runs the actual viewer source and fails against the old ungated input behavior. Android instrumentation uses `scripts/desktop-auth-fixture.ts` with fixed synthetic credentials to exercise ARD failure, success, saved-login reuse and invalidation, plus real Keystore encryption/scoping/tamper checks. These do not prove successful authentication to a user's Mac account.


## First-frame transport and black-screen regression

- A successful RFB login and allocated canvas do not prove rendering. The viewer now keeps the waiting surface until the canvas contains opaque framebuffer pixels (including a valid black desktop), and reports a retryable first-frame timeout.
- System screen sharing can send a single 5120×2880 ZRLE rectangle of approximately 20 MB. Previously the Host synchronously queued encrypted packets, aborted at 2 MiB of WebSocket backlog, and discarded its own close notification through the same congestion guard. The viewer then waited indefinitely for the remainder of that rectangle.
- Desktop packets now await the WebSocket write callback. SystemSharing pauses its TCP input until the packet write completes, keeping transport memory bounded without dropping part of an RFB rectangle. Control/close notifications are independent of the bulk-data congestion limit. A stalled write fails within ten seconds; a late failure from a retired session cannot close its replacement.
- Regression coverage includes a 20 MiB encrypted frame delivered intact under delayed writes, retired-session failure, a congested transport callback, and first-frame waiting/timeout. `DesktopSystemRenderingTest` is an opt-in real-Mac check: credentials enter through an ADB-forwarded loopback socket, and success requires opaque canvas pixels plus a live viewer. Its screenshot still requires visual inspection.

## 2026-09-25 latency follow-up

- A deterministic 80 ms RTT fixture reproduced stop-and-wait: a 1 MiB encrypted frame needed 17 ACK rounds (~1.6 s). The bounded eight-fragment window needs 3 rounds (~0.4 s in the same fixture), including a disconnect with all eight ACKs pending. This measures transport scheduling, not device FPS.
- Real Mac 5120×2880 compressed updates were still ~800–900 KB and 2.6–3.7 s over the configured public relay after pipelining. The same probe through local pinned TLS measured 779 ms for its first frame, 162 ms for the next full frame and 13–23 ms for 1280×720 regions. These are Mac-side probe measurements, excluding phone decoding/rendering.
- Physical Samsung enrollment validated the Mac certificate, preserved the public profile, reused the existing account through Android Keystore, and rendered the Mac lock screen over LAN. Native activity creation to ready was 3316 ms, including authentication and rendering.
- A 400% pan trace on that phone exposed repeated forced viewport updates during image delivery/decoding. The shared viewer now coalesces forced updates until the previous frame has painted, sampling only the latest viewport; keyboard and pointer messages bypass this gate. An incremental request waiting on an idle Mac must still be woken by a new full viewport request.
- The updated Mac App's client Keychain read blocked its main thread while the Mac was locked, preventing LAN startup. It now loads connections off the UI thread; edits cannot overwrite unloaded profiles and late results after shutdown are discarded. Tests hold the read pending while proving MainActor responsiveness. The installed App owns the LAN parent, Relay and Host processes even while Keychain awaits access.
- Local Mac installation is ad-hoc signed and backed up; it is not a notarized public release. Do not treat build/test success or a static rendered lock screen as smooth-motion acceptance.

Final physical-device selection was explicitly checked after navigation: the active endpoint is LAN and the native toolbar shows the LAN alias. Earlier pan recordings were on the public profile (returning through an old terminal selected its pinned profile). In the final LAN 400% lock-screen trace, the median gap between visible canvas paints was 175.5 ms over 40 paints, versus 506.5 ms in the earlier public trace. This is a short dynamic-lock-screen trace, not a 30/60 FPS video acceptance result.

## Session detail entry

Android's terminal detail menu now opens `RemoteDesktopActivity` through the “Remote desktop” entry. The former raw-terminal/mobile-layout toggle has been removed; Herdr retains the mobile terminal presentation. Navigation passes the session's pinned Host and endpoint, so another active profile or a second address for the same Mac cannot redirect it. A missing pinned endpoint fails closed.

`SessionRoutingTest` covers same-Host public/LAN selection and a removed endpoint. Opt-in `DesktopEntryTest` (`desktopNavigationFixture=true`) exercises the actual toolbar action, switches the global profile before tapping, and verifies the resulting native activity and endpoint-specific title. This navigation test passed on the Android emulator; installing this candidate on the physical phone still requires a reachable wireless ADB endpoint.


## Refresh-rate selection

The native iPad/iPhone and Android More menus offer 10, 20, and 30 FPS targets.
10 FPS is the default; each app persists the selection across viewer sessions.
The shared viewer paces incremental RFB requests at the selected interval. Input
packets and viewport refreshes remain immediate, queued updates coalesce, changing
rate reschedules the pending request, and closing the viewer cancels its timer.
The native Host capture ceiling is 30 FPS, with the existing acknowledgement window
bounding production; system sharing follows client RFB requests. These are target
limits, not measured or guaranteed playback FPS. An older native Host remains
limited by its existing 12 FPS capture ceiling until updated.

Regression checks: shared geometry/request tests cover 10/20/30 intervals, input
latency isolation, rate changes, coalescing, full refresh and retired timers.
