# macOS Codex terminal scrolling

## Correction after the 0.3.32 regression (2026-10-26)

0.3.32 forced Codex to the compatible snapshot transport. This was the wrong
fix: the user reported an oversized input area, a cursor below the input and
only a small amount of scrollable history. Reproduction against the same
running session confirmed both defects. The native transport must be retained.

The previous acceptance established a small snapshot could move and that the
release was signed and delivered. It did not establish input correctness,
resize correctness or useful history depth. The earlier conclusion that the
native viewport lacked history was incorrect.

## Controlled reproduction

A bounded probe used Termbridge's authenticated transport to attach the exact
existing session, without launching an Agent or taking over a controller.
It initially requested 100 columns / 30 rows, then resized to 70 / 20.

- Compatible transport returned about 60 source-pane lines after the resize,
  without cursor positioning. One upward request exhausted the useful snapshot.
- Native transport placed the input cursor at row 27, column 3, then correctly
  moved it to row 17, column 3 after the resize.
- Existing native `session_scroll` changed only live status output. Replaying
  the ANSI deltas through a terminal model showed the first 12 rows unchanged
  across five upward and five downward requests. Counting received bytes had
  hidden this distinction in the previous diagnosis.
- The same wheel events at the viewport center changed the transcript over
  five consecutive upward batches. Reversing them reproduced each previous
  screen hash and finally the original screen. The input cursor stayed valid.

Only bounded diagnostic data was kept locally; credentials were not printed.
No prompt was submitted and no Agent was restarted.

## Root cause and fix

Herdr's `terminal.scroll` command defaults missing coordinates to (0, 0).
This lands on Codex's fixed header, outside its scrollable transcript. Its
mouse-report branch emits one mouse event per command regardless of `lines`.
Termbridge supplied neither a position nor one command per event.

Host now uses the current native viewport center, updated on resize, and sends
bounded one-line wheel commands. This preserves the count for both application
mouse reporting and ordinary terminal scrollback. It does not use PageUp or
arrow-key substitutions. The behavior follows the native control implementation
and the center-position choice in Herdr's explicit alternate-screen reader:
[control parsing](https://github.com/herdrdev/herdr/blob/master/src/client/terminal_sessions.rs),
[wheel routing](https://github.com/herdrdev/herdr/blob/master/src/server/pane_input.rs),
[history reader](https://github.com/herdrdev/herdr/blob/master/src/server/alt_screen_read.rs).

macOS 0.3.33 restores native attach for Codex. Existing explicit native-unavailable
fallback remains. No Termbridge wire change is needed. A remote serving Host
also needs the fix (bundled Host 0.1.35); changing only the viewing app cannot
correct an old Host's control commands.

## Regression checks

The regression tests were run against the broken code first and failed:

- The AppKit/WebSocket test found the cursor at the footer and timed out waiting
  for a resized native viewport.
- The native-controller fixture reproduced both the ignored header wheel and
  Herdr's one-event-per-command behavior; the requested scroll never occurred.

After the fix, the AppKit test verifies cursor placement, window resize,
1000 lines of continued scrolling and return to the live input. The controller
test verifies the same depth before/after resizing, including a size that would
put stale coordinates outside the content area. Existing application-mouse and
older compatible-peer tests still pass.

Full Node validation passed (including typecheck, Worker tests and 32 integration
scenarios), followed by the production build. The macOS suite completed with
214 tests, 35 opt-in tests skipped and no failures.

The serving Host was backed up and reloaded after confirming all four sessions
were externally managed Herdr sessions. The authenticated production transport
then passed the original five-batch scroll comparison: five distinct historical
screens, four exact reverse-page hash matches, exact return to the initial
screen, and the input cursor still at row 17, column 3.
A second production probe used ten batches of 100 lines: ten distinct historical
screens, nine exact reverse-page matches and an exact return, with the same cursor.

## Historical distribution record

0.3.32 (36), commit `68d85f6`, was published in deployment `71aa7586` at
`https://termbridge-a0k.pages.dev/`. Its public ZIP was 95,253,283 bytes with
SHA-256 `eb692cde08c4461b4b1b895af14796db98e7921a4a1cb58bccfbcf0c4075dd55`.
Signature, notarization and isolated Sparkle upgrade checks passed. Those
checks establish artifact delivery only; they do not negate the input and
history regressions above. 0.3.33 supersedes that workaround.

## 0.3.33 installed-app and publication acceptance

The Developer ID-signed, notarized 0.3.33 (37) app was exported from Xcode and
installed at the existing application path. Its bundled Host is 0.1.35. Strict
signature, stapled-ticket and Gatekeeper checks passed. The installed executable
SHA-256 is `30438996379026ce51e0c3fc86db07ddbc48ef5532b4bcf941f0a0043445ac75`.
The previous installed app and serving Host executable were retained in backup.

Actual installed-window checks through Computer Use:

- The native input cursor sits inside Codex's input area, rather than the footer.
- A six-character Chinese draft was pasted and visibly rendered without sending.
  Resizing from about 960 x 732 to 723 x 523 and back retained the draft and
  correctly repositioned the input area/cursor. The draft was then deleted.
- Repeated upward mouse gestures reached successively older transcript content;
  reverse gestures returned to the prior content. Codex's visible Escape-to-latest
  action returned to live output without interrupting the Agent.
- The user's original Canvas session was also checked: two upward gestures
  reached two earlier transcript regions, and two equal downward gestures restored
  its original bottom screen. Its input area stayed correctly positioned.

These establish mouse automation, direct keyboard input, Chinese paste and
window geometry. Physical trackpad feel and a physical IME candidate window
were not measured. No prompt was submitted or external Agent restarted.

Release commit `56ba968` was pushed to `origin/master`. Production deployment
`de298592` publishes 0.3.33 (37). Download-site tests passed (14/14), and artifact
validation verified the update feed and archive signatures. Android, Windows
and the separately published npm CLI remain byte-identical to the previous
public manifest; the macOS app includes the updated Host 0.1.35.

The complete production ZIP was downloaded again: 95,251,452 bytes, SHA-256
`b1ba4a9cbf036bd21229b76ff0177eb195e1157aecc6156ac704ee42cf9ef6b6`.
Its app passed strict signature, stapled-ticket and Gatekeeper checks. Public
feed/archive signatures verified against the previous installed app's update
key. Public, installed and candidate app executables and bundled Host files
match; the serving Host bundle also matches the released Host.
