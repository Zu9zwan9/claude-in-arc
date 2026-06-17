# Arc limitations — split view, sidebar, and panel modes

Honest assessment of what Chromium extensions **can and cannot** do inside Arc,
based on Arc's architecture, the WebExtensions API, community patches, and
`claude-in-arc` v1.2.9 experiments.

## Executive summary

| Approach | Possible? | Notes |
|----------|:---------:|-------|
| Native `chrome.sidePanel` in Arc | **No** | Arc exposes missing or no-op stubs; not fixable without Arc shipping the API. |
| Arc **Split View** via extension API | **No** | Split View is a browser UI feature; no `splitView.create` API exists (Chrome 140+ only exposes read-only `splitViewId` on tabs). |
| Arc **native sidebar** injection | **No** | Spaces, pinned tabs, and Little Arc are not extensible; no `arc://` scheme to open split view programmatically. |
| **Split-panel mode** (v1.2.12) | **Yes (Arc)** | Page margin + docked popup window — optical integration without iframe. Default on Arc. |
| **Popup window** polyfill (v1.2.8) | **Yes** | Separate ~410px window; docks to browser right edge. Still available via `panel-mode popup`. |
| **In-page sidebar** iframe (v1.2.9) | **Chrome/Brave only** | Content-script overlay with extension iframe. **Arc blocks `chrome-extension://` in page iframes** — use split mode on Arc. |
| **macOS Dynamic Island** / system notch UI | **No** | No public API for extensions; requires a native companion app. See **[DYNAMIC_ISLAND.md](DYNAMIC_ISLAND.md)**. |

\* Requires the official extension's existing `scripting` permission and host access for the active tab. **Not available on Arc** — see below.

## Arc blocks extension iframes in pages

Arc (The Browser Company) applies a **browser-level restriction** that blocks
`chrome-extension://` URLs when embedded in a normal webpage `<iframe>`. The
user sees Arc's interstitial: **"This page has been blocked by Arc"** (sad
document icon). This is separate from site CSP or MV3 `web_accessible_resources`
— the bridge page loads fine when opened directly, but not when framed inside
`https://` pages.

**This is not documented** in Arc's public FAQ or extension docs at the time of
writing. Community extension patches (e.g.
[Dhravya/arc-sidepanel-patch](https://github.com/Dhravya/arc-sidepanel-patch))
note similar iframe blocking. There is **no supported bypass** for MV3 extensions
short of Arc shipping a policy change.

**What `claude-in-arc` does (v1.2.12+):**

- **Default on Arc:** split-panel mode — page content shrinks left (`margin-right`)
  while a docked popup window shows Claude flush to the browser's right edge.
  No iframe in the page, so Arc does not block it.
- **Popup-only fallback:** `claude-in-arc config --panel-mode popup` for users who
  prefer the detached window without page margin.
- **Auto-upgrade:** if sidebar mode is set on Arc, the shim uses split-panel instead.
- **In-page sidebar** remains available on **Chrome and Brave** where extension
  iframes in pages work.

**Cannot be bypassed** by CSP fixes, `web_accessible_resources`, or sandbox
attributes — it is enforced by the browser, not the host site.

Arc's [Split View](https://resources.arc.net/hc/en-us/articles/19335393146775-Split-View-View-Multiple-Tabs-at-Once)
lets users view 2–4 tabs side-by-side in one window (drag tab to center, ⌘⇧+,
or Command Bar → “Add Split View”). It is **purely user-driven UI** — there is
no documented extension API, URL scheme, or AppleScript hook to create or
control split views from an extension.

Chromium is adding **read-only** split-view detection (`tabs.Tab.splitViewId` in
Chrome 140+; see [W3C proposal](https://github.com/w3c/webextensions/blob/main/proposals/split_tabs_proposal.md)),
but **no API to create, resize, or remove** split views
([issue #967](https://github.com/w3c/webextensions/issues/967)). Arc has not
documented equivalent APIs.

### “Split tab” workarounds (not true split view)

Extensions can:

- `chrome.windows.create` + `chrome.windows.update` to place two **separate
  windows** side by side (what [Dylanyz/claude-arc-patch](https://github.com/Dylanyz/claude-arc-patch)
  and [Dhravya/arc-sidepanel-patch](https://github.com/Dhravya/arc-sidepanel-patch)
  use — popup windows, not Arc Split View).
- `chrome.tabs.create({ index: currentIndex + 1 })` — opens another tab; does
  **not** enter Arc split mode.
- Resize the browser window and open a narrow popup — still a second OS window,
  not an in-window split.

**Verdict:** Extensions cannot open Claude inside Arc's native Split View.

## Arc native sidebar

Arc's left sidebar (Spaces, pinned tabs, folders) is **not customizable** by
extensions. There is no Chrome extension API to:

- Add a persistent panel next to the Arc sidebar
- Register an extension page in Arc's Spaces UI
- Control Little Arc from an extension (Little Arc is a separate mini-window UX)

[chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc) attempted
deep Arc-internal patching; that approach is fragile across Arc updates and is
not pursued here.

AppleScript ([arc-applescript-api](https://github.com/kkoscielniak/arc-applescript-api))
can open tabs in Spaces but cannot embed extension UI in the sidebar.

**Verdict:** True Arc sidebar integration is **not feasible** for a standard MV3
extension.

## What `claude-in-arc` implements instead

### 1. Split-panel mode (default on Arc, v1.2.12+)

**v1.2.22:** waits for Arc window geometry before `windows.create` (avoids
center-screen floats); popup bounds re-applied at 0/50/150/300/500/1000ms;
refocuses Arc after dock; verifies gutter alignment and notifies on misalignment.
Closing the OS popup window removes the page margin (linked close behavior).

**v1.2.17:** popup bounds are re-applied at 0ms, 50ms, and 150ms after open
(`scheduleSplitBoundsRetries`) because macOS Arc often ignores the first
`windows.update`. Closing the OS popup window removes the page margin (linked
close behavior). The margin column shows the page background until the popup
covers it — split-host gutter CSS stays transparent.

**v1.2.14:** popup window bounds match the gutter exactly
(`left = anchor.left + anchor.width - panelWidth`, full anchor height). The page
margin is the only visible shrink — no white gutter column or × button; an
invisible resize strip remains at the margin edge. Split mode refuses
`tabs.create` fallback to avoid duplicate sidepanel tabs in the Arc sidebar.

**v1.2.13:** margin is applied *before* the docked popup opens (50ms delay) so
the page shrink is visible. A one-time notification explains the narrow-panel UX.
Legacy `popup` mode in extension storage auto-upgrades to split on Arc unless you
explicitly chose popup-only via the context menu.

Combines two techniques:

1. **Page layout:** injects `claude-arc-split-host.js` to add `margin-right` on the
   active tab (~410px, resizable) plus an invisible resize strip at the margin edge.
2. **Docked popup:** opens `sidepanel.html?tabId=…` in a `chrome.windows.create`
   popup positioned flush over the margin — **not** embedded in a page iframe.

When the Arc window moves or resizes, the popup repositions. When the popup or
page close control is used, the margin is removed.

**Pros:** Feels closer to Chrome's side panel — page narrows, Claude sits on the right.  
**Cons:** Claude still runs in a separate OS window (technically a popup). Minor
seam between page gutter and popup possible; focus/z-order quirks remain.

### 2. Popup window mode

Polyfills `chrome.sidePanel.open()` with `chrome.windows.create({ type: "popup" })`,
positioned flush to the focused browser window's right edge. Page context is
preserved via `sidepanel.html?tabId=<id>`.

**Pros:** Works on all pages (including `arc://extensions`). No page injection.  
**Cons:** Separate OS window; no in-window page shrink.

### 3. In-page sidebar mode (v1.2.9, Chrome/Brave only)

When enabled on **Chrome or Brave**, the shim injects `claude-arc-sidebar-host.js`
into the active tab and shows a fixed right column (~410px, resizable) with an
iframe to `claude-arc-sidebar-bridge.html?tabId=…`, which embeds the real
`sidepanel.html`.

**On Arc:** this mode does **not** work — Arc blocks the extension iframe. Use
split-panel mode (default) or popup-only.

**Pros (Chrome/Brave):** Panel moves with the page; feels closest to Chrome's side panel.  
**Cons:**

- **Not supported on Arc** (browser blocks extension iframes in pages).
- Does not work on restricted URLs (`chrome://`, `arc://`, `edge://`, …) — falls
  back to popup automatically.
- Some sites with strict CSP may block the overlay (rare for `chrome-extension://`
  iframes on Chrome).
- Injects DOM into the page (isolated host script; Claude UI stays in extension
  origin).
- Per-tab: switching tabs opens sidebar on the new tab; previous tab's sidebar
  is hidden.

## How to switch panel modes

```bash
# Arc: split-panel is default (recommended)
claude-in-arc install                    # split mode baked in on Arc
claude-in-arc config --panel-mode split  # explicit

# Arc: popup-only (no page margin)
claude-in-arc config --panel-mode popup

# Chrome/Brave: optional in-page sidebar
claude-in-arc config --panel-mode sidebar
```

Then **Reload** the unpacked extension in `arc://extensions` (or `chrome://extensions`).

**Runtime toggle (no rebuild):** Right-click the Claude toolbar icon →
**Panel mode: Split panel (Arc)** / **Popup window** / **In-page sidebar** (on Arc,
sidebar selection uses split). When the upstream manifest already includes `contextMenus`
permission.

**Service worker console** (`arc://extensions` → Service worker → Inspect):

```js
chrome.storage.local.set({ "claudeInArc.panelMode": "split" });  // Arc default
chrome.storage.local.set({ "claudeInArc.panelMode": "popup" });    // popup-only
// sidebar only works on Chrome/Brave:
chrome.storage.local.set({ "claudeInArc.panelMode": "sidebar" });
```

## Community patch comparison

| Project | Approach | Split / native sidebar? |
|---------|----------|-------------------------|
| **Dylanyz/claude-arc-patch** | Popup window | No |
| **Dhravya/arc-sidepanel-patch** | CDP inject polyfill → popup | No; notes iframe blocked for some extensions |
| **chxsong/Claude-in-Arc** | Arc internal patching | Aimed at visual integration; brittle |
| **timeoio/claude-for-arc** | Undocumented at time of writing | — |
| **claude-in-arc** (this) | Split-panel + popup + in-page sidebar | No native Arc APIs; best-effort UX |

## Recommendation

1. **On Arc:** use **split-panel mode** (default). Click the toolbar icon or ⌘E —
   page content narrows left, Claude docks on the right with full page context.
2. **Prefer no page injection?** `claude-in-arc config --panel-mode popup` → Reload.
3. **On Chrome/Brave:** try in-page sidebar if you prefer a true in-window column:
   `claude-in-arc config --panel-mode sidebar` → Reload.
4. **Use popup-only mode** on `arc://` pages or when split margin is undesirable.
5. **Do not expect** Arc Split View or native sidebar integration without Arc
   shipping new extension APIs.

## Claude Code `/chrome` remote bridge

Anthropic's official extension opens a **remote WebSocket** to
`wss://bridge.claudeusercontent.com` so Claude Code's `/chrome` command can drive
the browser (MCP tools like `tabs_context_mcp`). This is **not** the same as
`claude-in-arc`'s local `claude-arc-sidebar-bridge.html` page used for in-page
sidebar mode on Chrome/Brave.

| Capability | Arc (with claude-in-arc) | Google Chrome |
|------------|:------------------------:|:-------------:|
| Side-panel chat + page context | ✅ | ✅ |
| Split-panel / popup panel modes | ✅ | ✅ (native `chrome.sidePanel`) |
| Claude Desktop ↔ extension (native messaging) | ✅ (after `link`) | ✅ |
| Claude Code `/chrome` browser automation | ❌ | ✅ |
| Remote bridge WebSocket (`bridge.claudeusercontent.com`) | ❌ | ✅ |

### Why it fails in Arc

The extension checks a **server-side** feature flag (`chrome_ext_bridge_enabled`).
Anthropic evaluates it `false` for non-Chrome Chromium browsers (Arc, Brave,
Vivaldi, …). The extension may still attempt the WebSocket; the connection does
not complete. In DevTools you may see:

```
WebSocket connection to 'wss://bridge.claudeusercontent.com/chrome/<uuid>' failed:
Error during WebSocket handshake: net::ERR_ADDRESS_INVALID
```

`net::ERR_ADDRESS_INVALID` (Chromium error −108) means the network stack rejected
the target address during connect — here it is a **symptom of the gated remote
bridge**, not evidence that `claude-in-arc` broke DNS or proxy settings. The
patch does not modify upstream bridge code; it only adds the `chrome.sidePanel`
polyfill and optional panel-mode assets.

**Not fixable locally.** Use Chrome for `/chrome` automation, or advocate upstream:
[`docs/anthropic-bug-report.md`](anthropic-bug-report.md),
[claude-code#34364](https://github.com/anthropics/claude-code/issues/34364).

### If you see bridge errors but side panel works

That is normal. Side-panel chat does not depend on `bridge.claudeusercontent.com`.
Ignore the console noise unless you specifically need Claude Code browser automation.
