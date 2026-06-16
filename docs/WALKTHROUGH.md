# Claude in Arc — verification walkthrough

Step-by-step checklist to install, load, and confirm the patched Claude extension
works in Arc. Use this when the toolbar icon does nothing or `doctor` reports a
conflict.

## 1. Install the tool

```bash
curl -fsSL https://raw.githubusercontent.com/Zu9zwan9/claude-in-arc/main/bootstrap.sh | bash
```

Or from a clone: `./install.sh`

**Expected:** build written to  
`~/Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension/`  
with `CLAUDE_IN_ARC_PATCH.json`, `claude-arc-shim.js`, and `arc-sw-loader.js`.

## 2. Open `arc://extensions`

**Expected:**

- **Developer mode** toggle is available (top-right).
- If you previously installed Claude from the Web Store, you may see a **Claude**
  entry sourced from the Chrome Web Store.

## 3. Resolve the two-Claude conflict (same extension id)

The default build keeps Anthropic's official extension id. Arc can only register
**one** copy at a time.

| Goal | What to do |
|------|------------|
| **Recommended** — keep official id (Claude Desktop integration) | Remove the **Store** Claude entry. Keep only the unpacked build. |
| Keep both Store + patched copies | Re-run `claude-in-arc install --new-id` and load the new folder. |

**Expected after fix:** only one Claude entry, **Load unpacked**, path ending in
`ClaudeInArc/Claude-in-Arc-Extension`.

## 4. Load unpacked

1. Developer mode → **On**
2. **Load unpacked** → select  
   `~/Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension`

**Expected on the extension card:**

- Source: **Load unpacked**
- Service worker: **arc-sw-loader.js** (click "Service worker" → no red errors)

## 5. Verify click and keyboard shortcut

1. Open any normal webpage (not `chrome://` or `arc://`).
2. Click the **Claude** toolbar icon **or** press **⌘E**.

**Expected:** a popup window opens with Claude's side panel UI (`sidepanel.html?tabId=…`).

## 6. If nothing happens

Run the automated checklist:

```bash
claude-in-arc verify
# same as: claude-in-arc doctor --verbose
```

Check each item:

| Check | Expected |
|-------|----------|
| Patched build on disk | `CLAUDE_IN_ARC_PATCH.json` present |
| Arc prefs point at patched build | Path = `…/ClaudeInArc/Claude-in-Arc-Extension` |
| Service worker | `arc-sw-loader.js` |
| No Store copy on disk | No `…/Arc/…/Extensions/fcoeoabgfenejglbffodgkkbkcdhcgfn/` folder |
| Extension enabled | No "Disabled" badge |

**Service worker console** (`arc://extensions` → Claude → Service worker → Inspect):

- No import errors for `claude-arc-shim.js` or `arc-sw-loader.js`.
- After click, no "Browser not supported" notification path (that means the shim
  did not install — usually a stale Store copy or old build).

**Logs:**

```bash
tail -50 ~/Library/Logs/claude-in-arc/claude-in-arc.log
```

**Typical root causes:**

1. **Store copy still active or on disk** — Arc runs unpatched code; icon click
   hits a broken `chrome.sidePanel` stub and silently does nothing.
2. **Old shim** — before v1.2.1, a truthy but broken `chrome.sidePanel` stub
   caused the shim to no-op. Re-run `claude-in-arc install` and **Reload** the
   extension.
3. **Arc swallows `action.onClicked`** — fixed by the shim wiring
   `action.setPopup` to `sidepanel.html?tabId=…` (v1.2.1+).

## 7. Native messaging (optional)

For Claude Desktop integration:

1. Enable the browser extension in Claude Desktop settings.
2. `claude-in-arc link`
3. `claude-in-arc doctor` → "Arc is linked to the native-messaging host."

Side-panel chat with page context works without this step.

## Quick recovery recipe

```bash
# Rebuild from your installed official extension
claude-in-arc install

# In Arc: arc://extensions
#   → Remove Store "Claude" (if present)
#   → Load unpacked → ClaudeInArc/Claude-in-Arc-Extension
#   → Click Reload on the unpacked entry

claude-in-arc verify
```

Then click the icon or press **⌘E** on a normal webpage.
