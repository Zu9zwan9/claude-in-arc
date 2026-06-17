# Claude in Arc — verification walkthrough

Deep troubleshooting checklist for when the toolbar icon does nothing, `doctor`
reports a conflict, or you want to confirm every layer of the install.

**Start here:** [README.md](../README.md#quick-start) has the primary install and
daily-use guide. Use this document when you need expected-vs-actual detail for
each check, service worker console inspection, or a copy-paste recovery recipe.

Current tool version: **v1.2.1** (sidePanel stub detection, `verify` command,
Store copy conflict handling).

---

## 1. Confirm the tool and build exist

```bash
claude-in-arc --version          # should print v1.2.1 or newer
claude-in-arc verify             # verbose checklist — all items should pass
```

**Expected on disk:**

```
~/Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension/
├── CLAUDE_IN_ARC_PATCH.json     # patch marker (tool version, source browser)
├── claude-arc-shim.js           # chrome.sidePanel polyfill
├── arc-sw-loader.js             # service worker loader
└── manifest.json                # background.service_worker → arc-sw-loader.js
```

If the build folder is missing or `CLAUDE_IN_ARC_PATCH.json` is absent, run
`claude-in-arc install`.

---

## 2. Inspect `arc://extensions`

Open `arc://extensions` in Arc.

| What to look for | Expected |
|------------------|----------|
| Developer mode toggle | Visible, top-right |
| Claude entry source | **Load unpacked** (not Chrome Web Store) |
| Extension path | Ends in `ClaudeInArc/Claude-in-Arc-Extension` |
| Service worker | `arc-sw-loader.js` |
| Disabled badge | None — extension must be enabled |

---

## 3. Resolve the two-Claude conflict (same extension id)

The default build keeps Anthropic's official extension id
(`fcoeoabgfenejglbffodgkkbkcdhcgfn`). Arc can register **one** copy at a time.

| Goal | What to do |
|------|------------|
| **Recommended** — keep official id (Claude Desktop integration) | **Remove** the Store Claude entry. Keep only the unpacked build. |
| Keep both Store + patched copies | Re-run `claude-in-arc install --new-id` and load the new folder. |

**Why this matters:** Arc exposes a truthy but broken `chrome.sidePanel` stub.
The unpatched Store copy hits that stub and the toolbar icon silently does
nothing. v1.2.1 detects and replaces the stub; older builds no-op'd when the
stub was present.

`claude-in-arc install` will refuse to finish if the Store copy is still the
active registration (unless you pass `--ignore-conflict`). Even when the patched
build is loaded, a Store copy left on disk can cause Arc to revert on reload —
remove it from `arc://extensions`.

---

## 4. Load or reload unpacked

1. Developer mode → **On**
2. If needed: **Load unpacked** →
   `~/Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension`
3. After any rebuild: click **Reload** on the unpacked Claude card

**Expected on the extension card after reload:**

- Source: **Load unpacked**
- Service worker: **arc-sw-loader.js**
- Click "Service worker" → console opens with **no red import errors**

---

## 5. Verify click and keyboard shortcut

1. Open any normal webpage (not `chrome://` or `arc://` internal URLs).
2. Click the **Claude** toolbar icon **or** press **⌘E**.

**Expected:** a popup window opens with Claude's side panel UI
(`sidepanel.html?tabId=…`). Claude can see the current page context.

---

## 6. Automated verification (`verify` / `doctor --verbose`)

```bash
claude-in-arc verify
# equivalent to: claude-in-arc doctor --verbose
```

| Check | Expected |
|-------|----------|
| Patched build on disk | `CLAUDE_IN_ARC_PATCH.json` present |
| Arc prefs point at patched build | Path = `…/ClaudeInArc/Claude-in-Arc-Extension` |
| Service worker | `arc-sw-loader.js` |
| Shim asset in build | `claude-arc-shim.js` present |
| No Store copy on disk | No `…/Arc/…/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/` folder |
| Extension enabled | No "Disabled" badge; location = unpacked |

---

## 7. Service worker console (when clicks still fail)

`arc://extensions` → Claude → **Service worker** → **Inspect**

**Look for:**

- Import errors for `claude-arc-shim.js` or `arc-sw-loader.js`
- A "Browser not supported" notification path — means the shim did not install
  (usually a stale Store copy or old build pre-v1.2.1)
- Errors after clicking the icon or pressing ⌘E

**Tool logs:**

```bash
tail -50 ~/Library/Logs/claude-in-arc/claude-in-arc.log
```

---

## 8. Typical root causes

1. **Store copy still active or on disk** — Arc runs unpatched code; icon click
   hits the broken `chrome.sidePanel` stub and silently does nothing.
2. **Old shim (pre-v1.2.1)** — a truthy but broken stub caused the shim to
   no-op. Update the tool (`git pull` in `~/.claude-in-arc` or re-run
   bootstrap), then `claude-in-arc install` and **Reload** in Arc.
3. **Arc swallows `action.onClicked`** — fixed in v1.2.1+ by wiring
   `action.setPopup` to `sidepanel.html?tabId=…`.
4. **Extension disabled** — re-enable on `arc://extensions`.
5. **Wrong folder loaded** — confirm path ends in `ClaudeInArc/Claude-in-Arc-Extension`.

---

## 9. Native messaging (optional)

For Claude Desktop integration (side-panel chat works without this):

1. Enable the browser extension in Claude Desktop settings.
2. `claude-in-arc link`
3. `claude-in-arc doctor` → "Arc is linked to the native-messaging host."

---

## Quick recovery recipe

Copy-paste when nothing works and you want a clean slate:

```bash
# Update tool (one-liner install location)
cd ~/.claude-in-arc && git pull

# Rebuild from your installed official extension
claude-in-arc install
```

In Arc (`arc://extensions`):

1. **Remove** any Store "Claude" entry
2. **Load unpacked** → `~/Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension`
   (or click **Reload** if already loaded)
3. Confirm service worker = `arc-sw-loader.js`

```bash
claude-in-arc verify
```

Then click the icon or press **⌘E** on a normal webpage.

---

## Known limitation (not fixable locally)

Claude Code `/chrome` browser automation is gated by Anthropic's server-side
`chrome_ext_bridge_enabled` flag, which returns `false` for non-Chrome browsers.
Side-panel chat with page context — what this tool enables — does not depend on
that bridge. See [README.md](../README.md#the-honest-limitation-claude-code-chrome-automation).
