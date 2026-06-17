"""
claude_in_arc.core
==================

Production-grade toolkit that makes the official "Claude in Chrome" extension
work in Arc (and other Chromium browsers that lack the chrome.sidePanel API).

It does this WITHOUT bundling a stale copy of the extension: it locates the
freshest copy of the official extension already installed on this machine,
cryptographically verifies it is the genuine Anthropic extension, re-packs it
into an Arc-compatible unpacked build by injecting a chrome.sidePanel polyfill,
and (optionally) mirrors the Claude native-messaging host manifest into Arc.

Design principles
-----------------
- Least privilege: never requires sudo; writes only inside the user's home /
  Library. Refuses to operate on paths outside expected directories.
- Integrity: verifies the source extension's public key hashes to the official
  id before patching. Fails loudly otherwise.
- Reversible: backs up any file it overwrites and records a state file so
  `uninstall` fully rolls back.
- No secrets, no telemetry, no network calls. Standard library only.

macOS only.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

# The official "Claude in Chrome" extension id (Chrome Web Store).
OFFICIAL_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn"

# The official extension's public key (from its manifest). The Chromium
# extension id is derived from this key, so any genuine copy must carry a key
# that hashes to OFFICIAL_EXTENSION_ID. Kept here for defense-in-depth.
OFFICIAL_EXTENSION_KEY = (
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjU1XnLPoasGVmZU42K3h6S+sQhkog"
    "fcoLPbIcrWH5Oo8QoInBIugkew/7cWaEFySyQrkaEBe1fjeS/rlAqd3r778dKcTvDZcXmj0VV"
    "X0Fi1i8tnkarurceGKGdVxfkL7e30nwfgwoPxj3H8OQbsbxFcBWGVtcFekmdpiyaxwz6o4yXI"
    "WColfAxh9K2yToOZkoAS5GvgGvTexiCh1gYy++eFdk6C61mcFsyDdoGQtduhGEaX0zZ9uAW1j"
    "X4JTPmHV3kEFrZu/WVBl7Obw+Jk/osoHMdmghVNy6SCB8/6mcgmxkP9buPrNUZgYP6n0x5dqE"
    "J2Ecww/lb1Zd4nQf4XGOwIDAQAB"
)

# Native messaging host that Claude Desktop / Claude Code register.
NATIVE_HOST_NAME = "com.anthropic.claude_browser_extension"
NATIVE_HOST_FILENAME = f"{NATIVE_HOST_NAME}.json"

# Optional Phase 2 notch HUD companion (native/ClaudeInArcHUD).
HUD_HOST_NAME = "com.claudeinarac.hud"
HUD_HOST_FILENAME = f"{HUD_HOST_NAME}.json"
HUD_STATE_KEY = "hud_native_manifest"

TOOL_VERSION = "1.2.27"

# Anthropic's remote WebSocket bridge for Claude Code `/chrome` automation.
# Unrelated to claude-in-arc's local sidebar bridge page (claude-arc-sidebar-bridge.html).
REMOTE_BRIDGE_WS_HOST = "bridge.claudeusercontent.com"
REMOTE_BRIDGE_FEATURE_FLAG = "chrome_ext_bridge_enabled"

# Product identity (cohesive voice across CLI + docs).
PRODUCT_NAME = "Claude in Arc"
PRODUCT_TAGLINE = "Claude's side panel, now at home in Arc."
# Shown prominently so the project is never mistaken for an official release.
DISCLAIMER = (
    "Unofficial · community-built · not affiliated with or endorsed by "
    "Anthropic or The Browser Company."
)

APP_SUPPORT = Path.home() / "Library" / "Application Support"

# Stable location for the patched, unpacked extension. Keeping this path stable
# means Arc remembers the loaded extension across rebuilds.
BUILD_ROOT = APP_SUPPORT / "ClaudeInArc"
BUILD_EXTENSION_DIR = BUILD_ROOT / "Claude-in-Arc-Extension"
STATE_FILENAME = "state.json"
PATCH_MARKER_FILENAME = "CLAUDE_IN_ARC_PATCH.json"
BACKUP_SUFFIX = ".claude-in-arc.bak"

SHIM_FILENAME = "claude-arc-shim.js"
PRELUDE_FILENAME = "arc-shim-prelude.js"
SW_LOADER_FILENAME = "arc-sw-loader.js"
SIDEBAR_BRIDGE_FILENAME = "claude-arc-sidebar-bridge.html"
SIDEBAR_BRIDGE_JS_FILENAME = "claude-arc-sidebar-bridge.js"
HUD_BRIDGE_FILENAME = "claude-arc-hud-bridge.html"
HUD_BRIDGE_JS_FILENAME = "claude-arc-hud-bridge.js"
HUD_CHROME_POLYFILL_FILENAME = "claude-arc-hud-chrome-polyfill.js"
SIDEBAR_HOST_FILENAME = "claude-arc-sidebar-host.js"
SPLIT_HOST_FILENAME = "claude-arc-split-host.js"
PANEL_MODE_STATE_KEY = "panel_mode"

# Extension HTML pages that may themselves call chrome.sidePanel and therefore
# need the page-side shim injected.
PAGES_TO_PATCH = ["options.html", "sidepanel.html"]

ASSETS_DIR = Path(__file__).resolve().parent / "assets"
SHIM_SOURCE = ASSETS_DIR / SHIM_FILENAME
PRELUDE_SOURCE = ASSETS_DIR / PRELUDE_FILENAME
SIDEBAR_BRIDGE_SOURCE = ASSETS_DIR / SIDEBAR_BRIDGE_FILENAME
SIDEBAR_BRIDGE_JS_SOURCE = ASSETS_DIR / SIDEBAR_BRIDGE_JS_FILENAME
HUD_BRIDGE_SOURCE = ASSETS_DIR / HUD_BRIDGE_FILENAME
HUD_BRIDGE_JS_SOURCE = ASSETS_DIR / HUD_BRIDGE_JS_FILENAME
HUD_CHROME_POLYFILL_SOURCE = ASSETS_DIR / HUD_CHROME_POLYFILL_FILENAME
SIDEBAR_HOST_SOURCE = ASSETS_DIR / SIDEBAR_HOST_FILENAME
SPLIT_HOST_SOURCE = ASSETS_DIR / SPLIT_HOST_FILENAME

VALID_PANEL_MODES = ("popup", "sidebar", "split", "hud")


def shim_version_label() -> str:
    """Return SHIM_VERSION from the shim asset (e.g. '1.2.4')."""
    try:
        text = SHIM_SOURCE.read_text(encoding="utf-8")
    except OSError:
        return "unknown"
    m = re.search(r'SHIM_VERSION\s*=\s*"([^"]+)"', text)
    return m.group(1) if m else "unknown"


def shim_content_hash(short: int = 12) -> str:
    """SHA-256 of the shim asset for install verification."""
    return hashlib.sha256(SHIM_SOURCE.read_bytes()).hexdigest()[:short]

LOG_DIR = Path.home() / "Library" / "Logs" / "claude-in-arc"
LOG_FILE = LOG_DIR / "claude-in-arc.log"

# Chromium extension location enum (extensions::Manifest::Location).
LOCATION_COMPONENT = 0
LOCATION_EXTERNAL_PREF = 1
LOCATION_EXTERNAL_REGISTRY = 2
LOCATION_UNPACKED = 4
LOCATION_INTERNAL = 5
LOCATION_EXTERNAL_PREF_DOWNLOAD = 8
LOCATION_EXTERNAL_POLICY_DOWNLOAD = 9
LOCATION_COMMAND_LINE = 10
LOCATION_EXTERNAL_POLICY = 11
LOCATION_EXTERNAL_COMPONENT = 12

LOCATION_LABELS = {
    LOCATION_COMPONENT: "component",
    LOCATION_EXTERNAL_PREF: "web store",
    LOCATION_EXTERNAL_REGISTRY: "registry",
    LOCATION_UNPACKED: "unpacked (Load unpacked)",
    LOCATION_INTERNAL: "internal",
    LOCATION_EXTERNAL_PREF_DOWNLOAD: "web store (download)",
    LOCATION_EXTERNAL_POLICY_DOWNLOAD: "policy (download)",
    LOCATION_COMMAND_LINE: "command line",
    LOCATION_EXTERNAL_POLICY: "policy",
    LOCATION_EXTERNAL_COMPONENT: "external component",
}

# Exit codes.
EXIT_OK = 0
EXIT_ERROR = 1
EXIT_USAGE = 2


# ---------------------------------------------------------------------------
# Logging & verbosity
# ---------------------------------------------------------------------------

LOG = logging.getLogger("claude-in-arc")
_VERBOSITY = 1  # 0 = quiet (errors only), 1 = normal, 2 = verbose


def setup_logging(verbosity: int) -> None:
    """Configure module verbosity and structured file logging (best effort)."""
    global _VERBOSITY
    _VERBOSITY = verbosity
    LOG.setLevel(logging.DEBUG)
    LOG.handlers.clear()
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(LOG_FILE, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        handler.setLevel(logging.DEBUG)
        LOG.addHandler(handler)
        LOG.debug("=== run: %s v%s argv=%s ===", time.strftime("%Y-%m-%d %H:%M:%S"),
                  TOOL_VERSION, " ".join(sys.argv[1:]))
    except OSError:
        # Logging is a convenience; never fail the tool because of it.
        LOG.addHandler(logging.NullHandler())


# ---------------------------------------------------------------------------
# Browser registry (macOS data directories)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Browser:
    key: str
    name: str
    data_dir: Path
    # Whether this browser is known to lack a working chrome.sidePanel API.
    needs_patch: bool = False


def known_browsers() -> List[Browser]:
    base = APP_SUPPORT
    return [
        Browser("arc", "Arc", base / "Arc" / "User Data", needs_patch=True),
        Browser("chrome", "Google Chrome", base / "Google" / "Chrome"),
        Browser("chrome_beta", "Google Chrome Beta", base / "Google" / "Chrome Beta"),
        Browser("chrome_canary", "Google Chrome Canary", base / "Google" / "Chrome Canary"),
        Browser("brave", "Brave", base / "BraveSoftware" / "Brave-Browser"),
        Browser("edge", "Microsoft Edge", base / "Microsoft Edge"),
        Browser("vivaldi", "Vivaldi", base / "Vivaldi", needs_patch=True),
        Browser("chromium", "Chromium", base / "Chromium"),
        Browser("opera", "Opera", base / "com.operasoftware.Opera"),
        Browser("comet", "Comet", base / "Comet"),
        Browser("dia", "Dia", base / "Dia" / "User Data"),
    ]


def installed_browsers() -> List[Browser]:
    return [b for b in known_browsers() if b.data_dir.is_dir()]


def arc_browser() -> Optional[Browser]:
    return next((b for b in known_browsers() if b.key == "arc"), None)


def arc_installed() -> bool:
    b = arc_browser()
    return bool(b and b.data_dir.is_dir()) or Path("/Applications/Arc.app").exists()


# ---------------------------------------------------------------------------
# Output helpers (verbosity-aware + logged)
# ---------------------------------------------------------------------------

class Style:
    _enabled = sys.stdout.isatty()

    @classmethod
    def _wrap(cls, code: str, text: str) -> str:
        if not cls._enabled:
            return text
        return f"\033[{code}m{text}\033[0m"

    @classmethod
    def bold(cls, t: str) -> str:
        return cls._wrap("1", t)

    @classmethod
    def green(cls, t: str) -> str:
        return cls._wrap("32", t)

    @classmethod
    def yellow(cls, t: str) -> str:
        return cls._wrap("33", t)

    @classmethod
    def red(cls, t: str) -> str:
        return cls._wrap("31", t)

    @classmethod
    def cyan(cls, t: str) -> str:
        return cls._wrap("36", t)

    @classmethod
    def dim(cls, t: str) -> str:
        return cls._wrap("2", t)


def ok(msg: str) -> None:
    LOG.info(msg)
    if _VERBOSITY >= 1:
        print(f"  {Style.green('✓')} {msg}")


def warn(msg: str) -> None:
    LOG.warning(msg)
    if _VERBOSITY >= 1:
        print(f"  {Style.yellow('!')} {msg}")


def fail(msg: str) -> None:
    LOG.error(msg)
    # Errors always surface, even in quiet mode, and go to stderr.
    print(f"  {Style.red('✗')} {msg}", file=sys.stderr)


def info(msg: str) -> None:
    LOG.info(msg)
    if _VERBOSITY >= 1:
        print(f"  {Style.cyan('·')} {msg}")


def debug(msg: str) -> None:
    LOG.debug(msg)
    if _VERBOSITY >= 2:
        print(f"  {Style.dim('debug:')} {Style.dim(msg)}")


def heading(msg: str) -> None:
    LOG.info("== %s", msg)
    if _VERBOSITY >= 1:
        print()
        print(Style.bold(msg))


def say(msg: str) -> None:
    """Plain user-facing line (numbered steps etc.), suppressed when quiet."""
    if _VERBOSITY >= 1:
        print(msg)


def step(n: int, msg: str) -> None:
    """A numbered onboarding step with consistent alignment."""
    if _VERBOSITY >= 1:
        print(f"  {Style.bold(str(n) + '.')} {msg}")


def detail(msg: str) -> None:
    """Quiet secondary line under a step or status (calm, dimmed)."""
    if _VERBOSITY >= 1:
        print(f"     {Style.dim(msg)}")


def rule(width: int = 54) -> None:
    if _VERBOSITY >= 1:
        print("  " + Style.dim("─" * width))


_BANNER_SHOWN = False
_BANNER_WIDTH = 52


def _banner_inner(width: int = _BANNER_WIDTH) -> List[str]:
    """Pure layout helper: the two header rows, padded to exactly `width`.

    Kept separate (and side-effect free) so alignment is unit-testable and can't
    silently break if the product name/tagline/version change.
    """
    ver = f"v{TOOL_VERSION}"
    l1 = " " + PRODUCT_NAME
    l1 = l1 + " " * (width - len(l1) - len(ver) - 1) + ver + " "
    l2 = " " + PRODUCT_TAGLINE
    l2 = l2 + " " * (width - len(l2))
    return [l1, l2]


def banner(force: bool = False) -> None:
    """A restrained, designed product header. Shown once per invocation (TTY)."""
    global _BANNER_SHOWN
    if _VERBOSITY < 1 or (_BANNER_SHOWN and not force):
        return
    _BANNER_SHOWN = True

    w = _BANNER_WIDTH
    l1, l2 = _banner_inner(w)
    l1_disp = l1.replace(PRODUCT_NAME, Style.bold(PRODUCT_NAME), 1)

    d = Style.dim
    print()
    print("  " + d("╭" + "─" * w + "╮"))
    print("  " + d("│") + l1_disp + d("│"))
    print("  " + d("│") + d(l2) + d("│"))
    print("  " + d("╰" + "─" * w + "╯"))
    print("  " + d(DISCLAIMER))
    print()


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

class CliError(Exception):
    pass


class SecurityError(CliError):
    """Raised when an integrity/authenticity or path-safety check fails."""


# ---------------------------------------------------------------------------
# Path safety
# ---------------------------------------------------------------------------

def _assert_within(path: Path, root: Path) -> Path:
    """Refuse to operate on a path outside the expected root directory."""
    rp = path.resolve()
    rroot = root.resolve()
    if rp != rroot and rroot not in rp.parents:
        raise SecurityError(
            f"Refusing to operate on a path outside the expected directory:\n"
            f"    path: {rp}\n    must be within: {rroot}"
        )
    return rp


# ---------------------------------------------------------------------------
# Integrity verification
# ---------------------------------------------------------------------------

def _extension_id_from_key(key_b64: str) -> str:
    """Compute the Chromium extension id from a manifest 'key' (base64 DER)."""
    der = base64.b64decode(key_b64)
    digest = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def verify_official_source(source: "SourceExtension", allow_unverified: bool = False) -> str:
    """
    Verify the source is the genuine official extension by checking that its
    manifest 'key' hashes to the official extension id. Returns the computed id.
    Raises SecurityError on mismatch (unless allow_unverified is set).
    """
    manifest = _read_manifest(source.path)
    name = manifest.get("name", "")
    key = manifest.get("key")

    if not key:
        msg = ("Source extension manifest has no 'key', so its authenticity "
               "cannot be cryptographically verified.")
        if allow_unverified:
            warn(msg + " Proceeding because --allow-unverified was given.")
            return ""
        raise SecurityError(
            msg + "\n    Refusing to patch an unverifiable extension. Pass "
            "--allow-unverified to override (not recommended)."
        )

    try:
        computed = _extension_id_from_key(key)
    except (ValueError, Exception) as e:  # noqa: BLE001 - report any decode failure
        raise SecurityError(f"Could not parse the extension 'key': {e}")

    if computed != OFFICIAL_EXTENSION_ID:
        msg = (f"Source extension is NOT the official Claude extension.\n"
               f"    expected id: {OFFICIAL_EXTENSION_ID}\n"
               f"    computed id: {computed}  (name: {name!r})")
        if allow_unverified:
            warn(msg + "\n    Proceeding because --allow-unverified was given.")
            return computed
        raise SecurityError(msg + "\n    Aborting for your safety.")

    debug(f"verified authenticity: key hashes to {computed}")
    return computed


# ---------------------------------------------------------------------------
# Source extension discovery
# ---------------------------------------------------------------------------

_VERSION_DIR_RE = re.compile(r"^(\d+(?:\.\d+)*)(?:_\d+)?$")


def _parse_version(dir_name: str) -> Optional[Tuple[int, ...]]:
    m = _VERSION_DIR_RE.match(dir_name)
    if not m:
        return None
    try:
        return tuple(int(p) for p in m.group(1).split("."))
    except ValueError:
        return None


@dataclass
class SourceExtension:
    browser: Browser
    version: str
    version_tuple: Tuple[int, ...]
    path: Path  # directory containing manifest.json

    @property
    def label(self) -> str:
        return f"{self.version} (from {self.browser.name})"


def _iter_extension_copies(browser: Browser) -> List[SourceExtension]:
    """Find every installed copy of the official extension in a browser."""
    results: List[SourceExtension] = []
    data_dir = browser.data_dir
    if not data_dir.is_dir():
        return results

    candidate_ext_roots: List[Path] = []
    for ext_root in data_dir.glob(f"*/Extensions/{OFFICIAL_EXTENSION_ID}"):
        candidate_ext_roots.append(ext_root)
    direct = data_dir / "Extensions" / OFFICIAL_EXTENSION_ID
    if direct.is_dir():
        candidate_ext_roots.append(direct)

    for ext_root in candidate_ext_roots:
        if not ext_root.is_dir():
            continue
        for version_dir in ext_root.iterdir():
            if not version_dir.is_dir():
                continue
            vt = _parse_version(version_dir.name)
            if vt is None:
                continue
            if not (version_dir / "manifest.json").is_file():
                continue
            results.append(
                SourceExtension(
                    browser=browser,
                    version=version_dir.name,
                    version_tuple=vt,
                    path=version_dir,
                )
            )
    return results


def discover_sources() -> List[SourceExtension]:
    sources: List[SourceExtension] = []
    for browser in installed_browsers():
        sources.extend(_iter_extension_copies(browser))
    sources.sort(key=lambda s: s.version_tuple, reverse=True)
    return sources


def pick_source(explicit_path: Optional[str]) -> SourceExtension:
    if explicit_path:
        p = Path(explicit_path).expanduser().resolve()
        manifest = p / "manifest.json"
        if not manifest.is_file():
            raise CliError(
                f"No manifest.json found in --source path: {p}\n"
                "Point --source at an unpacked extension directory."
            )
        data = json.loads(manifest.read_text(encoding="utf-8"))
        version = str(data.get("version", "0"))
        vt = _parse_version(version) or (0,)
        synthetic = Browser("custom", "custom path", p.parent)
        return SourceExtension(synthetic, version, vt, p)

    sources = discover_sources()
    if not sources:
        raise CliError(
            "Could not find the official 'Claude in Chrome' extension on this Mac.\n"
            "Install it first from the Chrome Web Store in any Chromium browser\n"
            "(Arc, Chrome, Brave, Edge, ...), then re-run. Store page:\n"
            "  https://chromewebstore.google.com/detail/claude/"
            + OFFICIAL_EXTENSION_ID
        )
    return sources[0]


# ---------------------------------------------------------------------------
# State (for clean rollback)
# ---------------------------------------------------------------------------

def _state_path() -> Path:
    return BUILD_ROOT / STATE_FILENAME


def read_state() -> Dict:
    p = _state_path()
    if p.is_file():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def write_state(state: Dict) -> None:
    BUILD_ROOT.mkdir(parents=True, exist_ok=True)
    _state_path().write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")


def _backup_file(path: Path) -> Optional[Path]:
    """Back up an existing file before overwrite. Returns the backup path."""
    if not path.is_file():
        return None
    backup = path.with_name(path.name + BACKUP_SUFFIX)
    if not backup.exists():
        shutil.copy2(path, backup)
        debug(f"backed up {path} -> {backup}")
    return backup


# ---------------------------------------------------------------------------
# Patch engine
# ---------------------------------------------------------------------------

def _read_manifest(ext_dir: Path) -> Dict:
    manifest_path = ext_dir / "manifest.json"
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def _inject_page_shim(html_path: Path) -> bool:
    """Insert the shim as the first <head> script so it runs before bundled JS."""
    if not html_path.is_file():
        return False
    html = html_path.read_text(encoding="utf-8")
    tag = f'<script src="{SHIM_FILENAME}"></script>'
    if tag in html:
        return True
    m = re.search(r"<head[^>]*>", html, flags=re.IGNORECASE)
    if m:
        idx = m.end()
        new_html = html[:idx] + tag + html[idx:]
    else:
        m2 = re.search(r"<html[^>]*>", html, flags=re.IGNORECASE)
        if m2:
            idx = m2.end()
            new_html = html[:idx] + "<head>" + tag + "</head>" + html[idx:]
        else:
            new_html = tag + html
    html_path.write_text(new_html, encoding="utf-8")
    return True


def _apply_panel_mode_to_shim(shim_path: Path, panel_mode: str) -> None:
    """Bake default panel mode into the copied shim (popup | sidebar | split)."""
    if panel_mode not in VALID_PANEL_MODES:
        raise CliError(
            f"Invalid panel mode: {panel_mode!r} (expected popup, sidebar, split, or hud)"
        )
    text = shim_path.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'var DEFAULT_PANEL_MODE = "(?:popup|sidebar|split|hud)";',
        f'var DEFAULT_PANEL_MODE = "{panel_mode}";',
        text,
        count=1,
    )
    if count != 1:
        raise CliError("Build failed: could not set DEFAULT_PANEL_MODE in shim.")
    shim_path.write_text(updated, encoding="utf-8")


def _patch_web_accessible_resources(manifest: Dict, resource: str) -> bool:
    """Ensure an extension page can be embedded in a page iframe (no new permission)."""
    war = manifest.get("web_accessible_resources")
    if not war:
        manifest["web_accessible_resources"] = [
            {"resources": [resource], "matches": ["<all_urls>"]}
        ]
        return True

    entries: List[Dict] = []
    if isinstance(war, list):
        entries = [e for e in war if isinstance(e, dict)]
    elif isinstance(war, dict):
        entries = [war]

    for entry in entries:
        resources = entry.get("resources") or []
        if resource in resources:
            return False
        if "<all_urls>" in (entry.get("matches") or []) or entry.get("matches") == ["<all_urls>"]:
            entry.setdefault("resources", [])
            if resource not in entry["resources"]:
                entry["resources"].append(resource)
            manifest["web_accessible_resources"] = entries
            return True

    entries.append({"resources": [resource], "matches": ["<all_urls>"]})
    manifest["web_accessible_resources"] = entries
    return True


def _normalize_panel_mode(mode: str) -> str:
    """On Arc, in-page sidebar is blocked — use split-panel instead."""
    if mode not in VALID_PANEL_MODES:
        return "split" if arc_installed() else "popup"
    if mode == "sidebar" and arc_installed():
        return "split"
    return mode


def _panel_mode_from_state() -> str:
    state = read_state()
    if PANEL_MODE_STATE_KEY not in state:
        return "split" if arc_installed() else "popup"
    mode = state.get(PANEL_MODE_STATE_KEY, "popup")
    return _normalize_panel_mode(mode)


def _default_panel_mode_for_install() -> str:
    """First-time Arc installs default to split-panel mode."""
    state = read_state()
    if PANEL_MODE_STATE_KEY in state:
        return _panel_mode_from_state()
    return "split" if arc_installed() else "popup"


@dataclass
class BuildResult:
    source: SourceExtension
    build_dir: Path
    extension_id_preserved: bool
    patched_pages: List[str] = field(default_factory=list)
    original_service_worker: str = ""
    panel_mode: str = "popup"


def build_extension(
    source: SourceExtension,
    dry_run: bool = False,
    new_id: bool = False,
    panel_mode: Optional[str] = None,
) -> BuildResult:
    if not SHIM_SOURCE.is_file():
        raise CliError(f"Internal error: shim asset missing at {SHIM_SOURCE}")
    if not PRELUDE_SOURCE.is_file():
        raise CliError(f"Internal error: prelude asset missing at {PRELUDE_SOURCE}")
    if not SIDEBAR_BRIDGE_SOURCE.is_file():
        raise CliError(f"Internal error: sidebar bridge asset missing at {SIDEBAR_BRIDGE_SOURCE}")
    if not SIDEBAR_BRIDGE_JS_SOURCE.is_file():
        raise CliError(f"Internal error: sidebar bridge script missing at {SIDEBAR_BRIDGE_JS_SOURCE}")
    if not HUD_BRIDGE_SOURCE.is_file():
        raise CliError(f"Internal error: HUD bridge asset missing at {HUD_BRIDGE_SOURCE}")
    if not HUD_BRIDGE_JS_SOURCE.is_file():
        raise CliError(f"Internal error: HUD bridge script missing at {HUD_BRIDGE_JS_SOURCE}")
    if not HUD_CHROME_POLYFILL_SOURCE.is_file():
        raise CliError(
            f"Internal error: HUD chrome polyfill missing at {HUD_CHROME_POLYFILL_SOURCE}"
        )
    if not SIDEBAR_HOST_SOURCE.is_file():
        raise CliError(f"Internal error: sidebar host asset missing at {SIDEBAR_HOST_SOURCE}")
    if not SPLIT_HOST_SOURCE.is_file():
        raise CliError(f"Internal error: split host asset missing at {SPLIT_HOST_SOURCE}")

    if panel_mode is None:
        panel_mode = _default_panel_mode_for_install()
    if panel_mode not in VALID_PANEL_MODES:
        raise CliError(
            f"Invalid panel mode: {panel_mode!r} (expected popup, sidebar, split, or hud)"
        )
    panel_mode = _normalize_panel_mode(panel_mode)

    manifest = _read_manifest(source.path)

    background = manifest.get("background") or {}
    original_sw = background.get("service_worker")
    if not original_sw:
        raise CliError(
            "Source extension has no background.service_worker; cannot patch.\n"
            "This usually means the extension format changed. Please open an issue."
        )

    key_present = bool(manifest.get("key")) and not new_id

    if dry_run:
        print()
        info(f"[dry-run] would copy {source.path}")
        info(f"[dry-run]   -> {BUILD_EXTENSION_DIR}")
        info(f"[dry-run] would wrap service worker '{original_sw}' with '{SW_LOADER_FILENAME}'")
        info(f"[dry-run] would inject page shim into: {', '.join(PAGES_TO_PATCH)}")
        info(f"[dry-run] would add sidebar bridge + split/sidebar host assets")
        info(f"[dry-run] default panel mode: {panel_mode}")
        info(f"[dry-run] extension id preserved via manifest key: {key_present}")
        if new_id:
            info("[dry-run] --new-id: would drop manifest key and rename to 'Claude (Arc)'")
        return BuildResult(
            source=source,
            build_dir=BUILD_EXTENSION_DIR,
            extension_id_preserved=key_present,
            patched_pages=[],
            original_service_worker=original_sw,
            panel_mode=panel_mode,
        )

    # Path-safety: only ever build inside our managed directory.
    _assert_within(BUILD_EXTENSION_DIR, BUILD_ROOT)

    if BUILD_EXTENSION_DIR.exists():
        shutil.rmtree(BUILD_EXTENSION_DIR)
    BUILD_EXTENSION_DIR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source.path, BUILD_EXTENSION_DIR)

    # 1) Drop the chrome.sidePanel polyfill, sidebar assets, and SW prelude at the root.
    shutil.copy2(SHIM_SOURCE, BUILD_EXTENSION_DIR / SHIM_FILENAME)
    shutil.copy2(PRELUDE_SOURCE, BUILD_EXTENSION_DIR / PRELUDE_FILENAME)
    shutil.copy2(SIDEBAR_BRIDGE_SOURCE, BUILD_EXTENSION_DIR / SIDEBAR_BRIDGE_FILENAME)
    shutil.copy2(SIDEBAR_BRIDGE_JS_SOURCE, BUILD_EXTENSION_DIR / SIDEBAR_BRIDGE_JS_FILENAME)
    shutil.copy2(HUD_BRIDGE_SOURCE, BUILD_EXTENSION_DIR / HUD_BRIDGE_FILENAME)
    shutil.copy2(HUD_BRIDGE_JS_SOURCE, BUILD_EXTENSION_DIR / HUD_BRIDGE_JS_FILENAME)
    shutil.copy2(HUD_CHROME_POLYFILL_SOURCE, BUILD_EXTENSION_DIR / HUD_CHROME_POLYFILL_FILENAME)
    shutil.copy2(SIDEBAR_HOST_SOURCE, BUILD_EXTENSION_DIR / SIDEBAR_HOST_FILENAME)
    shutil.copy2(SPLIT_HOST_SOURCE, BUILD_EXTENSION_DIR / SPLIT_HOST_FILENAME)
    _apply_panel_mode_to_shim(BUILD_EXTENSION_DIR / SHIM_FILENAME, panel_mode)

    # 2) Create a module loader that runs the prelude + shim before the real worker.
    loader = (
        "// Auto-generated by claude-in-arc. Loads the chrome.sidePanel\n"
        "// polyfill before the upstream Claude service worker.\n"
        f'import "./{PRELUDE_FILENAME}";\n'
        f'import "./{SHIM_FILENAME}";\n'
        f'import "./{original_sw}";\n'
    )
    (BUILD_EXTENSION_DIR / SW_LOADER_FILENAME).write_text(loader, encoding="utf-8")

    # 3) Repoint the manifest service worker to our loader (keep type:module).
    manifest["background"]["service_worker"] = SW_LOADER_FILENAME
    if "type" not in manifest["background"]:
        manifest["background"]["type"] = "module"

    if new_id:
        manifest.pop("key", None)
        base_name = manifest.get("name", "Claude")
        if "(Arc)" not in base_name:
            manifest["name"] = f"{base_name} (Arc)"

    _patch_web_accessible_resources(manifest, SIDEBAR_BRIDGE_FILENAME)

    (BUILD_EXTENSION_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # 4) Inject the page-side shim into HTML pages that touch chrome.sidePanel.
    patched_pages: List[str] = []
    for page in PAGES_TO_PATCH:
        if _inject_page_shim(BUILD_EXTENSION_DIR / page):
            patched_pages.append(page)

    # 5) Drop a patch marker (kept out of manifest.json to avoid manifest warnings).
    marker = {
        "tool": "claude-in-arc",
        "tool_version": TOOL_VERSION,
        "shim_version": shim_version_label(),
        "shim_hash": shim_content_hash(),
        "panel_mode": panel_mode,
        "source_browser": source.browser.name,
        "source_version": source.version,
        "extension_id_preserved": key_present,
        "service_worker_loader": SW_LOADER_FILENAME,
        "original_service_worker": original_sw,
        "patched_pages": patched_pages,
    }
    (BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).write_text(
        json.dumps(marker, indent=2) + "\n", encoding="utf-8"
    )

    _validate_build(BUILD_EXTENSION_DIR)

    # Record state for rollback.
    state = read_state()
    state["build_dir"] = str(BUILD_EXTENSION_DIR)
    state["tool_version"] = TOOL_VERSION
    state["new_id"] = new_id
    state[PANEL_MODE_STATE_KEY] = panel_mode
    write_state(state)

    return BuildResult(
        source=source,
        build_dir=BUILD_EXTENSION_DIR,
        extension_id_preserved=key_present,
        patched_pages=patched_pages,
        original_service_worker=original_sw,
        panel_mode=panel_mode,
    )


def _validate_build(build_dir: Path) -> None:
    manifest_path = build_dir / "manifest.json"
    if not manifest_path.is_file():
        raise CliError("Build validation failed: manifest.json missing.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    sw = manifest.get("background", {}).get("service_worker")
    if sw != SW_LOADER_FILENAME:
        raise CliError("Build validation failed: service worker was not repointed.")
    for required in (
        SW_LOADER_FILENAME,
        PRELUDE_FILENAME,
        SHIM_FILENAME,
        SIDEBAR_BRIDGE_FILENAME,
        SIDEBAR_BRIDGE_JS_FILENAME,
        HUD_BRIDGE_FILENAME,
        HUD_BRIDGE_JS_FILENAME,
        HUD_CHROME_POLYFILL_FILENAME,
        SIDEBAR_HOST_FILENAME,
        SPLIT_HOST_FILENAME,
        manifest["background"].get("service_worker"),
    ):
        if not (build_dir / required).is_file():
            raise CliError(f"Build validation failed: missing {required}.")
    loader_text = (build_dir / SW_LOADER_FILENAME).read_text(encoding="utf-8")
    if PRELUDE_FILENAME not in loader_text:
        raise CliError("Build validation failed: loader does not import the prelude.")
    if SHIM_FILENAME not in loader_text:
        raise CliError("Build validation failed: loader does not import the shim.")
    prelude_idx = loader_text.index(PRELUDE_FILENAME)
    shim_idx = loader_text.index(SHIM_FILENAME)
    if prelude_idx >= shim_idx:
        raise CliError("Build validation failed: prelude must import before shim.")


# ---------------------------------------------------------------------------
# Native messaging mirroring
# ---------------------------------------------------------------------------

def _nmh_dir(browser: Browser) -> Path:
    return browser.data_dir / "NativeMessagingHosts"


def find_native_host_manifest() -> Optional[Path]:
    """Locate an existing Claude native-messaging host manifest, if any."""
    for browser in installed_browsers():
        candidate = _nmh_dir(browser) / NATIVE_HOST_FILENAME
        if candidate.is_file():
            return candidate
    for browser in installed_browsers():
        d = _nmh_dir(browser)
        if not d.is_dir():
            continue
        for j in d.glob("*.json"):
            try:
                data = json.loads(j.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue
            if data.get("name") == NATIVE_HOST_NAME:
                return j
    return None


@dataclass
class LinkResult:
    status: str  # "linked", "already", "missing-source", "dry-run"
    source: Optional[Path] = None
    target: Optional[Path] = None


def link_native_messaging(dry_run: bool = False) -> LinkResult:
    arc = arc_browser()
    if arc is None or not arc.data_dir.is_dir():
        return LinkResult(status="missing-source")

    target = _nmh_dir(arc) / NATIVE_HOST_FILENAME
    source = find_native_host_manifest()
    if source is None:
        return LinkResult(status="missing-source", target=target)

    src_data = json.loads(source.read_text(encoding="utf-8"))
    origins = src_data.get("allowed_origins") or []
    official_origin = f"chrome-extension://{OFFICIAL_EXTENSION_ID}/"
    if official_origin not in origins:
        origins.append(official_origin)
        src_data["allowed_origins"] = origins

    if target.is_file():
        try:
            existing = json.loads(target.read_text(encoding="utf-8"))
            if (
                existing.get("allowed_origins")
                and official_origin in existing.get("allowed_origins", [])
                and existing.get("path") == src_data.get("path")
            ):
                return LinkResult(status="already", source=source, target=target)
        except (ValueError, OSError):
            pass

    if dry_run:
        return LinkResult(status="dry-run", source=source, target=target)

    target.parent.mkdir(parents=True, exist_ok=True)

    # Back up any pre-existing manifest we did not create, then record state.
    state = read_state()
    pre_existed = target.is_file()
    backup = _backup_file(target) if pre_existed else None

    target.write_text(json.dumps(src_data, indent=2) + "\n", encoding="utf-8")

    state["native_manifest"] = str(target)
    state["native_manifest_preexisted"] = pre_existed
    if backup is not None:
        state["native_manifest_backup"] = str(backup)
    write_state(state)

    return LinkResult(status="linked", source=source, target=target)


# ---------------------------------------------------------------------------
# Notch HUD companion (Phase 2 scaffold)
# ---------------------------------------------------------------------------

def _hud_package_dir(repo_root: Optional[Path] = None) -> Optional[Path]:
    root = repo_root or _find_tool_repo_root()
    if root is None:
        return None
    pkg = root / "native" / "ClaudeInArcHUD"
    return pkg if pkg.is_dir() else None


def _hud_host_binary(pkg_dir: Path, release: bool = False) -> Path:
    config = "release" if release else "debug"
    return pkg_dir / ".build" / config / "ClaudeInArcHUDHost"


def _hud_app_binary(pkg_dir: Path, release: bool = False) -> Path:
    config = "release" if release else "debug"
    return pkg_dir / ".build" / config / "ClaudeInArcHUD"


def _hud_manifest_template(pkg_dir: Path) -> Path:
    return pkg_dir / "native-messaging" / HUD_HOST_FILENAME


@dataclass
class HudBuildResult:
    status: str  # "built", "dry-run", "missing-repo", "build-failed"
    binary: Optional[Path] = None
    message: str = ""


@dataclass
class HudInstallResult:
    status: str  # "installed", "already", "dry-run", "missing-binary", "missing-repo"
    target: Optional[Path] = None
    binary: Optional[Path] = None


def build_hud(dry_run: bool = False, release: bool = False) -> HudBuildResult:
    pkg = _hud_package_dir()
    if pkg is None:
        return HudBuildResult(status="missing-repo", message="native/ClaudeInArcHUD not found")

    if dry_run:
        config = "release" if release else "debug"
        return HudBuildResult(
            status="dry-run",
            binary=_hud_host_binary(pkg, release=release),
            message=f"[dry-run] would run: swift build -c {config} in {pkg}",
        )

    cmd = ["swift", "build", "-c", "release" if release else "debug"]
    try:
        r = subprocess.run(
            cmd,
            cwd=str(pkg),
            capture_output=True,
            text=True,
            timeout=600,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return HudBuildResult(status="build-failed", message=str(e))

    if r.returncode != 0:
        msg = (r.stderr or r.stdout or "swift build failed").strip()
        return HudBuildResult(status="build-failed", message=msg)

    binary = _hud_host_binary(pkg, release=release)
    if not binary.is_file():
        return HudBuildResult(status="build-failed", message=f"expected binary missing: {binary}")

    return HudBuildResult(status="built", binary=binary, message="swift build succeeded")


def install_hud_manifest(dry_run: bool = False, release: bool = False) -> HudInstallResult:
    arc = arc_browser()
    if arc is None or not arc.data_dir.is_dir():
        return HudInstallResult(status="missing-repo")

    pkg = _hud_package_dir()
    if pkg is None:
        return HudInstallResult(status="missing-repo")

    binary = _hud_host_binary(pkg, release=release)
    if not binary.is_file():
        built = build_hud(dry_run=False, release=release)
        if built.status != "built" or built.binary is None:
            return HudInstallResult(status="missing-binary", binary=binary)
        binary = built.binary

    template = _hud_manifest_template(pkg)
    if not template.is_file():
        return HudInstallResult(status="missing-repo")

    data = json.loads(template.read_text(encoding="utf-8"))
    data["name"] = HUD_HOST_NAME
    data["path"] = str(binary.resolve())
    origins = list(data.get("allowed_origins") or [])
    official_origin = f"chrome-extension://{OFFICIAL_EXTENSION_ID}/"
    if official_origin not in origins:
        origins.append(official_origin)
    data["allowed_origins"] = origins

    target = _nmh_dir(arc) / HUD_HOST_FILENAME

    if target.is_file():
        try:
            existing = json.loads(target.read_text(encoding="utf-8"))
            if existing.get("path") == data.get("path"):
                return HudInstallResult(status="already", target=target, binary=binary)
        except (ValueError, OSError):
            pass

    if dry_run:
        return HudInstallResult(status="dry-run", target=target, binary=binary)

    target.parent.mkdir(parents=True, exist_ok=True)
    pre_existed = target.is_file()
    backup = _backup_file(target) if pre_existed else None

    target.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    state = read_state()
    state[HUD_STATE_KEY] = str(target)
    state["hud_native_manifest_preexisted"] = pre_existed
    if backup is not None:
        state["hud_native_manifest_backup"] = str(backup)
    write_state(state)

    return HudInstallResult(status="installed", target=target, binary=binary)


def open_hud_app(release: bool = False) -> bool:
    pkg = _hud_package_dir()
    if pkg is None:
        return False
    binary = _hud_app_binary(pkg, release=release)
    if not binary.is_file():
        built = build_hud(dry_run=False, release=release)
        if built.status != "built":
            return False
        binary = _hud_app_binary(pkg, release=release)
    if not binary.is_file():
        return False
    try:
        subprocess.Popen([str(binary.resolve())], start_new_session=True)
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Arc state inspection
# ---------------------------------------------------------------------------

def _store_extension_roots() -> List[Path]:
    """Return Arc profile dirs that still contain Store extension files on disk."""
    arc = arc_browser()
    if arc is None or not arc.data_dir.is_dir():
        return []
    roots: List[Path] = []
    for ext_root in arc.data_dir.glob(f"*/Extensions/{OFFICIAL_EXTENSION_ID}"):
        if ext_root.is_dir() and any(ext_root.iterdir()):
            roots.append(ext_root)
    return roots


def arc_has_store_extension() -> bool:
    return bool(_store_extension_roots())


def _arc_profile_extension_settings(profile_dir: Path) -> Optional[Dict]:
    """Read the Claude extension entry from one Arc profile's prefs."""
    for pref_name in ("Secure Preferences", "Preferences"):
        pref = profile_dir / pref_name
        if not pref.is_file():
            continue
        try:
            data = json.loads(pref.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        ext = (data.get("extensions") or {}).get("settings", {}).get(OFFICIAL_EXTENSION_ID)
        if ext:
            return ext
    return None


def find_orphaned_store_extension_dirs() -> List[Path]:
    """Store extension folders left on disk after removal from arc://extensions."""
    arc = arc_browser()
    if arc is None or not arc.data_dir.is_dir():
        return []
    orphaned: List[Path] = []
    for ext_root in _store_extension_roots():
        profile_dir = ext_root.parent.parent
        if _arc_profile_extension_settings(profile_dir) is None:
            orphaned.append(ext_root)
    return orphaned


def find_removable_store_extension_dirs() -> List[Path]:
    """Store extension folders safe to delete (not actively loaded in that profile)."""
    arc = arc_browser()
    if arc is None or not arc.data_dir.is_dir():
        return []
    removable: List[Path] = []
    build_path = str(BUILD_EXTENSION_DIR.resolve())
    for ext_root in _store_extension_roots():
        profile_dir = ext_root.parent.parent
        ext = _arc_profile_extension_settings(profile_dir)
        if ext is None:
            removable.append(ext_root)
            continue
        registered_path = ext.get("path") or ""
        if registered_path == build_path or build_path in registered_path:
            removable.append(ext_root)
    return removable


@dataclass
class ArcExtensionState:
    """Parsed Arc registration for the official Claude extension id."""

    registered: bool = False
    path: Optional[str] = None
    location: Optional[int] = None
    from_webstore: Optional[bool] = None
    disabled: bool = False
    service_worker: Optional[str] = None
    is_patched_path: bool = False
    has_patch_marker: bool = False
    store_copy_on_disk: bool = False
    store_copy_orphaned: bool = False
    store_copy_active: bool = False
    store_versions: List[str] = field(default_factory=list)
    orphaned_store_dirs: List[str] = field(default_factory=list)
    conflict: bool = False
    conflict_detail: str = ""

    @property
    def location_label(self) -> str:
        if self.location is None:
            return "unknown"
        return LOCATION_LABELS.get(self.location, f"location {self.location}")


def _arc_extension_settings() -> Optional[Dict]:
    """Read the Claude extension entry from Arc's Secure Preferences / Preferences."""
    arc = arc_browser()
    if arc is None or not arc.data_dir.is_dir():
        return None
    for pref_name in ("Default/Secure Preferences", "Default/Preferences"):
        pref = arc.data_dir / pref_name
        if not pref.is_file():
            continue
        try:
            data = json.loads(pref.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        ext = (data.get("extensions") or {}).get("settings", {}).get(OFFICIAL_EXTENSION_ID)
        if ext:
            return ext
    return None


def _store_versions_on_disk() -> List[str]:
    arc = arc_browser()
    if arc is None or not arc.data_dir.is_dir():
        return []
    versions: List[str] = []
    for ext_root in arc.data_dir.glob(f"*/Extensions/{OFFICIAL_EXTENSION_ID}"):
        if not ext_root.is_dir():
            continue
        for version_dir in ext_root.iterdir():
            if version_dir.is_dir() and (version_dir / "manifest.json").is_file():
                versions.append(version_dir.name)
    return sorted(set(versions))


def inspect_arc_extension() -> ArcExtensionState:
    """Inspect how Arc has registered the Claude extension (best effort)."""
    state = ArcExtensionState()
    state.store_copy_on_disk = arc_has_store_extension()
    state.store_versions = _store_versions_on_disk()
    orphaned_dirs = find_orphaned_store_extension_dirs()
    state.store_copy_orphaned = bool(orphaned_dirs)
    state.orphaned_store_dirs = [str(p) for p in orphaned_dirs]

    ext = _arc_extension_settings()
    if not ext:
        if state.store_copy_orphaned:
            state.conflict_detail = (
                "Leftover Store extension files on disk (removed from arc://extensions "
                "but not deleted). They are not loaded — run "
                "'claude-in-arc cleanup' to remove them."
            )
        return state

    state.registered = True
    state.path = ext.get("path")
    state.location = ext.get("location")
    state.from_webstore = ext.get("from_webstore")
    state.disabled = bool(ext.get("disable_reasons"))

    manifest = ext.get("manifest") or {}
    if isinstance(manifest, dict):
        bg = manifest.get("background") or {}
        state.service_worker = bg.get("service_worker")

    build_path = str(BUILD_EXTENSION_DIR.resolve())
    registered_path = state.path or ""
    state.is_patched_path = registered_path == build_path or build_path in registered_path
    if state.is_patched_path and BUILD_EXTENSION_DIR.is_dir():
        state.has_patch_marker = (BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).is_file()
        try:
            disk_manifest = _read_manifest(BUILD_EXTENSION_DIR)
            state.service_worker = (
                (disk_manifest.get("background") or {}).get("service_worker")
                or state.service_worker
            )
        except (ValueError, OSError):
            pass

    state.store_copy_active = state.registered and not state.is_patched_path
    dual_install = (
        state.is_patched_path
        and state.store_copy_on_disk
        and read_state().get("new_id") is not True
    )
    if state.store_copy_active:
        state.conflict = True
        state.conflict_detail = (
            "Arc is running the Store copy, not the patched build at "
            f"{BUILD_EXTENSION_DIR}."
        )
    elif dual_install:
        state.conflict = True
        state.conflict_detail = (
            "The patched build is loaded, but a Store copy still exists on disk "
            f"({', '.join(state.store_versions) or 'unknown version'}). With the same "
            "extension id, remove the Store copy from arc://extensions to avoid "
            "Arc serving stale files on reload/update."
        )
    elif state.store_copy_orphaned:
        state.conflict_detail = (
            "Leftover Store extension files on disk (removed from arc://extensions "
            "but not deleted). They are not loaded — run "
            "'claude-in-arc cleanup' to remove them."
        )
    return state


def arc_has_patched_build_loaded() -> bool:
    """True when Arc's prefs point at our patched build with a valid patch marker."""
    state = inspect_arc_extension()
    return state.is_patched_path and state.has_patch_marker and not state.disabled


def arc_extension_conflict() -> Tuple[bool, str]:
    """Return (has_conflict, human-readable detail)."""
    state = inspect_arc_extension()
    return state.conflict, state.conflict_detail


# ---------------------------------------------------------------------------
# Best-effort "open the right place for the user"
# ---------------------------------------------------------------------------

def _open_arc_extensions() -> bool:
    """Best-effort open of Arc's extensions page. Never raises."""
    if not arc_installed():
        return False
    for cmd in (
        ["open", "-a", "Arc", "arc://extensions"],
        ["open", "-a", "Arc", "chrome://extensions"],
    ):
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=10)
            if r.returncode == 0:
                debug("opened Arc extensions page via: " + " ".join(cmd))
                return True
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def _reveal_in_finder(path: Path) -> bool:
    try:
        r = subprocess.run(["open", "-R", str(path)], capture_output=True, timeout=10)
        if r.returncode != 0:
            r = subprocess.run(["open", str(path)], capture_output=True, timeout=10)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _find_tool_repo_root() -> Optional[Path]:
    """Best-effort locate the claude-in-arc git repository."""
    candidates: List[Path] = []
    env = os.environ.get("CLAUDE_IN_ARC_REPO")
    if env:
        candidates.append(Path(env).expanduser())
    pkg = Path(__file__).resolve().parent.parent
    candidates.append(pkg)
    cwd = Path.cwd()
    if cwd not in candidates:
        candidates.append(cwd)

    for root in candidates:
        if (root / ".git").is_dir():
            return root.resolve()

    for start in (pkg, cwd):
        try:
            r = subprocess.run(
                ["git", "-C", str(start), "rev-parse", "--show-toplevel"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if r.returncode == 0:
                return Path(r.stdout.strip()).resolve()
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def _git_pull(repo_root: Path, dry_run: bool = False) -> Tuple[bool, str]:
    """Run git pull --ff-only in repo_root. Returns (success, message)."""
    if dry_run:
        return True, f"[dry-run] would run: git pull in {repo_root}"
    try:
        r = subprocess.run(
            ["git", "-C", str(repo_root), "pull", "--ff-only"],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)
    if r.returncode != 0:
        msg = (r.stderr or r.stdout or "git pull failed").strip()
        return False, msg
    return True, (r.stdout or "Already up to date.").strip()


def _read_installed_shim_version() -> Optional[str]:
    """Return SHIM_VERSION from the installed patched build, if present."""
    shim_path = BUILD_EXTENSION_DIR / SHIM_FILENAME
    if not shim_path.is_file():
        return None
    try:
        text = shim_path.read_text(encoding="utf-8")
    except OSError:
        return None
    m = re.search(r'SHIM_VERSION\s*=\s*"([^"]+)"', text)
    return m.group(1) if m else None


def _verify_installed_shim() -> Tuple[bool, str]:
    """Compare installed shim SHIM_VERSION to the bundled asset. Returns (ok, detail)."""
    expected = shim_version_label()
    installed = _read_installed_shim_version()
    if installed is None:
        return False, f"no SHIM_VERSION in {BUILD_EXTENSION_DIR / SHIM_FILENAME}"
    if installed == expected:
        return True, f"claude-arc-shim v{installed}"
    return False, f"expected v{expected}, installed v{installed}"


def _run_osascript(source: str, timeout: int = 30) -> Tuple[bool, str]:
    """Run AppleScript via osascript. Returns (success, stdout or stderr)."""
    try:
        r = subprocess.run(
            ["osascript", "-e", source],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)
    out = (r.stdout or r.stderr or "").strip()
    if r.returncode != 0:
        return False, out or "osascript failed"
    return True, out


def _arc_click_reload_extension() -> Tuple[bool, str]:
    """
    Best-effort click Reload on the Claude unpacked extension card in Arc.

    Requires macOS Accessibility permission for the calling terminal/IDE.
    Arc's arc://extensions page is Chromium web UI; Reload buttons usually have
    no AX label, so this often returns reload_not_found — click Reload manually.

    Returns (clicked, detail).
    """
    script = r'''
on buttonLabel(b)
    try
        set d to description of b
        if d is not missing value and (d as text) is not "missing value" and (d as text) is not "" then return d as text
    end try
    try
        set t to title of b
        if t is not missing value and (t as text) is not "missing value" and (t as text) is not "" then return t as text
    end try
    try
        set v to value of b
        if v is not missing value and (v as text) is not "missing value" and (v as text) is not "" then return v as text
    end try
    try
        set n to name of b
        if n is not missing value and (n as text) is not "missing value" and (n as text) is not "" then return n as text
    end try
    return ""
end buttonLabel

tell application "Arc" to activate
delay 2.5
tell application "System Events"
    if not (exists process "Arc") then return "no_arc_process"
    tell process "Arc"
        set frontmost to true
        repeat with w in windows
            if (name of w as text) contains "Extension" then
                repeat with g in groups of w
                    try
                        repeat with b in buttons of g
                            set lbl to my buttonLabel(b)
                            if lbl is "Reload" or lbl contains "Reload" then
                                click b
                                return "clicked_first_reload"
                            end if
                        end repeat
                    end try
                end repeat
            end if
        end repeat
        return "reload_not_found"
    end tell
end tell
'''
    ok, detail = _run_osascript(script)
    if not ok and "not allowed assistive" in detail.lower():
        return False, "accessibility_denied"
    if ok and detail.startswith("clicked"):
        return True, detail
    return False, detail or "reload_not_found"


def _open_url_in_arc(url: str) -> bool:
    """Open a URL in Arc. Never raises."""
    if not arc_installed():
        return False
    for cmd in (["open", "-a", "Arc", url], ["open", "-a", "Arc", "-n", url]):
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=15)
            if r.returncode == 0:
                debug("opened in Arc: " + url)
                return True
        except (OSError, subprocess.SubprocessError):
            continue
    return False


def _arc_send_toggle_side_panel() -> Tuple[bool, str]:
    """
    Best-effort send ⌘E (toggle-side-panel) to the frontmost Arc window.

    Requires Accessibility permission. Returns (sent, detail).
    """
    script = r'''
tell application "Arc" to activate
delay 0.75
tell application "System Events"
    if not (exists process "Arc") then return "no_arc_process"
    tell process "Arc"
        set frontmost to true
        keystroke "e" using command down
        return "sent"
    end tell
end tell
'''
    ok, detail = _run_osascript(script)
    if not ok and "not allowed assistive" in detail.lower():
        return False, "accessibility_denied"
    return ok and detail == "sent", detail


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def _print_conflict_fix(state: ArcExtensionState, *, include_detail: bool = True) -> None:
    if state.store_copy_orphaned and not state.conflict:
        if include_detail:
            warn(state.conflict_detail)
        info(
            f"Run {Style.bold('claude-in-arc cleanup')} to delete the leftover Store "
            "folder(s), or ignore them — they are not loaded."
        )
        for orphan in state.orphaned_store_dirs:
            detail(orphan)
        return
    if not state.conflict:
        return
    if include_detail:
        warn(state.conflict_detail)
    if state.is_patched_path and state.store_copy_on_disk:
        info(
            f"In {Style.cyan('arc://extensions')}, {Style.bold('Remove')} the Store "
            "copy of Claude (keep the unpacked entry pointing at ClaudeInArc)."
        )
        detail("Or rebuild with --new-id if you intentionally want both copies.")
        detail("Or run: claude-in-arc cleanup")
    elif state.store_copy_active:
        info(
            f"In {Style.cyan('arc://extensions')}, {Style.bold('Remove')} the Store "
            "copy, then Load unpacked →"
        )
        detail(str(BUILD_EXTENSION_DIR))


def _arc_sidebar_unsupported_warning() -> None:
    """Warn that Arc blocks extension iframes in page embeds."""
    warn(
        "Arc blocks extension pages inside page iframes — in-page sidebar mode\n"
        "    does not work on Arc. Use split-panel mode (default) or popup."
    )
    detail("See docs/ARC_LIMITATIONS.md for details.")


def _non_chrome_chromium_browsers() -> List[Browser]:
    """Browsers where the side-panel patch applies (not Google Chrome itself)."""
    return [b for b in installed_browsers() if b.needs_patch]


def _print_remote_bridge_limitation(*, verbose: bool = False) -> None:
    """Document Claude Code /chrome remote bridge — unavailable on non-Chrome Chromium."""
    patched = _non_chrome_chromium_browsers()
    if patched:
        names = ", ".join(b.name for b in patched)
        warn(
            f"Claude Code '/chrome' browser automation is unavailable in {names}."
        )
    else:
        info("Claude Code '/chrome' browser automation requires Google Chrome.")
    detail(
        f"The official extension opens a remote WebSocket to wss://{REMOTE_BRIDGE_WS_HOST}"
    )
    detail(
        f"only when Anthropic's server-side flag ({REMOTE_BRIDGE_FEATURE_FLAG}) allows it."
    )
    detail("That flag evaluates false for non-Chrome Chromium browsers (Arc, Brave, …).")
    detail("No local patch can change a server flag.")
    if patched:
        detail(
            "In Arc you may see: WebSocket connection to "
            f"'wss://{REMOTE_BRIDGE_WS_HOST}/chrome/…' failed: "
            "net::ERR_ADDRESS_INVALID — expected; not caused by claude-in-arc."
        )
    if verbose:
        detail("Side-panel chat with page context (this tool's goal) does not use that bridge.")
        detail("For /chrome automation, use Google Chrome or upvote anthropics/claude-code#34364.")
    else:
        detail("Side-panel chat with page context — which this tool enables — is unaffected.")


def _print_next_steps(build: BuildResult, opened_page: bool, revealed: bool) -> None:
    heading("One step left")
    say("  Chromium asks you to load an unpacked extension yourself — a deliberate")
    say("  security boundary that no tool can bypass. It takes about fifteen seconds.")
    say("")

    arc_state = inspect_arc_extension()
    needs_removal = build.extension_id_preserved and arc_state.store_copy_active
    if needs_removal:
        warn("Arc already has the Store copy of Claude. This build shares the official")
        detail("id, so only one copy can be active. Remove the Store copy below — or")
        detail("re-run with --new-id to keep both (Claude Desktop integration differs).")
        say("")

    n = 1
    if opened_page:
        ok("Arc's extensions page is open for you.")
    else:
        step(n, f"In Arc, open  {Style.cyan('arc://extensions')}")
        n += 1
    if needs_removal:
        step(n, f"Remove the existing {Style.bold('Claude')} extension (the Store copy).")
        n += 1
    elif arc_state.conflict:
        _print_conflict_fix(arc_state)
        say("")
    step(n, f"Turn on {Style.bold('Developer mode')} — top-right toggle.")
    n += 1
    step(n, f"Click {Style.bold('Load unpacked')} and choose:")
    detail(str(build.build_dir))
    if revealed:
        detail("(already revealed in Finder)")

    say("")
    if build.panel_mode == "sidebar":
        if arc_installed():
            _arc_sidebar_unsupported_warning()
            say("")
        say(f"  Then open Claude with the toolbar icon or {Style.bold('⌘E')}. On Chrome/Brave,")
        say("  it appears as an in-page sidebar on the right (resize or close with ×).")
        say(f"  On Arc, the shim uses split-panel mode instead. Right-click the")
        say("  extension icon to switch panel modes.")
    elif build.panel_mode == "split":
        say(f"  Then open Claude with the toolbar icon or {Style.bold('⌘E')}. On Arc,")
        say("  the page narrows on the left and Claude docks on the right — integrated")
        say("  split-panel mode (recommended). Right-click the icon to switch modes.")
    else:
        say(f"  Then open Claude with the toolbar icon or {Style.bold('⌘E')}. It appears as a")
        say("  side window docked to the browser's right edge.")
        say("")
        if arc_installed():
            say(
                f"  Prefer integrated split-panel on Arc? Run "
                f"{Style.cyan('claude-in-arc config --panel-mode split')}"
            )
            say("  then Reload the extension.")
        else:
            say(f"  Prefer an in-page sidebar on Chrome/Brave? Run {Style.cyan('claude-in-arc config --panel-mode sidebar')}")
            say("  then Reload the extension.")
    say("")
    rule()
    say(f"  {Style.dim('Check status')}   claude-in-arc doctor")
    say(f"  {Style.dim('Undo cleanly')}   claude-in-arc uninstall")


def cmd_install(args: argparse.Namespace) -> int:
    upgrade_mode = getattr(args, "_upgrade_mode", False)
    if not upgrade_mode:
        banner()

    if not arc_installed():
        warn("Arc isn't installed yet. I'll build the extension anyway; you'll need")
        detail("Arc to load it — get it at https://arc.net")

    heading("Preparing")
    source = pick_source(args.source)
    ok(f"Found the official Claude extension — {Style.bold(source.label)}")

    # Integrity gate: verify authenticity before touching anything.
    verify_official_source(source, allow_unverified=getattr(args, "allow_unverified", False))
    if not getattr(args, "allow_unverified", False):
        ok("Verified it's genuine — its signing key matches Anthropic's published id.")

    build = build_extension(
        source,
        dry_run=args.dry_run,
        new_id=getattr(args, "new_id", False),
        panel_mode=getattr(args, "panel_mode", None),
    )
    if args.dry_run:
        warn("Dry run — nothing was written.")
        return EXIT_OK

    arc_state = inspect_arc_extension()
    if build.extension_id_preserved and not getattr(args, "ignore_conflict", False):
        if arc_state.store_copy_active:
            heading("Store copy conflict")
            fail(
                "Arc is still running the Chrome Web Store copy of Claude, not the\n"
                "    patched build. Toolbar clicks will not work until you load the\n"
                "    patched build and remove the Store copy."
            )
            _print_conflict_fix(arc_state)
            say("")
            info("Fix options:")
            detail("1. arc://extensions → Remove Store Claude → Load unpacked →")
            detail(f"   {BUILD_EXTENSION_DIR}")
            detail("2. Re-run: claude-in-arc install --new-id  (coexists; different tradeoffs)")
            detail("3. Override (not recommended): claude-in-arc install --ignore-conflict")
            return EXIT_ERROR
        if arc_state.store_copy_orphaned:
            heading("Leftover Store files")
            warn(
                "Arc still has Store extension files on disk, but they are not\n"
                "    registered in Arc — you already removed Claude from\n"
                "    arc://extensions. Install will continue; run cleanup to\n"
                "    delete the leftover folder(s)."
            )
            for orphan in arc_state.orphaned_store_dirs:
                detail(orphan)
            say("")
        if arc_state.is_patched_path and arc_state.store_copy_on_disk:
            heading("Action required")
            warn(
                "The patched build is loaded, but a Store copy still exists on disk.\n"
                "    Remove it from arc://extensions so Arc cannot revert to the\n"
                "    unpatched copy on reload or update."
            )
            _print_conflict_fix(arc_state, include_detail=False)
            say("")

    heading("Building")
    ok("Repacked the extension for Arc.")
    detail(str(build.build_dir))
    if build.patched_pages:
        ok("Added the side-panel compatibility shim (no-op on Chrome/Brave/Edge).")
        detail(f"shim v{shim_version_label()} sha256:{shim_content_hash()}")
    if build.extension_id_preserved:
        ok("Kept the official extension id — Claude Desktop integration stays valid.")
    else:
        ok("Built with a fresh id (Claude (Arc)) — coexists with the Store copy.")

    if getattr(args, "link", True):
        link = link_native_messaging(dry_run=False)
        if link.status == "linked":
            ok("Connected Arc to Claude Desktop (native messaging).")
            detail(str(link.target))
        elif link.status == "already":
            ok("Arc is already connected to Claude Desktop.")
        elif link.status == "missing-source":
            info("Claude Desktop integration isn't set up yet — the chat works without it.")
            detail("Enable the browser extension in Claude Desktop, then run: claude-in-arc link")

    opened_page = False
    revealed = False
    if not upgrade_mode and getattr(args, "open", True) and _VERBOSITY >= 1:
        opened_page = _open_arc_extensions()
        revealed = _reveal_in_finder(build.build_dir)

    if upgrade_mode:
        return EXIT_OK

    _print_next_steps(build, opened_page, revealed)
    return EXIT_OK


def cmd_upgrade(args: argparse.Namespace) -> int:
    """
    End-to-end upgrade: git pull → install → reload extension in Arc → smoke test.

    Arc UI steps (Reload, ⌘E) are best-effort via AppleScript and may require
    Accessibility permission for your terminal.
    """
    banner()
    heading("Upgrade")

    if not arc_installed():
        warn("Arc isn't installed — install steps will still rebuild the extension.")

    # 1) git pull (optional)
    if not getattr(args, "no_pull", False):
        repo = _find_tool_repo_root()
        if repo is None:
            warn("Not inside a claude-in-arc git repo — skipping git pull.")
            detail("Set CLAUDE_IN_ARC_REPO or run from the repo, or pass --no-pull.")
        else:
            info(f"Pulling latest changes in {repo}")
            pulled, msg = _git_pull(repo, dry_run=args.dry_run)
            if pulled:
                ok(msg if not args.dry_run else msg)
            else:
                fail(f"git pull failed: {msg}")
                return EXIT_ERROR
    else:
        info("Skipping git pull (--no-pull).")

    # 2) install / rebuild
    heading("Rebuilding extension")
    install_args = argparse.Namespace(
        source=getattr(args, "source", None),
        dry_run=args.dry_run,
        new_id=getattr(args, "new_id", False),
        allow_unverified=getattr(args, "allow_unverified", False),
        ignore_conflict=getattr(args, "ignore_conflict", False),
        open=False,
        link=getattr(args, "link", True),
        panel_mode=getattr(args, "panel_mode", None),
        _upgrade_mode=True,
    )
    rc = cmd_install(install_args)
    if rc != EXIT_OK:
        return rc
    if args.dry_run:
        warn("Dry run — skipped Arc reload and verification.")
        return EXIT_OK

    problems = 0

    # 3) Arc extensions → Reload
    if not getattr(args, "no_reload", False):
        heading("Reload in Arc")
        if not arc_installed():
            warn("Arc not installed — open arc://extensions manually and click Reload.")
            problems += 1
        elif _open_arc_extensions():
            ok("Opened arc://extensions in Arc.")
            clicked, reload_detail = _arc_click_reload_extension()
            if clicked:
                ok("Clicked Reload on the Claude extension (best effort).")
                reload_msg = reload_detail.replace("_", " ")
                if reload_msg != "clicked":
                    detail(reload_msg)
            elif reload_detail == "accessibility_denied":
                warn(
                    "Could not click Reload — grant Accessibility to your terminal "
                    "(System Settings → Privacy & Security → Accessibility)."
                )
                info("Manual step: on arc://extensions, click Reload on the Claude card.")
                problems += 1
            else:
                warn("Could not find the Reload button automatically.")
                info(
                    "Manual step: on arc://extensions, click Reload on the Claude card "
                    "(Arc's extensions page does not expose Reload to Accessibility)."
                )
                if reload_detail and reload_detail != "reload_not_found":
                    detail(reload_detail)
                problems += 1
        else:
            warn("Could not open arc://extensions in Arc.")
            info("Manual step: Arc → arc://extensions → Reload on the Claude card.")
            problems += 1
    else:
        info("Skipping Arc reload (--no-reload).")

    # 4) Open test page + ⌘E
    test_url = getattr(args, "test_url", "https://example.com")
    if not getattr(args, "no_test_page", False) and test_url:
        heading("Smoke test")
        if _open_url_in_arc(test_url):
            ok(f"Opened {test_url} in Arc.")
        else:
            warn(f"Could not open {test_url} in Arc.")
            problems += 1

        sent, toggle_detail = _arc_send_toggle_side_panel()
        if sent:
            ok("Sent ⌘E to toggle the Claude side panel (best effort).")
        elif toggle_detail == "accessibility_denied":
            warn("Could not send ⌘E — grant Accessibility to your terminal.")
            info("Manual step: on a normal https:// page, press ⌘E or click the Claude icon.")
            problems += 1
        else:
            warn("Could not send ⌘E automatically.")
            info("Manual step: on a normal https:// page, press ⌘E or click the Claude icon.")
            if toggle_detail:
                detail(toggle_detail)
            problems += 1

        info("Service worker console should log:")
        detail("[claude-in-arc] claude-arc-shim v…  (arc://extensions → Service worker → Inspect)")

    # 5) Verify installed shim version
    heading("Verify shim")
    shim_ok, shim_detail = _verify_installed_shim()
    if shim_ok:
        ok(f"Installed shim matches bundled asset: {shim_detail}")
    else:
        fail(f"Shim verification failed: {shim_detail}")
        problems += 1

    say("")
    if problems:
        warn(f"{problems} step(s) need manual follow-up above.")
        return EXIT_ERROR
    ok("Upgrade complete.")
    return EXIT_OK


def cmd_build(args: argparse.Namespace) -> int:
    banner()
    heading("Building")
    source = pick_source(args.source)
    ok(f"Found the official Claude extension — {Style.bold(source.label)}")
    verify_official_source(source, allow_unverified=getattr(args, "allow_unverified", False))
    build = build_extension(
        source,
        dry_run=args.dry_run,
        new_id=getattr(args, "new_id", False),
        panel_mode=getattr(args, "panel_mode", None),
    )
    if args.dry_run:
        warn("Dry run — nothing was written.")
        return EXIT_OK
    ok("Repacked the extension for Arc.")
    detail(str(build.build_dir))
    detail(f"shim v{shim_version_label()} sha256:{shim_content_hash()}")
    return EXIT_OK


def cmd_hud(args: argparse.Namespace) -> int:
    banner()
    action = getattr(args, "hud_action", "build")

    if action == "build":
        heading("Building Claude-in-Arc HUD")
        result = build_hud(dry_run=args.dry_run, release=args.release)
        if result.status == "dry-run":
            info(result.message)
            return EXIT_OK
        if result.status == "missing-repo":
            fail("Could not find native/ClaudeInArcHUD. Run from the claude-in-arc repo.")
            return EXIT_ERROR
        if result.status == "build-failed":
            fail("swift build failed.")
            detail(result.message)
            return EXIT_ERROR
        ok("Built native HUD binaries.")
        if result.binary:
            detail(str(result.binary))
        pkg = _hud_package_dir()
        if pkg:
            detail(str(_hud_app_binary(pkg, release=args.release)))
        return EXIT_OK

    if action == "install":
        heading("Installing HUD native-messaging host")
        result = install_hud_manifest(dry_run=args.dry_run, release=args.release)
        if result.status == "installed":
            ok("Registered HUD host in Arc.")
            detail(str(result.target))
            detail(str(result.binary))
            if open_hud_app(release=args.release):
                ok("Launched menu-bar HUD app.")
            else:
                detail("Run: claude-in-arc hud open  (menu-bar app must be running)")
            detail("Then: claude-in-arc config --panel-mode hud  and Reload arc://extensions")
        elif result.status == "already":
            ok("HUD host already registered.")
            detail("Run: claude-in-arc hud open  and config --panel-mode hud if not set yet")
        elif result.status == "dry-run":
            info("[dry-run] would write HUD manifest:")
            detail(str(result.target))
            detail(str(result.binary))
        elif result.status == "missing-binary":
            fail("HUD host binary missing. Run: claude-in-arc hud build")
            return EXIT_ERROR
        else:
            fail("Could not install HUD host.")
            return EXIT_ERROR
        return EXIT_OK

    if action == "open":
        heading("Launching Claude-in-Arc HUD")
        if args.dry_run:
            pkg = _hud_package_dir()
            if pkg:
                info(f"[dry-run] would launch {_hud_app_binary(pkg, release=args.release)}")
            return EXIT_OK
        if open_hud_app(release=args.release):
            ok("Launched menu-bar HUD app.")
            return EXIT_OK
        fail("Could not launch HUD. Run: claude-in-arc hud build")
        return EXIT_ERROR

    fail(f"Unknown hud action: {action}")
    return EXIT_USAGE


def cmd_link(args: argparse.Namespace) -> int:
    banner()
    heading("Connecting Arc to Claude Desktop")
    link = link_native_messaging(dry_run=args.dry_run)
    if link.status == "linked":
        ok("Connected.")
        detail(f"{link.source}")
        detail(f"→ {link.target}")
    elif link.status == "already":
        ok("Already connected — nothing to do.")
    elif link.status == "dry-run":
        info("[dry-run] would copy:")
        detail(f"{link.source}")
        detail(f"→ {link.target}")
    elif link.status == "missing-source":
        warn("No Claude native-messaging host found on this Mac yet.")
        detail("Enable the browser extension in Claude Desktop (Settings), or install")
        detail("Claude Code, then re-run: claude-in-arc link")
        return EXIT_ERROR
    return EXIT_OK


def _doctor_arc_extension(verbose: bool = False) -> int:
    """Return number of problems found in Arc extension registration."""
    problems = 0
    arc_state = inspect_arc_extension()

    heading("Loaded in Arc?")
    if not arc_state.registered and not arc_state.store_copy_on_disk:
        warn("Claude extension not registered in Arc yet. Load it via arc://extensions →\n"
             "    Developer mode → Load unpacked.")
        problems += 1
        if verbose:
            detail(f"Expected path: {BUILD_EXTENSION_DIR}")
            detail("Actual: not registered")
        return problems

    if not arc_state.registered and arc_state.store_copy_orphaned:
        warn("Claude extension not registered in Arc yet. Load it via arc://extensions →\n"
             "    Developer mode → Load unpacked.")
        problems += 1
        if verbose:
            detail(f"Expected path: {BUILD_EXTENSION_DIR}")
            detail("Actual: not registered (leftover Store files on disk are harmless)")
        return problems

    if arc_state.is_patched_path and arc_state.has_patch_marker:
        ok("The patched build is registered in Arc.")
        detail(arc_state.path or "")
        if verbose:
            detail(f"Expected: {BUILD_EXTENSION_DIR}")
            detail(f"Service worker: {arc_state.service_worker or '(unknown)'}")
            if arc_state.service_worker != SW_LOADER_FILENAME:
                warn(
                    f"Service worker is {arc_state.service_worker!r}, expected "
                    f"{SW_LOADER_FILENAME!r}. Re-run install and Reload in Arc."
                )
                problems += 1
    elif arc_state.is_patched_path:
        warn("Arc points at the patched folder but CLAUDE_IN_ARC_PATCH.json is missing.\n"
             "    Re-run 'claude-in-arc install'.")
        problems += 1
    else:
        warn("Arc is running the Store / stock copy, not the patched build.")
        if arc_state.path:
            detail(arc_state.path)
        if verbose:
            detail(f"Expected patched path: {BUILD_EXTENSION_DIR}")
        problems += 1

    if arc_state.disabled:
        fail("The Claude extension is disabled in Arc. Enable it on arc://extensions.")
        problems += 1

    if verbose and arc_state.registered:
        info(f"Install source: {arc_state.location_label}")
        info(f"from_webstore flag: {arc_state.from_webstore}")

    return problems


def _doctor_arc_expectations() -> None:
    """Honest Arc UX — separate OS window is expected, not Chrome's in-browser panel."""
    heading("Arc — what this tool can and cannot do")
    info("Arc has no chrome.sidePanel. Claude opens in a separate OS window, not inside Arc.")
    detail(
        "A chrome-extension://…/sidepanel.html?tabId=N URL in that window is normal — "
        "not evidence the patch failed."
    )
    info("Split mode (default): page shrinks left (~410px); a narrow window docks on the right.")
    detail(
        "It may still appear as its own window in ⌘Tab — Arc cannot embed extension UI "
        "in-browser. See docs/ARC_LIMITATIONS.md."
    )
    info("Chat is working if: the window opens, you can type, and Claude answers about the current page.")
    detail(
        "After claude-in-arc upgrade: click Reload on arc://extensions "
        "(Arc does not expose Reload to automation)."
    )
    detail(
        "WebSocket errors to bridge.claudeusercontent.com are expected — "
        "Claude Code /chrome only; side-panel chat does not use that bridge."
    )


def _doctor_hud(verbose: bool = False) -> int:
    """Return number of HUD-specific setup problems."""
    if not arc_installed():
        return 0

    build_ok = BUILD_EXTENSION_DIR.is_dir() and (BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).is_file()
    if not build_ok:
        return 0

    marker = json.loads((BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).read_text(encoding="utf-8"))
    if _normalize_panel_mode(marker.get("panel_mode", "popup")) != "hud":
        return 0

    problems = 0
    heading("Notch HUD (panel-mode hud)")

    for name in (HUD_BRIDGE_FILENAME, HUD_BRIDGE_JS_FILENAME, HUD_CHROME_POLYFILL_FILENAME):
        path = BUILD_EXTENSION_DIR / name
        if path.is_file():
            ok(f"HUD asset present ({name})")
        else:
            warn(f"Missing {name} in patched build.")
            detail("Run: claude-in-arc install --panel-mode hud")
            problems += 1

    pkg = _hud_package_dir()
    if pkg is None:
        warn("native/ClaudeInArcHUD not found in this checkout.")
        problems += 1
    else:
        host_bin = _hud_host_binary(pkg)
        app_bin = _hud_app_binary(pkg)
        if host_bin.is_file():
            ok(f"HUD host binary: {host_bin.name}")
        else:
            warn("HUD host binary missing.")
            detail("Run: claude-in-arc hud build")
            problems += 1
        if app_bin.is_file():
            ok(f"Menu-bar app binary: {app_bin.name}")
        else:
            warn("ClaudeInArcHUD menu-bar app missing.")
            detail("Run: claude-in-arc hud build && claude-in-arc hud open")
            problems += 1

    arc = arc_browser()
    if arc and (_nmh_dir(arc) / HUD_HOST_FILENAME).is_file():
        ok("HUD native-messaging manifest registered in Arc.")
    else:
        warn("HUD native-messaging host not registered.")
        detail("Run: claude-in-arc hud install")
        problems += 1

    arc_state = inspect_arc_extension()
    if arc_state.store_copy_active:
        warn("Store Claude extension is loaded — HUD chrome proxy will not work.")
        detail("Remove the Store copy on arc://extensions; keep only Load unpacked.")
        problems += 1

    info("On ⌘E: compact notch pill + floating chat panel below the menu bar.")
    detail("Console.app → ClaudeInArcHUD / ClaudeInArcHUDHost for loadBridge and scheme logs.")
    if verbose:
        detail(f"Patched extension path: {BUILD_EXTENSION_DIR}")
        detail(f"Arc registered path: {arc_state.path or '(none)'}")

    return problems


def _doctor_split_panel(verbose: bool = False) -> int:
    """Return number of split-panel setup problems on Arc."""
    if not arc_installed():
        return 0

    problems = 0
    heading("Arc split-panel mode")
    build_ok = BUILD_EXTENSION_DIR.is_dir() and (BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).is_file()
    if not build_ok:
        warn("No patched build — cannot verify split-panel assets.")
        return 1

    split_host = BUILD_EXTENSION_DIR / SPLIT_HOST_FILENAME
    if split_host.is_file():
        ok(f"Split host present ({SPLIT_HOST_FILENAME})")
    else:
        warn(f"Missing {SPLIT_HOST_FILENAME} in patched build. Re-run install.")
        problems += 1

    marker = json.loads((BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).read_text(encoding="utf-8"))
    raw_mode = marker.get("panel_mode", "popup")
    mode = _normalize_panel_mode(raw_mode)
    if raw_mode == "sidebar" and mode == "split":
        warn("Build panel mode: sidebar — not supported on Arc (runtime uses split).")
        detail("Run: claude-in-arc config --panel-mode split  then Reload on arc://extensions")
    elif mode == "hud":
        ok("Build panel mode: hud (notch HUD + native messaging)")
    elif mode == "split":
        ok("Build panel mode: split (Arc default)")
    elif mode == "popup":
        warn("Build panel mode: popup — page margin disabled on Arc.")
        detail("Run: claude-in-arc config --panel-mode split")
        problems += 1
    else:
        info(f"Build panel mode: {mode}")

    info("Expected on Arc: page shrinks left (~410px), docked popup flush on the right,")
    detail("page margin + invisible resize strip; popup docks over the gutter.")
    detail(
        "Arc cannot embed Chrome's in-browser side panel — split mode uses a separate "
        "OS window positioned over the margin."
    )
    detail("If it still floats center-screen: focus Arc, press ⌘E, run claude-in-arc upgrade.")

    if verbose and build_ok:
        shim_path = BUILD_EXTENSION_DIR / SHIM_FILENAME
        if shim_path.is_file():
            shim = shim_path.read_text(encoding="utf-8")
            if "SPLIT_POPUP_DELAY_MS" in shim:
                ok("Shim applies margin before opening docked popup")
            if "arcExplicitPopupMode" in shim:
                ok("Shim defaults Arc to split unless popup is explicit")
            if "forcePanelWindowBounds" in shim:
                ok("Shim corrects popup bounds after windows.create")
            if "waitForSplitAnchorBounds" in shim:
                ok("Shim waits for Arc window geometry before opening docked popup")
            if "verifySplitDockAlignment" in shim:
                ok("Shim verifies popup gutter alignment after bounds retries")
            if "openPanelInSplit" in shim:
                ok("Shim defines openPanelInSplit")
            if "claude-arc-split-host" in shim:
                ok("Shim references split host script")

    return problems


def _doctor_conflicts() -> int:
    problems = 0
    heading("Conflicts")
    arc_state = inspect_arc_extension()
    if arc_state.conflict:
        warn(arc_state.conflict_detail)
        _print_conflict_fix(arc_state, include_detail=False)
        problems += 1
    elif arc_state.store_copy_orphaned:
        info("Leftover Store extension files on disk (not loaded).")
        _print_conflict_fix(arc_state, include_detail=False)
    else:
        ok("No Store vs patched conflict detected.")
    return problems


def _print_verify_walkthrough() -> None:
    """Verbose step-by-step checklist (doctor --verbose / verify)."""
    heading("Verification walkthrough")
    arc_state = inspect_arc_extension()
    build_ok = BUILD_EXTENSION_DIR.is_dir() and (BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).is_file()

    checks = [
        ("Patched build on disk", build_ok, str(BUILD_EXTENSION_DIR)),
        (
            "Arc prefs point at patched build",
            arc_state.is_patched_path and arc_state.has_patch_marker,
            arc_state.path or "(not registered)",
        ),
        (
            "Service worker is arc-sw-loader.js",
            arc_state.service_worker == SW_LOADER_FILENAME,
            arc_state.service_worker or "(unknown)",
        ),
        ("Shim asset in build", (BUILD_EXTENSION_DIR / SHIM_FILENAME).is_file() if build_ok else False,
         SHIM_FILENAME),
        (
            "Prelude asset in build",
            (BUILD_EXTENSION_DIR / PRELUDE_FILENAME).is_file() if build_ok else False,
            PRELUDE_FILENAME,
        ),
        (
            "Split host in build",
            (BUILD_EXTENSION_DIR / SPLIT_HOST_FILENAME).is_file() if build_ok else False,
            SPLIT_HOST_FILENAME,
        ),
        (
            "Arc panel mode is split (sidebar OK — runtime uses split)",
            (
                _normalize_panel_mode(
                    json.loads((BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).read_text(encoding="utf-8")).get(
                        "panel_mode", "popup"
                    )
                )
                == "split"
                if build_ok
                else False
            ),
            (
                json.loads((BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).read_text(encoding="utf-8")).get(
                    "panel_mode", "?"
                )
                if build_ok
                else "n/a"
            ),
        ),
        ("No Store copy on disk", not arc_state.store_copy_on_disk,
         ", ".join(arc_state.store_versions) if arc_state.store_versions else "none"),
        (
            "No leftover Store files",
            not arc_state.store_copy_orphaned,
            ", ".join(arc_state.orphaned_store_dirs) if arc_state.orphaned_store_dirs else "none",
        ),
        ("Extension enabled in Arc", arc_state.registered and not arc_state.disabled,
         "disabled" if arc_state.disabled else arc_state.location_label),
    ]

    for label, passed, actual in checks:
        if passed:
            ok(label)
        else:
            warn(f"{label} — expected OK, got: {actual}")
        if _VERBOSITY >= 2:
            detail(f"actual: {actual}")

    say("")
    info("If the icon still does nothing after Reload:")
    detail("arc://extensions → Claude → Service worker → Inspect → Console")
    detail("(Not options.html — that is a separate page console.)")
    detail("Look for [claude-in-arc] arc-shim-prelude loaded and claude-arc-shim v…")
    detail("Try Cmd+E (toggle-side-panel command) as well as the toolbar icon")
    detail(f"Logs: {LOG_FILE}")


def cmd_doctor(args: argparse.Namespace) -> int:
    banner()
    heading("Diagnostics")

    problems = 0
    verbose = getattr(args, "verbose", False) or _VERBOSITY >= 2

    if arc_installed():
        ok("Arc is installed.")
    else:
        fail("Arc not detected. Install it from https://arc.net")
        problems += 1

    heading("Browsers")
    browsers = installed_browsers()
    if not browsers:
        fail("No supported Chromium browsers detected.")
        problems += 1
    for b in browsers:
        tag = Style.yellow(" (needs sidePanel patch)") if b.needs_patch else ""
        ok(f"{b.name}{tag}")

    heading("Claude extension")
    sources = discover_sources()
    if not sources:
        fail("Official 'Claude in Chrome' extension not found in any browser.\n"
             "    Install it: https://chromewebstore.google.com/detail/claude/"
             + OFFICIAL_EXTENSION_ID)
        problems += 1
    for s in sources:
        try:
            verify_official_source(s)
            ok(f"{s.label}  {Style.dim('[verified]')}")
        except SecurityError:
            warn(f"{s.label}  [could NOT verify authenticity]")

    heading("Patched build")
    if BUILD_EXTENSION_DIR.is_dir() and (BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).is_file():
        marker = json.loads((BUILD_EXTENSION_DIR / PATCH_MARKER_FILENAME).read_text(encoding="utf-8"))
        ok(f"Present at {BUILD_EXTENSION_DIR}")
        info(f"Built from {marker.get('source_browser')} v{marker.get('source_version')} "
             f"(tool {marker.get('tool_version')})")
        if verbose:
            manifest = _read_manifest(BUILD_EXTENSION_DIR)
            info(f"manifest service_worker: {manifest.get('background', {}).get('service_worker')}")
    else:
        warn("No patched build yet. Run 'claude-in-arc install'.")
        problems += 1

    problems += _doctor_arc_extension(verbose=verbose)
    if arc_installed():
        _doctor_arc_expectations()
        problems += _doctor_hud(verbose=verbose)
        problems += _doctor_split_panel(verbose=verbose)
    problems += _doctor_conflicts()

    heading("Claude Desktop integration")
    src = find_native_host_manifest()
    if src is None:
        warn("No Claude native-messaging host found. Side-panel chat still works;\n"
             "    enable the browser extension in Claude Desktop to add desktop\n"
             "    integration, then run 'claude-in-arc link'.")
    else:
        ok(f"Found host manifest: {src}")
        arc = arc_browser()
        if arc and (_nmh_dir(arc) / NATIVE_HOST_FILENAME).is_file():
            ok("Arc is linked to the native-messaging host.")
        else:
            warn("Arc is NOT linked yet. Run 'claude-in-arc link'.")

    heading("Claude Code /chrome bridge")
    _print_remote_bridge_limitation(verbose=verbose)

    heading("Logs")
    info(f"{LOG_FILE}")

    if verbose:
        _print_verify_walkthrough()

    say("")
    if problems:
        warn(f"{problems} item(s) need attention above.")
        return EXIT_ERROR
    ok("Everything looks healthy.")
    return EXIT_OK


def cmd_verify(args: argparse.Namespace) -> int:
    """Verbose verification walkthrough (alias for doctor --verbose)."""
    args.verbose = True
    return cmd_doctor(args)


def cmd_uninstall(args: argparse.Namespace) -> int:
    banner()
    heading("Removing and rolling back")
    state = read_state()
    removed_any = False

    # 1) Remove the patched build (path-safety enforced).
    if BUILD_EXTENSION_DIR.exists():
        if args.dry_run:
            info(f"[dry-run] would remove {BUILD_EXTENSION_DIR}")
        else:
            _assert_within(BUILD_EXTENSION_DIR, BUILD_ROOT)
            shutil.rmtree(BUILD_EXTENSION_DIR)
            ok(f"Removed patched build: {BUILD_EXTENSION_DIR}")
        removed_any = True

    # 2) Restore or remove the native-messaging manifest we touched.
    arc = arc_browser()
    target = _nmh_dir(arc) / NATIVE_HOST_FILENAME if arc else None
    backup = state.get("native_manifest_backup")
    preexisted = state.get("native_manifest_preexisted", False)
    if target and target.is_file():
        if args.dry_run:
            if backup:
                info(f"[dry-run] would restore backup over {target}")
            else:
                info(f"[dry-run] would remove {target}")
        else:
            if backup and Path(backup).is_file() and preexisted:
                shutil.copy2(backup, target)
                Path(backup).unlink(missing_ok=True)
                ok(f"Restored original native-messaging manifest from backup.")
            else:
                target.unlink()
                ok(f"Removed Arc native-messaging manifest: {target}")
        removed_any = True

    # 3) Remove state + empty build root.
    if not args.dry_run:
        if _state_path().is_file():
            _state_path().unlink(missing_ok=True)
        if BUILD_ROOT.exists() and not any(BUILD_ROOT.iterdir()):
            BUILD_ROOT.rmdir()

    if not removed_any:
        ok("Already clean — nothing to remove.")
    else:
        ok("Done. Everything this tool added has been rolled back.")
    say("")
    info("If you loaded the unpacked extension in Arc, remove it from arc://extensions too.")
    return EXIT_OK


def cmd_cleanup(args: argparse.Namespace) -> int:
    banner()
    heading("Cleaning up leftover Store files")

    if not arc_installed():
        warn("Arc isn't installed — nothing to clean up.")
        return EXIT_OK

    arc = arc_browser()
    assert arc is not None
    removable = find_removable_store_extension_dirs()
    active = [p for p in _store_extension_roots() if p not in removable]

    if not removable and not active:
        ok("No Store extension folders found on disk.")
        return EXIT_OK

    if active:
        warn(
            "Skipping folder(s) still registered as the active Store copy in Arc.\n"
            "    Remove Claude from arc://extensions first, then re-run cleanup."
        )
        for path in active:
            detail(str(path))

    if not removable:
        return EXIT_ERROR

    info(f"Found {len(removable)} leftover Store folder(s) to remove:")
    for path in removable:
        detail(str(path))

    if args.dry_run:
        warn(f"Dry run — would remove {len(removable)} folder(s). Quit Arc first.")
        return EXIT_OK

    info("Quit Arc before cleanup so it does not recreate files.")
    removed = 0
    for ext_root in removable:
        _assert_within(ext_root, arc.data_dir)
        if ext_root.name != OFFICIAL_EXTENSION_ID:
            raise SecurityError(f"Refusing unexpected extension directory name: {ext_root.name}")
        shutil.rmtree(ext_root)
        ok(f"Removed {ext_root}")
        removed += 1

    say("")
    ok(f"Removed {removed} leftover Store folder(s).")
    info("Run 'claude-in-arc install' if you have not loaded the patched build yet.")
    return EXIT_OK


def cmd_config(args: argparse.Namespace) -> int:
    banner()
    panel_mode = getattr(args, "panel_mode", None)
    if not panel_mode:
        mode = _panel_mode_from_state()
        ok(f"Current panel mode: {Style.bold(mode)}")
        detail("split   — page margin + docked window on Arc (default on Arc)")
        detail("popup   — docked ~410px window flush to browser right edge")
        detail("sidebar — in-page right column on Chrome/Brave (not supported on Arc)")
        detail("hud     — notch HUD via native messaging (macOS; run claude-in-arc hud install)")
        detail("")
        detail("Set mode:  claude-in-arc config --panel-mode split|popup|sidebar|hud")
        detail("Then Reload the extension in arc://extensions")
        return EXIT_OK

    state = read_state()
    saved_mode = panel_mode
    panel_mode = _normalize_panel_mode(panel_mode)
    state[PANEL_MODE_STATE_KEY] = panel_mode
    write_state(state)
    if saved_mode == "sidebar" and panel_mode == "split" and arc_installed():
        ok(f"Panel mode saved as {Style.bold('split')} (sidebar is not supported on Arc).")
    else:
        ok(f"Panel mode preference saved: {Style.bold(panel_mode)}")
    if saved_mode == "sidebar" and arc_installed():
        say("")
        _arc_sidebar_unsupported_warning()
    if panel_mode == "hud" and not arc_installed():
        warn("HUD mode is designed for Arc + the ClaudeInArcHUD companion on macOS.")
    if panel_mode == "split" and not arc_installed():
        warn("Split-panel mode is designed for Arc. On Chrome/Brave the shim uses popup.")

    if not BUILD_EXTENSION_DIR.is_dir():
        warn("No patched build yet. Run 'claude-in-arc install' to apply this mode.")
        return EXIT_OK

    heading("Rebuilding")
    try:
        source = pick_source(getattr(args, "source", None))
    except CliError as exc:
        warn(str(exc))
        detail("Re-run 'claude-in-arc install --panel-mode " + panel_mode + "' to rebuild.")
        return EXIT_OK

    verify_official_source(source, allow_unverified=getattr(args, "allow_unverified", False))
    build = build_extension(
        source,
        dry_run=args.dry_run,
        new_id=state.get("new_id", False),
        panel_mode=panel_mode,
    )
    if args.dry_run:
        warn("Dry run — nothing was written.")
        return EXIT_OK
    ok("Rebuilt the extension with the new panel mode.")
    detail(str(build.build_dir))
    detail("Reload the extension in arc://extensions for the change to take effect.")
    return EXIT_OK


def cmd_reveal(args: argparse.Namespace) -> int:
    if not BUILD_EXTENSION_DIR.is_dir():
        fail("No build to reveal yet — run 'claude-in-arc install' first.")
        return EXIT_ERROR
    _reveal_in_finder(BUILD_EXTENSION_DIR)
    ok("Opened the extension folder in Finder.")
    detail(str(BUILD_EXTENSION_DIR))
    return EXIT_OK


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="claude-in-arc",
        description="Make the official 'Claude in Chrome' extension work in Arc.",
    )
    parser.add_argument("--version", action="version", version=f"claude-in-arc {TOOL_VERSION}")
    parser.add_argument("-v", "--verbose", action="store_true", help="Verbose output (debug detail).")
    parser.add_argument("-q", "--quiet", action="store_true", help="Quiet output (errors only).")

    sub = parser.add_subparsers(dest="command")

    def add_common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--dry-run", action="store_true", help="Preview without writing files.")

    def add_new_id(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--new-id",
            action="store_true",
            help="Drop the manifest key so the build gets a fresh id and can coexist "
            "with the Store copy of Claude. Native messaging then expects the official "
            "id, so leave this off if you use Claude Desktop integration.",
        )

    def add_verify(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--allow-unverified",
            action="store_true",
            help="Skip the authenticity check (NOT recommended). Only for patching a "
            "custom --source you fully trust.",
        )

    def add_panel_mode(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--panel-mode",
            choices=list(VALID_PANEL_MODES),
            help="Panel presentation: split (Arc default), popup window, or in-page sidebar (Chrome/Brave).",
        )

    p_install = sub.add_parser("install", help="Build the patched extension and link native messaging (default).")
    p_install.add_argument("--source", help="Path to an unpacked official extension to patch.")
    p_install.add_argument("--no-open", dest="open", action="store_false",
                           help="Don't auto-open Arc / reveal the folder.")
    p_install.add_argument("--no-link", dest="link", action="store_false",
                           help="Skip native-messaging mirroring.")
    p_install.add_argument(
        "--ignore-conflict",
        action="store_true",
        help="Build even when Arc still has the Store copy active (not recommended).",
    )
    add_new_id(p_install)
    add_verify(p_install)
    add_panel_mode(p_install)
    add_common(p_install)
    p_install.set_defaults(func=cmd_install, open=True, link=True)

    p_upgrade = sub.add_parser(
        "upgrade",
        help="Pull latest tool, rebuild, reload in Arc, and verify the shim.",
    )
    p_upgrade.add_argument(
        "--no-pull",
        action="store_true",
        help="Skip git pull (use when not in the claude-in-arc repo).",
    )
    p_upgrade.add_argument(
        "--no-reload",
        action="store_true",
        help="Skip opening arc://extensions and clicking Reload.",
    )
    p_upgrade.add_argument(
        "--no-test-page",
        action="store_true",
        help="Skip opening a test URL and sending ⌘E in Arc.",
    )
    p_upgrade.add_argument(
        "--test-url",
        default="https://example.com",
        help="URL to open in Arc for the smoke test (default: https://example.com).",
    )
    p_upgrade.add_argument("--source", help="Path to an unpacked official extension to patch.")
    p_upgrade.add_argument("--no-link", dest="link", action="store_false",
                           help="Skip native-messaging mirroring.")
    p_upgrade.add_argument(
        "--ignore-conflict",
        action="store_true",
        help="Build even when Arc still has the Store copy active (not recommended).",
    )
    add_new_id(p_upgrade)
    add_verify(p_upgrade)
    add_panel_mode(p_upgrade)
    add_common(p_upgrade)
    p_upgrade.set_defaults(func=cmd_upgrade, link=True)

    p_build = sub.add_parser("build", help="Only (re)build the patched extension.")
    p_build.add_argument("--source", help="Path to an unpacked official extension to patch.")
    add_new_id(p_build)
    add_verify(p_build)
    add_panel_mode(p_build)
    add_common(p_build)
    p_build.set_defaults(func=cmd_build)

    p_config = sub.add_parser(
        "config",
        help="Show or set panel mode (split, popup, or in-page sidebar).",
    )
    p_config.add_argument(
        "--panel-mode",
        choices=list(VALID_PANEL_MODES),
        help="Set default panel mode and rebuild the patched extension.",
    )
    p_config.add_argument("--source", help="Path to an unpacked official extension to patch.")
    add_verify(p_config)
    add_common(p_config)
    p_config.set_defaults(func=cmd_config)

    p_link = sub.add_parser("link", help="Mirror the Claude native-messaging host into Arc.")
    add_common(p_link)
    p_link.set_defaults(func=cmd_link)

    p_hud = sub.add_parser(
        "hud",
        help="Build, install, or launch the optional macOS notch HUD companion.",
    )
    p_hud.add_argument(
        "hud_action",
        nargs="?",
        choices=("build", "install", "open"),
        default="build",
        help="build (default), install native-messaging manifest, or open menu-bar app",
    )
    p_hud.add_argument(
        "--release",
        action="store_true",
        help="Use release build configuration (default: debug).",
    )
    add_common(p_hud)
    p_hud.set_defaults(func=cmd_hud, release=False)

    p_doctor = sub.add_parser("doctor", help="Diagnose the current setup.")
    p_doctor.add_argument(
        "--verbose",
        action="store_true",
        help="Print a step-by-step verification walkthrough (expected vs actual).",
    )
    p_doctor.set_defaults(func=cmd_doctor, verbose=False)

    p_verify = sub.add_parser(
        "verify",
        help="Verbose verification walkthrough (same as doctor --verbose).",
    )
    p_verify.set_defaults(func=cmd_verify, verbose=True)

    p_uninstall = sub.add_parser("uninstall", help="Remove the patched build and roll back changes.")
    add_common(p_uninstall)
    p_uninstall.set_defaults(func=cmd_uninstall)

    p_cleanup = sub.add_parser(
        "cleanup",
        help="Remove leftover Chrome Web Store extension files from Arc's profile.",
    )
    add_common(p_cleanup)
    p_cleanup.set_defaults(func=cmd_cleanup)

    p_reveal = sub.add_parser("reveal", help="Open the patched build folder in Finder.")
    p_reveal.set_defaults(func=cmd_reveal)

    return parser


def main(argv: Optional[List[str]] = None) -> int:
    if sys.platform != "darwin":
        print("claude-in-arc currently supports macOS only.", file=sys.stderr)
        return EXIT_USAGE

    parser = build_parser()
    args = parser.parse_args(argv)

    verbosity = 1
    if getattr(args, "verbose", False):
        verbosity = 2
    if getattr(args, "quiet", False):
        verbosity = 0
    setup_logging(verbosity)

    if not getattr(args, "command", None):
        # Default to install with sensible defaults.
        args.func = cmd_install
        args.source = None
        args.dry_run = False
        args.new_id = False
        args.open = True
        args.link = True
        args.allow_unverified = False

    try:
        return args.func(args)
    except SecurityError as e:
        fail(str(e))
        return EXIT_ERROR
    except CliError as e:
        fail(str(e))
        return EXIT_ERROR
    except KeyboardInterrupt:
        print(file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
