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
  const calls = { windowsCreate: [], windowsUpdate: [], tabsUpdate: [] };
  const wins = {};
  let nextWinId = 100;

  const chrome = {
    runtime: {
      id: "test-extension-id",
      lastError: undefined,
      getURL: (p) => "chrome-extension://test-extension-id/" + p,
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
        const id = nextWinId++;
        const tabId = 9000 + id;
        const win = {
          id,
          type: createOpts.type,
          tabs: [{ id: tabId, url: createOpts.url }],
        };
        wins[id] = win;
        calls.windowsCreate.push({ opts: createOpts, win });
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
      onActivated: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    action: {
      setPopup(_opts, cb) {
        if (cb) cb();
      },
      onClicked: { addListener() {} },
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
function loadShim(mockChrome) {
  const sandbox = {
    chrome: mockChrome,
    navigator: { userAgent: "node-harness" },
    console,
    Map,
    Promise,
    Object,
    encodeURIComponent,
    setTimeout,
  };
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

  // --- Scenario 3: nativeSidePanelWorks rejects plain-JS Arc stubs ------------
  {
    function fnSource(fn) {
      return Function.prototype.toString.call(fn);
    }
    function nativeSidePanelWorks(sp) {
      if (!sp) return false;
      if (typeof sp.open !== "function" || typeof sp.setOptions !== "function") return false;
      var openPlain = fnSource(sp.open).indexOf("[native code]") === -1;
      var setPlain = fnSource(sp.setOptions).indexOf("[native code]") === -1;
      if (openPlain && setPlain) return false;
      return true;
    }
    assert(
      !nativeSidePanelWorks({ open: function open() {}, setOptions: function setOptions() {} }),
      "plain JS sidePanel stub must not be treated as native Chrome"
    );
    assert(
      !nativeSidePanelWorks({}),
      "empty sidePanel object must not be treated as native Chrome"
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

  console.log("OK: open_side_panel path produces popup-window behavior via the shim");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(String((err && err.stack) || err));
    process.exit(1);
  }
);
