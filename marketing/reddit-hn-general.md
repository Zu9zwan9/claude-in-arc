# General Reddit / Hacker News "Show HN" post

For: r/ClaudeAI, r/programming, Hacker News (Show HN). Tone: technical,
matter‑of‑fact, leads with the interesting engineering detail. HN rewards
honesty and a clear "what I learned" — the server‑flag limitation is an asset,
not something to hide.

---

## Hacker News

**Title:** Show HN: Claude in Arc – run the official Claude extension in Arc (and why it breaks)

**Body:**

The official "Claude in Chrome" extension shows "This browser is not supported" in Arc. I traced it: the service worker does `if (!chrome.sidePanel) return reportUnsupportedBrowser()`, and Arc doesn't implement `chrome.sidePanel`.

The neat part is the fix doesn't require touching any minified code. The extension's panel URL already encodes the originating tab (`sidepanel.html?tabId=N`), so I inject a `chrome.sidePanel` polyfill that re‑hosts the panel as a popup window — and it keeps full page context. The polyfill is a no‑op when the real API exists, so the same build runs unchanged on Chrome/Brave/Edge.

A few design choices that make it durable where older patches go stale:
- It re‑packs the official extension you *already have installed*, picking the newest version, instead of bundling a frozen copy.
- It preserves the official extension id (the manifest ships a `key`), so native messaging keeps working.
- Zero dependencies (system `python3`), tested patch engine.

The honest limitation: Claude Code's `/chrome` browser automation talks to a remote bridge gated by a server‑side feature flag (`chrome_ext_bridge_enabled`) that returns false for non‑Chrome browsers. No client‑side tool can change that, so I documented it and filed it upstream instead of faking a fix (anthropics/claude-code#34364, #18075).

Repo: https://github.com/Zu9zwan9/claude-in-arc

macOS only for now; PRs for Windows/Linux and other Chromium browsers welcome.

---

## r/ClaudeAI (slightly friendlier framing)

**Title:** I made the official Claude extension work in Arc (open source, honest about what it can't do)

**Body:**

If you use Arc and the Claude extension just shows "unsupported browser," here's a fix. It re‑packs the official extension (the one you already installed) so the side‑panel chat opens as a popup with page context. Works on Arc; no‑op on Chrome/Brave/Edge so it's safe everywhere.

It fixes the chat + native messaging (Claude Desktop). It does **not** fix Claude Code `/chrome` automation — that's blocked by a server‑side flag on Anthropic's end, which I explain in the repo and reported upstream.

```
git clone https://github.com/Zu9zwan9/claude-in-arc.git && cd claude-in-arc && ./install.sh
```

https://github.com/Zu9zwan9/claude-in-arc — feedback and PRs welcome.
