import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PANEL_PATH,
  PANEL_TAB_KEY,
  PANEL_WINDOW_KEY,
  hasNativeSidePanel,
  openOrFocusPanel,
  resolvePanelPath,
} from "../../src/lib/sidepanel-fallback";

/**
 * A minimal fake of the subset of the chrome.* APIs the fallback touches:
 * storage.session (get/set/remove), windows (create/get/update), tabs.update,
 * runtime (getURL/lastError). It records calls so we can assert behaviour.
 */
function makeChrome(opts: { withSidePanel?: boolean } = {}) {
  const session: Record<string, unknown> = {};
  const calls = {
    created: [] as Array<Record<string, unknown>>,
    focused: [] as Array<{ id: number; info: Record<string, unknown> }>,
    tabUpdates: [] as Array<{ tabId: number; info: Record<string, unknown> }>,
  };
  const windowsStore = new Map<
    number,
    { id: number; tabs: Array<{ id: number }> }
  >();
  let nextWindowId = 100;
  let nextTabId = 900;

  const api: Record<string, unknown> = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    storage: {
      session: {
        get: (keys: string[], cb: (v: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {};
          for (const k of keys) if (k in session) out[k] = session[k];
          cb(out);
        },
        set: (obj: Record<string, unknown>, cb: () => void) => {
          Object.assign(session, obj);
          cb();
        },
        remove: (keys: string[], cb: () => void) => {
          for (const k of keys) delete session[k];
          cb();
        },
      },
    },
    tabs: {
      update: (
        tabId: number,
        info: Record<string, unknown>,
        cb: () => void,
      ) => {
        calls.tabUpdates.push({ tabId, info });
        cb();
      },
    },
    windows: {
      onRemoved: { addListener: () => {} },
      create: (
        info: Record<string, unknown>,
        cb: (win: { id: number; tabs: Array<{ id: number }> }) => void,
      ) => {
        const id = nextWindowId++;
        const win = { id, tabs: [{ id: nextTabId++ }] };
        windowsStore.set(id, win);
        calls.created.push(info);
        cb(win);
      },
      get: (
        id: number,
        _info: Record<string, unknown>,
        cb: (
          win: { id: number; tabs: Array<{ id: number }> } | undefined,
        ) => void,
      ) => {
        cb(windowsStore.get(id));
      },
      update: (id: number, info: Record<string, unknown>, cb: () => void) => {
        calls.focused.push({ id, info });
        cb();
      },
    },
  };

  if (opts.withSidePanel) {
    api.sidePanel = { open: () => {}, setOptions: () => {} };
  }

  return { api, session, calls, windowsStore };
}

const g = globalThis as unknown as { chrome?: unknown };

afterEach(() => {
  delete g.chrome;
  vi.restoreAllMocks();
});

describe("resolvePanelPath", () => {
  it("encodes the originating tab id into the panel path", () => {
    expect(resolvePanelPath(123)).toBe(`${DEFAULT_PANEL_PATH}?tabId=123`);
  });

  it("falls back to the bare panel path when there is no tab id", () => {
    expect(resolvePanelPath(null)).toBe(DEFAULT_PANEL_PATH);
  });
});

describe("hasNativeSidePanel", () => {
  it("is true when chrome.sidePanel exists (real Chromium)", () => {
    g.chrome = makeChrome({ withSidePanel: true }).api;
    expect(hasNativeSidePanel()).toBe(true);
  });

  it("is false when chrome.sidePanel is absent (Arc)", () => {
    g.chrome = makeChrome({ withSidePanel: false }).api;
    expect(hasNativeSidePanel()).toBe(false);
  });
});

describe("openOrFocusPanel (popup fallback)", () => {
  it("creates a popup window and persists its window/tab ids", async () => {
    const env = makeChrome();
    g.chrome = env.api;

    await openOrFocusPanel(42);

    expect(env.calls.created).toHaveLength(1);
    const info = env.calls.created[0];
    expect(info.type).toBe("popup");
    expect(String(info.url)).toContain(`${DEFAULT_PANEL_PATH}?tabId=42`);
    // Window + tab ids persisted to session for SW-suspension survival.
    expect(env.session[PANEL_WINDOW_KEY]).toBe(100);
    expect(env.session[PANEL_TAB_KEY]).toBe(900);
  });

  it("focuses and re-targets the existing popup instead of duplicating", async () => {
    const env = makeChrome();
    g.chrome = env.api;

    await openOrFocusPanel(42); // first click -> creates window 100
    await openOrFocusPanel(43); // second click on a new tab -> reuse window 100

    expect(env.calls.created).toHaveLength(1); // not duplicated
    expect(env.calls.focused).toHaveLength(1);
    expect(env.calls.focused[0].id).toBe(100);
    expect(env.calls.focused[0].info.focused).toBe(true);
    // Re-targeted the popup's tab to the new originating tab's panel URL.
    expect(env.calls.tabUpdates).toHaveLength(1);
    expect(String(env.calls.tabUpdates[0].info.url)).toContain("tabId=43");
  });

  it("recreates the popup when the stored window id is stale", async () => {
    const env = makeChrome();
    g.chrome = env.api;

    await openOrFocusPanel(42); // creates window 100
    env.windowsStore.delete(100); // user closed it; storage still has stale id

    await openOrFocusPanel(42); // should create a fresh window

    expect(env.calls.created).toHaveLength(2);
    expect(env.session[PANEL_WINDOW_KEY]).toBe(101);
  });
});
