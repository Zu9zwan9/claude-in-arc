/*
 * sidepanel-fallback.ts
 * -----------------------------------------------------------------------------
 * Capability-detected chrome.sidePanel -> popup fallback for the Claude Agent
 * side panel. This is a TypeScript port of the proven logic in the patcher's
 * `claude_in_arc/assets/claude-arc-shim.js` (`openOrFocusPanel`,
 * `PANEL_WINDOW_KEY` / `PANEL_TAB_KEY`, `windows.onRemoved` cleanup).
 *
 * Behaviour (1:1 with the shim):
 *   - On real Chromium (Chrome/Edge/Brave/Vivaldi) `chrome.sidePanel` exists, so
 *     callers use the native Side Panel API and never touch this fallback.
 *   - On Arc (and some Vivaldi builds) `chrome.sidePanel` is absent, so the panel
 *     is recreated as a single reusable always-on-top popup window keyed by tab
 *     id, with its window id persisted in `chrome.storage.session` so it survives
 *     service-worker suspension, and cleaned up on `windows.onRemoved`.
 *
 * M1 scope: this module only opens/focuses the (empty) panel page. No model
 * calls, no page reads, no content scripts.
 * -----------------------------------------------------------------------------
 */

export const PANEL_WINDOW_KEY = "claudeAgent.panelWindowId";
export const PANEL_TAB_KEY = "claudeAgent.panelTabId";

/** Path (relative to the extension root) of the side panel page. */
export const DEFAULT_PANEL_PATH = "sidepanel/index.html";

const POPUP_WIDTH = 480;
const POPUP_HEIGHT = 840;

/** True when the browser implements the native Side Panel API (real Chromium). */
export function hasNativeSidePanel(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof (chrome as { sidePanel?: unknown }).sidePanel !== "undefined"
  );
}

/**
 * Resolve the panel URL path for a given tab. The path encodes `?tabId=` so the
 * panel (in a later milestone) can recover its originating tab's page context,
 * mirroring how the native side panel is opened per-tab.
 */
export function resolvePanelPath(tabId: number | null): string {
  if (tabId != null) {
    return `${DEFAULT_PANEL_PATH}?tabId=${encodeURIComponent(String(tabId))}`;
  }
  return DEFAULT_PANEL_PATH;
}

function hasSession(): boolean {
  return Boolean(
    typeof chrome !== "undefined" && chrome.storage && chrome.storage.session,
  );
}

function sessionGet(keys: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    if (!hasSession()) return resolve({});
    try {
      chrome.storage.session.get(keys, (v) => {
        void chrome.runtime?.lastError;
        resolve((v as Record<string, unknown>) || {});
      });
    } catch {
      resolve({});
    }
  });
}

function sessionSet(obj: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    if (!hasSession()) return resolve();
    try {
      chrome.storage.session.set(obj, () => {
        void chrome.runtime?.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function sessionRemove(keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    if (!hasSession()) return resolve();
    try {
      chrome.storage.session.remove(keys, () => {
        void chrome.runtime?.lastError;
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

function getWindow(id: number): Promise<chrome.windows.Window | null> {
  return new Promise((resolve) => {
    try {
      chrome.windows.get(id, { populate: true }, (win) => {
        if (chrome.runtime?.lastError) return resolve(null);
        resolve(win || null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Open the panel as a popup, or re-focus and re-target the existing popup if one
 * is already open. Keyed by a single persisted window id so repeat clicks focus
 * rather than duplicate. This is the Arc / no-sidePanel code path.
 */
export async function openOrFocusPanel(tabId: number | null): Promise<void> {
  const url = getExtensionUrl(resolvePanelPath(tabId));

  const stored = await sessionGet([PANEL_WINDOW_KEY, PANEL_TAB_KEY]);
  const existingWindowId = stored[PANEL_WINDOW_KEY] as number | undefined;
  const existingTabId = stored[PANEL_TAB_KEY] as number | undefined;

  if (existingWindowId != null) {
    const win = await getWindow(existingWindowId);
    if (win) {
      try {
        let panelTabId = existingTabId;
        if (panelTabId == null && win.tabs && win.tabs[0]) {
          panelTabId = win.tabs[0].id;
        }
        if (panelTabId != null) {
          chrome.tabs.update(panelTabId, { url }, () => {
            void chrome.runtime?.lastError;
          });
        }
        chrome.windows.update(
          existingWindowId,
          { focused: true, drawAttention: true },
          () => {
            void chrome.runtime?.lastError;
          },
        );
        return;
      } catch {
        // fall through to recreate
      }
    }
    // Stale id; clear it.
    await sessionRemove([PANEL_WINDOW_KEY, PANEL_TAB_KEY]);
  }

  await new Promise<void>((resolve) => {
    try {
      chrome.windows.create(
        {
          url,
          type: "popup",
          width: POPUP_WIDTH,
          height: POPUP_HEIGHT,
          focused: true,
        },
        (win) => {
          void chrome.runtime?.lastError;
          if (win && win.id != null) {
            const firstTab = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
            sessionSet({
              [PANEL_WINDOW_KEY]: win.id,
              [PANEL_TAB_KEY]: firstTab,
            }).then(resolve, resolve);
          } else {
            resolve();
          }
        },
      );
    } catch {
      resolve();
    }
  });
}

function getExtensionUrl(path: string): string {
  if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
    return chrome.runtime.getURL(path);
  }
  return path;
}

/**
 * Keep the persisted window id in sync when the user closes the popup, so the
 * next click opens a fresh panel instead of trying to focus a dead window.
 * No-op when the native Side Panel API is present.
 */
export function registerPanelCleanup(): void {
  try {
    if (
      typeof chrome !== "undefined" &&
      chrome.windows &&
      chrome.windows.onRemoved
    ) {
      chrome.windows.onRemoved.addListener((closedId: number) => {
        void sessionGet([PANEL_WINDOW_KEY]).then((s) => {
          if (s[PANEL_WINDOW_KEY] === closedId) {
            void sessionRemove([PANEL_WINDOW_KEY, PANEL_TAB_KEY]);
          }
        });
      });
    }
  } catch {
    /* no-op */
  }
}
