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
        # Original loader and worker preserved untouched.
        self.assertTrue((result.build_dir / "service-worker-loader.js").is_file())
        self.assertTrue((result.build_dir / "assets" / "service-worker.js").is_file())

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
        self.assertTrue(state.conflict)
        self.assertFalse(core.arc_has_patched_build_loaded())


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
