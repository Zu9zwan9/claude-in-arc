# Claude in Arc — verification walkthrough

Deep troubleshooting checklist for when the toolbar icon does nothing, `doctor`
reports a conflict, or you want to confirm every layer of the install.

**Start here:** [README.md](../README.md#quick-start) has the primary install and
daily-use guide. Use this document when you need expected-vs-actual detail for
each check, service worker console inspection, or a copy-paste recovery recipe.

Current tool version: **v1.2.23** (doctor prints honest Arc expectations; sidebar mode
auto-migrates to split on Arc).

Previous: v1.2.17 split popup retries gutter alignment at 0/50/150ms on macOS Arc;
v1.2.20 fixes double blank arc://new-tab-page window; closing the OS popup window
removes the page margin.

---

## 1. Confirm the tool and build exist

```bash
claude-in-arc --version          # should print v1.2.22 or newer
claude-in-arc verify             # verbose checklist — all items should pass
```

**Expected on disk:**

```
~/Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension/
├── CLAUDE_IN_ARC_PATCH.json     # patch marker (tool version, source browser)
├── arc-shim-prelude.js          # SW flag: force polyfill before shim runs
├── claude-arc-shim.js           # chrome.sidePanel polyfill
├── claude-arc-sidebar-bridge.html  # iframe bridge for in-page sidebar mode
├── claude-arc-sidebar-bridge.js    # bridge loader (MV3 CSP: no inline scripts)
├── claude-arc-sidebar-host.js      # injected overlay host script (Chrome/Brave)
├── claude-arc-split-host.js        # page margin + gutter (Arc split mode)
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

**Why this matters:** Arc exposes native-looking but no-op `chrome.sidePanel`
bindings. The unpatched Store copy calls those stubs and the toolbar icon
silently does nothing. v1.2.5 forces the polyfill in the service worker via
`arc-shim-prelude.js` (Arc's SW often omits `Arc/` from `navigator.userAgent`).

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

### Split-panel mode (default on Arc, v1.2.12+)

1. Open any normal webpage (not `chrome://` or `arc://` internal URLs).
2. Click the **Claude** toolbar icon **or** press **⌘E**.

**Expected:** page content **narrows first** (~410px margin on the right), then a
**separate OS popup window** is positioned **over that margin column** (not beside
it) showing `sidepanel.html?tabId=…`. Until the popup docks, you may briefly see
the page's own background in the margin — that is normal. Once aligned, the popup
should cover the gutter; you should **not** see a persistent empty white column
with the chat floating elsewhere. Only a thin invisible resize strip remains at
the margin edge (drag to resize). Claude chat works with full page context — no
"blocked by Arc" iframe error.

**Closing the panel:** clicking the popup's OS window close button (red ×) closes
Claude **and** removes the page margin so the tab returns to full width. This is
intentional — the margin exists only while the panel is open. Reopening (⌘E)
re-applies the margin.

**Note:** Arc cannot embed the panel inside the browser window (no true split view
API). The popup is a separate OS window positioned to *look* integrated beside
your page — you will still see a narrow title bar on the popup. v1.2.22 waits for
Arc window geometry before creating the popup (avoids center-screen floats),
re-syncs bounds at 0/50/150/300/500/1000ms, refocuses Arc after dock, and verifies
alignment. v1.2.14+ aligns left/top/width/height with `anchor.right - panelWidth`.
v1.2.13 shows the page margin before the popup opens. Drag Arc wider if the panel
feels cramped.

**Page console (split mode):**

- `[claude-in-arc] split host injected gutter=claude-in-arc-split-gutter`
- `[claude-in-arc] split show width=410`
- `[claude-in-arc] split scheduling popup in 50ms margin=active`
- `[claude-in-arc] split anchor windowId=… @left,top widthxheight`
- `[claude-in-arc] split gutter sync @left,top widthxheight`
- `[claude-in-arc] bounds corrected @left,top widthxheight` (may repeat at 0/50/150/300/500/1000ms)

### Popup-only mode

```bash
claude-in-arc config --panel-mode popup
```

Reload, then click the icon. **Expected:** docked popup only — no page margin.

### In-page sidebar mode (Chrome/Brave only — not Arc)

Arc blocks `chrome-extension://` pages inside page iframes ("This page has been
blocked by Arc"). v1.2.12+ uses split-panel mode on Arc instead (margin + popup).

On **Chrome or Brave**:

```bash
claude-in-arc config --panel-mode sidebar
```

Reload in `chrome://extensions`, then click the icon on a normal `https://` page.

**Expected:** a fixed right column (~410px, resizable) inside the page — not a
separate OS window. You should see the Claude chat UI (not just a dark empty
column). Restricted URLs fall back to popup automatically.

**Page console (sidebar mode):** on the webpage where the sidebar opened, open
DevTools → Console and look for:

- `[claude-in-arc] sidebar host injected root=claude-in-arc-sidebar-root`
- `[claude-in-arc] sidebar show url=chrome-extension://…/claude-arc-sidebar-bridge.html?tabId=…`
- `[claude-in-arc] sidebar bridge creating sidepanel iframe url=…`
- `[claude-in-arc] sidebar panel ready`

If you only see the dark shell (× button, resize edge) with no chat, see
**§8 item 7** (blank sidebar).

See [ARC_LIMITATIONS.md](ARC_LIMITATIONS.md) for why Arc Split View and native
sidebar integration are not possible.

**Do not** open bare `chrome-extension://…/sidepanel.html` without `?tabId=`.
The chat needs the originating tab id in the URL; without it messages disappear
and Claude stays on the idle screen. If you must open manually, do it **while
focused on the page you want context from** — v1.2.5 redirects bare opens to
the active tab when possible.

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
| Arc panel mode is split | `panel_mode: split` in patch marker |
| Split host in build | `claude-arc-split-host.js` present |
| No Store copy on disk | No `…/Arc/…/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/` folder |
| Extension enabled | No "Disabled" badge; location = unpacked |

---

## 7. Service worker console (when clicks still fail)

`arc://extensions` → Claude → **Service worker** → **Inspect**

**Important:** use the **service worker** console, not options.html or
sidepanel.html (those are separate pages).

**Look for:**

- `[claude-in-arc] arc-shim-prelude loaded (service worker)`
- `[claude-in-arc] claude-arc-shim v1.2.22 (service worker)`
- `[claude-in-arc] sidePanel polyfill active`
- Import errors for `arc-shim-prelude.js`, `claude-arc-shim.js`, or `arc-sw-loader.js`
- A "Browser not supported" notification path — shim did not install (stale build)
- After clicking the icon or pressing ⌘E on **Arc**: `openPanelInSplit tabId=…`,
  then `split scheduling popup`, then `windows.create` (docked popup). On Chrome/Brave
  with sidebar mode: `openPanelInSidebar tabId=…`

**Tool logs:**

```bash
tail -50 ~/Library/Logs/claude-in-arc/claude-in-arc.log
```

---

## 8. Typical root causes

1. **Store copy still active or on disk** — Arc runs unpatched code; icon click
   hits the broken `chrome.sidePanel` stub and silently does nothing.
2. **Old shim (pre-v1.2.5)** — Arc service workers often lack `Arc/` in UA, so
   v1.2.4 could skip installing the polyfill while native stubs looked valid.
   Update (`git pull`), `claude-in-arc install`, **Reload** in Arc.
3. **Bare `sidepanel.html` without `?tabId=`** — panel UI loads but chat is
   broken (messages vanish, idle "How can I help you today?"). Use the toolbar
   icon / ⌘E on the target page, or let v1.2.5 redirect bare opens.
4. **Wrong console** — options.html / sidepanel DevTools are not the service
   worker; use **Service worker → Inspect** on `arc://extensions`.
5. **Extension disabled** — re-enable on `arc://extensions`.
6. **Wrong folder loaded** — confirm path ends in `ClaudeInArc/Claude-in-Arc-Extension`.
7. **Arc "This page has been blocked by Arc" in sidebar column** — Arc blocks
   extension iframes in pages. Rebuild with v1.2.11+ (`claude-in-arc install`),
   **Reload** in `arc://extensions`. v1.2.12+ uses split-panel mode on Arc instead.
   See [ARC_LIMITATIONS.md](ARC_LIMITATIONS.md).
8. **Still opens a detached OS window (title bar with extension id)** — common causes:
   - **Popup-only mode** — right-click the extension icon → Panel mode must be
     **Split panel (Arc)**, or run `claude-in-arc config --panel-mode split` and
     Reload. v1.2.13 auto-upgrades legacy `popup` storage on Arc unless you
     explicitly chose popup-only via the context menu.
   - **Split margin not applied** — the page should shrink *before* the popup
     appears. In the **page** DevTools console look for
     `[claude-in-arc] split host injected` and `split show width=410`. If missing,
     injection failed (restricted URL, stale build, or missing
     `claude-arc-split-host.js`). Re-run `claude-in-arc install` and Reload.
   - **Misaligned popup (empty white column + floating window)** — fixed in
     v1.2.17+ and v1.2.22: popup must cover the margin gutter exactly via retried
     bounds sync and anchor-wait before create. Service worker should log
     `split dock target @…`, `split gutter sync @…`, and repeated
     `bounds corrected @…`. If the popup still floats center-screen, run
     `claude-in-arc upgrade`, focus the Arc window, then press ⌘E again.
   - **Arc limitation** — a narrow popup with a title bar is expected; true
     in-browser embedding is impossible. Margin + gutter create the integrated
     illusion. Drag Arc wider if needed.
9. **Blank in-page sidebar on Chrome/Brave** — common causes:
   - **Stale v1.2.9 build** — bridge used an inline `<script>` blocked by MV3
     extension CSP (`script-src 'self'`). Rebuild with v1.2.10+:
     `claude-in-arc install` (or `config --panel-mode sidebar`), then **Reload**
     in `arc://extensions`. Confirm `claude-arc-sidebar-bridge.js` exists in the
     build folder.
   - **Missing `tabId`** — service worker should log
     `openPanelInSidebar … url=…bridge.html?tabId=…`. If `tabId` is absent,
     chat context breaks; use the toolbar icon on the target page (not a manual
     extension-page URL).
   - **Strict page CSP** — some sites block `chrome-extension://` iframes. The
     host shows an error after ~12s or falls back to popup on restricted URLs.
     Try another `https://` site or switch to popup mode (right-click icon).
   - **Wrong console** — sidebar host logs appear in the **page** DevTools
     console, not the service worker console.

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
# One command: pull tool updates, rebuild, reload in Arc, verify shim
claude-in-arc upgrade

# Or step-by-step:
cd ~/Projects/claude-in-arc && git pull
claude-in-arc install
```

**`claude-in-arc upgrade`** runs `git pull` (when run from the tool repo),
rebuilds via `install`, opens `arc://extensions`, attempts to click **Reload**
via AppleScript, opens a test page (default `https://example.com`), sends **⌘E**,
and checks that the installed shim's `SHIM_VERSION` matches the bundled asset.

Arc UI automation needs **Accessibility** permission for your terminal (System
Settings → Privacy & Security → Accessibility). **Reload** on `arc://extensions`
is usually **not** auto-clickable — Chromium does not expose those web buttons to
macOS Accessibility — so upgrade prints a one-line manual step. **⌘E** on a normal
page often works when Accessibility is granted. The command still verifies the shim.

Flags: `--no-pull`, `--no-reload`, `--no-test-page`, `--test-url URL`.

In Arc (`arc://extensions`) if upgrade did not click Reload:

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

### Remote bridge WebSocket errors in the service worker console

If you see:

```
WebSocket connection to 'wss://bridge.claudeusercontent.com/chrome/…' failed:
Error during WebSocket handshake: net::ERR_ADDRESS_INVALID
```

**Expected on Arc.** This is Anthropic's remote bridge for Claude Code `/chrome`
automation — not `claude-arc-sidebar-bridge.html` (the local in-page sidebar
loader). `claude-in-arc` does not patch or block that WebSocket.

| Check | Meaning |
|-------|---------|
| Side panel opens, chat works | Patch is fine; ignore bridge console noise |
| `/chrome` or MCP tools fail | Upstream limitation; use Chrome or upvote #34364 |
| `bridgeDisplayName` missing in `chrome.storage.local` | Bridge never authenticated (normal on Arc) |

`claude-in-arc doctor` prints a **Claude Code /chrome bridge** section when Arc
(or another patched Chromium browser) is detected.
