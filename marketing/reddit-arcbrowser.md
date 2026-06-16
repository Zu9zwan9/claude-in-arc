# r/ArcBrowser reply — "Is there a way to use Claude in Arc?"

Context: this is a direct, helpful reply to the existing thread
(https://www.reddit.com/r/ArcBrowser/comments/1rm13ts/is_there_a_way_to_use_claude_in_arc/).
Goal: answer the question genuinely, explain the *why*, link the tool, and be
upfront about the one thing it can't fix. Not spammy — lead with help.

---

**Title (if posting fresh):** Made an open‑source fix to run the official Claude extension in Arc (side‑panel chat + page context)

**Reply body:**

Yeah — I dug into why this breaks and built a small open‑source tool that fixes it. Quick explanation first so you know what you're installing.

There are actually three different "Claude in Arc" problems people mix up:

1. **The icon does nothing / "unsupported browser."** Arc doesn't implement Chrome's `chrome.sidePanel` API, and the extension hard‑bails when it's missing. ✅ Fixable.
2. **Claude Desktop can't connect.** The native‑messaging manifest only gets installed for Chrome/Edge automatically. ✅ Fixable.
3. **Claude Code `/chrome` browser automation.** This one goes through a remote bridge gated by a *server‑side* flag Anthropic returns `false` for non‑Chrome browsers. ❌ **Not** fixable locally — no tool can flip a server flag, and I won't pretend otherwise.

So the tool fixes #1 and #2 and is honest about #3 (which is just the chat, not automation, so most people are fine).

What makes it different from the older patches floating around: it **re‑packs the official extension you already have installed** (so it never goes stale on updates), the patch is a **no‑op on real Chrome/Brave/Edge** (same build works everywhere), and it **keeps the official extension id** so native messaging stays valid. Zero dependencies, just `python3`.

```
git clone https://github.com/Zu9zwan9/claude-in-arc.git
cd claude-in-arc
./install.sh
```

Then `arc://extensions` → Developer mode → Load unpacked → the folder it prints. Click the Claude icon (or Cmd+E) and it opens as a popup with page context.

Repo + full writeup (including the server‑flag limitation and the bug report I filed with Anthropic): https://github.com/Zu9zwan9/claude-in-arc

Happy to help if anyone hits a snag — open an issue with the output of `claude-in-arc doctor`.
