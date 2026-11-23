# macOS connection and Android picker upload

## macOS: reproduced and released in 0.3.6 (build 10)

The CLI and an XCTest client could list sessions using the same self-signed WSS
configuration. A standalone client carrying the shipping macOS Info.plist failed
with a TLS error. The Mac bundle lacked the ATS exception already present on iOS.
With the exception, the same client listed sessions; an incorrect certificate
fingerprint remained rejected. Normal system trust still applies without a pin.

`macos/TermBridgeControlCenter/scripts/test-packaged-connection.mjs` exercises a
signed app with the shipping Info.plist against a disposable TLS relay: valid pin
connects, incorrect pin fails, and an untrusted certificate without a pin fails.
Connection errors are classified without displaying private endpoint data.

Published Mac 0.3.6; public manifest, HTML link, downloaded DMG hash, and signature
verified. CLI and Android public artifacts were retained unchanged. CLI proxy
policy import remains a separate difference; it was not the reproduced TLS cause.

## Android: picker return race fixed in source; device acceptance pending

`TerminalActivity.onStop` disconnects and clears the attachment sid. A system
picker result can arrive before the next attach acknowledgement; `queueImage`
previously rejected that image when sid was null. An interrupted request could
also remain in pendingUploads indefinitely, disabling composer submission.

The queue now accepts images for the known stable session while disconnected,
converts them, and sends only after that session attaches. Requests time out after
45 seconds. Interrupted in-flight requests are removed rather than replayed
with an unknown outcome; late and mismatched acknowledgements are ignored.
Unsent items can wait for reconnection. Existing upload protocol is unchanged.

Validation: 219 Android unit tests passed, including four queue lifecycle tests;
lintDebug and assembleDebug passed. The live configured Host accepted a small PNG
through an independently created disposable cat session, which was then killed.
No active Agent received input. No Android device was connected over ADB; the
user's exact error and device picker reproduction remain unconfirmed. The APK
built from the shared development tree has not replaced the public Android APK.

This evidence does not establish that every reported phone upload failure is the
picker race, or require a Host upgrade for that client fix.

## macOS native terminal: old running Host confirmed, 0.3.7 client UI

A subsequent read-only attach to the reported Herdr session returned attach_ok
without nativeTerminal. The Mac correctly refused the legacy stream, but its
upgrade explanation was only a small footer label under a blank viewport. The
live Herdr snapshot did contain a terminal ID; this probe isolated the missing
capability to the running Host, not a SwiftTerm drawing failure.

Mac 0.3.7 shows connection progress and failures in the viewport, uses a unified
dark title bar/footer/attachment surface, and bounds native initial-screen waits.
Ordinary silent PTYs become ready on attach acknowledgement. Tests cover the
reported legacy Host response, real local PTY Unicode input/focus, failed
connections, attachments at minimum window size, and real remote upload/PTY input.

The running Host also owned a Claude PTY. Updating/restarting that service was
left pending explicit confirmation because it would terminate that owned session.
Herdr-managed Agent lifecycles remain external to TermBridge. The earlier successful
image-upload test does not imply native-terminal capability; these are independent
contracts. Published Host 0.1.24 provides the native-terminal protocol.
