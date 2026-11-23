#!/bin/zsh
set -euo pipefail

project_dir=${0:A:h:h}
source_app="$project_dir/dist/TermBridge.app"
install_dir="$HOME/Applications"
app_path="$install_dir/TermBridge.app"
legacy_app="$install_dir/TermBridge Control Center.app"
executable_path="$app_path/Contents/MacOS/TermBridgeControlCenter"
label=dev.termbridge.controlcenter
plist="$HOME/Library/LaunchAgents/$label.plist"

if [[ ! -d "$source_app" ]]; then
  "$project_dir/scripts/package-app.sh" >/dev/null
fi

codesign --verify --deep --strict "$source_app"
mkdir -p "$install_dir" "$HOME/Library/LaunchAgents"
staging_dir=$(mktemp -d "$install_dir/.termbridge-install.XXXXXX")
trap 'rm -rf "$staging_dir"' EXIT
ditto "$source_app" "$staging_dir/TermBridge.app"
codesign --verify --deep --strict "$staging_dir/TermBridge.app"

backup_root="$HOME/Library/Application Support/TermBridge/Backups"
mkdir -p "$backup_root"
backup_dir=$(mktemp -d "$backup_root/install-$(date +%Y%m%d-%H%M%S).XXXXXX")
if [[ -f "$plist" ]]; then cp "$plist" "$backup_dir/"; fi
if [[ -d "$app_path" ]]; then ditto "$app_path" "$backup_dir/TermBridge.app"; fi

if [[ -d "$legacy_app" ]]; then ditto "$legacy_app" "$backup_dir/TermBridge Control Center.app"; fi

staged_plist="$staging_dir/$label.plist"
plutil -create xml1 "$staged_plist"
plutil -insert Label -string "$label" "$staged_plist"
plutil -insert ProgramArguments -json "[]" "$staged_plist"
plutil -insert ProgramArguments.0 -string "$executable_path" "$staged_plist"
plutil -insert RunAtLoad -bool true "$staged_plist"
# Normal quit must stay quit so Sparkle can replace and relaunch the app.
plutil -insert KeepAlive -json '{"SuccessfulExit":false}' "$staged_plist"
plutil -insert ProcessType -string Interactive "$staged_plist"
launchctl bootout "gui/$UID/$label" 2>/dev/null || true
rm -rf "$app_path"
mv "$staging_dir/TermBridge.app" "$app_path"
mv "$staged_plist" "$plist"
# The legacy bundle is backed up above; retain the same launch job and Keychain identity.
if [[ -d "$legacy_app" ]]; then rm -rf "$legacy_app"; fi
# launchd may still be completing bootout after the old job disappears.
bootstrapped=false
for attempt in {1..10}; do
  if launchctl bootstrap "gui/$UID" "$plist" 2>"$staging_dir/bootstrap-error"; then
    bootstrapped=true
    break
  fi
  sleep 0.2
done
if [[ "$bootstrapped" != true ]]; then
  cat "$staging_dir/bootstrap-error" >&2
  exit 1
fi
launchctl kickstart "gui/$UID/$label"
printf '%s\n' "$app_path" "$plist" "$backup_dir"
