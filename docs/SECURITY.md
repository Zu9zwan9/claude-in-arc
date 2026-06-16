# Security model

`claude-in-arc` runs on your machine, touches a browser extension, and is often
installed via `curl | bash`. That deserves a real threat model. This document
states exactly what the tool does, what it refuses to do, and how to verify it.

## Principles

1. **Least privilege.** Never requires `sudo`. Writes only inside your home
   directory: the build under `~/Library/Application Support/ClaudeInArc/`, the
   PATH symlink under `~/.local/bin` (or `/usr/local/bin` if already writable),
   logs under `~/Library/Logs/claude-in-arc/`, and — only when you ask — the Arc
   native‑messaging manifest under `~/Library/Application Support/Arc/User Data/`.
2. **Integrity first.** The source extension is cryptographically verified to be
   the genuine Anthropic extension before any patching happens.
3. **Reversible.** Every file we overwrite is backed up; a state file records
   what we changed so `uninstall` fully rolls back.
4. **No secrets, no telemetry, no network calls** in the Python tool. The only
   network access is the optional `bootstrap.sh` fetching the repo from GitHub.
5. **Transparent.** Upstream code is copied verbatim; our only additions are a
   shim file, a two‑line loader, and one `<script>` tag per patched page.

## What gets verified

Chromium derives an extension's id from its public `key`. The official Claude
extension's id is `fcoeoabgfenejglbffodgkkbkcdhcgfn`. Before patching, the tool:

- reads the source `manifest.json`,
- base64‑decodes the `key`, SHA‑256 hashes it, and maps the first 16 bytes to
  the Chromium id alphabet, and
- **aborts** unless the computed id equals `fcoeoabgfenejglbffodgkkbkcdhcgfn`.

This means pointing `--source` at a tampered or look‑alike extension fails
loudly ("Aborting for your safety"). Override only with `--allow-unverified`,
and only for a `--source` you fully trust.

`doctor` re‑verifies every discovered copy and labels it `[verified]`.

## Threat model

| Threat | Mitigation |
|--------|------------|
| **Malicious / tampered source extension** | Public‑key → id verification; refuses to patch anything that isn't the official id. |
| **Supply‑chain via `curl \| bash`** | Documented inspect‑first alternative (download, read, run). Bootstrap is short, audited, sudo‑free, writes only to `$HOME`, and pins repo + branch. No piping into a root shell. |
| **Privilege escalation** | No `sudo` anywhere. All paths are under the user's home. |
| **Path traversal / clobbering unrelated files** | `_assert_within()` guards every destructive op: the build dir must live under the managed `ClaudeInArc/` root, or the tool refuses. |
| **Destroying a pre‑existing native‑messaging manifest** | Any existing manifest is backed up to `*.claude-in-arc.bak` before overwrite; `uninstall` restores it. |
| **Leaving junk behind** | A `state.json` tracks every change; `uninstall` removes the build, restores/removes the manifest, deletes state, and prunes empty dirs. |
| **Silent data exfiltration / telemetry** | None. The Python tool makes no network calls; logs are local and contain no secrets. |
| **Extension gaining new powers via the patch** | The patch adds **zero** permissions. See below. |

## Permissions: what the patched extension keeps and why

The patched build keeps **exactly** the permissions Anthropic's extension already
declares (e.g. `sidePanel`, `storage`, `activeTab`, `scripting`, `tabs`,
`nativeMessaging`, `<all_urls>` host access). We do **not** add or broaden any
permission. The only code we introduce is:

- `claude-arc-shim.js` — a `chrome.sidePanel` polyfill that opens the panel as a
  popup window using `chrome.windows.create` (no new permission required) and is
  a **no‑op when the real `chrome.sidePanel` exists** (Chrome/Brave/Edge).
- `arc-sw-loader.js` — two `import` lines that load the shim, then the original
  service worker, unchanged.
- one `<script src="claude-arc-shim.js">` tag injected at the top of
  `options.html` and `sidepanel.html`.

Because we keep the official `key`, the build has the **same id** as the Store
extension, so the existing native‑messaging allow‑list stays valid (no widening
of who can talk to the native host). The `--new-id` mode drops the key to create
a coexisting build; that build simply isn't recognized by the official native
host unless you link it explicitly.

## Verifying the build yourself

```bash
# Inspect every change we made relative to the upstream extension:
diff -ru "$(claude-in-arc doctor | … source path …)" \
         "~/Library/Application Support/ClaudeInArc/Claude-in-Arc-Extension"
# You should see ONLY: claude-arc-shim.js (added), arc-sw-loader.js (added),
# CLAUDE_IN_ARC_PATCH.json (added), manifest.json (service_worker repointed),
# options.html / sidepanel.html (one <script> tag added).
```

The patch marker `CLAUDE_IN_ARC_PATCH.json` records the source version and
exactly which files were modified.

## Reporting a vulnerability

Open a private security advisory on the GitHub repo, or email the maintainer
listed in `.github/FUNDING.yml`. Please do not file public issues for security
reports until a fix is available.
