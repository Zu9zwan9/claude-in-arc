"""
Regression test for the chrome.sidePanel polyfill's "open_side_panel" path.

The official extension exposes a SECOND way to open the side panel: a content
script on claude.ai (assets/content-script.ts-*.js) wires an onboarding button
that sends a runtime message:

    chrome.runtime.sendMessage({type:"open_side_panel", onboardingTaskId})

The service worker's handler resolves the tab and calls Ve(tabId), which does
nothing more than:

    chrome.sidePanel.setOptions({tabId, path:`sidepanel.html?tabId=${tabId}`, enabled:true});
    chrome.sidePanel.open({tabId});

So on Arc this path is only as good as our chrome.sidePanel polyfill. This test
drives the REAL shim asset (claude_in_arc/assets/claude-arc-shim.js) through a
Node harness that mocks the chrome APIs and replays that exact setOptions()+open()
chain, asserting it becomes a single reusable popup window carrying the tabId,
and that the shim is a strict no-op when a real chrome.sidePanel exists.

The shim is JavaScript, so we exercise it with Node (the same runtime our build
validation already requires via `node --check`). If Node is unavailable the test
is skipped rather than failing.
"""

import shutil
import subprocess
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent / "shim_open_side_panel_harness.js"
SHIM = (
    Path(__file__).resolve().parent.parent
    / "claude_in_arc"
    / "assets"
    / "claude-arc-shim.js"
)


class OpenSidePanelShimTests(unittest.TestCase):
    def setUp(self):
        self.node = shutil.which("node")
        if not self.node:
            self.skipTest("node not available; shim JS test requires Node.js")
        self.assertTrue(HARNESS.is_file(), f"missing harness: {HARNESS}")
        self.assertTrue(SHIM.is_file(), f"missing shim asset: {SHIM}")

    def test_shim_syntax_is_valid(self):
        proc = subprocess.run(
            [self.node, "--check", str(SHIM)],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(proc.returncode, 0, f"shim failed node --check:\n{proc.stderr}")

    def test_open_side_panel_message_opens_popup_via_shim(self):
        proc = subprocess.run(
            [self.node, str(HARNESS)],
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(
            proc.returncode,
            0,
            "open_side_panel shim harness failed:\n"
            f"STDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}",
        )
        self.assertIn("OK:", proc.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
