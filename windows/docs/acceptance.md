# Native Windows acceptance — 2026-09-09

Candidate: TermBridge 0.2.0, C# / WinUI 3 / Windows App SDK 2.4.0 / .NET 10. WebView2 contains only xterm.js; navigation, pairing, session list, settings and permission controls are native XAML.

Environment: Windows 11 Pro ARM64 25H2, standard Finance Test user, QEMU/HVF VM with 4 vCPU and 6 GiB RAM. The candidate is x64 and runs through Windows emulation. This does not establish native ARM64 hardware acceptance.

## Verified before installer packaging

- App and CLI publish on Windows; application PRI is included. A missing unpackaged PRI caused the initial launch failure; publishing now checks it explicitly.
- Original Electron DPAPI profiles remain readable. Real Mac mini pairing was added through the native dialog without plaintext configuration export.
- Real Mac mini lists its current Herdr sessions through the bundled CLI and native UI. UTF-8 is explicit for all redirected native/Node/Python streams; Chinese session names render correctly.
- Native dialog creates an ordinary, TB-owned zsh session on the real Mac mini. Opening a terminal focuses input. Ctrl+C cancels input while the App remains open.
- Ctrl+V pastes Chinese text through Windows clipboard and xterm bracketed-paste handling. Output of 120 lines scrolls back to the original Chinese marker using the mouse wheel.
- Clicking Allow Assistance starts Windows-MCP. A Snapshot request from the real Mac mini succeeds; Ctrl+Alt+Esc revokes permission and subsequent Snapshot is rejected.
- Node `pnpm test` passes, including 31 integration scenarios; `pnpm build` passes. The dedicated desktop bridge test additionally covers one-time creation, UTF-8 input, resize, replacement of an attached viewer and preservation of Host sessions after disconnect.

Installer, restart and final artifact checks are recorded below after execution. Build output alone is not installer acceptance.

## Boundaries

- The bundled CLI uses reviewed 0.1.27 code plus the new local desktop bridge; this is not a new npm release.
- No production Host restart, website deployment, repository commit or push is part of this rewrite.
- Windows code signing and SmartScreen reputation are separate from building a native app. This candidate is not yet Authenticode-signed.
- The VM is a test environment; real financial workflows and elevated Windows applications have not been accepted.

## Final functional checks

- Native core: 10/10 checks pass, including the explicit UTF-8/no-BOM process contract.
- Standard-user installation exits 0; old Electron executable is removed. `tb` resolves to the native installation, reports 0.1.27, and reads the same three DPAPI profiles.
- Restart retains the selected Mac mini and dark theme; assistance remains disabled. Desktop shortcut targets the native executable and branded icon.
- Theme-dependent caption colors are verified on the actual dark Windows window.
- Through the real Mac mini Host, Windows-MCP opens Notepad, creates a separate test tab and types Chinese multiline text. UI Automation reads the exact expected string back. Initial per-key Unicode typing duplicated a character on the ARM VM; the reproducible compatibility patch routes Unicode/multiline text through clipboard typing.
- Stop cancels pending activation and validates the current activation before each MCP write, preventing a queued old write from reaching a newly enabled executor.

Screenshots and private diagnostic logs are kept outside version control in `windows/evidence/` and `windows/vm/`. Pairing credentials are excluded from artifacts; temporary plaintext pairing material is removed after acceptance.

## Final installer artifact

- `TermBridge-Setup-0.2.0-x64.exe`: 128207654 bytes.
- SHA-256: `925efdaf6153b638d6d027e59784691043954edece11bd877a42de4d2c8a0492`.
- Final overwrite installation exits 0. App DLL, Core DLL and patched Windows-MCP input implementation hashes match the packaged candidate.
- Installed CLI `ls` exits 0 and returns the real Mac mini Herdr sessions. The native app reconnects, preserves dark theme and all three encrypted profiles, and starts with computer assistance off.

## Compact desktop layout (2026-09-09)

- Uses a 32 px title bar, 18 px page title, 8 px horizontal page inset, 44 px session rows and 26 px terminal header. The always-visible terminal shortcut footer is replaced with a title tooltip; assistance remains visible in a single bottom row.
- In the 800 × 552 app window on the 800 × 600 VM display, UI Automation measures the terminal viewport at 495 × 390 px (previous screenshot: about 484 × 282 px). Eight full session rows fit instead of four.
- Host navigation stays compact at narrow widths, with the computer names available by expanding the pane. Description text truncates before the assistance button instead of overlapping it.
- This pass rebuilds and updates the installed app in the VM. The installer checksum above identifies the earlier rewrite candidate, not this layout update.
- Final Windows publish exits 0. Live checks cover 800 × 552 and 600 × 540 app windows, settings scrolling, Mac mini reconnect, selecting the owned zsh session, Ctrl+C, and ordinary terminal input (`stty size` reports 21 rows / 58 columns). Screenshots: `native-compact.png`, `native-compact-narrow.png`, `native-compact-settings.png`.

## Desktop layout and Chrome integration (0.2.1)

- Removed the terminal title row and the full-width top/bottom toolbars. New/refresh actions float at the bottom of the session list; computer assistance is in settings.
- The divider supports mouse dragging and keyboard changes, clamps both panes to usable widths, and persists its width. Real Windows mouse events changed the list from 208 to 158 px. Merely calling `SetCursorPos` did not generate WinUI drag updates; tests must generate mouse movement events.
- Opening or clicking the selected session focuses xterm after layout; polling reconciles existing list items instead of clearing them. Live input reached the owned zsh terminal without clicking its canvas.
- Native browser host registration and binary stdio framing were tested on Windows, including connection, enable and revoke. Chrome itself is not installed in this VM; full real-Chrome page-operation acceptance runs separately in an isolated Mac Chrome profile, as documented in `browser-extension/README.md`.
- Windows native core checks: 10/10. Node suite: 31 integration scenarios pass; `pnpm build` passes. macOS suite: 82 tests, 17 skipped, no failures.
- The macOS archive includes the Chrome component and builds successfully. Developer ID export failed with Xcode `No Accounts`; the archive is development-signed and is not a notarized release.

## 0.2.1 installer candidate

- Artifact: `windows/dist/TermBridge-Setup-0.2.1-x64.exe`, 132018463 bytes.
- SHA-256: `f4dbdafde881d71e005e9e046dd091dfc0eae951382e7439eaefe21007224bd0`.
- Unsigned Windows candidate; installer includes the shared Chrome component and registers its per-user Native Messaging manifest. The Chrome extension still requires manual development loading until Store publication.
- Final overwrite installation exits 0. All selected installed file hashes match `release.json`; app version is 0.2.1, the 158 px list width survives reinstall, and Chrome native registration reports installed. Ordinary terminal input and Ctrl+V succeed after a polling interval and reselecting the current session.

## 0.2.2 terminal repaint regression

- Real Chromium with the bundled xterm reproduces an old-session prompt arriving after reset. Reset now runs in the xterm write queue; the old prompt is absent and the new one remains.
- Herdr native snapshots use the alternate screen, matching `packages/cli/src/terminalMode.ts`. Ordinary PTYs keep their normal scrollback. Repeated repaint at four widths retains a single prompt.
- Every attachment explicitly reports its viewport size even if the WebView did not resize. This works with the bundled CLI 0.1.27. The source CLI additionally retains pre-attach and in-flight sizes; `windows/tests/desktop-acceptance.mjs` covers both against a real isolated Relay/Host. This CLI source change has not been published to npm.
- Checks: `node windows/tests/terminal-rendering.mjs`, `TB_TEST_DIST="$PWD/dist" node windows/tests/desktop-acceptance.mjs`, `pnpm test`, `pnpm build`.
- Windows VM: 0.2.2.0 runs against the real Mac mini; two shell/Codex switch cycles preserve normal/alternate buffers respectively. Each Codex check has one visible prompt, no local scrollback offset, and `xterm-helper-textarea` focus. Actual pointer drags change 66 → 55 → 66 columns and restore list width 158; both checks retain one prompt. Native core checks: 10/10. Evidence: `vm/results/164-install-ghost.json`, `165-ghost-native-switch.json`, `167-ghost-drag.json`.
- Installer: `dist/TermBridge-Setup-0.2.2-x64.exe`, 132,016,799 bytes, SHA-256 `bdf233205c57c7060a5c17cf1cd548c8c8977273777f87c57d3d5e6851289aeb`. Windows signing remains unchanged (unsigned).
- Final overwrite install exits 0, all installed file hashes match the 0.2.2 package, saved connection configuration is unchanged, and WebView debugging is removed before the final app launch (`vm/results/168-install-022-release.json`).
