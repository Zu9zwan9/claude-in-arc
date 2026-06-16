#!/usr/bin/env bash
# One-command bootstrapper for claude-in-arc.
#
#   ./install.sh            # build + load instructions, and put `claude-in-arc` on PATH
#   ./install.sh --no-link  # skip creating the PATH symlink
#
set -euo pipefail

REPO_ROOT="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
LAUNCHER="$REPO_ROOT/bin/claude-in-arc"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "claude-in-arc currently supports macOS only." >&2
  exit 2
fi

chmod +x "$LAUNCHER"

LINK=1
RUN=1
for arg in "$@"; do
  case "$arg" in
    --no-link) LINK=0 ;;
    --no-run) RUN=0 ;;
  esac
done

# Put `claude-in-arc` on PATH via a symlink in a writable bin dir.
if [ "$LINK" = "1" ]; then
  TARGET_DIR=""
  for d in "/usr/local/bin" "$HOME/.local/bin"; do
    if [ -d "$d" ] && [ -w "$d" ]; then TARGET_DIR="$d"; break; fi
  done
  if [ -z "$TARGET_DIR" ]; then
    mkdir -p "$HOME/.local/bin"
    TARGET_DIR="$HOME/.local/bin"
  fi
  ln -sf "$LAUNCHER" "$TARGET_DIR/claude-in-arc"
  echo "Linked: $TARGET_DIR/claude-in-arc -> $LAUNCHER"
  case ":$PATH:" in
    *":$TARGET_DIR:"*) ;;
    *) echo "Note: add $TARGET_DIR to your PATH to use 'claude-in-arc' directly." ;;
  esac
fi

if [ "$RUN" = "1" ]; then
  exec "$LAUNCHER" install
fi
