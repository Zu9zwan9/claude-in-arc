# Claude Agent (Phase 1) — early scaffold

> **Unofficial · community-built · not affiliated with or endorsed by Anthropic or The Browser Company.**

A read-first Claude copilot that lives in a browser **side panel** for Chromium
browsers — including **Arc**, which lacks `chrome.sidePanel` (it falls back to a
popup window). This is the **Phase 1 / M1** milestone: just the loadable
scaffold. See [`../research/phase-1-scope.md`](../research/phase-1-scope.md) for
the full plan and [`../research/zero-to-one-cross-browser-agent.md`](../research/zero-to-one-cross-browser-agent.md)
for the feasibility/business audit.

## What M1 delivers (and what it does NOT)

**M1 is the shell only.** It is a separate package from the existing
[`claude-in-arc` patcher](../README.md) and does not touch it.

Delivered in M1:

- An **MV3 extension** that builds to a load-unpacked `dist/`.
- A **least-privilege manifest**: `activeTab`, `scripting`, `storage`,
  `sidePanel` — and deliberately **no** `<all_urls>`, **no** broad host
  permissions, **no** `chrome.debugger`.
- A **side panel shell** (`Claude Agent — Phase 1`) with a placeholder chat area
  and a disabled input. No logic.
- The proven **`chrome.sidePanel` → popup fallback** ported from the patcher's
  shim, so the panel opens in **both** Chrome (native side panel) and **Arc**
  (reusable popup window), from **one build**.
- The **safety-first architecture** laid out as stubs — `src/lib/safety`,
  `src/lib/providers`, `src/content`, `src/types` — sketching the
  **observe → plan → consent → act** loop that later milestones fill in.

**Not in M1** (later milestones): any Anthropic/provider calls, BYO-key
onboarding, page/selection/tab capture, content scripts, consent UI, audit log,
or write tools. M1 makes **zero** network and model calls.

## Build it

Requires Node.js (18+).

```bash
cd agent
npm install
npm run build      # → produces dist/ (load-unpacked MV3 extension)
```

Other scripts: `npm test` (Vitest), `npm run typecheck` (tsc), `npm run lint`
(ESLint), `npm run format` (Prettier), `npm run dev` (esbuild watch).

## Load it

### Chrome (and Edge / Brave / Vivaldi) — native side panel

1. `npm run build`.
2. Go to `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select `agent/dist`.
4. Click the extension's toolbar icon → the **Claude Agent** panel opens as a
   native **side panel** showing the shell.

### Arc — popup fallback

Arc has no `chrome.sidePanel`, so the same build opens the panel as a popup:

1. `npm run build`.
2. Go to `arc://extensions` (or the Extensions page), enable **Developer mode**.
3. **Load unpacked** → select `agent/dist`.
4. Click the extension's toolbar icon → the panel opens as a **popup window**.
   Clicking again **re-focuses** the same window (it does not duplicate), and
   closing it resets the state.

The native-vs-popup decision is made at runtime by capability-detecting
`chrome.sidePanel` (see `src/lib/sidepanel-fallback.ts`) — there is no
Arc-specific build.

## Layout

```
agent/
  manifest.json              # MV3, least-privilege
  build.mjs                  # esbuild bundle + static copy → dist/
  src/
    background/index.ts      # service worker: opens panel (sidePanel | popup)
    sidepanel/               # static shell: index.html, sidepanel.ts, sidepanel.css
    content/                 # (stub) JIT capture / write tool — later milestone
    lib/
      sidepanel-fallback.ts  # ported chrome.sidePanel→popup shim (tested)
      safety/                # (stub) sanitize / blocklist / budget / separation
      providers/             # (stub) Provider interface + Anthropic impl (M2)
    types/                   # (stub) tool schemas, message envelopes
  tests/
    unit/                    # Vitest: fallback path / window-id logic
    injection-corpus/        # (placeholder) adversarial pages — M5
    e2e/                     # (placeholder) Playwright load test — later
```

## Status

Early scaffold. The product thesis is **trust + safety as the moat**: read-first,
copilot-only, BYO-key, least-privilege. Nothing here acts on a page yet.
