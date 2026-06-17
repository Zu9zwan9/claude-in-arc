# Claude-in-Arc Native HUD (Phase 2 scaffold)

Optional macOS companion that shows Claude chat in a **Dynamic Island–style notch overlay**, separate from the Arc extension patch.

**Status:** M0 scaffold + M1 pill UI — extension wire-up in M2.

## Why a separate app?

- Arc has no `chrome.sidePanel`; v1.2.9 **in-page sidebar** and popup modes stay the primary surfaces.
- [boring.notch](https://github.com/TheBoredTeam/boring.notch) is GPL-3.0 with **no plugin API** — we cannot embed into it from this MIT repo.
- Community notch apps (MioIsland, agent-notch, etc.) use **DynamicNotchKit** (MIT) + local IPC; we follow that pattern and bridge the **browser extension** via native messaging.

## Layout

```
native/
  README.md
  schemas/hud-message-v1.json
  ClaudeInArcHUD/
    Package.swift
    Sources/
      ClaudeInArcHUD/         ← MenuBarExtra app (ClaudeInArcHUDApp.swift)
      ClaudeInArcHUDCore/     ← NSPanel positioning (HUDPanelController.swift)
      ClaudeInArcHUDHost/     ← chrome native-messaging stdin/stdout stub
```

## Integration plan

### Phase 2-M0 (current)

- [x] Document architecture in `docs/DYNAMIC_ISLAND.md`
- [x] Draft `schemas/hud-message-v1.json`
- [x] SPM package skeleton with DynamicNotchKit
- [x] `claude-in-arc hud build|install|open` CLI stub
- [x] `NotchPillController` (DynamicNotchKit compact/expand)

### Phase 2-M1 — Notch shell

- [x] MenuBarExtra + `LSUIElement` accessory policy
- [x] Collapsed pill via DynamicNotchKit; expand on toggle
- [x] Read notch geometry from `NSScreen.safeAreaInsets` / auxiliary areas
- [ ] Hover-to-expand parity with agent-notch

### Phase 2-M2 — Native messaging host

- [x] Host manifest template `com.claudeinarac.hud`
- [x] `claude-in-arc hud install` (mirror `link` pattern)
- [ ] Patched extension background: optional `connectNative("com.claudeinarac.hud")` when HUD mode enabled
- [ ] Host ↔ app IPC (notifications or Unix socket)

### Phase 2-M3 — Chat surface

- [ ] Expanded notch hosts `WKWebView` loading extension `sidepanel.html` **or** a slim build artifact from `agent/`
- [ ] Pass `tabId` / page context over native messaging per schema

### Phase 2-M4 — Ship path

- [ ] Ad-hoc signing instructions (match boring.notch: no Dev ID yet → quarantine / `xattr` docs)
- [ ] `doctor` check: HUD host registered, app running

## Build (scaffold)

Requires macOS 13+, Swift 5.9+, Xcode CLI tools:

```bash
cd native/ClaudeInArcHUD
swift build
.build/debug/ClaudeInArcHUD          # menu-bar HUD panel (placeholder view)
.build/debug/ClaudeInArcHUDHost      # native-messaging host stub (com.claudeinarac.hud)
```

`HUDPanelController` uses `NSScreen.auxiliaryTopLeftArea` / `auxiliaryTopRightArea` for notch-center positioning (same idea as boring.notch, reimplemented). DynamicNotchKit is a dependency for M1 expand/collapse UI.

## License

MIT — same as parent repo. **Do not** import GPL code from boring.notch.
