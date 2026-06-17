#!/usr/bin/env bash
# Install Claude in Arc HUD native-messaging host manifest into Arc.
# Usage: ./native/install-hud.sh [--dry-run]
set -euo pipefail

SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
PKG_DIR="$SCRIPT_DIR/ClaudeInArcHUD"
HOST_NAME="com.claudeinarac.hud"
MANIFEST_TEMPLATE="$PKG_DIR/native-messaging/${HOST_NAME}.json"
ARC_NMH_DIR="$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
INSTALL_ROOT="${CLAUDE_IN_ARC_HUD_ROOT:-$HOME/Library/Application Support/ClaudeInArc/HUD}"
HOST_BINARY="$INSTALL_ROOT/bin/ClaudeInArcHUDHost"
MANIFEST_DEST="$ARC_NMH_DIR/${HOST_NAME}.json"

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: $0 [--dry-run]"
      echo "Builds ClaudeInArcHUDHost (if swift is available) and installs NM manifest for Arc."
      exit 0
      ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "HUD host install supports macOS only." >&2
  exit 2
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "swift not found — install Xcode Command Line Tools." >&2
  exit 1
fi

echo "Building ClaudeInArcHUDHost..."
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would run: (cd $PKG_DIR && swift build -c release)"
else
  (cd "$PKG_DIR" && swift build -c release)
fi

BUILT_HOST="$PKG_DIR/.build/release/ClaudeInArcHUDHost"
if [ "$DRY_RUN" != "1" ] && [ ! -f "$BUILT_HOST" ]; then
  echo "Build failed: $BUILT_HOST not found" >&2
  exit 1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] would mkdir -p $INSTALL_ROOT/bin"
  echo "[dry-run] would cp $BUILT_HOST -> $HOST_BINARY"
  echo "[dry-run] would write $MANIFEST_DEST"
  exit 0
fi

mkdir -p "$INSTALL_ROOT/bin"
cp "$BUILT_HOST" "$HOST_BINARY"
chmod +x "$HOST_BINARY"

mkdir -p "$ARC_NMH_DIR"
MANIFEST_TEMPLATE="$MANIFEST_TEMPLATE" MANIFEST_DEST="$MANIFEST_DEST" HOST_BINARY="$HOST_BINARY" python3 <<'PY'
import json
import os
from pathlib import Path

template = Path(os.environ["MANIFEST_TEMPLATE"]).read_text(encoding="utf-8")
data = json.loads(template)
data["path"] = os.environ["HOST_BINARY"]
dest = Path(os.environ["MANIFEST_DEST"])
dest.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
print(f"Installed manifest: {dest}")
print(f"Host binary: {os.environ['HOST_BINARY']}")
PY

echo ""
echo "Next: extension must add nativeMessaging + connectNative('${HOST_NAME}') — not enabled in current patch."
echo "See docs/DYNAMIC_ISLAND.md"
