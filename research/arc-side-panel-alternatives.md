# Arc side panel — alternative approaches

Research note (June 2026). The user sees Claude load correctly at
`chrome-extension://…/sidepanel.html?tabId=…` but in a **separate OS window**,
not Chrome’s in-browser side panel. This doc ranks other ways to improve or
replace that UX.

See also: [ARC_LIMITATIONS.md](../docs/ARC_LIMITATIONS.md),
[DYNAMIC_ISLAND.md](../docs/DYNAMIC_ISLAND.md), [STRATEGY.md](../STRATEGY.md).

---

## What “success” means today

| Signal | Meaning |
|--------|---------|
| `sidepanel.html?tabId=N` in a narrow window | **Working** — chat + page context |
| Empty chat UI, icon does nothing | **Broken** — different debugging path |
| Page has `claude-in-arc-split-open` + margin | Split mode applied |
| Floating center-screen window | Dock misalignment (best-effort bug class) |

**Ceiling on Arc:** no MV3 extension can call a real `chrome.sidePanel` or Arc
Split View API. Any “fix” is a **different surface**, not the same API.

---

## Options ranked by feasibility

### 1. Split-panel mode (current default) — **High / shipped**

Page `margin-right` + docked `type: "popup"` over the gutter.

| Pros | Cons |
|------|------|
| Chat works; page context preserved | Still a separate OS window (title bar) |
| No Arc iframe block | Dock can drift; focus quirks |
| Default in `claude-in-arc` | Never identical to Chrome side panel |

**Verdict:** Best **extension-only** option on Arc. Further work = polish
(bounds retries, doctor messaging), not a new paradigm.

---

### 2. Chrome or Brave with in-page sidebar — **High / shipped elsewhere**

`claude-in-arc config --panel-mode sidebar` on Chrome/Brave injects a fixed
right column; iframe loads `sidepanel.html` inside the **same browser window**.

| Pros | Cons |
|------|------|
| True in-window panel on supported browsers | **Not Arc** |
| Same patched official extension | Two browsers if user keeps Arc for browsing |

**Verdict:** If the goal is *Chrome-like side panel*, use Chrome/Brave for
Claude-on-page sessions. Arc for everything else.

---

### 3. Popup-only mode — **High / shipped**

`--panel-mode popup` — no page margin, just the docked narrow window.

| Pros | Cons |
|------|------|
| Simplest; works on `arc://` pages | No page shrink; feels most “detached” |
| Fewer moving parts than split | Same separate-window limitation |

**Verdict:** Fallback when split injection fails or user prefers minimal DOM touch.

---

### 4. Shadow DOM / non-iframe overlay — **Low / likely blocked**

Idea: inject a content-script shell (shadow DOM) and load chat UI without
`<iframe src="chrome-extension://…">`.

| Blocker | Why |
|---------|-----|
| Extension pages are `chrome-extension://` origin | Cannot mount full sidepanel UI in page origin without iframe or remote code |
| MV3 CSP | No arbitrary script injection of extension bundle into page |
| Arc already blocks extension iframes | Suggests broad “no extension UI in page” policy |

**Verdict:** **Not viable** without Arc shipping an embed API or relaxing iframe
policy. v1.2.9–1.2.11 proved iframe path fails on Arc.

---

### 5. Offscreen documents — **Low**

`chrome.offscreen` for background work, not visible UI.

**Verdict:** Does not solve presentation. **Not applicable.**

---

### 6. Arc Split View (native) — **Impossible (extensions)**

User-driven UI only (drag tab, ⌘⇧+). Chromium 140+ may expose read-only
`splitViewId`; no create/resize API ([W3C #967](https://github.com/w3c/webextensions/issues/967)).

**Verdict:** Cannot programmatically put Claude inside Arc’s split tabs.

---

### 7. Arc internal / deep patches — **Low / fragile**

[chxsong/Claude-in-Arc](https://github.com/chxsong/Claude-in-Arc) style hacks
into Arc binaries or private APIs.

| Pros | Cons |
|------|------|
| Theoretically closest to “native” | Breaks every Arc update; not redistributable |
| | Legal/support risk |

**Verdict:** **Not pursued** by this project (see STRATEGY.md).

---

### 8. AppleScript window tiling — **Medium / partial**

Use [arc-applescript-api](https://github.com/kkoscielniak/arc-applescript-api) +
System Events to snap Arc main window left and Claude popup right.

| Pros | Cons |
|------|------|
| Could feel like a two-pane layout | Still two windows; brittle on multi-monitor |
| No extension API needed | Requires Accessibility; not bundled today |

**Verdict:** Optional **v2 CLI helper** (`claude-in-arc tile`) — experiment only;
does not remove the OS window.

---

### 9. Native macOS companion (notch / menu bar HUD) — **Medium / Phase 2**

MIT companion app in `native/ClaudeInArcHUD/`: `NSPanel` + DynamicNotchKit +
`chrome.runtime.connectNative` to the patched extension.

| Pros | Cons |
|------|------|
| Novel UX; not fighting Arc window manager | **Separate install**; months of work |
| MIT-safe (no boring.notch GPL fork) | Chat still not *inside* Arc window |
| Scaffold exists | M3–M4: WebView, signing, notarization |

**Verdict:** Best **long-term differentiator** if users want “system HUD” instead
of in-Arc chrome. See [DYNAMIC_ISLAND.md](../docs/DYNAMIC_ISLAND.md).

---

### 10. Claude Desktop / Comet — **Medium / different product**

User’s extension is sourced from Comet (`1.0.74_0 (from Comet)`). Anthropic’s
own browsers may integrate panel UX differently.

| Pros | Cons |
|------|------|
| Official stack | Not Arc; may not have arbitrary page context |
| Desktop app has native windowing | `/chrome` MCP still gated on non-Chrome |

**Verdict:** Parallel path for “official” chat; does not fix Arc extension UX.

---

### 11. Greenfield cross-browser agent — **Low / long horizon**

[phase-1-scope.md](phase-1-scope.md) — own MV3 agent, not repackaging Anthropic’s
extension.

| Pros | Cons |
|------|------|
| Full UX control | Not Claude-in-Chrome feature parity |
| | Large engineering bet |

**Verdict:** Research track only; not a quick fix for current users.

---

### 12. Upstream: Arc ships `sidePanel` — **Impossible (community)**

Requires The Browser Company to implement Chrome’s Side Panel API.

**Verdict:** File feedback with Arc; monitor Chromium parity. No extension workaround.

---

## Recommended path forward

### If chat works but UX feels wrong (most users)

1. **Accept split mode ceiling** or use **Chrome/Brave + sidebar** for true in-window panel.
2. Run `claude-in-arc doctor` — read **“Arc — what this tool can and cannot do”**.
3. Ensure **split** mode, **Reload** after upgrade, test on `https://` (not `arc://`).

### If willing to invest in product work

| Priority | Experiment | Effort |
|----------|------------|--------|
| **P1** | AppleScript `tile` helper (snap Arc + popup) | ~1–2 days |
| **P2** | Native HUD M1–M2 (`native/ClaudeInArcHUD`) | weeks |
| **P3** | Arc feature request + Anthropic bridge allowlist | ongoing |

### Quick experiments **not** recommended

- Shadow-DOM chat shell without iframe
- `chrome.debugger` to fake side panel
- Forking Arc or boring.notch into this repo

---

## Won’t fix (honest list)

- True Chrome `chrome.sidePanel` inside Arc’s window frame
- Extension UI in Arc’s left sidebar / Spaces
- Programmatic Arc Split View with Claude in a pane
- Claude Code `/chrome` MCP in Arc (server-side `chrome_ext_bridge_enabled`)
- Removing the popup title bar without OS-level borderless window hacks
- One-click Reload on `arc://extensions` (Accessibility tree exposes no labels)

---

## References

- Community patches: [Dylanyz/claude-arc-patch](https://github.com/Dylanyz/claude-arc-patch), [Dhravya/arc-sidepanel-patch](https://github.com/Dhravya/arc-sidepanel-patch), [timeoio/claude-for-arc](https://github.com/timeoio/claude-for-arc)
- Arc Split View (user docs): https://resources.arc.net/hc/en-us/articles/19335393146775
- W3C split tabs (read-only): https://github.com/w3c/webextensions/blob/main/proposals/split_tabs_proposal.md
