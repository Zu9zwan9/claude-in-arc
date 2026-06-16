/*
 * sidepanel/sidepanel.ts — side panel UI entry (M1)
 * -----------------------------------------------------------------------------
 * M1 renders a static shell only. There is intentionally no chat logic, no
 * provider calls, and no page capture here yet. This entry exists so the panel
 * loads as an ES module in both the native side panel (Chrome) and the popup
 * fallback (Arc) from one build, and gives later milestones a mount point.
 * -----------------------------------------------------------------------------
 */

function readTabIdFromQuery(): number | null {
  try {
    const raw = new URLSearchParams(globalThis.location?.search ?? "").get(
      "tabId",
    );
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// The originating tab id is carried in the panel URL (?tabId=) by both the
// native side-panel open and the popup fallback. M1 only records it for later
// milestones; it performs no reads.
const originatingTabId = readTabIdFromQuery();
void originatingTabId;

export {};
