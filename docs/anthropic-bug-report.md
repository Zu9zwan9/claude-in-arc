# Feature request / bug report: enable the Claude extension bridge for Chromium browsers (Arc, Brave, Vivaldi, …)

A ready‑to‑file, evidence‑backed writeup for Anthropic. Constructive, specific,
and low‑risk to act on. Post as a new issue on `anthropics/claude-code` (or as a
comment that amplifies the existing threads) — links below to avoid duplication.

**Related existing issues (please read/upvote rather than duplicate):**
- [claude-code#34364 — Bridge feature flag blocks non‑Chrome Chromium browsers from `/chrome`](https://github.com/anthropics/claude-code/issues/34364)
- [claude-code#18075 — Add env var for custom Chromium browser path](https://github.com/anthropics/claude-code/issues/18075)

---

## Summary

The "Claude in Chrome" extension and Claude Code's `/chrome` integration work
end‑to‑end in Chromium‑based browsers (Arc, Brave, Vivaldi, Edge, Helium, …)
**except** for one server‑gated step: the extension only opens its bridge
WebSocket to `wss://bridge.claudeusercontent.com` when the feature flag
`chrome_ext_bridge_enabled` evaluates `true`, and it currently evaluates `false`
for non‑Chrome browsers. As a result, Claude Code's MCP server never finds the
extension on the bridge, and `/chrome` reports "extension not connected."

Everything else already works in these browsers — including, with a tiny
client‑side `chrome.sidePanel` polyfill, the full side‑panel chat with page
context (demonstrated by the open‑source `claude-in-arc` project).

## Environment

- **Browser:** Arc (Chromium‑based), also reproduces on Brave/Vivaldi.
- **OS:** macOS (also reported on Linux for Helium/ungoogled‑chromium).
- **Extension:** official "Claude in Chrome" (id `fcoeoabgfenejglbffodgkkbkcdhcgfn`), current version.
- **Claude Code:** current.

## What works in Arc today

- The extension installs and runs (verified: service worker active, native messaging functional).
- `chrome.storage.local` shows `chrome_ext_bridge_enabled` defaulting to `true` on both Chrome and Arc.
- The `bridge-keepalive` alarm is active in both.
- With a client‑side `chrome.sidePanel` polyfill, the side‑panel chat and page context work normally in Arc.

## What fails

- The bridge WebSocket to `wss://bridge.claudeusercontent.com` is **established on Chrome** but **fails on Arc** (and other non-Chrome Chromium browsers).
- On Arc, DevTools may show `net::ERR_ADDRESS_INVALID` during the WebSocket handshake — a symptom of the gated remote bridge, not a `claude-in-arc` regression.
- `bridgeDisplayName` is set on Chrome, missing on Arc.
- Because the extension never appears on the bridge, Claude Code's `/chrome` MCP server cannot match it, and tool calls (`tabs_context_mcp`, etc.) fail or prompt to "set up in Chrome."

This matches the root‑cause analysis in #34364: `/chrome` does not use local
sockets for tool calls; it matches the extension and the MCP server by account
through the remote bridge, and the bridge connection is browser‑gated.

## Steps to reproduce

1. Install the official extension in Arc.
2. Confirm the extension is active and `chrome_ext_bridge_enabled` is `true` in `chrome.storage.local`.
3. In Claude Code, run `/chrome` (or call any `mcp__Claude_in_Chrome__*` tool).
4. Observe that Chrome is targeted / the extension is reported as not connected, even though it is running in Arc.

## Expected behavior

The bridge connection should be available to any Chromium browser where the
extension runs and native messaging is configured — not restricted to Chrome by
browser type.

## Proposed fixes (either is sufficient)

1. **Allowlist Chromium browsers for `chrome_ext_bridge_enabled`.** The extension already runs correctly in these browsers; only the bridge connection is gated. Removing the browser‑type restriction (or extending the allowlist to Brave/Arc/Vivaldi/Edge/Helium) is the smallest change.
2. **Provide a local‑socket fallback / `CLAUDE_CODE_CHROME_PATH` env var.** Let the MCP server connect to the extension via the existing native‑messaging/local‑socket path when the bridge is unavailable, and let users point Claude Code at a specific Chromium binary (see #18075).

## Why this is low‑risk

- No new surface area: the extension, native messaging, and bridge already exist and function; this only changes *which browsers are permitted* to use them.
- Demonstrated safe: the extension's full UI and page context already work in Arc via a client polyfill, so there's no hidden incompatibility being masked.
- Large, vocal demand: Arc/Brave/Vivaldi are common developer dailies; multiple issues and community workarounds exist.

## Appendix: client‑side context

The side‑panel UI failure in Arc is a *separate*, client‑side issue (Arc doesn't
implement `chrome.sidePanel`); it's fixable without Anthropic via a polyfill and
is handled by the community `claude-in-arc` tool. This report is specifically
about the **server‑gated bridge**, which only Anthropic can unlock.
