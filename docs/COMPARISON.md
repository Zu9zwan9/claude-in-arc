# How `claude-in-arc` compares

There are several attempts to get Claude working in Arc. This page is an honest,
concrete comparison so you can choose with eyes open. (If any project below has
improved since this was written, please open a PR to update it.)

## At a glance

| Capability | **claude‑in‑arc** (this) | timeoio/claude‑for‑arc | chxsong/Claude‑in‑Arc | Dylanyz/claude‑arc‑patch | stolot0mt0m/native‑messaging |
|---|:--:|:--:|:--:|:--:|:--:|
| Side‑panel chat works in Arc | ✅ | ❓ | ⚠️ | ✅ | ❌ |
| **Page context** preserved (`?tabId=`) | ✅ | ❓ | ⚠️ | ✅ | ❌ |
| Patches **your own freshly‑installed** extension (never stale) | ✅ | ❓ | ❌ | ❌ (bundled copy) | n/a |
| **No‑op on real Chrome/Brave/Edge** (one universal build) | ✅ | ❓ | ❌ | ❌ | n/a |
| **Preserves official extension id** (native messaging stays valid) | ✅ | ❓ | ❌ | ❌ | n/a |
| **Cryptographic authenticity check** before patching | ✅ | ❌ | ❌ | ❌ | ❌ |
| Native‑messaging host setup | ✅ | ❓ | ❌ | partial | ✅ |
| **One‑line remote install** (`curl \| bash`) | ✅ | ❓ | ❌ | ❌ | ❌ |
| Auto‑opens Arc + reveals folder, HIG‑style guidance | ✅ | ❓ | ❌ | ❌ | ❌ |
| **Backup + full rollback** on uninstall | ✅ | ❌ | ❌ | ❌ | partial |
| `doctor` diagnostics | ✅ | ❌ | ❌ | ❌ | ❌ |
| No `sudo`, least‑privilege, documented threat model | ✅ | ❓ | ❌ | ❌ | ⚠️ |
| Automated tests | ✅ (22) | ❌ | ❌ | ❌ | ✅ |
| Zero dependencies | ✅ | ❓ | ❌ | ❌ | shell |

Legend: ✅ yes · ⚠️ partial/inconsistent · ❌ no · ❓ not documented/empty at time of writing. Tests count: 22.

## Head‑to‑head: `claude-in-arc` vs `Dylanyz/claude-arc-patch`

`Dylanyz/claude-arc-patch` deserves real credit — it demonstrated that re‑hosting
the side panel as a popup window works in Arc, and this project builds on that
idea. The comparison below is factual and based on its repository and README at
the time of writing (a JavaScript/HTML repo distributed as a downloadable ZIP,
described by its author as "the latest claude in chrome extension, with a minor
tweak that makes the window a pop‑up," with manual native‑messaging file copying
and a note that it was "made … late at night with claude's help").

| Axis | Dylanyz/claude-arc-patch | claude-in-arc | Why ours is materially better |
|---|---|---|---|
| **Freshness** | Ships a **bundled, hand‑edited copy** of one extension version, frozen at authoring time. | **Auto‑detects and re‑packs the newest copy already installed on your machine.** | Theirs drifts out of date on every Claude release and can fall behind on features/security fixes; ours is current by construction — re‑run `install` after an update. |
| **Universality** | A one‑off popup edit; not designed to be safe on Chrome/Brave/Edge. | `chrome.sidePanel` polyfill is a **no‑op where the real API exists**. | One identical build is safe everywhere; no separate artifacts, no risk of degrading Chrome. |
| **Extension id** | Bundling/editing a copy does not guarantee the official id; not addressed in docs. | **Preserves the official `key`/id**, verified cryptographically. | Keeping the official id means native messaging and the existing allow‑list stay valid **without widening** who can talk to the host. |
| **Authenticity** | None. You trust whatever is in the ZIP. | **Verifies the source key SHA‑256‑hashes to `fcoeoab…` before patching;** aborts otherwise. | You're guaranteed you patched the genuine Anthropic extension, not a tampered bundle. |
| **Install UX** | Manual: download ZIP → unzip → `chrome://extensions` → dev mode → load unpacked. | **One‑line `curl \| bash`** (with inspect‑first), auto‑detect, auto‑open Arc, reveal folder, calm numbered steps. | Far lower friction; only the single Chromium‑mandated click remains, and we walk you through it. |
| **Native messaging** | "Copy this file and rename it… not sure if that is actually needed." | **Detects and mirrors** the host into Arc, merges the official origin, **backs up** any existing file. | Reliable, idempotent, and reversible instead of manual and uncertain. |
| **Reversibility** | No uninstaller; you clean up by hand. | **State‑tracked `uninstall`** restores backups and removes everything we added. | Clean, trustworthy rollback — important for an enterprise/managed Mac. |
| **Diagnostics** | None. | **`doctor`** reports Arc, extension copies (verified), build state, "loaded in Arc?", conflicts, native messaging, and the honest limitation. | Self‑service troubleshooting instead of guesswork. |
| **Two‑Claude conflict** | Not handled. | Detected, with a `--new-id` mode to coexist with the Store copy. | Avoids the confusing "Arc won't load it" dead end. |
| **Observability** | None. | Structured local **logfile**, `--verbose`/`--quiet`. | Debuggable, scriptable, CI‑friendly. |
| **Tests** | None. | **22 automated tests** (patching, verification, path‑safety, backups, rollback, layout). | Confidence the patch is correct and stays correct. |
| **Security posture** | Undocumented; manual steps. | **No `sudo`, least‑privilege, path‑safety guards, documented [threat model](SECURITY.md).** | Safe to recommend broadly, including in managed environments. |
| **Docs & maintenance** | Brief README; single late‑night author. | Product‑grade README + `SECURITY.md`, `COMPARISON.md`, upstream report; contributor‑ready architecture. | Built to be the durable, canonical fix. |

Net: theirs is a clever proof of concept; this is a maintained, verifiable,
reversible product that does the same job and much more — without going stale.

## Notes per project

- **timeoio/claude-for-arc** — At the time of writing the repository had no
  published README or documented solution (effectively empty). We therefore
  can't credit specific functionality; the columns above reflect "not
  documented." Regardless of its eventual approach, the differentiators below
  are what make this project enterprise‑grade.

- **chxsong/Claude-in-Arc** — "Deep patching toolkit to inject the extension
  into Arc's visual structure." Powerful in spirit but brittle: it patches Arc's
  internals rather than the extension, which is fragile across Arc updates and
  is the approach the original requester reported as not working properly.

- **Dylanyz/claude-arc-patch** — Proved the popup‑window approach (credit!), but
  ships a **bundled, hand‑edited copy** of one extension version. It goes stale
  on every Claude update, changes the extension id, and has no verification,
  tests, or rollback.

- **stolot0mt0m/claude-chromium-native-messaging** — Excellent native‑messaging
  analysis and the canonical reference for that piece. It does **not** fix the
  Arc side‑panel UI (it documents the limitation), which is the core thing this
  tool solves.

## Why we're a step above

1. **Freshness by construction.** We re‑pack the official extension *already
   installed on your machine*, picking the newest version — so the patch never
   rots. Re‑run `install` after an update and you're current.
2. **Universality.** The `chrome.sidePanel` polyfill is a no‑op where the real
   API exists, so the same build is safe on Chrome/Brave/Edge too.
3. **Identity preserved.** Keeping the official `key` means the build keeps the
   official id, so native messaging and the existing allow‑list stay valid —
   without widening anything.
4. **Trust & safety.** Cryptographic authenticity verification, a documented
   [threat model](SECURITY.md), no `sudo`, backups, and a clean rollback.
5. **Frictionless.** One‑line `curl | bash` (with an inspect‑first path),
   auto‑opening Arc and revealing the folder, and impeccable, HIG‑aligned next
   steps for the single manual click Chromium requires.
6. **Maintainable.** A tested patch engine (22 tests), `doctor` diagnostics, and
   structured local logs.
7. **Honest.** We never claim to fix Claude Code `/chrome` automation, which is
   blocked by a server‑side feature flag only Anthropic can change. See the
   [upstream report](anthropic-bug-report.md).
