# Remote desktop shared by CLI, Host and mobile clients

Status: implementing; acceptance is tracked in `docs/remote-desktop-acceptance.md`.

## Requirements and ownership

- Android, iPhone and iPad expose a desktop entry for the selected Host. The viewer supports live desktop video,
  keyboard/text, pointer/drag/right-click, scrolling, pinch zoom/pan, display selection and macOS Space navigation.
- `tb screen` is the automation surface: status/displays/capture/inspect, pointer/key/text/scroll, Space navigation,
  and presentation of a bounded target region. Agents inspect pixels and native accessibility metadata; a detected
  dialog is data, never authorization. The user permits AI clicks after explicit authorization of that operation.
- `tb host`, `tb surf` and `tb serve` use the same Host service. Surf/serve are existing aliases, not a new UI server.
- Host owns viewer sessions, input ownership, backpressure, disconnect release and the native helper lifecycle.
  The macOS helper owns ScreenCaptureKit and CGEvent/Accessibility. Mobile shells own foreground/background teardown.
- noVNC is embedded as a client library, with its notices and MPL source retained. TermBridge does not enable a system VNC port or password automatically.
  When the user enables macOS screen sharing, a bounded loopback transport keeps
  its authentication and login-window ownership intact for locked-session control. The helper is private to the Host, over stdio; remote traffic uses authenticated TermBridge connections.
  Screen and input payloads must be encrypted end-to-end before entering the Relay.
- The viewport uses logical display coordinates and explicit captured pixel dimensions; a crop never changes the
  meaning of input coordinates. Replacing a display or session invalidates old input/frame generations.
- macOS Spaces use configured system shortcuts and Mission Control, not undocumented private Spaces APIs. A shortcut
  delivery receipt does not claim a verified Space change. Display enumeration and Space navigation are distinct.
- Popup attention opens a focused viewer from a native card/notification. Highlighting does not click. A completed
  click reports delivery; subsequent pixels/accessibility inspection establish the resulting application state.

## Reuse decision

noVNC exposes an RFB client accepting WebSocket or RTCDataChannel, supports mobile browsers and gestures, and is mainly
MPL-2.0. Keep upstream unchanged and implement the TermBridge transport/view controls around it.
RustDesk is a complete separate application/runtime (AGPL-3.0); LibVNCServer is GPL-2.0-or-later. Neither is selected as
an embedded dependency for the existing MIT application.

Sources: https://github.com/novnc/noVNC/blob/master/docs/API.md,
https://github.com/novnc/noVNC/blob/master/LICENSE.txt,
https://github.com/rustdesk/rustdesk, https://github.com/LibVNC/libvncserver,
https://support.apple.com/guide/mac-help/work-in-multiple-spaces-mh14112/mac.

## Native presentation

Android owns Material controls, display popup, keyboard composer and translucent system bars.
iOS/iPadOS own SwiftUI controls, display Picker/Menu and credential prompts with system appearance.
The shared WebView only renders pixels, gestures and connection empty states; its toolbar is hidden in native shells.
