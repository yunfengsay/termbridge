#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
OUTPUT="${TMPDIR:-/tmp}/termbridge-ios-protocol-smoke"

: "${TB_RELAY_URL:?TB_RELAY_URL is required}"

cd "$ROOT"
xcrun swiftc -parse-as-library \
  Termbridge/Protocol/MessagePack.swift \
  Termbridge/Protocol/FrameCodec.swift \
  Termbridge/Models/SessionInfo.swift \
  Termbridge/Security/HMACHelper.swift \
  Termbridge/Security/ConnectionSettings.swift \
  Termbridge/Networking/TermbridgeClient.swift \
  Tools/ProtocolSmoke.swift \
  -o "$OUTPUT"

"$OUTPUT"

