/*
 * claude-arc-shim.js
 * -----------------------------------------------------------------------------
 * A drop-in polyfill for chrome.sidePanel that lets the official "Claude in
 * Chrome" extension run in browsers that do NOT implement the chrome.sidePanel
 * API (most notably Arc, but also some Vivaldi builds).
 *
 * Why this exists
 * ---------------
 * The extension's service worker contains logic equivalent to:
 *
 *     async function openPanel(tabId) {
 *       if (!chrome.sidePanel) return reportUnsupportedBrowser();   // Arc dies here
 *       chrome.sidePanel.setOptions({ tabId, path: `sidepanel.html?tabId=${tabId}`, enabled: true });
 *       chrome.sidePanel.open({ tabId });
 *       ...
 *     }
 *
 * Arc does not expose chrome.sidePanel, so the extension short-circuits with
 * "This browser is not supported. Use Google Chrome, Microsoft Edge, or Brave."
 *
 * The panel path already encodes the originating tab (`?tabId=<id>`), so we can
 * faithfully recreate the side panel as a small always-on-top popup window and
 * still get full page context for the correct tab.
 *
 * Design goals
 * ------------
 *   - Zero behavioral change on real Chrome/Brave/Edge: if chrome.sidePanel
 *     already exists, this file does nothing.
 *   - Safe to load both as an ES-module import (service worker) and as a classic
 *     <script> (extension HTML pages). It contains no import/export statements.
 *   - Single reusable popup window that re-targets when the user opens the panel
 *     from a different tab, mirroring Chrome's per-tab side panel behavior.
 *   - Survives service-worker suspension by persisting the window id in
 *     chrome.storage.session.
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  var LOG_PREFIX = "[claude-in-arc]";
  var SHIM_VERSION = "1.2.4";

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(LOG_PREFIX);
      console.log.apply(console, args);
    } catch (_e) { /* no-op */ }
  }

  function warn() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(LOG_PREFIX);
      console.warn.apply(console, args);
    } catch (_e) { /* no-op */ }
  }

  // Bail out quietly if we are not in an extension context.
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
    return;
  }

  // If the browser already supports the real Side Panel API, do nothing.
  // This keeps the patched build identical to upstream on Chrome/Brave/Edge.
  //
  // Arc (and some Chromium forks) expose a truthy chrome.sidePanel object whose
  // methods are missing or no-op JS stubs — NOT the native Chrome binding. A
  // simple `if (chrome.sidePanel) return` lets those broken stubs through, the
  // upstream worker calls sidePanel.open(), and the toolbar click silently does
  // nothing. Real Chrome implementations are [native code] bindings.
  function isOurShim(sp) {
    return sp && sp.__claudeInArcShim === true;
  }

  function fnSource(fn) {
    try {
      return Function.prototype.toString.call(fn);
    } catch (_e) {
      return "";
    }
  }

  function isNativeBinding(fn) {
    return typeof fn === "function" && fnSource(fn).indexOf("[native code]") !== -1;
  }

  function nativeSidePanelWorks(sp) {
    if (!sp || isOurShim(sp)) return false;
    // Both core methods must exist AND be real Chromium bindings. Arc may ship
    // one native-looking stub while the other is plain JS, or native no-ops.
    return isNativeBinding(sp.open) && isNativeBinding(sp.setOptions);
  }

  // Arc (and some forks) now expose native-looking sidePanel bindings that are
  // still no-ops — nativeSidePanelWorks() alone lets those through and clicks
  // silently do nothing. Force our polyfill on known forks.
  function shouldForcePolyfill() {
    var ua = navigator.userAgent || "";
    if (/Arc\//.test(ua)) return true;
    if (/Company\/The Browser Company/.test(ua)) return true;
    return false;
  }

  if (nativeSidePanelWorks(chrome.sidePanel) && !shouldForcePolyfill()) {
    return;
  }

  log("claude-arc-shim v" + SHIM_VERSION);
  if (shouldForcePolyfill()) {
    log("forcing polyfill on Arc/Chromium fork (native sidePanel may be a no-op)");
  } else {
    log("installing sidePanel polyfill (broken stub detected)");
  }

  var PANEL_WINDOW_KEY = "claudeInArc.panelWindowId";
  var PANEL_TAB_KEY = "claudeInArc.panelTabId";
  var DEFAULT_PATH = "sidepanel.html";
  var POPUP_WIDTH = 480;
  var POPUP_HEIGHT = 840;
  var TOGGLE_COMMAND = "toggle-side-panel";

  // Per-tab options set by the extension via setOptions().
  var optionsByTab = new Map();

  // In-memory panel target so toolbar clicks can open synchronously (user gesture).
  var memPanelWindowId = null;
  var memPanelTabId = null;
  var memPanelInTab = false;

  function hasSession() {
    return !!(chrome.storage && chrome.storage.session);
  }

  function sessionGet(keys) {
    return new Promise(function (resolve) {
      if (!hasSession()) return resolve({});
      try {
        chrome.storage.session.get(keys, function (v) {
          void chrome.runtime.lastError; // swallow
          resolve(v || {});
        });
      } catch (_e) {
        resolve({});
      }
    });
  }

  function sessionSet(obj) {
    return new Promise(function (resolve) {
      if (!hasSession()) return resolve();
      try {
        chrome.storage.session.set(obj, function () {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (_e) {
        resolve();
      }
    });
  }

  function sessionRemove(keys) {
    return new Promise(function (resolve) {
      if (!hasSession()) return resolve();
      try {
        chrome.storage.session.remove(keys, function () {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (_e) {
        resolve();
      }
    });
  }

  function getWindow(id) {
    return new Promise(function (resolve) {
      try {
        chrome.windows.get(id, { populate: true }, function (win) {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(win || null);
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  // Resolve the panel path for a given tab. The extension sets a path that
  // already includes ?tabId=, which is what gives the panel its page context.
  function resolvePath(tabId) {
    var opts = tabId != null ? optionsByTab.get(tabId) : null;
    if (opts && typeof opts.path === "string" && opts.path) {
      return opts.path;
    }
    if (tabId != null) {
      return DEFAULT_PATH + "?tabId=" + encodeURIComponent(tabId);
    }
    return DEFAULT_PATH;
  }

  // Best-effort resolution of the "current" browsing tab when open() is called
  // without an explicit tabId. We deliberately exclude popup-type windows so we
  // never target our own panel window.
  function resolveActiveTabId() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
          void chrome.runtime.lastError;
          var t = tabs && tabs[0];
          if (t && t.id != null) return resolve(t.id);
          chrome.tabs.query({ active: true }, function (all) {
            void chrome.runtime.lastError;
            var first = (all || []).find(function (x) { return x && x.id != null; });
            resolve(first ? first.id : null);
          });
        });
      } catch (_e) {
        resolve(null);
      }
    });
  }

  function notifyOpenFailure(message) {
    warn(message);
    try {
      if (chrome.notifications && chrome.notifications.create) {
        chrome.notifications.create("claude-in-arc-open-failed", {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icon-128.png"),
          title: "Claude in Arc",
          message: message,
        });
      }
    } catch (_e) { /* no-op */ }
  }

  function persistPanelTarget(windowId, tabId, inTab) {
    memPanelWindowId = inTab ? null : windowId;
    memPanelTabId = tabId;
    memPanelInTab = !!inTab;
    var toStore = {};
    toStore[PANEL_WINDOW_KEY] = inTab ? null : windowId;
    toStore[PANEL_TAB_KEY] = tabId;
    sessionSet(toStore);
  }

  function clearPanelTarget() {
    memPanelWindowId = null;
    memPanelTabId = null;
    memPanelInTab = false;
    sessionRemove([PANEL_WINDOW_KEY, PANEL_TAB_KEY]);
  }

  // Create a panel window. Calls onDone(true) on success, onDone(false) on failure.
  // Must be invoked synchronously inside a user-gesture handler when possible.
  function createPanelWindow(url, windowType, onDone) {
    var createOpts = {
      url: url,
      type: windowType,
      width: POPUP_WIDTH,
      height: POPUP_HEIGHT,
      focused: true,
    };
    if (windowType === "normal") {
      createOpts.state = "normal";
    }
    try {
      chrome.windows.create(createOpts, function (win) {
        var err = chrome.runtime.lastError;
        if (err) {
          warn("windows.create type=" + windowType + " failed:", err.message || String(err));
        }
        if (win && win.id != null) {
          log("opened panel window id=" + win.id + " type=" + windowType);
          var firstTab = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
          persistPanelTarget(win.id, firstTab, false);
          if (onDone) onDone(true);
          return;
        }
        if (onDone) onDone(false);
      });
    } catch (e) {
      warn("windows.create threw:", e && e.message ? e.message : String(e));
      if (onDone) onDone(false);
    }
  }

  function createPanelTab(url, onDone) {
    try {
      void chrome.runtime.lastError;
      chrome.tabs.create({ url: url, active: true }, function (tab) {
        var err = chrome.runtime.lastError;
        if (err) {
          warn("tabs.create failed:", err.message || String(err));
        }
        if (tab && tab.id != null) {
          log("opened panel in new tab id=" + tab.id);
          persistPanelTarget(null, tab.id, true);
          if (onDone) onDone(true);
          return;
        }
        if (onDone) onDone(false);
      });
    } catch (e) {
      warn("tabs.create threw:", e && e.message ? e.message : String(e));
      if (onDone) onDone(false);
    }
  }

  // Priority: popup window → normal window → new tab. Logs every attempt.
  function tryOpenWithFallbacks(url, onDone) {
    log("tryOpenWithFallbacks url=" + url);
    createPanelWindow(url, "popup", function (ok) {
      if (ok) {
        if (onDone) onDone(true);
        return;
      }
      log("popup window failed; retrying as type=normal state=normal");
      createPanelWindow(url, "normal", function (ok2) {
        if (ok2) {
          if (onDone) onDone(true);
          return;
        }
        log("normal window failed; falling back to tabs.create");
        createPanelTab(url, function (ok3) {
          if (!ok3) {
            notifyOpenFailure(
              "Could not open Claude panel. Run: claude-in-arc install, then Reload in arc://extensions."
            );
          }
          if (onDone) onDone(!!ok3);
        });
      });
    });
  }

  function focusExistingPanel(url) {
    if (memPanelInTab && memPanelTabId != null) {
      try {
        chrome.tabs.update(memPanelTabId, { url: url, active: true }, function () {
          void chrome.runtime.lastError;
        });
        log("focused existing panel tab id=" + memPanelTabId);
        return true;
      } catch (_e) {
        return false;
      }
    }
    if (memPanelWindowId != null) {
      try {
        if (memPanelTabId != null) {
          chrome.tabs.update(memPanelTabId, { url: url }, function () {
            void chrome.runtime.lastError;
          });
        }
        chrome.windows.update(memPanelWindowId, { focused: true, drawAttention: true }, function () {
          void chrome.runtime.lastError;
        });
        log("focused existing panel window id=" + memPanelWindowId);
        return true;
      } catch (_e) {
        return false;
      }
    }
    return false;
  }

  // Synchronous-first open for toolbar clicks (preserves user gesture).
  function openPanelImmediate(tabId, reason) {
    var path = resolvePath(tabId);
    var url = chrome.runtime.getURL(path);
    log("openPanelImmediate tabId=" + tabId + " reason=" + (reason || "unknown") + " url=" + path);

    if (focusExistingPanel(url)) {
      return Promise.resolve(true);
    }

    return new Promise(function (resolve) {
      tryOpenWithFallbacks(url, resolve);
    });
  }

  async function openOrFocusPanel(tabId) {
    var path = resolvePath(tabId);
    var url = chrome.runtime.getURL(path);
    log("openOrFocusPanel tabId=" + tabId + " url=" + path);

    if (focusExistingPanel(url)) {
      return;
    }

    var stored = await sessionGet([PANEL_WINDOW_KEY, PANEL_TAB_KEY]);
    var existingWindowId = stored[PANEL_WINDOW_KEY];
    var existingTabId = stored[PANEL_TAB_KEY];

    if (existingWindowId != null) {
      memPanelWindowId = existingWindowId;
      memPanelTabId = existingTabId;
      memPanelInTab = false;
      var win = await getWindow(existingWindowId);
      if (win) {
        if (focusExistingPanel(url)) {
          return;
        }
      }
      clearPanelTarget();
    } else if (existingTabId != null) {
      memPanelTabId = existingTabId;
      memPanelInTab = true;
      if (focusExistingPanel(url)) {
        return;
      }
      clearPanelTarget();
    }

    await new Promise(function (resolve) {
      tryOpenWithFallbacks(url, resolve);
    });
  }

  // Keep stored window id in sync when the user closes the panel window.
  try {
    if (chrome.windows && chrome.windows.onRemoved) {
      chrome.windows.onRemoved.addListener(function (closedId) {
        if (memPanelWindowId === closedId) {
          clearPanelTarget();
          return;
        }
        sessionGet([PANEL_WINDOW_KEY]).then(function (s) {
          if (s[PANEL_WINDOW_KEY] === closedId) {
            clearPanelTarget();
          }
        });
      });
    }
  } catch (_e) {
    /* no-op */
  }

  // Normalize the (options?, callback?) calling convention used across the
  // chrome.sidePanel API and always resolve (never reject) so we don't break
  // the extension's non-awaited call chains.
  function settle(callback, value) {
    if (typeof callback === "function") {
      try { callback(value); } catch (_e) { /* no-op */ }
    }
    return Promise.resolve(value);
  }

  var panelBehavior = { openPanelOnActionClick: false };
  var actionClickWired = false;

  function onActionClickOpenPanel(tab) {
    var tabId = tab && tab.id;
    if (tabId == null) return;
    log("action.onClicked tabId=" + tabId);
    // Must call windows.create synchronously in this handler (user gesture).
    openPanelImmediate(tabId, "action.onClicked").catch(function (_e) { /* no-op */ });
  }

  // The upstream worker registers chrome.action.onClicked itself. Setting
  // action.setPopup to a non-empty path PREVENTS onClicked from firing, and Arc
  // often does not show action popups anyway — so we must keep popup cleared.
  function wireToolbarOpenHandlers() {
    if (chrome.action && chrome.action.setPopup) {
      try {
        chrome.action.setPopup({ popup: "" }, function () {
          void chrome.runtime.lastError;
        });
        log("cleared action.setPopup so onClicked can fire");
      } catch (_e) { /* no-op */ }
    }

    if (!actionClickWired && chrome.action && chrome.action.onClicked) {
      actionClickWired = true;
      chrome.action.onClicked.addListener(onActionClickOpenPanel);
      log("wired action.onClicked handler");
    }

    if (chrome.commands && chrome.commands.onCommand) {
      chrome.commands.onCommand.addListener(function (command) {
        if (command !== TOGGLE_COMMAND) return;
        log("commands.onCommand " + command);
        try {
          chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
            void chrome.runtime.lastError;
            var t = tabs && tabs[0];
            if (t && t.id != null) {
              openPanelImmediate(t.id, "commands.onCommand").catch(function (_e) { /* no-op */ });
            }
          });
        } catch (_e) { /* no-op */ }
      });
      log("wired commands.onCommand for " + TOGGLE_COMMAND);
    }

    if (chrome.runtime && chrome.runtime.onMessage && !chrome.runtime.onMessage.__claudeInArcOpenWired) {
      chrome.runtime.onMessage.__claudeInArcOpenWired = true;
      chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (!message || message.type !== "open_side_panel") return;
        var tabId = message.tabId != null ? message.tabId : (sender.tab && sender.tab.id);
        if (tabId == null) return;
        log("runtime message open_side_panel tabId=" + tabId);
        openPanelImmediate(tabId, "runtime.open_side_panel")
          .then(function () {
            try {
              sendResponse({ success: true });
            } catch (_e) { /* no-op */ }
          })
          .catch(function () {
            try {
              sendResponse({ success: false });
            } catch (_e2) { /* no-op */ }
          });
        return true;
      });
      log("wired runtime.onMessage for open_side_panel");
    }
  }

  var sidePanelPolyfill = {
    // Marker so other code / diagnostics can detect the shim.
    __claudeInArcShim: true,

    setOptions: function (options, callback) {
      try {
        if (options && options.tabId != null) {
          optionsByTab.set(options.tabId, options);
        }
      } catch (_e) { /* no-op */ }
      return settle(callback, undefined);
    },

    getOptions: function (options, callback) {
      var tabId = options && options.tabId;
      var value = (tabId != null && optionsByTab.get(tabId)) || {
        path: DEFAULT_PATH,
        enabled: true,
      };
      return settle(callback, value);
    },

    setPanelBehavior: function (behavior, callback) {
      try {
        if (behavior && typeof behavior.openPanelOnActionClick === "boolean") {
          panelBehavior.openPanelOnActionClick = behavior.openPanelOnActionClick;
          if (behavior.openPanelOnActionClick && !actionClickWired) {
            wireToolbarOpenHandlers();
          }
        }
      } catch (_e) { /* no-op */ }
      return settle(callback, undefined);
    },

    getPanelBehavior: function (callback) {
      return settle(callback, {
        openPanelOnActionClick: panelBehavior.openPanelOnActionClick,
      });
    },

    open: function (options, callback) {
      var run = (async function () {
        var tabId = options && (options.tabId != null ? options.tabId : null);
        if (tabId == null) {
          tabId = await resolveActiveTabId();
        }
        log("sidePanel.open tabId=" + tabId);
        // Prefer immediate path when tabId is known (may still be in a gesture chain).
        if (tabId != null) {
          await openPanelImmediate(tabId, "sidePanel.open");
        } else {
          await openOrFocusPanel(tabId);
        }
      })();
      run.catch(function (_e) { /* never throw */ });
      run.then(function () { settle(callback, undefined); }, function () { settle(callback, undefined); });
      return run.then(function () { return undefined; }, function () { return undefined; });
    },
  };

  function patchSidePanelMethods(target) {
    var names = ["setOptions", "getOptions", "open", "setPanelBehavior", "getPanelBehavior"];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      try {
        target[name] = sidePanelPolyfill[name];
      } catch (_e) { /* no-op */ }
    }
    try {
      target.__claudeInArcShim = true;
    } catch (_e2) { /* no-op */ }
  }

  function installSidePanelPolyfill() {
    var installed = false;
    try {
      Object.defineProperty(chrome, "sidePanel", {
        value: sidePanelPolyfill,
        writable: true,
        configurable: true,
        enumerable: true,
      });
      installed = chrome.sidePanel === sidePanelPolyfill;
    } catch (_e) {
      /* fall through */
    }
    if (!installed) {
      try {
        chrome.sidePanel = sidePanelPolyfill;
        installed = chrome.sidePanel === sidePanelPolyfill;
      } catch (_e2) {
        /* fall through */
      }
    }
    if (!installed && chrome.sidePanel && !isOurShim(chrome.sidePanel)) {
      warn("chrome.sidePanel not replaceable; patching methods in place");
      patchSidePanelMethods(chrome.sidePanel);
      installed = isOurShim(chrome.sidePanel);
    }
    if (installed) {
      log("sidePanel polyfill active");
    } else {
      warn("failed to install sidePanel polyfill");
    }
    return installed;
  }

  installSidePanelPolyfill();
  wireToolbarOpenHandlers();
})();
