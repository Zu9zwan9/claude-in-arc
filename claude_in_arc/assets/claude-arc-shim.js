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

  // Bail out quietly if we are not in an extension context.
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.id) {
    return;
  }

  // If the browser already supports the real Side Panel API, do nothing.
  // This keeps the patched build identical to upstream on Chrome/Brave/Edge.
  if (chrome.sidePanel) {
    return;
  }

  var PANEL_WINDOW_KEY = "claudeInArc.panelWindowId";
  var PANEL_TAB_KEY = "claudeInArc.panelTabId";
  var DEFAULT_PATH = "sidepanel.html";
  var POPUP_WIDTH = 480;
  var POPUP_HEIGHT = 840;

  // Per-tab options set by the extension via setOptions().
  var optionsByTab = new Map();

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

  async function openOrFocusPanel(tabId) {
    var path = resolvePath(tabId);
    var url = chrome.runtime.getURL(path);

    var stored = await sessionGet([PANEL_WINDOW_KEY, PANEL_TAB_KEY]);
    var existingWindowId = stored[PANEL_WINDOW_KEY];
    var existingTabId = stored[PANEL_TAB_KEY];

    if (existingWindowId != null) {
      var win = await getWindow(existingWindowId);
      if (win) {
        // Re-target the existing panel to the (possibly new) tab, then focus it.
        try {
          var panelTabId = existingTabId;
          if (panelTabId == null && win.tabs && win.tabs[0]) {
            panelTabId = win.tabs[0].id;
          }
          if (panelTabId != null) {
            chrome.tabs.update(panelTabId, { url: url }, function () {
              void chrome.runtime.lastError;
            });
          }
          chrome.windows.update(existingWindowId, { focused: true, drawAttention: true }, function () {
            void chrome.runtime.lastError;
          });
          return;
        } catch (_e) {
          // fall through to recreate
        }
      }
      // Stale id; clear it.
      await sessionRemove([PANEL_WINDOW_KEY, PANEL_TAB_KEY]);
    }

    await new Promise(function (resolve) {
      try {
        chrome.windows.create(
          {
            url: url,
            type: "popup",
            width: POPUP_WIDTH,
            height: POPUP_HEIGHT,
            focused: true,
          },
          function (win) {
            void chrome.runtime.lastError;
            if (win && win.id != null) {
              var firstTab = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
              var toStore = {};
              toStore[PANEL_WINDOW_KEY] = win.id;
              toStore[PANEL_TAB_KEY] = firstTab;
              sessionSet(toStore).then(resolve, resolve);
            } else {
              resolve();
            }
          }
        );
      } catch (_e) {
        resolve();
      }
    });
  }

  // Keep stored window id in sync when the user closes the panel window.
  try {
    if (chrome.windows && chrome.windows.onRemoved) {
      chrome.windows.onRemoved.addListener(function (closedId) {
        sessionGet([PANEL_WINDOW_KEY]).then(function (s) {
          if (s[PANEL_WINDOW_KEY] === closedId) {
            sessionRemove([PANEL_WINDOW_KEY, PANEL_TAB_KEY]);
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

    setPanelBehavior: function (_behavior, callback) {
      // The extension registers its own action.onClicked handler, so we don't
      // need to wire openPanelOnActionClick. Accept and ignore.
      return settle(callback, undefined);
    },

    getPanelBehavior: function (callback) {
      return settle(callback, { openPanelOnActionClick: false });
    },

    open: function (options, callback) {
      var run = (async function () {
        var tabId = options && (options.tabId != null ? options.tabId : null);
        if (tabId == null) {
          tabId = await resolveActiveTabId();
        }
        await openOrFocusPanel(tabId);
      })();
      run.catch(function (_e) { /* never throw */ });
      run.then(function () { settle(callback, undefined); }, function () { settle(callback, undefined); });
      return run.then(function () { return undefined; }, function () { return undefined; });
    },
  };

  try {
    Object.defineProperty(chrome, "sidePanel", {
      value: sidePanelPolyfill,
      writable: false,
      configurable: true,
      enumerable: true,
    });
  } catch (_e) {
    try { chrome.sidePanel = sidePanelPolyfill; } catch (_e2) { /* no-op */ }
  }
})();
