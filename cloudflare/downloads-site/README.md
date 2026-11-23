# TermBridge landing and downloads

Independent Cloudflare Pages site, using the same static-site + streamed APK pattern as PhoneBrain. No changes to the Relay deployment. `/` and `/downloads/` contain the landing and download section; `/download/:file` streams only manifest-listed Android/macOS artifacts. iOS is explicitly unavailable until a public distribution channel exists.

## Build

Requires Node.js 24, Android SDK build-tools, and macOS packaging tools. First build the Android debug APK and package the Mac app using their existing workflows; this site snapshots those artifacts, verifies their signatures, and uses their embedded version information. No app data or connection settings are packaged.

```sh
cd cloudflare/downloads-site
npm ci
npm run build
npm test
npm run check
npm run dev
```

Defaults: `android/app/build/outputs/apk/debug/app-debug.apk`, `macos/TermBridgeControlCenter/dist/TermBridge.app`, and the latest published npm `agent-termbridge` release. Override artifact paths with `TB_ANDROID_APK`, `TB_MACOS_APP`, or version with `TB_CLI_VERSION`. The npm tarball is checked against registry SHA-512 before generating metadata. Build fails when Android SDK/channel or Mac architecture/minimum OS disagrees with the page copy; update the requirements together.

Output `dist/downloads/manifest.json` records SHA-256 and size of every artifact and part. Download filenames include their content hash, so newly built packages cannot silently reuse an old cached URL. `checksums.txt` covers the complete downloaded files. Each Pages part is at most 20 MiB; the download Function joins them using a bounded stream. No R2 bucket or credentials in the browser are needed.

## Deploy and validate

```sh
npx wrangler pages project create termbridge --production-branch master # first deployment only
npm run deploy
```

Cloudflare Pages project: `termbridge`; production URL: https://termbridge-a0k.pages.dev/. Read back the resulting deployment URL, fetch `/downloads/manifest.json`, then download the Android and Mac links and compare complete-file SHA-256 with the manifest. Check the desktop and phone layout, copy command, FAQ anchors, and error paths in a browser. The product image is a capture of the native macOS settings view with example connection profiles, not a live session.

Pages static requests are free; the streaming download Function uses the account's Workers request quota. Current platform references: https://developers.cloudflare.com/pages/platform/limits/ and https://developers.cloudflare.com/pages/functions/pricing/. The site does not alter account billing.

The Android package is a Debug-signed test build; the Mac package is Apple Silicon-only, Developer ID signed and Apple-notarized (its stapled ticket, signature and Gatekeeper assessment are verified during the build). The landing page discloses those distribution limits. Git commits and pushes are separate from direct Pages deployment.

For landing-only changes, run `npm run build:web && npm run check`. This retains the existing release manifest and exact verified app artifacts rather than repackaging concurrent native builds.

The split hero pairs a desktop terminal and phone connection illustration. Its CLI table was captured from published `agent-termbridge@0.1.24` with an isolated local Relay/Host, Herdr discovery disabled, and one Bash PTY. The illustration is labeled as a demo and contains no real user sessions or pairing information.

Mac downloads use `TermBridge-<version>-macOS-AppleSilicon.dmg`, with a versioned content query and SHA-256-addressed storage parts. The DMG includes the branded `TermBridge.app`, an Applications shortcut, and a custom volume icon. Packaging requires macOS/Xcode command-line tools (`hdiutil`, `iconutil`, `SetFile`). Released Mac archives are Developer ID signed and notarized; the builder records `notarized: true` only after verifying the enclosed app's signature and stapled ticket.
