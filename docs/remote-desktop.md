# Remote desktop

The mobile **View desktop / 查看桌面** entry connects to the existing Host.
The macOS App's **远程桌面** button (or ⇧⌘R) opens the selected Host in an
independent window using the same encrypted connection and bundled viewer.
Each window keeps its captured Host even when the main window changes tabs.
`tb serve` and `tb surf` start that same implementation. TermBridge opens no
new listening VNC port and embeds the viewer in each mobile app. The Mac must
run macOS 14 or later. Android owns its translucent system bars and Material
controls; iPhone/iPad use native SwiftUI menus, controls and system appearance.
The WebView owns desktop pixels and gestures, not app/system chrome.

## Lock screen and connection modes

The More menu offers Automatic, Direct desktop and System sharing:

- Direct desktop uses ScreenCaptureKit, Accessibility and CGEvent. Grant Screen
  Recording and Accessibility to the actual Host process identity. This mode
  supports physical-display selection and AI region highlighting. It must not
  be claimed to unlock macOS's secure login window merely because input was posted.
- System sharing connects only to `127.0.0.1:5900` on the Host, using macOS's
  built-in screen-sharing service. The native login dialog supplies credentials
  to embedded noVNC's RFB authentication inside the encrypted desktop channel;
  they are never tool results, AI messages or stored preferences. Pixels, keys,
  text and gestures then use the same system-owned RFB connection, including
  ordinary lock-screen interaction when allowed by macOS. The system service
  decides its framebuffer layout; native display cropping/highlighting is not
  offered on this mode.
- Automatic prefers system sharing if its local service is reachable, otherwise
  uses direct capture. A service authentication failure does not silently fall
  back to a less restrictive authentication path.

Run `tb screen permissions sharing` to open System Settings → General → Sharing.
Enable Screen Sharing and restrict access to your own permitted account. Existing
Remote Management settings remain untouched. macOS screen sharing has its own
network listener and access policy; TermBridge does not enable an unauthenticated
server or change that policy. Screen Recording/Accessibility grants do not replace
this system service. `tb screen status` includes `systemSharingAvailable`.

Ordinary locked-session control is a required acceptance case; until verified on
the real Mac, a successful tunnel/fixture is not proof of unlocking. FileVault's
pre-boot disk-unlock screen is outside a running Host process's lifecycle.

## Local CLI

```sh
tb screen status
tb screen displays
tb screen capture --display 3 --width 1920 --output /tmp/desktop.jpg
tb screen inspect
tb screen attention --display 3 --region 0.2,0.2,0.4,0.3 --title '请查看这个确认框'
tb screen press <fresh-control-id> --authorized
tb screen pointer click 0.5 0.5 --display 3
tb screen text '输入中文'
tb screen space next
tb screen release
```

These commands use the owner-only Host socket. Read/inspect output can coexist
with a mobile viewer. A mobile connection exclusively owns pointer/keyboard
input; local writes reject during viewing, except an exact inspected control
press with `--authorized`. That flag records the caller's explicit authorization
intent; it does not obtain authorization from a model or from text in a dialog.
The caller must obtain the user's authorization for that operation first.

Inspect returns bounded app/window/control metadata and opaque control IDs,
valid for 30 seconds and consumed on press. Changed titles/roles/descriptions,
disabled controls and expired IDs reject. A successful input result means
`delivered`; capture/inspect the resulting state before claiming that the
application completed the operation. Attention never clicks. It highlights the
region in an existing viewer, opens a foreground mobile desktop view, or posts
an Android notification. With multiple subscribed devices, use `--device` from
`desktopClients` in `tb screen status`. Without a subscribed device, the region
waits for the next viewer for up to five minutes.

If permissions are missing, explicitly run `tb screen permissions screen` or
`tb screen permissions input` and finish the macOS system permission flow.
These commands cannot bypass macOS approval or Keyguard/login restrictions.

## Touch and navigation

- Tap to click; two-finger tap for right click.
- Long press or enable **拖动** to drag a remote object.
- Pinch to zoom locally. Move one finger to pan when zoomed.
- Two fingers scroll the remote application; switch **双指滚动** to **双指平移**
  to pan the viewport instead.
- The display picker selects physical screens. Arrow buttons use macOS
  previous/next Space shortcuts; **所有桌面** opens Mission Control.
- The keyboard button opens explicit Unicode input and Esc/Tab/Backspace/Enter
  keys. Hardware keyboards use noVNC's key handling.

Leaving the native desktop screen or backgrounding the app disconnects it and
releases held input. WebView visibility changes only release keys; the native
Activity/scene owns connection lifetime. Reconnection requires a fresh encrypted
session and never replays old input.

macOS desktop windows retain their connection when the app loses focus; closing
the window or quitting the app retires the connection. Mouse buttons and hardware
keyboard input go to the remote desktop, while the native text field supports
explicit Unicode text. Use the zoom buttons to magnify and Option-scroll to pan
locally. Passwords are saved only after authentication, in the local Keychain,
scoped to the exact endpoint, Host and trust material. Keychain work is serialized
off the UI thread.

TermBridge does not send a lock command on viewer teardown. macOS System Sharing
can restore the screen state that preceded its connection. The system-owned
`com.apple.RemoteManagement` / `RestoreMachineState` preference is distinct from
automatic screen-lock timers; only change it on the owner's explicit request,
preserve its prior value, and verify a fresh connect/disconnect on that Mac.

## Build and acceptance

`pnpm build` bundles the shared viewer and its unchanged noVNC 1.7.0 source and
licenses into Android/iOS/macOS resources and `dist/desktop`. On macOS it also builds
the universal arm64/x86_64 helper into `dist/native`. A standalone viewer build
uses `node packages/desktop-ui/scripts/build.mjs <output-directory>`.

Transport details: [protocol](protocol.md#remote-desktop-v1).
Full delivery gates and evidence: [acceptance](remote-desktop-acceptance.md).
The isolated `scripts/desktop-ui-fixture.ts` validates native WebViews without
reading or operating the actual desktop; it cannot prove real app interaction.
Run `node --import tsx macos/TermBridgeControlCenter/scripts/test-remote-desktop.ts`
for the macOS WebKit fixture: it verifies encrypted framebuffer pixels, native
input routing, independent Host windows and repeated teardown, without capturing
or sending input to the real Mac. Native state notifications do not depend on
animation frames, which WebKit suspends for occluded or locally locked windows.
