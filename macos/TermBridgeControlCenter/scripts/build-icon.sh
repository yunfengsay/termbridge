#!/bin/zsh
set -euo pipefail

project_dir=${0:A:h:h}
output=${1:?Usage: build-icon.sh output.icns}
icon_work=$(mktemp -d)
trap 'rm -rf "$icon_work"' EXIT
mkdir "$icon_work/AppIcon.iconset"
sips -s format png "$project_dir/Resources/AppIcon.svg" --out "$icon_work/master.png" >/dev/null
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$icon_work/master.png" --out "$icon_work/AppIcon.iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$icon_work/master.png" --out "$icon_work/AppIcon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$icon_work/AppIcon.iconset" -o "$output"
