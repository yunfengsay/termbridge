# Termbridge for iPhone and iPad

Native SwiftUI universal client for the existing Termbridge host, relay, Cloudflare pairing,
multi-host, Brain, and Herdr protocol. The app targets iOS/iPadOS 17 and has no runtime CDN or
Swift package dependency.

## What works

- Cloudflare pairing by camera QR scan, pasted `termbridge://pair` URL, or `tb1_` connection code
- Multiple Mac profiles with fast switching; Cloudflare `host_list_result` discovery automatically
  expands one room into one profile per online Mac
- Session list with PTY/Herdr origin, workspace/pane metadata, agent state, preview, viewers, and
  observed completion time
- Terminal attach/create, raw PTY input, resize, scrollback, touch scrolling, clipboard, and a
  mobile key row (Escape, Control, Alt, Tab, navigation keys)
- Global Brain conversation (`brain_snapshot`, `brain_send`, agent route selection) with links from
  each dispatched task to its terminal execution detail
- Read-only Git review for any Session whose working directory is inside a repository: uncommitted
  changes, a diff against a chosen local base branch, and project file browsing, with a collapsible
  directory tree or flat file list, on-device syntax highlighting, and a guarded branch switch
- Graphical conversation view for existing Codex / Claude Herdr sessions, using the shared
  `agent-chat-ui` renderer and a native iOS composer; switch between conversation and terminal
  without starting another Agent. Settings → 界面 → 默认会话视图 chooses 自动 / 对话 / 终端.
  Automatic mode falls back to the terminal with a reason when the Host or session lacks support.
- Conversation history paging, capability-gated send, per-Host/session drafts, exact subscription
  generations, and accepted / delivered / observed / uncertain / failed receipts. Unknown outcomes
  retain the draft and never retry automatically. Attachments, stop and approvals remain terminal actions.
- Dark interface throughout
- Local completion notifications and notification/URL deep links back to the correct Mac profile
  and session
- iPad `NavigationSplitView` sidebar/detail layout; the same hierarchy collapses naturally on iPhone

Herdr remains the owner of discovered panes. The iOS app requests `presentation=mobile` when it
attaches and negotiates revisioned line patches. The Host sends one structured snapshot, then only
the changed lines; a revision mismatch requests an automatic full resync. The app can read and send
terminal input, and never kills, restarts, resizes, or rearranges a Herdr pane.

## Pairing and profiles

On the Mac host:

```bash
tb cloudflare pair
```

In the app, open **Manage connections** and choose **Import Cloudflare QR or code**. The QR carries
the secure relay URL, room secret, stable host ID, host name, and an optional SHA-256 certificate
pin for self-signed WSS relays. A short `tb1_` code initially has
no host ID; after connecting, the app consumes the relay's host roster and creates switchable Mac
profiles.

Profile metadata is stored in `UserDefaults`. Every profile's secret is stored separately in the
Apple Keychain with `AfterFirstUnlockThisDeviceOnly`; secrets are not stored in the project or app
preferences.

Manual `ws://` profiles remain available for a trusted LAN. Pairing imports deliberately require
`wss://`. A full `termbridge://pair` URI is used for self-hosted relays; compact `tb1_` codes are
reserved for the official Termbridge Cloud room. Hosted Cloudflare room connections send the room key through `X-Termbridge-Room-Key` and
then complete the normal HMAC challenge/response.

## Protocol mapping

The Swift client mirrors `packages/protocol` rather than introducing an iOS-only API:

| Product surface | Existing wire semantics |
| --- | --- |
| Authentication | `auth_challenge` -> HMAC-SHA256 `auth_response` -> client `hello` |
| Multi-Mac | `hello.wantsHosts=true`, `host_list_result`, `selectedHostId` |
| Sessions | `session_list`, `agents`, `session_create`, `attach`, `kill` |
| Agent status | `source`, `agent`, `status`, `completedAt`, `preview`, Herdr workspace/pane ID |
| Terminal | frame types 1/2/3 with per-connection big-endian `sid`; negotiated `terminal_mobile_snapshot` / `terminal_mobile_patch` / `terminal_mobile_resync` for Herdr mobile views |
| Global | `brain_snapshot`, `brain_send`, `brain_accepted` |
| Review | `review_probe` gates the entry point; `review_snapshot` (`working` / `branch` / `files`, optional `path`) and `review_switch_branch` return the same bounded structures Android reads |

The app rejects reverse `tool_request` calls because an iPhone viewer does not expose its file
system or shell as a Termbridge peer.

## Notifications and deep links

While the app maintains its monitoring connection, it polls the session snapshot and emits one
local notification for an observed Herdr `working` -> `done` transition. Tapping the notification
selects its Mac profile and opens the terminal detail.

The same route can be opened explicitly:

```text
termbridge://session?host=<host-id>&id=<session-id>&name=<label>&source=herdr
termbridge://review?host=<host-id>&id=<session-id>&name=<label>&mode=working
```

`mode` accepts `working`, `branch`, or `files` and falls back to `working`.

Pairing QR URLs are also registered as app links through the `termbridge` URL scheme. Local
notifications are not a replacement for server push: after iOS suspends the app, guaranteed
background completion delivery would require an APNs provider in the host/relay chain.

## Build

`project.yml` is the project source. Regenerate after adding files:

```bash
cd ios
xcodegen generate
```

Build the universal app targets without signing:

```bash
xcodebuild -project Termbridge.xcodeproj -target Termbridge \
  -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build

xcodebuild -project Termbridge.xcodeproj -target Termbridge \
  -configuration Debug -sdk iphoneos CODE_SIGNING_ALLOWED=NO build
```

`CODE_SIGNING_ALLOWED=NO` is useful as a compile-only check. To install a Simulator build and
exercise pairing/Keychain persistence, let Xcode apply its local ad-hoc signature:

```bash
xcodebuild -project Termbridge.xcodeproj -target Termbridge \
  -configuration Debug -sdk iphonesimulator SYMROOT=build build
xcrun simctl install booted build/Debug-iphonesimulator/Termbridge.app
```

Choose a Development Team in Xcode for a physical iPhone or iPad build. The target's
`TARGETED_DEVICE_FAMILY` is `1,2`.

## Tests

Run the protocol/model suite directly on the Mac:

```bash
cd ios
swift test
```

It covers MessagePack fixtures, frame byte order, HMAC vectors, pairing payload validation,
multi-host profile merging, completion transition tracking, session/host metadata, review row and
navigator presentation, the syntax tokenizer, and deep-link routing.

Compile the XCTest bundle for iOS Simulator:

```bash
xcodebuild -project Termbridge.xcodeproj -target TermbridgeTests \
  -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build
```

The real relay smoke test remains available:

```bash
TB_RELAY_URL=wss://relay.example.com \
TB_HOST_ID=your-host-id \
TB_SECRET='your-shared-secret' \
./scripts/protocol-smoke.sh
```

Set `TB_SMOKE_PTY=1` to create a temporary shell, send input, verify output, and exit it. Debug app
builds can be configured without committing credentials through `TB_RELAY_URL`, `TB_HOST_ID`,
`TB_HOST_NAME`, `TB_SECRET`, and `TB_TLS_FINGERPRINT` launch environment variables.

The terminal renderer is xterm.js packaged offline in `Termbridge/Resources`. See
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Agent conversation validation

`swift test` covers preference fallback, existing-session-only selection, generation isolation,
earlier frame round-tripping, malformed receipts, pending sends, unknown outcomes, repeated text,
and preservation of the next draft. The shared renderer is bundled as `Resources/AgentChat/`;
its third-party notice travels with the app.

For synthetic UI acceptance (no real Host, transcript, or Agent):

```sh
# From the repository root, with a supported Node version:
node node_modules/tsx/dist/cli.mjs ios/scripts/agent-chat-fixture.ts
# In another terminal, choose a private Simulator compatible with the installed Xcode:
xcodebuild -project ios/Termbridge.xcodeproj -scheme TermbridgeUITests \
  -destination 'platform=iOS Simulator,id=YOUR_TEST_SIMULATOR_ID' test
```

The fixture binds only `127.0.0.1:38641`, uses synthetic messages, and logs operation names only.
The UI test verifies shared transcript rendering, native text entry, observed receipt, and draft
retention across view switches. It is a synthetic protocol test, not live provider or physical-device
acceptance. Candidate-word IME composition and live Agent replies still need device validation.
