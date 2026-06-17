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

TOOL_VERSION = "1.2.4"

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
SW_LOADER_FILENAME = "arc-sw-loader.js"

# Extension HTML pages that may themselves call chrome.sidePanel and therefore
# need the page-side shim injected.
PAGES_TO_PATCH = ["options.html", "sidepanel.html"]

ASSETS_DIR = Path(__file__).resolve().parent / "assets"
SHIM_SOURCE = ASSETS_DIR / SHIM_FILENAME


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


@dataclass
class BuildResult:
    source: SourceExtension
    build_dir: Path
    extension_id_preserved: bool
    patched_pages: List[str] = field(default_factory=list)
    original_service_worker: str = ""


def build_extension(
    source: SourceExtension, dry_run: bool = False, new_id: bool = False
) -> BuildResult:
    if not SHIM_SOURCE.is_file():
        raise CliError(f"Internal error: shim asset missing at {SHIM_SOURCE}")

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
        info(f"[dry-run] extension id preserved via manifest key: {key_present}")
        if new_id:
            info("[dry-run] --new-id: would drop manifest key and rename to 'Claude (Arc)'")
        return BuildResult(
            source=source,
            build_dir=BUILD_EXTENSION_DIR,
            extension_id_preserved=key_present,
            patched_pages=[],
            original_service_worker=original_sw,
        )

    # Path-safety: only ever build inside our managed directory.
    _assert_within(BUILD_EXTENSION_DIR, BUILD_ROOT)

    if BUILD_EXTENSION_DIR.exists():
        shutil.rmtree(BUILD_EXTENSION_DIR)
    BUILD_EXTENSION_DIR.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source.path, BUILD_EXTENSION_DIR)

    # 1) Drop the chrome.sidePanel polyfill at the extension root.
    shutil.copy2(SHIM_SOURCE, BUILD_EXTENSION_DIR / SHIM_FILENAME)

    # 2) Create a module loader that runs the shim before the real worker.
    loader = (
        "// Auto-generated by claude-in-arc. Loads the chrome.sidePanel\n"
        "// polyfill before the upstream Claude service worker.\n"
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
    write_state(state)

    return BuildResult(
        source=source,
        build_dir=BUILD_EXTENSION_DIR,
        extension_id_preserved=key_present,
        patched_pages=patched_pages,
        original_service_worker=original_sw,
    )


def _validate_build(build_dir: Path) -> None:
    manifest_path = build_dir / "manifest.json"
    if not manifest_path.is_file():
        raise CliError("Build validation failed: manifest.json missing.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    sw = manifest.get("background", {}).get("service_worker")
    if sw != SW_LOADER_FILENAME:
        raise CliError("Build validation failed: service worker was not repointed.")
    for required in (SW_LOADER_FILENAME, SHIM_FILENAME, manifest["background"].get("service_worker")):
        if not (build_dir / required).is_file():
            raise CliError(f"Build validation failed: missing {required}.")
    loader_text = (build_dir / SW_LOADER_FILENAME).read_text(encoding="utf-8")
    if SHIM_FILENAME not in loader_text:
        raise CliError("Build validation failed: loader does not import the shim.")


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
    say(f"  Then open Claude with the toolbar icon or {Style.bold('⌘E')}. It appears as a")
    say("  side window with full page context — exactly like Chrome.")
    say("")
    rule()
    say(f"  {Style.dim('Check status')}   claude-in-arc doctor")
    say(f"  {Style.dim('Undo cleanly')}   claude-in-arc uninstall")


def cmd_install(args: argparse.Namespace) -> int:
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

    build = build_extension(source, dry_run=args.dry_run, new_id=getattr(args, "new_id", False))
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
    if getattr(args, "open", True) and _VERBOSITY >= 1:
        opened_page = _open_arc_extensions()
        revealed = _reveal_in_finder(build.build_dir)

    _print_next_steps(build, opened_page, revealed)
    return EXIT_OK


def cmd_build(args: argparse.Namespace) -> int:
    banner()
    heading("Building")
    source = pick_source(args.source)
    ok(f"Found the official Claude extension — {Style.bold(source.label)}")
    verify_official_source(source, allow_unverified=getattr(args, "allow_unverified", False))
    build = build_extension(source, dry_run=args.dry_run, new_id=getattr(args, "new_id", False))
    if args.dry_run:
        warn("Dry run — nothing was written.")
        return EXIT_OK
    ok("Repacked the extension for Arc.")
    detail(str(build.build_dir))
    detail(f"shim v{shim_version_label()} sha256:{shim_content_hash()}")
    return EXIT_OK


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
    detail("Look for errors loading claude-arc-shim.js or arc-sw-loader.js")
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

    heading("Known limitation")
    info("Claude Code '/chrome' browser automation is gated by a server-side flag")
    detail("(chrome_ext_bridge_enabled) that Anthropic returns false for non-Chrome")
    detail("browsers. No local tool can change that. The side-panel chat with page")
    detail("context — which this tool enables — is unaffected.")

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
    add_common(p_install)
    p_install.set_defaults(func=cmd_install, open=True, link=True)

    p_build = sub.add_parser("build", help="Only (re)build the patched extension.")
    p_build.add_argument("--source", help="Path to an unpacked official extension to patch.")
    add_new_id(p_build)
    add_verify(p_build)
    add_common(p_build)
    p_build.set_defaults(func=cmd_build)

    p_link = sub.add_parser("link", help="Mirror the Claude native-messaging host into Arc.")
    add_common(p_link)
    p_link.set_defaults(func=cmd_link)

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
