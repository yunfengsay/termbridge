# macOS direct distribution

## Preferred: command-line release with a dedicated keychain

Use `scripts/package-headless-release.py` for unattended releases. It unlocks only
the configured release keychain through Security.framework, validates the local
Developer ID identity and notarytool profile, and invokes the existing package,
sign and notarize steps. It does not invoke Xcode Organizer or fall back to a
development/ad-hoc signature. Desktop unlock is not part of this path.

One-time provisioning requires a Developer ID Application certificate **and its
private key**, plus a notarytool API-key or app-specific-password profile. A
cloud-managed signing certificate alone is insufficient. Create a dedicated
keychain, import the identity with access for `/usr/bin/codesign`, and configure
its `apple-tool:,apple:,codesign:` key partition list. Store the notarytool profile
in that same keychain using `--keychain`. Keep credentials on the release machine.

The machine-local configuration defaults to
`~/.termbridge/macos-release/config.json` (owner-only, mode 0600):

```json
{
  "keychain": "/absolute/path/to/release.keychain-db",
  "passwordFile": "/absolute/path/to/release-keychain-password",
  "identity": "Developer ID Application: YOUR NAME (YOURTEAMID)",
  "notaryProfile": "termbridge-notary",
  "sparkleKeyFile": "/absolute/path/to/existing-sparkle-private-key"
}
```

The password file is also owner-only, mode 0600. The helper passes its contents
directly to Security.framework, never as shell/process arguments. The signing
and notarization commands receive the explicit keychain path; the login keychain
and Xcode account are not their credential sources. Credential access must be
configured during provisioning so codesign/notarytool do not need access dialogs.

```sh
python3 macos/TermBridgeControlCenter/scripts/package-headless-release.py --check
python3 macos/TermBridgeControlCenter/scripts/package-headless-release.py
```

This produces a notarized app. Export the **existing** Sparkle private key once
to an owner-only file (mode 0600) and set `sparkleKeyFile` to sign updates without
login-keychain access. Do not regenerate update keys to work around credential
access. Initial Apple account two-factor authentication remains necessary when
creating release credentials.

After selecting the approved artifacts, the same helper can build, validate and
deploy the site using that key. Public artifact readback is still required:

```sh
TB_MACOS_FORMAT=zip TB_ANDROID_APK=/absolute/path/to/approved.apk \
  python3 macos/TermBridgeControlCenter/scripts/package-headless-release.py --publish-site
```

`scripts/test-headless-release.py` exercises unlock/relock/rejection using an empty
disposable keychain. Only an actual signed/notarized submission with the provisioned
identity establishes that unattended publication is ready.

## Fallback: Xcode cloud signing with the logged-in developer account

The September 2026 release was successfully signed and notarized through Xcode
using its existing logged-in personal developer account. No local Developer ID
private key or separate notarytool password profile was needed.

```sh
macos/TermBridgeControlCenter/scripts/package-xcode-release.py
```

The helper selects the sole installed Apple Development identity (or the exact
`TB_MACOS_DEVELOPMENT_IDENTITY` name/hash when more than one exists), derives its
team from the signed archive, and asks Xcode to use automatic Developer ID signing
and upload for notarization. The original archive is retained under `dist/` for
resuming an interrupted or still-processing submission:

```sh
macos/TermBridgeControlCenter/scripts/package-xcode-release.py --resume /path/to/TermBridge.xcarchive
```

It replaces the local release app only after verifying its Developer ID signature,
hardened runtime, stapled ticket and Gatekeeper acceptance. Xcode must be logged
in to the intended paid developer team with signing permissions. An expired login
or required agreement must be resolved in Xcode/the Apple portal by the account
holder. This submits to Apple but does not publish the website.

### If the CLI reports `No Accounts` despite a signed-in Xcode

This occurred during the 0.3.10 release: the same archive failed at
`IDEDistributionUploadAccountStep` in `xcodebuild`, but Xcode Organizer could use
the existing account and complete Developer ID signing and notarization. Removing
the inherited `__CFBundleIdentifier` did not fix the CLI failure. This is evidence
of a CLI/GUI account-discovery discrepancy, not proof that the user is signed out.

Open the retained `.xcarchive` in Xcode, select **Distribute App → Direct
Distribution**, and wait for the Apple notary upload to complete. Do not select
App Store Connect. Xcode imports the archive into its Archives directory; resume
the helper against that imported archive (whose version/build must match), not
the original unsubmitted copy. The helper must still pass Developer ID, stapled
ticket and Gatekeeper checks. This fallback does not fix CLI account discovery,
change credentials, publish the site, or install the update on the user's Mac.

During 0.3.12, Organizer kept showing **Processing** after Apple had issued its
ticket. A copy of that exact archive's Developer ID-signed `Submissions/.../TermBridge.app`
was successfully stapled with `xcrun stapler staple`, then passed `codesign --verify
--deep --strict`, `stapler validate`, and Gatekeeper's `Notarized Developer ID`
assessment. Its embedded version/build and developer team were checked before
using that verified copy as `TB_MACOS_APP` for the release builder. This is an
alternative export path only after all those checks pass, never permission to
ship an archive merely because its upload completed. The resulting public ZIP
was downloaded again and its ticket, signature, SHA-256 and Sparkle signatures
were verified against the already installed App's public update key.

For this cloud-managed signing path, distribute the exported notarized app as ZIP:

```sh
TB_MACOS_FORMAT=zip TB_ANDROID_APK=/absolute/path/to/approved.apk \
  node cloudflare/downloads-site/scripts/build-release.mjs
```

ZIP containers do not have code signatures; the enclosed App retains its Developer
ID signature and stapled Apple ticket. The builder validates both before recording
`notarized: true`. The download page uses ZIP installation instructions.

## Alternative: locally installed Developer ID certificate


The download-site app uses Developer ID Application signing and Apple notarization.
Apple Development and Apple Distribution are different certificate types and do
not satisfy this workflow. The Apple Developer Program Account Holder can create
a Developer ID Application certificate. A `.dmg` does not need Developer ID Installer
(that certificate is for `.pkg` installers).

## One-time setup on the release Mac

1. In Xcode Settings → Accounts, sign in to the Apple developer account, select
   its paid team, and open Manage Certificates. Use `+` → Developer ID Application.
   If the team already has a suitable certificate on another Mac, transfer that
   certificate together with its private key securely, or have the Account Holder
   create one on this Mac. Installing a `.cer` without its matching private key
   is insufficient.
2. Run `security find-identity -v -p codesigning`. Copy the full identity name that
   starts with `Developer ID Application:`. Do not substitute an Apple Development
   identity or a Personal Team. Use the same bundle ID and developer team for updates.
3. Configure notarization credentials interactively on this Mac:

   ```sh
   xcrun notarytool store-credentials termbridge-notary
   ```

   Supply the developer Apple ID, Developer Team ID and an Apple app-specific
   password at the tool's prompts. These are release-machine credentials, not a
   password the TermBridge app asks end users to provide. Alternatively configure
   an App Store Connect API key using `notarytool store-credentials --help`.
   Do not put credentials in repository files, command history or chat.

## Build, sign and notarize

From the repository root, set the exact installed identity name:

```sh
export TB_MACOS_SIGN_IDENTITY='Developer ID Application: YOUR NAME (YOURTEAMID)'
export TB_MACOS_NOTARY_PROFILE=termbridge-notary
macos/TermBridgeControlCenter/scripts/package-app.sh
```

The script enables hardened runtime, adds Apple's timestamp, signs the finalized
app, submits a ZIP with `notarytool`, checks for `Accepted`, staples the ticket,
and requires Gatekeeper acceptance before replacing `dist/TermBridge.app`.
SwiftTerm is statically linked; no hardened-runtime exception is currently added.
Test local PTY launch, remote input, image attachments and notification delivery
with the signed release before publishing.

Build the download assets with both environment variables still set and explicitly
select the intended Android artifact:

```sh
TB_ANDROID_APK=/absolute/path/to/approved.apk \
  node cloudflare/downloads-site/scripts/build-release.mjs
```

This validates the app ticket, creates and signs the DMG, notarizes and staples the
DMG, and records `notarized: true` only after successful checks. Hashes are computed
after stapling. It does not publish the site. Use the existing download-site release
checks and deployment workflow after acceptance.

With neither variable set, packaging retains the existing ad-hoc preview behavior.
Specifying notarization without a Developer ID identity fails rather than silently
producing a preview artifact. The notarization helper also rejects unsigned,
ad-hoc and development-signed artifacts before submitting anything to Apple.

The Xcode cloud-signing path above has completed a live Apple submission. The
local-certificate/notarytool alternative has only passed preflight rejection and
preview-packaging checks; it still requires local credentials before live use.

References:
- https://developer.apple.com/help/account/certificates/create-developer-id-certificates/
- https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution
- https://developer.apple.com/documentation/security/customizing-the-notarization-workflow

## In-app updates (0.3.9 and later)

Settings → 软件更新 and the application menu use Sparkle 2.9.6. Automatic checks
are enabled by default; automatic download/install is opt-in and defers to quit.
System profiling is disabled. Download-page installation remains available.
Updates only replace this App, never the Host/CLI, Keychain profiles or remote sessions.

Before each release, increase `CFBundleVersion` and update the display version and
`Resources/ReleaseNotes.md`. The public feed is `https://termbridge-a0k.pages.dev/appcast.xml`.
The release builder generates and signs this feed and the notarized ZIP, embeds release
notes, and independently verifies both Ed25519 signatures against the app's public key.
Keep `SUVerifyUpdateBeforeExtraction` and `SURequireSignedFeed` enabled. Do not edit
published appcast bytes after signing. Deploy the feed and its matching archive together.

The update signing private key lives only in the release Mac's Keychain, account
`dev.termbridge.controlcenter`. `SUPublicEDKey` in the app is public. Sparkle tools
are in `.build/artifacts/sparkle/Sparkle/bin` after `swift package resolve`; the builder
accepts `TB_SPARKLE_BIN` for an equivalent official tool distribution. Do not generate
a replacement key for routine releases. Back up or transfer release keys using
Sparkle's documented Keychain workflow, never repository files or chat.

`sign-app.py` signs the updater helpers, XPC services and framework before the app.
Xcode then re-signs the archive with Developer ID and notarizes it; the release helper
waits for processing and fails on rejection. `install-launch-agent.sh` preserves
crash recovery but stops relaunching after normal exit so installation can complete.
When reinstalling an old development LaunchAgent, run this updated install script.

Verification: `swift test`, download-site `npm test`, signed feed/archive checks,
and a Sparkle installation against an isolated older bundle. Keep the existing
Android artifact explicit when building a macOS-only release.
