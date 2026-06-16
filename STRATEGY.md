# Strategy: community, promotion, and sustainability

This document is the playbook for turning `claude-in-arc` into the canonical,
trusted fix for running Claude in Arc — and keeping it sustainably maintained.
The free MIT core is never gated. Everything below is built on top of a tool
that genuinely works, and stays honest about what it can't do.

---

## 1. Positioning

**One‑line:** *The honest, never‑stale, open‑source way to run the official Claude extension in Arc.*

Three pillars, in priority order:

1. **It works** — side‑panel chat with page context, validated against the real installed extension.
2. **It's honest** — fixes the two client‑side problems, openly documents the one server‑side limitation (`chrome_ext_bridge_enabled`) instead of faking it.
3. **It's durable** — re‑packs the user's *own* freshly‑installed extension, so it survives extension updates where bundled‑copy patches rot.

Trust is the moat. In a space full of stale, half‑working "patches," being the
one that is accurate, tested, and candid is what earns the canonical link.

## 2. Community‑growth path

**Goal:** become the repo that gets linked whenever someone asks "Claude in Arc?"

- **Seed the existing demand.** The r/ArcBrowser thread already exists and ranks for the query. Reply helpfully (see `marketing/reddit-arcbrowser.md`), don't drive‑by spam. Answer follow‑ups with `claude-in-arc doctor` output.
- **Lower friction to zero.** One command (`./install.sh`), no dependencies, clear two‑click load steps, a `doctor` that explains state. Every extra step loses users.
- **Make contribution obvious and easy.** Label issues `good first issue`. The architecture is built for PRs:
  - Additional Chromium browsers needing the `sidePanel` patch (Vivaldi, Helium, Brave Beta, Opera) — mostly registry entries in `known_browsers()`.
  - **Windows** (`%LOCALAPPDATA%` paths, PowerShell launcher) and **Linux** (`~/.config`, Claude Code native host) — the patch engine is platform‑agnostic; only path discovery and the launcher differ.
  - A polished demo GIF (high‑leverage for conversion).
- **SEO / discoverability.** Repo topics: `arc-browser`, `claude`, `claude-ai`, `chrome-extension`, `side-panel`, `anthropic`, `macos`. A clear README H1 and the comparison table rank well for "claude arc" searches.
- **Cross‑link the ecosystem.** Reference (and ask to be referenced by) the prior‑art repos. Being listed in stolot0mt0m's browser‑support table is a high‑intent traffic source.
- **Keep it current.** A short note in releases when a new extension version is confirmed working builds the "actively maintained" signal that the stale repos lack.

## 3. Promotional path

Assets are ready in `marketing/`:

- `reddit-arcbrowser.md` — targeted reply to the specific thread (highest intent).
- `reddit-hn-general.md` — Show HN + r/ClaudeAI / r/programming versions.
- `twitter-thread.md` — 6‑post thread with a clear CTA.

**Sequencing:** ship a working release + demo GIF → reply on r/ArcBrowser → Show HN (lead with the engineering insight; HN rewards the honest limitation) → X thread → r/ClaudeAI. Engage in comments; convert questions into FAQ/issues.

**Tone rule:** every post leads with genuine help and the *why*, names the limitation plainly, and has exactly one link. Helpfulness compounds; spam burns the canonical position.

## 4. Financial paths (realistic, non‑intrusive)

The core is and stays free MIT. Money, if any, follows from being genuinely useful and visible.

- **Donations / sponsors (now).** GitHub Sponsors + Ko‑fi/BMC buttons (`.github/FUNDING.yml`, README Support section). Realistic for a niche dev tool: coffee‑money that signals appreciation and funds maintenance time. Do **not** gate features behind it.
- **Adjacent broader product (later, optional).** The patch engine generalizes to *"Claude for any Chromium browser"* (Brave, Vivaldi, Helium, Edge variants, Linux). A cross‑platform installer / menu‑bar helper could be a paid "pro" convenience layer **without ever restricting the open‑source CLI** — packaging/auto‑update/GUI as the value, not access.
- **Consulting / support (opportunistic).** Browser‑extension reverse‑engineering and native‑messaging integration is a real skill set; a visible, credible repo is a portfolio piece that attracts contract work.
- **Upstream goodwill (indirect value).** A well‑evidenced bug report to Anthropic (next section) builds reputation, may get `/chrome` unlocked for Arc (making the tool even more valuable), and positions the author as a serious contributor — worth more than ad revenue.

**What to avoid:** crippling the free tool, ads, telemetry, or any dark‑pattern monetization. They would destroy the trust that is the entire value.

## 5. Upstream: turn the limitation into goodwill + visibility

The `chrome_ext_bridge_enabled` server flag is the one thing we can't fix — so
we make it work *for* the project. `docs/anthropic-bug-report.md` is a credible,
evidence‑backed writeup that:

- Links the existing analysis ([claude‑code#34364](https://github.com/anthropics/claude-code/issues/34364)) and feature request ([#18075](https://github.com/anthropics/claude-code/issues/18075)) so we amplify rather than duplicate.
- Frames a concrete, low‑risk ask (allowlist Chromium browsers for the bridge flag, or expose a `CLAUDE_CODE_CHROME_PATH` fallback).
- Demonstrates the extension already works in Arc (this tool proves it), removing Anthropic's likely objection.

If Anthropic ships it, `/chrome` automation lights up in Arc and the tool's
value jumps. Either way, the writeup signals rigor and good faith, which is
exactly the reputation that drives stars, sponsors, and contributors.

## 6. Success metrics

- ⭐ Stars and the share of "Claude in Arc" threads that link here (canonical‑link rate).
- Issues closed with `doctor` output (support efficiency).
- PRs adding browsers / platforms (contributor pull).
- 👍 on the upstream Anthropic issues (community signal we can point to).
- Sponsors — a nice‑to‑have, never the point.
