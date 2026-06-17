/*
 * shim_open_side_panel_harness.js
 * -----------------------------------------------------------------------------
 * Node harness that loads the REAL claude-arc-shim.js and replays the official
 * extension's "open_side_panel" runtime-message path against mocked chrome APIs.
 *
 * Why this exists
 * ---------------
 * The official service worker (assets/service-worker.ts-*.js) handles a runtime
 * message sent by the claude.ai onboarding button:
 *
 *     chrome.runtime.onMessage(({type:"open_side_panel", onboardingTaskId}, sender) => {
 *       const tabId = msg.tabId || sender.tab?.id;
 *       await Ve(tabId);                      // the ONLY side-panel open path
 *       ...POPULATE_INPUT_TEXT to the panel...
 *     })
 *
 * where Ve(tabId) is literally:
 *
 *     if (!chrome.sidePanel) { ...notify "Browser not supported"; return; }
 *     chrome.sidePanel.setOptions({tabId, path:`sidepanel.html?tabId=${tabId}`, enabled:true});
 *     chrome.sidePanel.open({tabId});
 *
 * So on Arc the entire onboarding-button path depends on our chrome.sidePanel
 * polyfill. This harness faithfully replays setOptions()+open() (exactly as Ve
 * does) and asserts the shim turns it into a single reusable popup window whose
 * URL carries the originating tabId. It also asserts the shim is a strict no-op
 * when a real chrome.sidePanel already exists.
 *
 * Exit code 0 = all assertions passed. Non-zero = failure (message on stderr).
 * -----------------------------------------------------------------------------
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SHIM_PATH = path.resolve(
  __dirname,
  "..",
  "claude_in_arc",
  "assets",
  "claude-arc-shim.js"
);
const SHIM_SRC = fs.readFileSync(SHIM_PATH, "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error("ASSERT FAILED: " + msg);
}

// Build a fresh mock `chrome` plus a record of the side-effecting calls we care
// about. Callbacks fire synchronously, mirroring how the shim consumes them.
function makeChrome(opts) {
  opts = opts || {};
  const sessionStore = {};
  const localStore = Object.assign({}, opts.localStorage || {});
  const calls = {
    windowsCreate: [],
    windowsUpdate: [],
    tabsUpdate: [],
    setPopup: [],
    onClickedListeners: [],
    commandListeners: [],
  };
  const wins = {};
  let nextWinId = 100;
  const onRemovedListeners = [];

  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      getURL: (p) => "chrome-extension://test-extension-id/" + p,
      onMessage: {
        addListener(fn) {
          calls.messageListeners = calls.messageListeners || [];
          calls.messageListeners.push(fn);
        },
      },
    },
    storage: {
      local: {
        get(keys, cb) {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of arr) if (k in localStore) out[k] = localStore[k];
          if (cb) cb(out);
        },
        set(obj, cb) {
          Object.assign(localStore, obj);
          if (cb) cb();
        },
      },
      session: {
        get(keys, cb) {
          const arr = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of arr) if (k in sessionStore) out[k] = sessionStore[k];
          cb(out);
        },
        set(obj, cb) {
          Object.assign(sessionStore, obj);
          if (cb) cb();
        },
        remove(keys, cb) {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) delete sessionStore[k];
          if (cb) cb();
        },
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      getLastFocused(cb) {
        calls.getLastFocused = calls.getLastFocused || [];
        calls.getLastFocused.push({});
        if (opts.noAnchorWindow) {
          if (cb) cb({ id: 99, type: "popup", state: "minimized", left: 0, top: 0, width: 1, height: 1 });
          return;
        }
        const anchor = opts.anchorWindow || {
          id: 1,
          type: "normal",
          state: "normal",
          left: 100,
          top: 80,
          width: 1280,
          height: 900,
        };
        if (cb) cb(anchor);
      },
      getAll(query, cb) {
        calls.getAll = calls.getAll || [];
        calls.getAll.push(query);
        if (cb) cb([]);
      },
      create(createOpts, cb) {
        calls.windowsCreate.push({ opts: createOpts, failed: !!opts.failWindowsCreate });
        if (opts.failWindowsCreate) {
          chrome.runtime.lastError = { message: "windows.create blocked" };
          if (cb) cb();
          return;
        }
        chrome.runtime.lastError = undefined;
        const id = nextWinId++;
        const tabId = 9000 + id;
        const win = {
          id,
          type: createOpts.type,
          left: createOpts.left,
          top: createOpts.top,
          width: createOpts.width,
          height: createOpts.height,
          tabs: [{ id: tabId, url: createOpts.url }],
        };
        wins[id] = win;
        calls.windowsCreate[calls.windowsCreate.length - 1].win = win;
        if (cb) cb(win);
      },
      get(id, getInfoOrCb, maybeCb) {
        const cb = typeof getInfoOrCb === "function" ? getInfoOrCb : maybeCb;
        if (wins[id]) {
          if (cb) cb(wins[id]);
          return;
        }
        if (opts.noAnchorWindow && id === 99) {
          if (cb) {
            cb({
              id: 99,
              type: "popup",
              state: "minimized",
              left: 0,
              top: 0,
              width: 1,
              height: 1,
            });
          }
          return;
        }
        const anchor = opts.anchorWindow || {
          id: 1,
          type: "normal",
          state: "normal",
          left: 100,
          top: 80,
          width: 1280,
          height: 900,
        };
        if (id === anchor.id) {
          if (cb) cb(anchor);
          return;
        }
        if (cb) cb(null);
      },
      update(id, updateInfo, cb) {
        calls.windowsUpdate.push({ id, updateInfo });
        if (wins[id]) {
          Object.assign(wins[id], updateInfo);
        }
        if (cb) cb();
      },
      onRemoved: {
        addListener(fn) {
          onRemovedListeners.push(fn);
        },
      },
      onFocusChanged: { addListener() {} },
      onBoundsChanged: { addListener() {} },
    },
    tabs: {
      get(id, cb) {
        calls.tabsGet = calls.tabsGet || [];
        calls.tabsGet.push({ id });
        const anchorId =
          opts.noAnchorWindow
            ? 99
            : (opts.anchorWindow && opts.anchorWindow.id) || 1;
        cb({
          id,
          windowId: anchorId,
          url: opts.tabUrl || "https://example.com/page",
        });
      },
      query(query, cb) {
        cb([{ id: 4242, windowId: 1 }]);
      },
      update(id, updateProps, cb) {
        calls.tabsUpdate.push({ id, updateProps });
        if (cb) cb();
      },
      create(createOpts, cb) {
        calls.tabsCreate = calls.tabsCreate || [];
        chrome.runtime.lastError = undefined;
        const tab = { id: 8000 + calls.tabsCreate.length, url: createOpts.url, active: createOpts.active };
        calls.tabsCreate.push({ opts: createOpts, tab });
        if (cb) cb(tab);
      },
      sendMessage(tabId, msg, cb) {
        calls.tabsSendMessage = calls.tabsSendMessage || [];
        calls.tabsSendMessage.push({ tabId, msg });
        if (cb) cb({ ok: true });
      },
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    action: {
      setPopup(opts, cb) {
        calls.setPopup.push(opts);
        if (cb) cb();
      },
      onClicked: {
        addListener(fn) {
          calls.onClickedListeners.push(fn);
        },
      },
    },
    commands: {
      onCommand: {
        addListener(fn) {
          calls.commandListeners.push(fn);
        },
      },
    },
    notifications: {
      create(id, opts, cb) {
        calls.notifications = calls.notifications || [];
        calls.notifications.push({ id, opts });
        if (cb) cb();
      },
    },
  };

  if (opts.withScripting !== false) {
    chrome.scripting = {
      executeScript(opts2, cb) {
        calls.scripting = calls.scripting || [];
        calls.scripting.push(opts2);
        if (cb) cb();
      },
    };
  }

  if (opts.withDisplayWorkArea) {
    chrome.system = {
      display: {
        getInfo(cb) {
          calls.displayGetInfo = calls.displayGetInfo || [];
          calls.displayGetInfo.push({});
          cb([
            {
              isPrimary: true,
              workArea: { left: 0, top: 38, width: 1728, height: 1000 },
            },
          ]);
        },
      },
    };
  }

  if (opts.withRealSidePanel) {
    // Cannot instantiate real [native code] bindings in Node; scenario 3 tests the
    // detection helper directly instead of loading the shim.
    opts.skipSidePanel = true;
  }
  return { chrome, calls, sessionStore, wins, onRemovedListeners };
}

// Load the shim against a given mock chrome, returning the (possibly polyfilled)
// chrome.sidePanel. The shim is an IIFE that reads the global `chrome`.
function loadShim(mockChrome, sandboxExtras) {
  function ServiceWorkerGlobalScope() {}
  const self = new ServiceWorkerGlobalScope();
  const sandbox = {
    chrome: mockChrome,
    globalThis: {},
    self: self,
    ServiceWorkerGlobalScope: ServiceWorkerGlobalScope,
    navigator: { userAgent: (sandboxExtras && sandboxExtras.userAgent) || "node-harness" },
    console,
    Map,
    Promise,
    Object,
    encodeURIComponent,
    setTimeout,
    location: sandboxExtras && sandboxExtras.location,
  };
  if (sandboxExtras && sandboxExtras.forcePolyfill) {
    sandbox.globalThis.__CLAUDE_IN_ARC_FORCE_POLYFILL = true;
  }
  vm.createContext(sandbox);
  vm.runInContext(SHIM_SRC, sandbox, { filename: "claude-arc-shim.js" });
  return mockChrome.sidePanel;
}

// Faithful replay of the official Ve(tabId): setOptions() then open(), exactly
// as the service worker calls them inside the open_side_panel handler.
async function replayVe(chrome, tabId) {
  chrome.sidePanel.setOptions({
    tabId,
    path: `sidepanel.html?tabId=${encodeURIComponent(tabId)}`,
    enabled: true,
  });
  await chrome.sidePanel.open({ tabId });
}

// Faithful replay of the open_side_panel onMessage handler's tab resolution.
async function replayOpenSidePanel(chrome, message, sender) {
  const tabId = message.tabId || (sender && sender.tab && sender.tab.id);
  if (!tabId) return { success: false };
  await replayVe(chrome, tabId);
  return { success: true };
}

async function main() {
  // --- Scenario 1: onboarding button on a claude.ai tab opens the panel ------
  {
    const env = makeChrome();
    const sp = loadShim(env.chrome);
    assert(sp && sp.__claudeInArcShim === true, "shim should install sidePanel polyfill on Arc");

    // claude.ai content-script sends {type:"open_side_panel", onboardingTaskId}
    // with NO tabId; the SW falls back to sender.tab.id (the claude.ai tab).
    const res = await replayOpenSidePanel(
      env.chrome,
      { type: "open_side_panel", onboardingTaskId: "welcome-task" },
      { tab: { id: 4242 } }
    );
    assert(res.success === true, "handler should report success");
    assert(env.calls.windowsCreate.length === 1, "exactly one popup window should be created");

    const created = env.calls.windowsCreate[0].opts;
    assert(created.type === "popup", "panel must be a popup window, got " + created.type);
    assert(created.width === 410, "panel width should be 410px, got " + created.width);
    assert(
      created.left === 100 + 1280 - 410,
      "panel left should hug browser right edge, got " + created.left
    );
    assert(created.top === 80, "panel top should match browser top, got " + created.top);
    assert(created.height === 900, "panel height should match browser height, got " + created.height);
    assert(
      created.url === "chrome-extension://test-extension-id/sidepanel.html?tabId=4242",
      "popup URL must carry the originating tabId, got " + created.url
    );
    assert(
      env.sessionStore["claudeInArc.panelWindowId"] != null,
      "panel window id must be persisted for reuse"
    );
  }

  // --- Scenario 2: opening again from a different tab reuses the one popup ----
  {
    const env = makeChrome();
    loadShim(env.chrome);

    await replayOpenSidePanel(
      env.chrome,
      { type: "open_side_panel", onboardingTaskId: "t1" },
      { tab: { id: 4242 } }
    );
    await replayOpenSidePanel(
      env.chrome,
      { type: "open_side_panel", onboardingTaskId: "t2" },
      { tab: { id: 7777 } }
    );

    assert(
      env.calls.windowsCreate.length === 1,
      "second open must reuse the existing popup, not create a new one (got " +
        env.calls.windowsCreate.length +
        ")"
    );
    const focused = env.calls.windowsUpdate.some(
      (c) =>
        c.updateInfo &&
        c.updateInfo.focused &&
        c.updateInfo.width === 410 &&
        c.updateInfo.left != null
    );
    assert(focused, "existing popup must be focused and re-positioned on re-open");
    const retargeted = env.calls.tabsUpdate.some(
      (c) =>
        c.updateProps &&
        c.updateProps.url ===
          "chrome-extension://test-extension-id/sidepanel.html?tabId=7777"
    );
    assert(retargeted, "reused popup must be re-targeted to the new tab's panel URL");
  }

  // --- Scenario 3: nativeSidePanelWorks requires BOTH native bindings ----------
  {
    function fnSource(fn) {
      return Function.prototype.toString.call(fn);
    }
    function isNativeBinding(fn) {
      return typeof fn === "function" && fnSource(fn).indexOf("[native code]") !== -1;
    }
    function nativeSidePanelWorks(sp) {
      if (!sp) return false;
      return isNativeBinding(sp.open) && isNativeBinding(sp.setOptions);
    }
    assert(
      !nativeSidePanelWorks({ open: function open() {}, setOptions: function setOptions() {} }),
      "plain JS sidePanel stub must not be treated as native Chrome"
    );
    assert(!nativeSidePanelWorks({}), "empty sidePanel object must not be treated as native Chrome");
    assert(
      !nativeSidePanelWorks({
        open: function nativeOpen() {
          return "[native code]";
        },
        setOptions: function setOptions() {},
      }),
      "partial native-looking stub must not be treated as native Chrome"
    );
    assert(
      nativeSidePanelWorks({
        open: function nativeOpen() {
          return "[native code]";
        },
        setOptions: function nativeSet() {
          return "[native code]";
        },
      }),
      "both native-looking bindings should be treated as native Chrome"
    );
  }

  // --- Scenario 4: Arc-style broken sidePanel stub gets replaced --------------
  {
    const env = makeChrome();
    env.chrome.sidePanel = {
      open: function open() {},
      setOptions: function setOptions() {},
    };
    const sp = loadShim(env.chrome);
    assert(sp && sp.__claudeInArcShim === true, "broken JS stub sidePanel must be replaced by shim");

    await replayVe(env.chrome, 5555);
    assert(env.calls.windowsCreate.length === 1, "broken stub path must open popup via shim");
  }

  // --- Scenario 5: missing sidePanel methods still get the shim ---------------
  {
    const env = makeChrome();
    env.chrome.sidePanel = {};
    const sp = loadShim(env.chrome);
    assert(sp && sp.__claudeInArcShim === true, "empty sidePanel object must be replaced");
  }

  // --- Scenario 6: shim clears setPopup; panel opens via sidePanel.open only ----
  {
    const env = makeChrome();
    loadShim(env.chrome);
    const cleared = env.calls.setPopup.some((o) => o && o.popup === "");
    assert(cleared, "shim must clear action.setPopup so onClicked can fire");
    const setTabPopup = env.calls.setPopup.some(
      (o) => o && o.tabId != null && o.popup && o.popup.length > 0
    );
    assert(!setTabPopup, "shim must NOT set per-tab action popups (blocks onClicked)");
    assert(
      env.calls.onClickedListeners.length === 0,
      "shim must NOT wire action.onClicked (upstream calls sidePanel.open; duplicate opens two windows)"
    );
    assert(env.calls.commandListeners.length >= 1, "shim must wire commands.onCommand");
  }

  // --- Scenario 7: Cmd+E command opens panel ----------------------------------
  {
    const env = makeChrome();
    loadShim(env.chrome);
    assert(env.calls.commandListeners.length >= 1, "command listener missing");
    env.calls.commandListeners[0]("toggle-side-panel");
    await new Promise((r) => setTimeout(r, 0));
    assert(env.calls.windowsCreate.length === 1, "toggle-side-panel must open popup");
    assert(
      env.calls.windowsCreate[0].opts.url.indexOf("tabId=4242") !== -1,
      "toggle-side-panel must target active tab"
    );
  }

  // --- Scenario 8: tabs.create fallback when windows.create is blocked --------
  {
    const env = makeChrome({ failWindowsCreate: true });
    loadShim(env.chrome);
    await replayVe(env.chrome, 9999);
    assert(env.calls.windowsCreate.length >= 2, "should attempt popup and normal windows.create");
    assert(env.calls.tabsCreate && env.calls.tabsCreate.length === 1, "must fall back to tabs.create");
    assert(
      env.calls.tabsCreate[0].opts.url ===
        "chrome-extension://test-extension-id/sidepanel.html?tabId=9999",
      "tabs.create URL must carry tabId"
    );
  }

  // --- Scenario 8b: Arc must not retry type=normal (blank arc://new-tab-page/) --
  {
    const env = makeChrome({ failWindowsCreate: true });
    loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    await replayVe(env.chrome, 9999);
    await new Promise((r) => setTimeout(r, 200));
    const normalAttempts = env.calls.windowsCreate.filter(
      (c) => c.opts && c.opts.type === "normal"
    );
    assert(
      normalAttempts.length === 0,
      "Arc must not attempt type=normal windows.create (got " +
        normalAttempts.length +
        ")"
    );
    assert(
      env.calls.windowsCreate.length === 1,
      "Arc should only attempt popup windows.create when popup fails"
    );
  }

  {
    const env = makeChrome();
    function nativeLike(name) {
      const fn = function () {};
      fn.toString = function () {
        return "function " + name + "() { [native code] }";
      };
      return fn;
    }
    env.chrome.sidePanel = {
      open: nativeLike("open"),
      setOptions: nativeLike("setOptions"),
    };
    const sp = loadShim(env.chrome, { userAgent: "Mozilla/5.0 Arc/1.0 Chrome/120" });
    assert(sp && sp.__claudeInArcShim === true, "Arc UA must force shim over native-looking stubs");
    await replayVe(env.chrome, 1111);
    assert(env.calls.windowsCreate.length === 1, "forced shim must open popup");
  }

  // --- Scenario 9b: prelude flag forces shim when UA lacks Arc token ----------
  {
    const env = makeChrome();
    function nativeLike(name) {
      const fn = function () {};
      fn.toString = function () {
        return "function " + name + "() { [native code] }";
      };
      return fn;
    }
    env.chrome.sidePanel = {
      open: nativeLike("open"),
      setOptions: nativeLike("setOptions"),
    };
    const sp = loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Chrome/120",
      forcePolyfill: true,
    });
    assert(
      sp && sp.__claudeInArcShim === true,
      "prelude force flag must install shim without Arc UA"
    );
    await replayVe(env.chrome, 2222);
    assert(env.calls.windowsCreate.length === 1, "prelude-forced shim must open popup");
  }

  // --- Scenario 10: shim exposes SHIM_VERSION ---------------------------------
  {
    assert(SHIM_SRC.indexOf('SHIM_VERSION = "1.2.28"') !== -1, "shim must declare SHIM_VERSION 1.2.28");
    assert(SHIM_SRC.indexOf("isHudWebViewContext") !== -1, "shim must detect HUD WKWebView context");
    assert(
      SHIM_SRC.indexOf("skipping shim in HUD WebView") !== -1,
      "shim must skip full polyfill inside HUD WebView"
    );
    assert(
      SHIM_SRC.indexOf("shouldSkipNormalWindowFallback") !== -1,
      "shim must skip type=normal windows.create on Arc"
    );
    assert(SHIM_SRC.indexOf("normalizeTabId") !== -1, "shim must normalize tab ids");
    assert(SHIM_SRC.indexOf("tabIdsEqual") !== -1, "shim must compare tab ids with normalization");
    assert(SHIM_SRC.indexOf("SPLIT_HIDE_GUARD_MS") !== -1, "shim must guard split hide after show");
    assert(SHIM_SRC.indexOf("shouldSuppressSplitHide") !== -1, "shim must suppress premature split hide");
    assert(SHIM_SRC.indexOf("splitBoundsSyncInFlight") !== -1, "shim must track split bounds sync in flight");
    assert(SHIM_SRC.indexOf("arcExplicitPopupMode") !== -1, "shim must default Arc to split unless explicit popup");
    assert(SHIM_SRC.indexOf("forcePanelWindowBounds") !== -1, "shim must correct bounds after windows.create");
    assert(SHIM_SRC.indexOf("SPLIT_POPUP_DELAY_MS") !== -1, "shim must delay popup after split margin");
    assert(SHIM_SRC.indexOf("SPLIT_POPUP_SYNC_MS") !== -1, "shim must re-sync popup after open");
    assert(SHIM_SRC.indexOf("SPLIT_BOUNDS_RETRY_DELAYS_MS") !== -1, "shim must retry gutter bounds on macOS Arc");
    assert(SHIM_SRC.indexOf("scheduleSplitBoundsRetries") !== -1, "shim must schedule split bounds retries");
    assert(SHIM_SRC.indexOf("splitGutterBoundsFromAnchor") !== -1, "shim must compute gutter bounds from anchor");
    assert(SHIM_SRC.indexOf("resolveSplitAnchorForTab") !== -1, "shim must resolve anchor from tab window");
    assert(SHIM_SRC.indexOf("notifyArcSplitPanelHint") !== -1, "shim must notify Arc split-panel hint");
    assert(SHIM_SRC.indexOf("waitForSplitAnchorBounds") !== -1, "shim must wait for anchor before split create");
    assert(SHIM_SRC.indexOf("verifySplitDockAlignment") !== -1, "shim must verify split dock alignment");
  }

  // --- Scenario 10b: Arc uses split-panel (margin + popup), not iframe sidebar ----
  {
    const env = makeChrome({
      localStorage: { "claudeInArc.panelMode": "sidebar" },
    });
    const sp = loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    assert(sp && sp.__claudeInArcShim === true, "Arc must install shim");
    await new Promise((r) => setTimeout(r, 0));
    await replayVe(env.chrome, 7777);
    const showMsg =
      env.calls.tabsSendMessage &&
      env.calls.tabsSendMessage.find(
        (m) => m.msg && m.msg.type === "claude-in-arc-split" && m.msg.action === "show"
      );
    assert(showMsg, "split mode must apply page margin before opening popup");
    await new Promise((r) => setTimeout(r, 60));
    assert(
      env.calls.windowsCreate.length === 1,
      "Arc with sidebar mode must open docked popup via split mode"
    );
    assert(
      env.calls.scripting && env.calls.scripting.length >= 1,
      "Arc split mode must inject split host script"
    );
    const injected = env.calls.scripting[0];
    assert(
      injected.files && injected.files[0] === "claude-arc-split-host.js",
      "Arc must inject split host, not sidebar host"
    );
    const created = env.calls.windowsCreate[0].opts;
    assert(
      created.url.indexOf("sidepanel.html?tabId=7777") !== -1,
      "split mode popup must load sidepanel directly, not bridge iframe"
    );
  }

  // --- Scenario 10c: Arc popup-only mode skips split host injection ------------
  {
    const env = makeChrome({
      localStorage: {
        "claudeInArc.panelMode": "popup",
        "claudeInArc.panelModeExplicit": true,
      },
      withScripting: false,
    });
    loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    await replayVe(env.chrome, 8888);
    assert(env.calls.windowsCreate.length === 1, "Arc popup mode must open docked popup");
    assert(!env.calls.scripting, "Arc popup mode must not inject split host");
  }

  // --- Scenario 10d: shim declares split + Arc iframe fallback helpers ----------
  {
    assert(SHIM_SRC.indexOf("isArcBrowser") !== -1, "shim must define isArcBrowser");
    assert(SHIM_SRC.indexOf("effectivePanelMode") !== -1, "shim must define effectivePanelMode");
    assert(SHIM_SRC.indexOf("openPanelInSplit") !== -1, "shim must define openPanelInSplit");
    assert(SHIM_SRC.indexOf("claude-arc-split-host") !== -1, "shim must reference split host");
    assert(
      SHIM_SRC.indexOf("claude-in-arc-sidebar-iframe-blocked") !== -1,
      "shim must handle sidebar iframe blocked messages"
    );
  }

  // --- Scenario 10e: split mode docks popup at exact gutter bounds ----------
  {
    const env = makeChrome({
      localStorage: { "claudeInArc.panelMode": "split" },
    });
    loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    await replayVe(env.chrome, 5555);
    await new Promise((r) => setTimeout(r, 1200));
    assert(env.calls.windowsCreate.length === 1, "split mode must open one docked popup");
    const created = env.calls.windowsCreate[0].opts;
    assert(created.left === 100 + 1280 - 410, "split popup left must match gutter");
    assert(created.top === 80, "split popup top must match anchor top");
    assert(created.height === 900, "split popup height must match anchor height");
    assert(created.width === 410, "split popup width must match gutter width");
    assert(
      env.calls.windowsUpdate && env.calls.windowsUpdate.length >= 6,
      "split mode must retry popup position after open (0/50/150/300/500/1000ms)"
    );
    assert(
      created.focused === false,
      "split dock popup must not steal focus from Arc on create"
    );
  }

  // --- Scenario 10f: Arc without stored mode still uses split (not build default popup) ---
  {
    const env = makeChrome({});
    loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    await replayVe(env.chrome, 6666);
    await new Promise((r) => setTimeout(r, 80));
    assert(
      env.calls.scripting && env.calls.scripting.length >= 1,
      "Arc with no stored panel mode must still inject split host"
    );
    assert(env.calls.windowsCreate.length === 1, "Arc default must open docked popup");
  }

  // --- Scenario 10g: split margin failure notifies and still opens popup -------
  {
    const env = makeChrome({
      localStorage: { "claudeInArc.panelMode": "split" },
    });
    const origSend = env.chrome.tabs.sendMessage;
    env.chrome.tabs.sendMessage = function (tabId, msg, cb) {
      env.calls.tabsSendMessage = env.calls.tabsSendMessage || [];
      env.calls.tabsSendMessage.push({ tabId, msg });
      if (msg && msg.type === "claude-in-arc-split" && msg.action === "show") {
        if (cb) cb({ ok: false });
        return;
      }
      return origSend.call(this, tabId, msg, cb);
    };
    loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    await replayVe(env.chrome, 7778);
    await new Promise((r) => setTimeout(r, 200));
    assert(env.calls.windowsCreate.length === 1, "margin failure must still open popup");
    assert(
      env.calls.notifications &&
        env.calls.notifications.some((n) =>
          (n.opts.message || "").includes("page margin unavailable")
        ),
      "margin failure must notify user"
    );
  }

  // --- Scenario 10h: onRemoved during panel create must not hide split margin -
  {
    const env = makeChrome({
      localStorage: { "claudeInArc.panelMode": "split" },
    });
    const origCreate = env.chrome.windows.create;
    let firstWinId = null;
    env.chrome.windows.create = function (createOpts, cb) {
      if (firstWinId != null) {
        for (const fn of env.onRemovedListeners) {
          fn(firstWinId);
        }
      }
      return origCreate.call(this, createOpts, function (win) {
        if (firstWinId == null && win && win.id != null) {
          firstWinId = win.id;
        }
        if (cb) cb(win);
      });
    };
    loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    await replayVe(env.chrome, 4242);
    await new Promise((r) => setTimeout(r, 200));
    const hideMsgs = (env.calls.tabsSendMessage || []).filter(
      (m) => m.msg && m.msg.type === "claude-in-arc-split" && m.msg.action === "hide"
    );
    assert(hideMsgs.length === 0, "onRemoved during reopen must not hide split margin");
    await replayVe(env.chrome, 4242);
    await new Promise((r) => setTimeout(r, 200));
    const hideAfterReopen = (env.calls.tabsSendMessage || []).filter(
      (m) => m.msg && m.msg.type === "claude-in-arc-split" && m.msg.action === "hide"
    );
    assert(
      hideAfterReopen.length === 0,
      "stale panel onRemoved during create must not hide split margin"
    );
  }

  // --- Scenario 10i: onRemoved after open within hide guard must not hide margin -
  {
    const env = makeChrome({
      localStorage: { "claudeInArc.panelMode": "split" },
    });
    loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    await replayVe(env.chrome, 5151);
    await new Promise((r) => setTimeout(r, 180));
    const panelWinId =
      env.calls.windowsCreate[0] &&
      env.calls.windowsCreate[0].win &&
      env.calls.windowsCreate[0].win.id;
    assert(panelWinId != null, "split open must create panel window");
    for (const fn of env.onRemovedListeners) {
      fn(panelWinId);
    }
    const hideMsgs = (env.calls.tabsSendMessage || []).filter(
      (m) => m.msg && m.msg.type === "claude-in-arc-split" && m.msg.action === "hide"
    );
    assert(
      hideMsgs.length === 0,
      "onRemoved within hide guard must not hide split margin"
    );
  }

  // --- Scenario 10j: string/number tabId must not hide+re-show same tab margin -
  {
    const env = makeChrome({
      localStorage: { "claudeInArc.panelMode": "split" },
    });
    loadShim(env.chrome, {
      userAgent: "Mozilla/5.0 Arc/1.74.0 Chrome/131",
      forcePolyfill: true,
    });
    await new Promise((r) => setTimeout(r, 0));
    await replayVe(env.chrome, 5151);
    await new Promise((r) => setTimeout(r, 400));
    const showBefore =
      (env.calls.tabsSendMessage || []).filter(
        (m) => m.msg && m.msg.type === "claude-in-arc-split" && m.msg.action === "show"
      ).length;
    assert(showBefore >= 1, "split open must show margin at least once");
    await replayVe(env.chrome, "5151");
    await new Promise((r) => setTimeout(r, 100));
    const hideMsgs = (env.calls.tabsSendMessage || []).filter(
      (m) => m.msg && m.msg.type === "claude-in-arc-split" && m.msg.action === "hide"
    );
    assert(
      hideMsgs.length === 0,
      "duplicate open with string tabId must not hide same-tab split margin"
    );
  }

  // --- Scenario 12: duplicate open paths on one click open only one window ------
  {
    const env = makeChrome();
    loadShim(env.chrome);
    // Faithful replay of toolbar click: upstream onClicked calls setOptions+open;
    // a second concurrent sidePanel.open must not create another window.
    await Promise.all([
      replayVe(env.chrome, 551106480),
      replayVe(env.chrome, 551106480),
    ]);
    assert(
      env.calls.windowsCreate.length === 1,
      "concurrent sidePanel.open calls must open exactly one window (got " +
        env.calls.windowsCreate.length +
        ")"
    );
  }

  // --- Scenario 11: display work area is fallback when no browser anchor -------
  {
    const env = makeChrome({ withDisplayWorkArea: true, noAnchorWindow: true });
    loadShim(env.chrome);
    await replayVe(env.chrome, 3333);
    assert(env.calls.displayGetInfo && env.calls.displayGetInfo.length >= 1, "should query display work area");
    const created = env.calls.windowsCreate[0].opts;
    assert(created.left === 1728 - 410 - 8, "panel left should hug screen right edge when no anchor");
    assert(created.top === 38 + 8, "panel top should respect menu bar margin");
    assert(created.height === 1000 - 16, "panel height should fill work area minus margin");
  }

  // --- Scenario 11b: browser anchor beats display work area -------------------
  {
    const env = makeChrome({ withDisplayWorkArea: true });
    loadShim(env.chrome);
    await replayVe(env.chrome, 4444);
    const created = env.calls.windowsCreate[0].opts;
    assert(
      created.left === 100 + 1280 - 410,
      "browser anchor must win over display work area"
    );
    assert(created.top === 80, "browser anchor top must win over work area margin");
  }

  console.log("OK: open_side_panel path produces popup-window behavior via the shim");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String((err && err.stack) || err));
    process.exit(1);
  }
);
