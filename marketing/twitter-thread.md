# X / Twitter thread

Short, punchy, one clear CTA. Keep each post under ~280 chars. Replace
the demo link before posting. Attach the demo GIF to post 1 for reach.

---

**1/ (hook + demo GIF)**
The official Claude extension shows "browser not supported" in Arc. 😤

I built a tiny open‑source tool that fixes it — real side‑panel chat with page context, in Arc.

`git clone … && ./install.sh`

🧵 how it works + the one thing it *can't* fix:
https://github.com/Zu9zwan9/claude-in-arc

**2/**
Why it breaks: the extension's service worker literally does
`if (!chrome.sidePanel) return unsupported()`.
Arc doesn't implement `chrome.sidePanel`. Dead end.

**3/**
The fix (no minified‑code hacking needed): the panel URL already encodes the tab —
`sidepanel.html?tabId=N`.
So I polyfill `chrome.sidePanel` to open it as a popup window. Page context intact. ✅

**4/**
Why it's better than the older patches:
• re‑packs YOUR installed extension → never goes stale
• no‑op on real Chrome/Brave/Edge → one universal build
• keeps the official extension id → native messaging still works
• zero deps, tested

**5/ (the honest part)**
What it does NOT do: Claude Code `/chrome` automation.
That's gated by a *server‑side* flag (`chrome_ext_bridge_enabled`) Anthropic returns false for non‑Chrome browsers.
No client tool can flip a server flag. I reported it upstream instead of faking it.

**6/ (CTA)**
macOS today. MIT, free forever.
⭐ the repo, and if you want `/chrome` automation in Arc too, 👍 anthropics/claude-code#34364.

👉 https://github.com/Zu9zwan9/claude-in-arc
