#!/bin/zsh
set -euo pipefail

project_dir=${0:A:h:h}
output_app="${TB_MACOS_OUTPUT_APP:-$project_dir/dist/TermBridge.app}"

signing_identity=${TB_MACOS_SIGN_IDENTITY:--}
if [[ "$signing_identity" != - ]]; then
  [[ "$signing_identity" == 'Developer ID Application: '* ]] || {
    print -u2 'TB_MACOS_SIGN_IDENTITY must be the full Developer ID Application identity name'; exit 2
  }
  signing_keychain_args=()
  [[ -z "${TB_MACOS_SIGNING_KEYCHAIN:-}" ]] || signing_keychain_args=("$TB_MACOS_SIGNING_KEYCHAIN")
  identities=$(/usr/bin/security find-identity -v -p codesigning "${signing_keychain_args[@]}")
  [[ "$identities" == *\""$signing_identity"\"* ]] || {
    print -u2 'Requested Developer ID Application certificate and private key are not installed'; exit 2
  }
elif [[ -n "${TB_MACOS_NOTARY_PROFILE:-}" ]]; then
  print -u2 'Notarization requires TB_MACOS_SIGN_IDENTITY; refusing ad-hoc fallback'; exit 2
fi

cd "$project_dir"

# Regenerate the shared conversation surface before building.
#
# `Package.swift` only *copies* `Resources/AgentChat`, so whatever happens to be
# sitting there is what ships. Leaving that to a separate manual step is how a
# release went out with a renderer that predated its own Markdown support. The
# build now produces it, and refuses if it cannot.
if [[ "${TB_MACOS_SKIP_SHARED_UI:-0}" != 1 ]]; then
  ( cd "$project_dir/../.." && pnpm -s build:agent-chat-ui \
      "macos/TermBridgeControlCenter/Sources/TermBridgeControlCenter/Resources/AgentChat" ) \
    || { print -u2 'Failed to build the shared Agent Chat surface'; exit 2; }
fi
shared_ui_dir="$project_dir/Sources/TermBridgeControlCenter/Resources/AgentChat"
# Regenerate the desktop viewer from the same source used by Android and iOS.
node "$project_dir/../../packages/desktop-ui/scripts/build.mjs" "$project_dir/Sources/TermBridgeControlCenter/Resources/Desktop"
desktop_ui_dir="$project_dir/Sources/TermBridgeControlCenter/Resources/Desktop"
desktop_ui_sha=$(/usr/bin/shasum -a 256 "$desktop_ui_dir/desktop.js" | cut -d' ' -f1)
# The renderer and the licences of what it bundles ship together; an app that
# carries third-party code without its licence text is not redistributable.
typeset -A shared_ui_shas
for file in chat.js THIRD_PARTY_LICENSES.md; do
  [[ -f "$shared_ui_dir/$file" ]] || { print -u2 "Missing generated $file"; exit 2; }
  shared_ui_shas[$file]=$(/usr/bin/shasum -a 256 "$shared_ui_dir/$file" | cut -d' ' -f1)
  print "[package-app] shared $file ${shared_ui_shas[$file]}"
done

runtime_dir="${TB_MACOS_RUNTIME_DIR:-$project_dir/build/Runtime}"
if [[ -z "${TB_MACOS_RUNTIME_DIR:-}" ]]; then
  node "$project_dir/scripts/prepare-runtime.mjs" "$runtime_dir"
fi
[[ -x "$runtime_dir/node" && -f "$runtime_dir/package/dist/cli.js" ]] || { print -u2 "Missing embedded Host runtime"; exit 2; }

swift build -c release
mkdir -p "$project_dir/dist"
staging_dir=$(mktemp -d "$project_dir/dist/.package.XXXXXX")
trap 'rm -rf "$staging_dir"' EXIT
app_dir="$staging_dir/TermBridge.app"
contents_dir="$app_dir/Contents"
mkdir -p "$contents_dir/MacOS"
mkdir -p "$contents_dir/Resources"
cp ".build/release/TermBridgeControlCenter" "$contents_dir/MacOS/TermBridgeControlCenter"
cp ".build/checkouts/SwiftTerm/LICENSE" "$contents_dir/Resources/SwiftTerm-LICENSE.txt"
ditto ".build/release/SwiftTerm_SwiftTerm.bundle" "$contents_dir/Resources/SwiftTerm_SwiftTerm.bundle"
ditto ".build/release/TermBridgeControlCenter_TermBridgeControlCenter.bundle" "$contents_dir/Resources/TermBridgeControlCenter_TermBridgeControlCenter.bundle"
packaged_desktop="$contents_dir/Resources/TermBridgeControlCenter_TermBridgeControlCenter.bundle/Desktop/desktop.js"
[[ -f "$packaged_desktop" && "$desktop_ui_sha" == "$(/usr/bin/shasum -a 256 "$packaged_desktop" | cut -d' ' -f1)" ]] || {
  print -u2 'Packaged desktop viewer is missing or stale'; exit 2
}
# The three stages must agree: what was generated, what SwiftPM bundled, and
# what the app carries. A mismatch means a stale renderer is about to ship.
for file in ${(k)shared_ui_shas}; do
  packaged="$contents_dir/Resources/TermBridgeControlCenter_TermBridgeControlCenter.bundle/AgentChat/$file"
  [[ -f "$packaged" ]] || { print -u2 "Packaged app is missing AgentChat/$file"; exit 2; }
  bundled_ui_sha=$(/usr/bin/shasum -a 256 "$packaged" | cut -d' ' -f1)
  [[ "$bundled_ui_sha" == "${shared_ui_shas[$file]}" ]] || {
    print -u2 "Packaged $file $bundled_ui_sha does not match the generated ${shared_ui_shas[$file]}"; exit 2
  }
done
mkdir -p "$contents_dir/Frameworks"
ditto ".build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework" "$contents_dir/Frameworks/Sparkle.framework"
cp ".build/checkouts/Sparkle/LICENSE" "$contents_dir/Resources/Sparkle-LICENSE.txt"
mkdir -p "$contents_dir/Resources/Browser"
cp "$project_dir/../../browser-extension/bridge.mjs" "$contents_dir/Resources/Browser/bridge.mjs"
ditto "$project_dir/../../browser-extension/extension" "$contents_dir/Resources/Browser/extension"
ditto "$runtime_dir" "$contents_dir/Resources/Runtime"
cp "Resources/Info.plist" "$contents_dir/Info.plist"
zsh "$project_dir/scripts/build-icon.sh" "$contents_dir/Resources/AppIcon.icns"
# Sign nested updater helpers before the framework and app root.
python3 "$project_dir/scripts/sign-app.py" "$app_dir" "$signing_identity"
if [[ -n "${TB_MACOS_NOTARY_PROFILE:-}" ]]; then
  "$project_dir/scripts/notarize-artifact.sh" "$app_dir"
fi
# Replace only after the complete new bundle passes signature verification.
mkdir -p "${output_app:h}"
rm -rf "$output_app"
mv "$app_dir" "$output_app"
printf '%s\n' "$output_app"
