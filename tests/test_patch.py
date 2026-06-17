"""
Unit tests for the claude-in-arc patch engine.

These build a synthetic "official extension" fixture and verify the patcher
produces a correct, Arc-compatible unpacked build. No real browser required.

Run with:  python3 -m unittest discover -s tests
"""

import argparse
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from claude_in_arc import core


FAKE_KEY = "MIIBFAKEKEYFORTESTSONLY=="


def make_fixture(root: Path, version: str = "1.0.77", with_key: bool = True,
                 key: str = FAKE_KEY) -> Path:
    """Create a minimal but realistic unpacked extension at root/<version>_0."""
    ext = root / f"{version}_0"
    ext.mkdir(parents=True)
    manifest = {
        "manifest_version": 3,
        "name": "Claude",
        "version": version,
        "background": {"service_worker": "service-worker-loader.js", "type": "module"},
        "action": {"default_title": "Open Claude"},
        "permissions": ["sidePanel", "storage", "tabs"],
    }
    if with_key:
        manifest["key"] = key
    (ext / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (ext / "service-worker-loader.js").write_text(
        'import "./assets/service-worker.js";\n', encoding="utf-8"
    )
    (ext / "assets").mkdir()
    (ext / "assets" / "service-worker.js").write_text(
        "// upstream worker\nif(!chrome.sidePanel){/* unsupported */}\n", encoding="utf-8"
    )
    for page in ("options.html", "sidepanel.html"):
        (ext / page).write_text(
            '<!doctype html><html><head>\n<meta charset="utf-8">\n'
            '<script type="module" src="/assets/app.js"></script>\n'
            "</head><body></body></html>",
            encoding="utf-8",
        )
    return ext


class PatchEngineTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.src_root = tmp / "src"
        self.src_root.mkdir()
        # Redirect build output into the temp dir.
        self._orig_build_dir = core.BUILD_EXTENSION_DIR
        self._orig_build_root = core.BUILD_ROOT
        self._orig_verbosity = core._VERBOSITY
        core.BUILD_ROOT = tmp / "ClaudeInArc"
        core.BUILD_EXTENSION_DIR = core.BUILD_ROOT / "Claude-in-Arc-Extension"
        core._VERBOSITY = 0  # keep test output clean

    def tearDown(self):
        core.BUILD_EXTENSION_DIR = self._orig_build_dir
        core.BUILD_ROOT = self._orig_build_root
        core._VERBOSITY = self._orig_verbosity
        self._tmp.cleanup()

    def _source(self, ext_path: Path) -> core.SourceExtension:
        vt = core._parse_version(ext_path.name)
        browser = core.Browser("fixture", "Fixture", ext_path.parent)
        return core.SourceExtension(browser, ext_path.name, vt, ext_path)

    def test_build_repoints_service_worker_and_keeps_key(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(self._source(ext), dry_run=False)

        manifest = json.loads((result.build_dir / "manifest.json").read_text())
        self.assertEqual(manifest["background"]["service_worker"], core.SW_LOADER_FILENAME)
        self.assertEqual(manifest["background"]["type"], "module")
        self.assertEqual(manifest["key"], FAKE_KEY)
        self.assertTrue(result.extension_id_preserved)

    def test_loader_imports_prelude_before_shim_before_original(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(self._source(ext), dry_run=False)
        loader = (result.build_dir / core.SW_LOADER_FILENAME).read_text()
        prelude_idx = loader.index(core.PRELUDE_FILENAME)
        shim_idx = loader.index(core.SHIM_FILENAME)
        orig_idx = loader.index("service-worker-loader.js")
        self.assertLess(prelude_idx, shim_idx, "prelude must import before shim")
        self.assertLess(shim_idx, orig_idx, "shim must import before upstream worker")

    def test_loader_imports_shim_before_original(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(self._source(ext), dry_run=False)
        loader = (result.build_dir / core.SW_LOADER_FILENAME).read_text()
        shim_idx = loader.index(core.SHIM_FILENAME)
        orig_idx = loader.index("service-worker-loader.js")
        self.assertLess(shim_idx, orig_idx, "shim must be imported before the upstream worker")

    def test_shim_asset_copied_and_original_preserved(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(self._source(ext), dry_run=False)
        self.assertTrue((result.build_dir / core.SHIM_FILENAME).is_file())
        self.assertTrue((result.build_dir / core.SIDEBAR_BRIDGE_FILENAME).is_file())
        self.assertTrue((result.build_dir / core.SIDEBAR_BRIDGE_JS_FILENAME).is_file())
        self.assertTrue((result.build_dir / core.SIDEBAR_HOST_FILENAME).is_file())
        # Original loader and worker preserved untouched.
        self.assertTrue((result.build_dir / "service-worker-loader.js").is_file())
        self.assertTrue((result.build_dir / "assets" / "service-worker.js").is_file())

    def test_sidebar_bridge_is_web_accessible(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(self._source(ext), dry_run=False)
        manifest = json.loads((result.build_dir / "manifest.json").read_text())
        war = manifest.get("web_accessible_resources") or []
        resources: list[str] = []
        for entry in war:
            resources.extend(entry.get("resources") or [])
        self.assertIn(core.SIDEBAR_BRIDGE_FILENAME, resources)

    def test_sidebar_bridge_uses_external_script_not_inline(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(self._source(ext), dry_run=False)
        bridge_html = (result.build_dir / core.SIDEBAR_BRIDGE_FILENAME).read_text()
        bridge_js = (result.build_dir / core.SIDEBAR_BRIDGE_JS_FILENAME).read_text()
        self.assertIn(
            f'src="{core.SIDEBAR_BRIDGE_JS_FILENAME}"',
            bridge_html,
            "bridge must load external JS (MV3 CSP blocks inline scripts)",
        )
        self.assertNotIn("document.createElement", bridge_html)
        self.assertIn("sidepanel.html", bridge_js)
        self.assertIn("chrome.runtime.getURL", bridge_js)

    def test_panel_mode_split_baked_into_shim(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(
            self._source(ext), dry_run=False, panel_mode="split"
        )
        shim = (result.build_dir / core.SHIM_FILENAME).read_text()
        self.assertIn('var DEFAULT_PANEL_MODE = "split";', shim)
        self.assertEqual(result.panel_mode, "split")
        split_host = result.build_dir / core.SPLIT_HOST_FILENAME
        self.assertTrue(split_host.is_file(), "split host asset must be copied")

    def test_panel_mode_sidebar_baked_into_shim(self):
        ext = make_fixture(self.src_root)
        with patch.object(core, "arc_installed", return_value=False):
            result = core.build_extension(
                self._source(ext), dry_run=False, panel_mode="sidebar"
            )
        shim = (result.build_dir / core.SHIM_FILENAME).read_text()
        self.assertIn('var DEFAULT_PANEL_MODE = "sidebar";', shim)
        self.assertEqual(result.panel_mode, "sidebar")
        marker = json.loads((result.build_dir / core.PATCH_MARKER_FILENAME).read_text())
        self.assertEqual(marker.get("panel_mode"), "sidebar")

    def test_panel_mode_sidebar_normalizes_to_split_on_arc(self):
        ext = make_fixture(self.src_root)
        with patch.object(core, "arc_installed", return_value=True):
            result = core.build_extension(
                self._source(ext), dry_run=False, panel_mode="sidebar"
            )
        shim = (result.build_dir / core.SHIM_FILENAME).read_text()
        self.assertIn('var DEFAULT_PANEL_MODE = "split";', shim)
        self.assertEqual(result.panel_mode, "split")

    def test_pages_get_shim_injected_once(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(self._source(ext), dry_run=False)
        for page in ("options.html", "sidepanel.html"):
            html = (result.build_dir / page).read_text()
            self.assertEqual(html.count(f'src="{core.SHIM_FILENAME}"'), 1)
            # Injected inside <head>, before the module bundle.
            self.assertLess(
                html.index(core.SHIM_FILENAME),
                html.index('type="module"'),
                f"shim must precede module scripts in {page}",
            )

    def test_idempotent_rebuild(self):
        ext = make_fixture(self.src_root)
        core.build_extension(self._source(ext), dry_run=False)
        result2 = core.build_extension(self._source(ext), dry_run=False)
        for page in ("options.html", "sidepanel.html"):
            html = (result2.build_dir / page).read_text()
            self.assertEqual(html.count(f'src="{core.SHIM_FILENAME}"'), 1)

    def test_marker_written(self):
        ext = make_fixture(self.src_root)
        result = core.build_extension(self._source(ext), dry_run=False)
        marker = json.loads((result.build_dir / core.PATCH_MARKER_FILENAME).read_text())
        self.assertEqual(marker["tool"], "claude-in-arc")
        self.assertEqual(marker["original_service_worker"], "service-worker-loader.js")

    def test_build_without_key_flags_fresh_id(self):
        ext = make_fixture(self.src_root, with_key=False)
        result = core.build_extension(self._source(ext), dry_run=False)
        self.assertFalse(result.extension_id_preserved)

    def test_new_id_drops_key_and_renames(self):
        ext = make_fixture(self.src_root, with_key=True)
        result = core.build_extension(self._source(ext), dry_run=False, new_id=True)
        manifest = json.loads((result.build_dir / "manifest.json").read_text())
        self.assertNotIn("key", manifest)
        self.assertIn("(Arc)", manifest["name"])
        self.assertFalse(result.extension_id_preserved)

    def test_version_parsing_and_ordering(self):
        self.assertEqual(core._parse_version("1.0.77_0"), (1, 0, 77))
        self.assertEqual(core._parse_version("1.0.74"), (1, 0, 74))
        self.assertIsNone(core._parse_version("not-a-version"))
        self.assertGreater((1, 0, 77), (1, 0, 74))

    def test_dry_run_writes_nothing(self):
        ext = make_fixture(self.src_root)
        core.build_extension(self._source(ext), dry_run=True)
        self.assertFalse(core.BUILD_EXTENSION_DIR.exists())

    def test_shim_declares_arc_split_mode(self):
        shim = core.SHIM_SOURCE.read_text(encoding="utf-8")
        self.assertIn("openPanelInSplit", shim)
        self.assertIn("claude-arc-split-host", shim)
        self.assertIn("claude-in-arc-split", shim)
        split_host = core.SPLIT_HOST_SOURCE.read_text(encoding="utf-8")
        self.assertIn("claude-in-arc-split-open", split_host)

    def test_shim_declares_split_timing_and_hint(self):
        shim = core.SHIM_SOURCE.read_text(encoding="utf-8")
        self.assertIn("SPLIT_POPUP_DELAY_MS", shim)
        self.assertIn("notifyArcSplitPanelHint", shim)
        self.assertIn("applySplitMarginThenOpen", shim)

    def test_shim_declares_arc_iframe_fallback(self):
        shim = core.SHIM_SOURCE.read_text(encoding="utf-8")
        self.assertIn("isArcBrowser", shim)
        self.assertIn("effectivePanelMode", shim)
        self.assertIn("claude-in-arc-sidebar-iframe-blocked", shim)
        host = core.SIDEBAR_HOST_SOURCE.read_text(encoding="utf-8")
        self.assertIn("blocked by arc", host.lower())

    def test_shim_declares_split_gutter_alignment(self):
        shim = core.SHIM_SOURCE.read_text(encoding="utf-8")
        self.assertIn("splitGutterBoundsFromAnchor", shim)
        self.assertIn("resolveSplitAnchorForTab", shim)
        self.assertIn("syncSplitPopupToGutter", shim)
        self.assertIn("SPLIT_BOUNDS_RETRY_DELAYS_MS", shim)
        self.assertIn("scheduleSplitBoundsRetries", shim)
        self.assertIn("splitBoundsSyncInFlight", shim)
        self.assertIn("waitForSplitAnchorBounds", shim)
        self.assertIn("verifySplitDockAlignment", shim)
        self.assertIn("refocusAnchorWindowAfterDock", shim)
        split_host = core.SPLIT_HOST_SOURCE.read_text(encoding="utf-8")
        self.assertIn("background:transparent", split_host)

    def test_shim_declares_arc_split_default(self):
        shim = core.SHIM_SOURCE.read_text(encoding="utf-8")
        self.assertIn("arcExplicitPopupMode", shim)
        self.assertIn("isHttpsPageUrl", shim)
        self.assertIn("forcePanelWindowBounds", shim)
        self.assertIn("SPLIT_INJECT_SETTLE_MS", shim)

    def test_shim_version_and_hash_helpers(self):
        self.assertEqual(core.shim_version_label(), "1.2.23")
        h = core.shim_content_hash()
        self.assertEqual(len(h), 12)
        self.assertTrue(all(c in "0123456789abcdef" for c in h))

    def test_remote_bridge_constants_documented(self):
        self.assertEqual(core.REMOTE_BRIDGE_WS_HOST, "bridge.claudeusercontent.com")
        self.assertEqual(core.REMOTE_BRIDGE_FEATURE_FLAG, "chrome_ext_bridge_enabled")
        src = Path(core.__file__).read_text(encoding="utf-8")
        self.assertIn("ERR_ADDRESS_INVALID", src)


class NativeMessagingTests(unittest.TestCase):
    def test_allowed_origin_added_when_missing(self):
        # Validate the origin-merging logic in isolation.
        official = f"chrome-extension://{core.OFFICIAL_EXTENSION_ID}/"
        origins = ["chrome-extension://someother/"]
        if official not in origins:
            origins.append(official)
        self.assertIn(official, origins)


class SecurityTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.src_root = self.tmp / "src"
        self.src_root.mkdir()
        self._orig_verbosity = core._VERBOSITY
        core._VERBOSITY = 0

    def tearDown(self):
        core._VERBOSITY = self._orig_verbosity
        self._tmp.cleanup()

    def _source(self, ext_path: Path) -> core.SourceExtension:
        vt = core._parse_version(ext_path.name) or (0,)
        browser = core.Browser("fixture", "Fixture", ext_path.parent)
        return core.SourceExtension(browser, ext_path.name, vt, ext_path)

    def test_extension_id_from_key_matches_official(self):
        self.assertEqual(
            core._extension_id_from_key(core.OFFICIAL_EXTENSION_KEY),
            core.OFFICIAL_EXTENSION_ID,
        )

    def test_verify_accepts_official_key(self):
        ext = make_fixture(self.src_root, key=core.OFFICIAL_EXTENSION_KEY)
        computed = core.verify_official_source(self._source(ext))
        self.assertEqual(computed, core.OFFICIAL_EXTENSION_ID)

    def test_verify_rejects_wrong_key(self):
        # A syntactically valid but non-official key must be rejected.
        wrong = core.base64.b64encode(b"not the official public key bytes").decode()
        ext = make_fixture(self.src_root, key=wrong)
        with self.assertRaises(core.SecurityError):
            core.verify_official_source(self._source(ext))

    def test_verify_no_key_raises_unless_allowed(self):
        ext = make_fixture(self.src_root, with_key=False)
        with self.assertRaises(core.SecurityError):
            core.verify_official_source(self._source(ext))
        # With override, it returns (empty string) instead of raising.
        self.assertEqual(core.verify_official_source(self._source(ext), allow_unverified=True), "")

    def test_assert_within_rejects_outside_path(self):
        root = self.tmp / "root"
        root.mkdir()
        inside = root / "a" / "b"
        # Inside is fine.
        self.assertEqual(core._assert_within(inside, root), inside.resolve())
        # Outside must raise.
        with self.assertRaises(core.SecurityError):
            core._assert_within(self.tmp / "elsewhere", root)

    def test_backup_file_creates_sidecar(self):
        f = self.tmp / "manifest.json"
        f.write_text('{"v":"original"}', encoding="utf-8")
        backup = core._backup_file(f)
        self.assertIsNotNone(backup)
        self.assertTrue(backup.exists())
        self.assertIn("original", backup.read_text())


class IdentityAndLayoutTests(unittest.TestCase):
    def test_banner_rows_are_exactly_box_width(self):
        # Production uses 52; verify exact alignment at the default and wider.
        self.assertEqual(core._BANNER_WIDTH, 52)
        for width in (52, 60, 72):
            rows = core._banner_inner(width)
            self.assertEqual(len(rows), 2)
            for row in rows:
                self.assertEqual(
                    len(row), width,
                    f"banner row not padded to {width}: {len(row)} chars -> {row!r}",
                )

    def test_disclaimer_is_unofficial(self):
        text = core.DISCLAIMER.lower()
        self.assertIn("unofficial", text)
        self.assertIn("not affiliated", text)
        self.assertIn("anthropic", text)
        self.assertIn("browser company", text)

    def test_product_identity_present(self):
        self.assertEqual(core.PRODUCT_NAME, "Claude in Arc")
        self.assertTrue(core.PRODUCT_TAGLINE)


class ArcInspectionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.arc_dir = self.tmp / "Arc" / "User Data"
        self.default = self.arc_dir / "Default"
        self.default.mkdir(parents=True)
        self._orig_arc = core.arc_browser
        self._orig_build = core.BUILD_EXTENSION_DIR
        self._orig_root = core.BUILD_ROOT
        self._orig_verbosity = core._VERBOSITY
        core.BUILD_ROOT = self.tmp / "ClaudeInArc"
        core.BUILD_EXTENSION_DIR = core.BUILD_ROOT / "Claude-in-Arc-Extension"
        core._VERBOSITY = 0
        core.arc_browser = lambda: core.Browser("arc", "Arc", self.arc_dir)

    def tearDown(self):
        core.arc_browser = self._orig_arc
        core.BUILD_EXTENSION_DIR = self._orig_build
        core.BUILD_ROOT = self._orig_root
        core._VERBOSITY = self._orig_verbosity
        self._tmp.cleanup()

    def _write_prefs(self, ext_settings: dict) -> None:
        prefs = {"extensions": {"settings": {core.OFFICIAL_EXTENSION_ID: ext_settings}}}
        (self.default / "Secure Preferences").write_text(
            json.dumps(prefs), encoding="utf-8"
        )

    def test_inspect_detects_patched_unpacked_path(self):
        build = core.BUILD_EXTENSION_DIR
        build.mkdir(parents=True)
        (build / core.PATCH_MARKER_FILENAME).write_text("{}", encoding="utf-8")
        (build / "manifest.json").write_text(
            json.dumps({"background": {"service_worker": core.SW_LOADER_FILENAME}}),
            encoding="utf-8",
        )
        self._write_prefs(
            {
                "path": str(build.resolve()),
                "location": core.LOCATION_UNPACKED,
                "from_webstore": False,
                "disable_reasons": [],
            }
        )
        state = core.inspect_arc_extension()
        self.assertTrue(state.is_patched_path)
        self.assertTrue(state.has_patch_marker)
        self.assertEqual(state.service_worker, core.SW_LOADER_FILENAME)
        self.assertTrue(core.arc_has_patched_build_loaded())

    def test_inspect_flags_store_on_disk_with_patched_loaded(self):
        build = core.BUILD_EXTENSION_DIR
        build.mkdir(parents=True)
        (build / core.PATCH_MARKER_FILENAME).write_text("{}", encoding="utf-8")
        (build / "manifest.json").write_text(
            json.dumps({"background": {"service_worker": core.SW_LOADER_FILENAME}}),
            encoding="utf-8",
        )
        store = self.default / "Extensions" / core.OFFICIAL_EXTENSION_ID / "1.0.77_0"
        store.mkdir(parents=True)
        (store / "manifest.json").write_text('{"version":"1.0.77"}', encoding="utf-8")
        self._write_prefs(
            {
                "path": str(build.resolve()),
                "location": core.LOCATION_UNPACKED,
                "from_webstore": False,
                "disable_reasons": [],
            }
        )
        state = core.inspect_arc_extension()
        self.assertTrue(state.conflict)
        self.assertIn("Store copy still exists", state.conflict_detail)

    def test_inspect_store_active_not_patched(self):
        store = self.default / "Extensions" / core.OFFICIAL_EXTENSION_ID / "1.0.77_0"
        store.mkdir(parents=True)
        (store / "manifest.json").write_text('{"version":"1.0.77"}', encoding="utf-8")
        self._write_prefs(
            {
                "path": str(store.resolve()),
                "location": core.LOCATION_EXTERNAL_PREF,
                "from_webstore": True,
                "disable_reasons": [],
            }
        )
        state = core.inspect_arc_extension()
        self.assertFalse(state.is_patched_path)
        self.assertTrue(state.store_copy_active)
        self.assertTrue(state.conflict)
        self.assertFalse(state.store_copy_orphaned)
        self.assertFalse(core.arc_has_patched_build_loaded())

    def test_inspect_orphaned_store_files_not_a_conflict(self):
        store = self.default / "Extensions" / core.OFFICIAL_EXTENSION_ID / "1.0.77_0"
        store.mkdir(parents=True)
        (store / "manifest.json").write_text('{"version":"1.0.77"}', encoding="utf-8")
        state = core.inspect_arc_extension()
        self.assertFalse(state.registered)
        self.assertTrue(state.store_copy_on_disk)
        self.assertTrue(state.store_copy_orphaned)
        self.assertFalse(state.store_copy_active)
        self.assertFalse(state.conflict)
        self.assertIn("Leftover Store extension files", state.conflict_detail)

    def test_install_continues_with_orphaned_store_files(self):
        store = self.default / "Extensions" / core.OFFICIAL_EXTENSION_ID / "1.0.77_0"
        store.mkdir(parents=True)
        (store / "manifest.json").write_text('{"version":"1.0.77"}', encoding="utf-8")
        ext = make_fixture(self.tmp / "src-fixture")
        source = core.SourceExtension(
            core.Browser("fixture", "Fixture", ext.parent),
            ext.name,
            core._parse_version(ext.name) or (0,),
            ext,
        )
        args = argparse.Namespace(
            source=None,
            dry_run=False,
            new_id=False,
            allow_unverified=False,
            ignore_conflict=False,
            open=False,
            link=False,
        )
        with patch.object(core, "pick_source", return_value=source), patch.object(
            core, "verify_official_source", return_value=core.OFFICIAL_EXTENSION_ID
        ):
            rc = core.cmd_install(args)
        self.assertEqual(rc, core.EXIT_OK)
        self.assertTrue(core.BUILD_EXTENSION_DIR.is_dir())

    def test_cleanup_removes_orphaned_store_dir(self):
        store = self.default / "Extensions" / core.OFFICIAL_EXTENSION_ID / "1.0.77_0"
        store.mkdir(parents=True)
        (store / "manifest.json").write_text('{"version":"1.0.77"}', encoding="utf-8")
        self.assertTrue(store.exists())
        rc = core.cmd_cleanup(argparse.Namespace(dry_run=False))
        self.assertEqual(rc, core.EXIT_OK)
        self.assertFalse(store.parent.exists())

    def test_cleanup_skips_active_store_registration(self):
        store = self.default / "Extensions" / core.OFFICIAL_EXTENSION_ID / "1.0.77_0"
        store.mkdir(parents=True)
        (store / "manifest.json").write_text('{"version":"1.0.77"}', encoding="utf-8")
        self._write_prefs(
            {
                "path": str(store.resolve()),
                "location": core.LOCATION_EXTERNAL_PREF,
                "from_webstore": True,
                "disable_reasons": [],
            }
        )
        rc = core.cmd_cleanup(argparse.Namespace(dry_run=False))
        self.assertEqual(rc, core.EXIT_ERROR)
        self.assertTrue(store.exists())


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self._orig_build_dir = core.BUILD_EXTENSION_DIR
        self._orig_build_root = core.BUILD_ROOT
        self._orig_arc = core.arc_browser
        self._orig_verbosity = core._VERBOSITY
        core.BUILD_ROOT = self.tmp / "ClaudeInArc"
        core.BUILD_EXTENSION_DIR = core.BUILD_ROOT / "Claude-in-Arc-Extension"
        core._VERBOSITY = 0

    def tearDown(self):
        core.BUILD_EXTENSION_DIR = self._orig_build_dir
        core.BUILD_ROOT = self._orig_build_root
        core.arc_browser = self._orig_arc
        core._VERBOSITY = self._orig_verbosity
        self._tmp.cleanup()

    def test_uninstall_restores_native_backup_and_removes_build(self):
        # Fake Arc data dir.
        arc_dir = self.tmp / "arc"
        nmh = arc_dir / "NativeMessagingHosts"
        nmh.mkdir(parents=True)
        target = nmh / core.NATIVE_HOST_FILENAME
        target.write_text('{"v":"ours"}', encoding="utf-8")  # the file we wrote
        backup = target.with_name(target.name + core.BACKUP_SUFFIX)
        backup.write_text('{"v":"original"}', encoding="utf-8")  # pre-existing original

        # Patched build present.
        core.BUILD_EXTENSION_DIR.mkdir(parents=True, exist_ok=True)
        (core.BUILD_EXTENSION_DIR / "marker").write_text("x", encoding="utf-8")

        core.write_state({
            "native_manifest": str(target),
            "native_manifest_preexisted": True,
            "native_manifest_backup": str(backup),
        })

        core.arc_browser = lambda: core.Browser("arc", "Arc", arc_dir)
        rc = core.cmd_uninstall(argparse.Namespace(dry_run=False))

        self.assertEqual(rc, core.EXIT_OK)
        self.assertEqual(json.loads(target.read_text())["v"], "original")
        self.assertFalse(backup.exists())
        self.assertFalse(core.BUILD_EXTENSION_DIR.exists())

    def test_uninstall_removes_manifest_when_not_preexisting(self):
        arc_dir = self.tmp / "arc"
        nmh = arc_dir / "NativeMessagingHosts"
        nmh.mkdir(parents=True)
        target = nmh / core.NATIVE_HOST_FILENAME
        target.write_text('{"v":"ours"}', encoding="utf-8")

        core.write_state({
            "native_manifest": str(target),
            "native_manifest_preexisted": False,
        })
        core.arc_browser = lambda: core.Browser("arc", "Arc", arc_dir)

        core.cmd_uninstall(argparse.Namespace(dry_run=False))
        self.assertFalse(target.exists())


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self._orig_build_dir = core.BUILD_EXTENSION_DIR
        self._orig_build_root = core.BUILD_ROOT
        self._orig_verbosity = core._VERBOSITY
        core.BUILD_ROOT = tmp / "ClaudeInArc"
        core.BUILD_EXTENSION_DIR = core.BUILD_ROOT / "Claude-in-Arc-Extension"
        core._VERBOSITY = 0

    def tearDown(self):
        core.BUILD_EXTENSION_DIR = self._orig_build_dir
        core.BUILD_ROOT = self._orig_build_root
        core._VERBOSITY = self._orig_verbosity
        self._tmp.cleanup()

    def test_find_tool_repo_root_from_package(self):
        root = core._find_tool_repo_root()
        self.assertIsNotNone(root)
        self.assertTrue((root / "claude_in_arc" / "core.py").is_file())

    def test_git_pull_dry_run(self):
        repo = core._find_tool_repo_root()
        self.assertIsNotNone(repo)
        ok, msg = core._git_pull(repo, dry_run=True)
        self.assertTrue(ok)
        self.assertIn("dry-run", msg)

    def test_verify_installed_shim_matches_asset(self):
        core.BUILD_EXTENSION_DIR.mkdir(parents=True)
        expected = core.shim_version_label()
        (core.BUILD_EXTENSION_DIR / core.SHIM_FILENAME).write_text(
            f'var SHIM_VERSION = "{expected}";\n', encoding="utf-8"
        )
        ok, detail = core._verify_installed_shim()
        self.assertTrue(ok)
        self.assertIn(expected, detail)

    def test_verify_installed_shim_detects_mismatch(self):
        core.BUILD_EXTENSION_DIR.mkdir(parents=True)
        (core.BUILD_EXTENSION_DIR / core.SHIM_FILENAME).write_text(
            'var SHIM_VERSION = "0.0.0";\n', encoding="utf-8"
        )
        ok, detail = core._verify_installed_shim()
        self.assertFalse(ok)
        self.assertIn("0.0.0", detail)

    def test_upgrade_parser_registers_command(self):
        parser = core.build_parser()
        args = parser.parse_args(["upgrade", "--no-pull", "--no-reload", "--no-test-page"])
        self.assertEqual(args.command, "upgrade")
        self.assertTrue(args.no_pull)
        self.assertTrue(args.no_reload)
        self.assertTrue(args.no_test_page)

    def test_cmd_upgrade_skips_pull_with_no_pull(self):
        ext = make_fixture(Path(self._tmp.name) / "src")
        source = core.SourceExtension(
            core.Browser("fixture", "Fixture", ext.parent),
            ext.name,
            core._parse_version(ext.name) or (0,),
            ext,
        )
        args = argparse.Namespace(
            no_pull=True,
            no_reload=True,
            no_test_page=True,
            dry_run=False,
            source=None,
            new_id=False,
            allow_unverified=False,
            ignore_conflict=True,
            link=False,
            panel_mode=None,
            test_url="https://example.com",
        )
        with patch.object(core, "pick_source", return_value=source), patch.object(
            core, "verify_official_source", return_value=core.OFFICIAL_EXTENSION_ID
        ), patch.object(core, "_git_pull") as mock_pull:
            rc = core.cmd_upgrade(args)
        mock_pull.assert_not_called()
        self.assertEqual(rc, core.EXIT_OK)
        self.assertTrue(core.BUILD_EXTENSION_DIR.is_dir())

    def test_cmd_upgrade_reload_path_does_not_shadow_detail_helper(self):
        """Regression: reload/toggle detail strings must not shadow detail()."""
        ext = make_fixture(Path(self._tmp.name) / "src")
        source = core.SourceExtension(
            core.Browser("fixture", "Fixture", ext.parent),
            ext.name,
            core._parse_version(ext.name) or (0,),
            ext,
        )
        args = argparse.Namespace(
            no_pull=True,
            no_reload=False,
            no_test_page=False,
            dry_run=False,
            source=None,
            new_id=False,
            allow_unverified=False,
            ignore_conflict=True,
            link=False,
            panel_mode=None,
            test_url="https://example.com",
        )
        with patch.object(core, "pick_source", return_value=source), patch.object(
            core, "verify_official_source", return_value=core.OFFICIAL_EXTENSION_ID
        ), patch.object(core, "_open_arc_extensions", return_value=True), patch.object(
            core, "_arc_click_reload_extension", return_value=(False, "reload_not_found")
        ), patch.object(core, "_open_url_in_arc", return_value=True), patch.object(
            core, "_arc_send_toggle_side_panel", return_value=(True, "sent")
        ), patch.object(core, "_verify_installed_shim", return_value=(True, "claude-arc-shim v1.2.23")):
            rc = core.cmd_upgrade(args)
        self.assertEqual(rc, core.EXIT_ERROR)


if __name__ == "__main__":
    unittest.main(verbosity=2)
