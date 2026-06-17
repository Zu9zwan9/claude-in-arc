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
          tabs: [{ id: tabId, url: createOpts.url }],
        };
        wins[id] = win;
        calls.windowsCreate[calls.windowsCreate.length - 1].win = win;
        if (cb) cb(win);
      },
      get(id, getInfo, cb) {
        cb(wins[id] || null);
      },
      update(id, updateInfo, cb) {
        calls.windowsUpdate.push({ id, updateInfo });
        if (cb) cb();
      },
      onRemoved: { addListener() {} },
    },
    tabs: {
      query(query, cb) {
        cb([{ id: 4242 }]);
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

  if (opts.withRealSidePanel) {
    // Cannot instantiate real [native code] bindings in Node; scenario 3 tests the
    // detection helper directly instead of loading the shim.
    opts.skipSidePanel = true;
  }
  return { chrome, calls, sessionStore, wins };
}

// Load the shim against a given mock chrome, returning the (possibly polyfilled)
// chrome.sidePanel. The shim is an IIFE that reads the global `chrome`.
function loadShim(mockChrome, sandboxExtras) {
  const sandbox = {
    chrome: mockChrome,
    globalThis: {},
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
    const focused = env.calls.windowsUpdate.some((c) => c.updateInfo && c.updateInfo.focused);
    assert(focused, "existing popup must be focused on re-open");
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

  // --- Scenario 6: shim clears setPopup and wires toolbar handlers ------------
  {
    const env = makeChrome();
    loadShim(env.chrome);
    const cleared = env.calls.setPopup.some((o) => o && o.popup === "");
    assert(cleared, "shim must clear action.setPopup so onClicked can fire");
    const setTabPopup = env.calls.setPopup.some(
      (o) => o && o.tabId != null && o.popup && o.popup.length > 0
    );
    assert(!setTabPopup, "shim must NOT set per-tab action popups (blocks onClicked)");
    assert(env.calls.onClickedListeners.length >= 1, "shim must wire action.onClicked");
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

  // --- Scenario 9: Arc UA forces shim even with native-looking bindings -------
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
    assert(SHIM_SRC.indexOf('SHIM_VERSION = "1.2.5"') !== -1, "shim must declare SHIM_VERSION 1.2.5");
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
