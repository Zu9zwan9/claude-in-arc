# End-to-end (Playwright) — later milestones

Per `research/phase-1-scope.md` §5, the e2e layer loads the unpacked build in
Chromium via Playwright (`launchPersistentContext` with
`--load-extension=<dist>`), asserts the side panel renders, and documents a
**manual** Arc smoke test for the popup fallback (Arc cannot be driven headless
and exposes no `chrome.sidePanel`).

M1 keeps tooling dependency-light and does **not** add Playwright yet. The M1
load checks are performed manually (see `agent/README.md` → "Load it"). The
fallback's path / window-id logic that powers the Arc popup is covered by the
Vitest unit test in `../unit/sidepanel-fallback.test.ts`.
