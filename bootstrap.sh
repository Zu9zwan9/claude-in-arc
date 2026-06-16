#!/usr/bin/env bash
#
# claude-in-arc — remote bootstrap
# =============================================================================
# One-line install:
#
#     curl -fsSL https://raw.githubusercontent.com/Zu9zwan9/claude-in-arc/main/bootstrap.sh | bash
#
# Prefer to read before you run (recommended for any curl|bash):
#
#     curl -fsSLO https://raw.githubusercontent.com/Zu9zwan9/claude-in-arc/main/bootstrap.sh
#     less bootstrap.sh        # inspect it
#     bash bootstrap.sh        # then run
#
# This script is idempotent and runs entirely as your user — it NEVER needs sudo.
# It only writes into your home directory (~/.claude-in-arc and ~/.local/bin).
# It performs no telemetry and collects nothing.
# =============================================================================
set -euo pipefail

REPO_SLUG="Zu9zwan9/claude-in-arc"
BRANCH="main"
HOME_DIR="${CLAUDE_IN_ARC_HOME:-$HOME/.claude-in-arc}"
RAW_BASE="https://raw.githubusercontent.com/${REPO_SLUG}/${BRANCH}"
GIT_URL="https://github.com/${REPO_SLUG}.git"
TARBALL_URL="https://github.com/${REPO_SLUG}/archive/refs/heads/${BRANCH}.tar.gz"

c_bold=$'\033[1m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '  %s!%s %s\n' "$c_yellow" "$c_off" "$*"; }
die()  { printf '  %s✗%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }

say "${c_bold}Claude in Arc — bootstrap${c_off}"

# --- Preconditions ----------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "This installer supports macOS only."

if ! command -v python3 >/dev/null 2>&1; then
  die "python3 not found. Install the Xcode Command Line Tools first:
      xcode-select --install
    then re-run this bootstrap."
fi
ok "python3 found ($(python3 -V 2>&1))"

if [ -d "/Applications/Arc.app" ] || [ -d "$HOME/Library/Application Support/Arc" ]; then
  ok "Arc detected."
else
  warn "Arc not detected. You can still build the extension, but you'll need Arc"
  warn "to load it later: https://arc.net"
fi

# --- Fetch or update the repo (idempotent) ----------------------------------
fetch_with_git() {
  if [ -d "$HOME_DIR/.git" ]; then
    say "  Updating existing checkout in $HOME_DIR ..."
    git -C "$HOME_DIR" fetch --quiet origin "$BRANCH"
    git -C "$HOME_DIR" reset --quiet --hard "origin/$BRANCH"
  else
    say "  Cloning $REPO_SLUG into $HOME_DIR ..."
    rm -rf "$HOME_DIR"
    git clone --quiet --depth 1 --branch "$BRANCH" "$GIT_URL" "$HOME_DIR"
  fi
}

fetch_with_tarball() {
  say "  Downloading $REPO_SLUG tarball ..."
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  curl -fsSL "$TARBALL_URL" -o "$tmp/src.tar.gz" \
    || die "Download failed. Check your connection and the repo URL ($REPO_SLUG)."
  tar -xzf "$tmp/src.tar.gz" -C "$tmp"
  local extracted
  extracted="$(find "$tmp" -maxdepth 1 -type d -name 'claude-in-arc-*' | head -n1)"
  [ -n "$extracted" ] || die "Unexpected tarball layout."
  rm -rf "$HOME_DIR"
  mkdir -p "$(dirname "$HOME_DIR")"
  mv "$extracted" "$HOME_DIR"
}

if command -v git >/dev/null 2>&1; then
  fetch_with_git
else
  warn "git not found — falling back to a tarball download."
  fetch_with_tarball
fi
ok "Source ready in $HOME_DIR"

LAUNCHER="$HOME_DIR/bin/claude-in-arc"
[ -f "$LAUNCHER" ] || die "Launcher missing at $LAUNCHER (corrupt download?)."
chmod +x "$LAUNCHER" "$HOME_DIR/install.sh" 2>/dev/null || true

# --- Put `claude-in-arc` on PATH (no sudo) ----------------------------------
BIN_DIR=""
for d in "$HOME/.local/bin" "/usr/local/bin"; do
  if [ -d "$d" ] && [ -w "$d" ]; then BIN_DIR="$d"; break; fi
done
if [ -z "$BIN_DIR" ]; then
  mkdir -p "$HOME/.local/bin"
  BIN_DIR="$HOME/.local/bin"
fi
ln -sf "$LAUNCHER" "$BIN_DIR/claude-in-arc"
ok "Linked: $BIN_DIR/claude-in-arc"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "Add $BIN_DIR to your PATH to run 'claude-in-arc' directly (e.g. add to ~/.zshrc):"
     say  "      export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# --- Run the install flow ---------------------------------------------------
say ""
say "${c_bold}Running the installer...${c_off}"
exec "$LAUNCHER" install "$@"
