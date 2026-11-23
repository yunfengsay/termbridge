# PTY descriptor leak repair — 2026-11-16

## Cause and repair

- `node-pty@1.1.0` leaked the Darwin low-fd prologue's spare master, the parent's slave FD and the exit monitor's kqueue. Calling `IPty.destroy()` alone did not fix the spare master. See upstream [#907](https://github.com/microsoft/node-pty/issues/907) and [#950](https://github.com/microsoft/node-pty/issues/950). Both the distributable package and Host workspace now pin `1.2.0-beta.18`, whose shipped native binary was measured to release these resources. The exact prerelease pin is intentional until a verified stable release includes these fixes.
- `packages/host/src/sessionManager.ts` now owns idempotent retirement: remove the session before callbacks, dispose subscriptions, destroy terminal I/O, and clear viewers/output. Kill, failed setup and Host shutdown share cleanup. A disconnect removes viewers while retaining a live session; tmux restart retains its attachment, and Host shutdown preserves durable backend sessions.
- Host exit handling also removes stale client SID references. PTY allocation failures return a bounded, actionable message, including terminal-handle exhaustion. CLI treats a failed terminal launch as terminal instead of reconnecting indefinitely. No wire-schema change.
- SwiftTerm 1.20.0 marked natural exits stopped without closing DispatchIO. `AttachmentTerminalView.processTerminated` now releases through SwiftTerm's owner before forwarding the callback. Disconnect uses a guarded, repeatable local stop. CLI desktop transport already terminates replaced WebSockets; no extra PTY is allocated for Herdr discovery/attachments.

## Evidence

The same `scripts/check-pty-leak.py` runs 20 immediate exits, five one-second exits and five explicit kills against the configured launchd Host.

| Host | Baseline | After 20 echo | After 5 sleep | After 5 kill | Retained masters |
| --- | ---: | ---: | ---: | ---: | ---: |
| Before repair | 6 | 26 | 31 | 36 | +30 |
| destroy-only candidate, rejected | 0 | 20 | 25 | 30 | +30 |
| Native dependency + lifecycle repair | 0 | 0 | 0 | 0 | 0 |

The stronger regression counts **all** process PTY masters/slaves, not just the FD exposed by IPty. Against the old dependency it failed with 15 versus a baseline of 1; with the pinned native fix it passed. It also forces `posix_spawn(E2BIG)` to cover native allocation failure cleanup.

- Three new tests: Host resource lifecycle, CLI fatal-allocation error, macOS natural exit/reconnect.
- Related Node suite: 52 initially passed; the two Host failures were corrected and rerun successfully. Host/CLI typechecks passed after correcting the new fixture's required auth field; remaining workspace typechecks passed on the initial run. No unrelated suite was repeated.
- Related Swift suite: four passed, two existing opt-in tests skipped. Builds passed for bundled CLI/Host, universal native desktop helper and macOS App.
- After the authorized launchd restart, the installed Host uses the fixed library. Global CLI installed locally as 0.1.37.
- `tb ls`: 34 Herdr sessions, zero remaining test sessions. Real `tb attach herdr:…` acknowledged attachment and exited 0 through its local detach menu. No Agent input or lifecycle operation was sent.
- Final packaged macOS runtime: CLI 0.1.37, node-pty 1.2.0-beta.18; real spawn/exit measured 0 → 0 PTY masters.

## Release state

Source fixes are committed on `master` (`a4701cd`, `c803bb1`) and pushed. Desktop candidate: **0.3.34 (38)**. CLI **0.1.37 is now public on npm and the download site**. Artifacts were built from committed sources; concurrent Android/iOS/Windows/docs changes were excluded and preserved.

The CLI retry completed through the existing OIDC workflow: [run 43881375721](https://github.com/yunfengsay/agent-termbridge/actions/runs/43881375721), source `f89f5ee`. Full Node tests, native desktop helper tests, universal packaging checks and publication passed. Registry processing delayed availability for several minutes; public bytes were downloaded and verified only after the version became available. The published CLI/Host/Relay JavaScript bundles exactly match the accepted local bundles, and the package pins node-pty 1.2.0-beta.18.

- Local npm authentication still returns HTTP 401, but OIDC publication works. The initial tag workflow was cancelled because it selected the retired `macos-14` runner. `f89f5ee` switches to `macos-15`. After confirming 0.1.37 was still unpublished, its release tag was moved with an explicit old-SHA lease to this workflow fix. The earlier rejected 0.1.36 candidate tag was removed without publishing it. See the [official runner retirement notice](https://github.blog/changelog/2026-10-01-github-actions-macos-14-runner-image-retirement/).
- The dedicated release keychain lacks the configured Developer ID identity. Xcode's existing development identity produced a candidate, but cloud Developer ID export failed with `PLA Update available` and no Developer ID certificate. The account holder must resolve Apple's updated developer agreement; this task did not accept terms, log in or handle credentials.
- Desktop candidate is ad-hoc signed; its retry archive is Apple Development signed. Neither is Developer ID signed or notarized, and neither was uploaded to the download site/Sparkle feed. A fresh Xcode export on the retry still returned `PLA Update available` and no Developer ID certificate. At the user's request, the Apple Developer account page was opened and handed to the user for login/agreement handling; desktop publication awaits that manual step.
- The download site now advertises CLI 0.1.37: [production](https://termbridge-a0k.pages.dev/), [deployment](https://72ece101.termbridge-a0k.pages.dev). Public manifest/HTML/appcast readback matched the staged release. Existing macOS 0.3.33, Android 0.1.35, Windows 0.2.4, all their asset metadata/parts and the signed Sparkle appcast were preserved. The first Pages deployment attempt hit a network fetch error; retry succeeded.

Local handoff artifacts (not repository files):

- Published CLI readback: `/tmp/termbridge-pty-published-0.1.37.tgz`, SHA-256 `3f2db56bd769d2e46c26f1b56acd90da1a5e25fb64a726e24c6267557e321db4`. The earlier local candidate remains `/tmp/agent-termbridge-0.1.37.tgz`; its native helper build bytes differ from the CI build, while CLI/Host/Relay JavaScript matches exactly.
- App: `/tmp/termbridge-pty-release/macos/TermBridgeControlCenter/dist/TermBridge-0.3.34.app`.
- Final archive: `/tmp/termbridge-pty-release/macos/TermBridgeControlCenter/dist/TermBridge-0.3.34.xcarchive`.
- Matching export options: same directory, `TermBridge-0.3.34-ExportOptions.plist`. This archive has not been submitted: first upload with `xcodebuild -exportArchive`, then use the existing helper's `--resume` notarized-export path after Apple accepts it.
- Exact runtime/source/measurement proof: `/tmp/termbridge-pty-release-proof.json`.
- Logs: `/tmp/termbridge-pty-{red,green-final}.jsonl`, `*-native-regression.log`, `*-swift-test.log`, `*-macos-release.log`, `*-final-archive.log`.

After Apple account readiness, complete Developer ID signing/notarization for desktop 0.3.34 (38), preserve the now-published CLI 0.1.37 and existing Android/Windows artifacts when rebuilding the site, and verify download/appcast bytes before declaring desktop publication complete. Never distribute the development/ad-hoc candidate as the notarized update.
