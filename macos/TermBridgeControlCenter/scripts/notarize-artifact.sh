#!/bin/zsh
# Submit only explicitly selected release artifacts; credentials stay in Keychain.
set -euo pipefail
if (( $# != 1 )) || [[ -z "${TB_MACOS_NOTARY_PROFILE:-}" ]]; then
  print -u2 'Usage: TB_MACOS_NOTARY_PROFILE=<keychain-profile> notarize-artifact.sh <app-or-dmg>'
  exit 2
fi
artifact=${1:A}
[[ -e "$artifact" ]] || { print -u2 'Artifact does not exist'; exit 2; }
case "$artifact" in
  *.app|*.dmg) ;;
  *) print -u2 'Only .app and .dmg artifacts are supported'; exit 2 ;;
esac
signature=$(/usr/bin/codesign -dv --verbose=2 "$artifact" 2>&1)
[[ "$signature" == *'Authority=Developer ID Application:'* ]] || {
  print -u2 'Developer ID Application signature required before notarization'; exit 2
}
/usr/bin/codesign --verify --deep --strict "$artifact"
notary_scratch=$(mktemp -d "${TMPDIR:-/tmp}/termbridge-notary.XXXXXX")
trap 'rm -rf "$notary_scratch"' EXIT
submission="$artifact"
if [[ "$artifact" == *.app ]]; then
  submission="$notary_scratch/TermBridge.zip"
  /usr/bin/ditto -c -k --keepParent "$artifact" "$submission"
fi
notary_keychain_args=()
[[ -z "${TB_MACOS_NOTARY_KEYCHAIN:-}" ]] || notary_keychain_args=(--keychain "$TB_MACOS_NOTARY_KEYCHAIN")
/usr/bin/xcrun notarytool submit "$submission" --keychain-profile "$TB_MACOS_NOTARY_PROFILE" "${notary_keychain_args[@]}" --wait --output-format json > "$notary_scratch/result.json"
notary_result=$(/usr/bin/plutil -extract status raw -o - "$notary_scratch/result.json")
if [[ "$notary_result" != Accepted ]]; then
  print -u2 'Apple did not accept the artifact:'
  cat "$notary_scratch/result.json" >&2
  print -u2 'Use xcrun notarytool log <id> --keychain-profile <profile> to inspect the rejection.'
  exit 1
fi
/usr/bin/xcrun stapler staple "$artifact"
/usr/bin/xcrun stapler validate "$artifact"
if [[ "$artifact" == *.app ]]; then
  /usr/sbin/spctl --assess --type execute --verbose=2 "$artifact"
else
  /usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=2 "$artifact"
fi
