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
 * faithfully recreate the side panel as a narrow popup window docked to the
 * right edge of the screen (or the focused browser window) and still get full
 * page context for the correct tab.
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
  var SHIM_VERSION = "1.2.25";

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

  function isServiceWorkerContext() {
    try {
      return (
        typeof self !== "undefined" &&
        typeof ServiceWorkerGlobalScope !== "undefined" &&
        self instanceof ServiceWorkerGlobalScope
      );
    } catch (_e) {
      return false;
    }
  }

  function isSidepanelPage() {
    try {
      return (
        typeof location !== "undefined" &&
        /sidepanel\.html$/i.test(location.pathname || "")
      );
    } catch (_e2) {
      return false;
    }
  }

  // Opening sidepanel.html without ?tabId= leaves the chat without page context —
  // messages disappear and Claude never answers. Redirect to the active tab.
  function ensureTabIdInPanelUrl() {
    if (!isSidepanelPage()) return;
    try {
      var params = new URLSearchParams(location.search || "");
      if (params.has("tabId")) return;
      log("sidepanel missing tabId — resolving active tab for redirect");
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
        void chrome.runtime.lastError;
        var t = tabs && tabs[0];
        if (!t || t.id == null) {
          chrome.tabs.query({ active: true, currentWindow: true }, function (tabs2) {
            void chrome.runtime.lastError;
            redirectSidepanelWithTabId(tabs2 && tabs2[0] && tabs2[0].id);
          });
          return;
        }
        redirectSidepanelWithTabId(t.id);
      });
    } catch (_e3) { /* no-op */ }
  }

  function redirectSidepanelWithTabId(tabId) {
    if (tabId == null) {
      warn(
        "could not resolve tabId — click the Claude icon (or press Cmd+E) on the page you want context from"
      );
      return;
    }
    var path = "sidepanel.html?tabId=" + encodeURIComponent(tabId);
    var target = chrome.runtime.getURL(path);
    log("redirecting sidepanel to tabId=" + tabId);
    location.replace(target);
  }

  if (!isServiceWorkerContext()) {
    ensureTabIdInPanelUrl();
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
  function isArcBrowser() {
    try {
      if (globalThis.__CLAUDE_IN_ARC_FORCE_POLYFILL === true) return true;
    } catch (_e) { /* no-op */ }
    var ua = navigator.userAgent || "";
    if (/Arc\//.test(ua)) return true;
    if (/Company\/The Browser Company/.test(ua)) return true;
    return false;
  }

  // Arc opens chrome.windows.create({ type: "normal" }) as a blank arc://new-tab-page/
  // window and ignores the extension URL — only popup type loads sidepanel.html.
  function shouldSkipNormalWindowFallback() {
    return isArcBrowser();
  }

  function shouldForcePolyfill() {
    return isArcBrowser();
  }

  if (nativeSidePanelWorks(chrome.sidePanel) && !shouldForcePolyfill()) {
    return;
  }

  log(
    "claude-arc-shim v" +
      SHIM_VERSION +
      (isServiceWorkerContext() ? " (service worker)" : " (extension page)")
  );
  if (shouldForcePolyfill()) {
    log("forcing polyfill on Arc/Chromium fork (native sidePanel may be a no-op)");
  } else {
    log("installing sidePanel polyfill (broken stub detected)");
  }

  var PANEL_WINDOW_KEY = "claudeInArc.panelWindowId";
  var PANEL_TAB_KEY = "claudeInArc.panelTabId";
  var PANEL_MODE_KEY = "claudeInArc.panelMode";
  var ARC_SIDEBAR_BLOCKED_NOTIFIED_KEY = "claudeInArc.arcSidebarBlockedNotified";
  var ARC_SPLIT_HINT_NOTIFIED_KEY = "claudeInArc.arcSplitHintNotified";
  var ARC_PANEL_MODE_EXPLICIT_KEY = "claudeInArc.panelModeExplicit";
  var SIDEBAR_BRIDGE_PAGE = "claude-arc-sidebar-bridge.html";
  var SIDEBAR_HOST_FILE = "claude-arc-sidebar-host.js";
  var SPLIT_HOST_FILE = "claude-arc-split-host.js";
  var HUD_HOST_NAME = "com.claudeinarac.hud";
  // Overridden at build time by `claude-in-arc install --panel-mode …`.
  var DEFAULT_PANEL_MODE = "popup";
  var DEFAULT_PATH = "sidepanel.html";
  // Narrow side-panel proportions (~Chrome side panel on a laptop display).
  var POPUP_WIDTH = 410;
  var POPUP_HEIGHT = 840;
  var PANEL_MARGIN = 8;
  var MIN_PANEL_HEIGHT = 480;
  var TOGGLE_COMMAND = "toggle-side-panel";

  // Cached geometry so windows.create can run synchronously inside user-gesture
  // handlers (toolbar click / Cmd+E). Updated from tab/window events and display API.
  var cachedAnchorWindow = null;
  var cachedWorkArea = null;
  var memAnchorWindowId = null;
  var anchorByTabId = new Map();
  var panelHiddenForAnchor = false;

  // Per-tab options set by the extension via setOptions().
  var optionsByTab = new Map();

  // In-memory panel target so toolbar clicks can open synchronously (user gesture).
  var memPanelWindowId = null;
  var memPanelTabId = null;
  var memPanelInTab = false;

  // Single-flight guard: upstream action.onClicked AND sidePanel.open both fire on
  // one toolbar click. Without this, two windows.create calls race before memPanelWindowId
  // is persisted in the async create callback.
  var panelOpenInFlight = false;
  var panelCreatePending = false;
  var splitBoundsSyncInFlight = false;
  var panelOpenLastTabId = null;
  var panelOpenLastAt = 0;
  var PANEL_OPEN_DEDUPE_MS = 300;
  var SPLIT_POPUP_DELAY_MS = 50;
  var SPLIT_POPUP_SYNC_MS = 120;
  // macOS Arc often ignores the first windows.update after create — retry gutter alignment.
  var SPLIT_BOUNDS_RETRY_DELAYS_MS = [0, 50, 150, 300, 500, 1000];
  var SPLIT_ANCHOR_WAIT_ATTEMPTS = 6;
  var SPLIT_ANCHOR_WAIT_MS = 40;
  var SPLIT_DOCK_ALIGN_TOLERANCE_PX = 12;
  var SPLIT_INJECT_SETTLE_MS = 16;
  var SPLIT_HIDE_GUARD_MS = 500;
  var splitLastShowAt = 0;
  var splitLastShowTabId = null;
  // Arc defaults to split unless the user explicitly chose popup-only.
  var arcExplicitPopupMode = false;
  var cachedPanelMode =
    DEFAULT_PANEL_MODE === "hud"
      ? "hud"
      : isArcBrowser()
        ? "split"
        : DEFAULT_PANEL_MODE;
  var memSidebarTabId = null;
  var memSplitTabId = null;
  var memSplitWidth = POPUP_WIDTH;
  var panelModeMenuWired = false;
  var hudPort = null;
  var hudReady = false;
  var hudLifecycleWired = false;

  // Chrome tab ids are numbers; some callers pass strings (runtime messages, JSON).
  // Strict equality (5 !== "5") caused duplicate opens to hide then re-show margin.
  function normalizeTabId(tabId) {
    if (tabId == null) return null;
    if (typeof tabId === "number" && !isNaN(tabId)) return tabId;
    var n = parseInt(tabId, 10);
    return isNaN(n) ? null : n;
  }

  function tabIdsEqual(a, b) {
    return normalizeTabId(a) === normalizeTabId(b);
  }

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
    tabId = normalizeTabId(tabId);
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

  // Arc blocks chrome-extension:// in page iframes. On Arc, "split" pairs page
  // margin injection with a docked popup (not an iframe). Popup-only stays available
  // only when the user explicitly chose it (arcExplicitPopupMode).
  function effectivePanelMode() {
    if (cachedPanelMode === "hud") return "hud";
    if (isArcBrowser()) {
      if (arcExplicitPopupMode) return "popup";
      return "split";
    }
    if (cachedPanelMode === "split") return "popup";
    return cachedPanelMode;
  }

  function isHudMode() {
    return effectivePanelMode() === "hud";
  }

  function disconnectHudPort() {
    if (!hudPort) return;
    try {
      hudPort.disconnect();
    } catch (_e) {
      /* no-op */
    }
    hudPort = null;
    hudReady = false;
  }

  function ensureHudPort() {
    if (!isServiceWorkerContext() || !isHudMode()) return null;
    if (hudPort) return hudPort;
    if (!chrome.runtime.connectNative) {
      warn("HUD mode: chrome.runtime.connectNative unavailable");
      return null;
    }
    try {
      hudPort = chrome.runtime.connectNative(HUD_HOST_NAME);
      hudPort.onMessage.addListener(function (msg) {
        handleHudHostMessage(msg);
      });
      hudPort.onDisconnect.addListener(function () {
        var err = chrome.runtime.lastError;
        if (err) {
          warn("HUD native port disconnected:", err.message || String(err));
        } else {
          log("HUD native port disconnected");
        }
        hudPort = null;
        hudReady = false;
      });
      log("connected native HUD host " + HUD_HOST_NAME);
      return hudPort;
    } catch (e) {
      warn("connectNative(" + HUD_HOST_NAME + ") failed:", e && e.message ? e.message : String(e));
      hudPort = null;
      return null;
    }
  }

  function sendHudMessage(payload) {
    var port = ensureHudPort();
    if (!port) return false;
    try {
      port.postMessage(payload);
      return true;
    } catch (e) {
      warn("HUD postMessage failed:", e && e.message ? e.message : String(e));
      disconnectHudPort();
      return false;
    }
  }

  function hudSendPageContext(tab) {
    if (!tab || tab.id == null) return false;
    return sendHudMessage({
      v: 1,
      dir: "ext_to_host",
      type: "page_context",
      tabId: tab.id,
      url: tab.url || "",
      title: tab.title || "",
    });
  }

  function pushActivePageContext() {
    if (!isHudMode()) return;
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
        void chrome.runtime.lastError;
        var tab = tabs && tabs[0];
        if (tab && tab.id != null) {
          hudSendPageContext(tab);
          return;
        }
        chrome.tabs.query({ active: true, currentWindow: true }, function (tabs2) {
          void chrome.runtime.lastError;
          if (tabs2 && tabs2[0]) hudSendPageContext(tabs2[0]);
        });
      });
    } catch (_e) {
      /* no-op */
    }
  }

  function handleHudHostMessage(msg) {
    if (!msg || msg.dir !== "host_to_ext" || !msg.type) return;
    switch (msg.type) {
      case "hud_ready":
        hudReady = true;
        pushActivePageContext();
        break;
      case "request_page_context":
        pushActivePageContext();
        break;
      case "hud_chrome_call":
        handleHudChromeCall(msg);
        break;
      case "hud_expanded":
      case "hud_collapsed":
      case "pong":
        break;
      default:
        log("HUD host message type=" + msg.type);
    }
  }

  function replyHudChrome(requestId, result, error) {
    if (!requestId) return;
    sendHudMessage({
      v: 1,
      dir: "ext_to_host",
      type: "hud_chrome_response",
      requestId: requestId,
      result: result == null ? null : result,
      error: error || null,
    });
  }

  function handleHudChromeCall(msg) {
    var requestId = msg.requestId;
    var method = msg.method;
    var args = msg.args || [];
    if (!requestId || !method) return;

    function fail(message) {
      replyHudChrome(requestId, null, message || "hud chrome call failed");
    }

    try {
      switch (method) {
        case "runtime.sendMessage":
          chrome.runtime.sendMessage(args[0], function (response) {
            var err = chrome.runtime.lastError;
            if (err) fail(err.message || String(err));
            else replyHudChrome(requestId, response, null);
          });
          return;
        case "storage.local.get":
        case "storage.session.get":
        case "storage.sync.get": {
          var area = method.split(".")[1];
          var store = chrome.storage && chrome.storage[area];
          if (!store || !store.get) return fail("storage." + area + " unavailable");
          store.get(args[0], function (items) {
            var err = chrome.runtime.lastError;
            if (err) fail(err.message || String(err));
            else replyHudChrome(requestId, items || {}, null);
          });
          return;
        }
        case "storage.local.set":
        case "storage.session.set":
        case "storage.sync.set": {
          var areaSet = method.split(".")[1];
          var storeSet = chrome.storage && chrome.storage[areaSet];
          if (!storeSet || !storeSet.set) return fail("storage." + areaSet + " unavailable");
          storeSet.set(args[0], function () {
            var err = chrome.runtime.lastError;
            if (err) fail(err.message || String(err));
            else replyHudChrome(requestId, true, null);
          });
          return;
        }
        case "storage.local.remove":
        case "storage.session.remove":
        case "storage.sync.remove": {
          var areaRm = method.split(".")[1];
          var storeRm = chrome.storage && chrome.storage[areaRm];
          if (!storeRm || !storeRm.remove) return fail("storage." + areaRm + " unavailable");
          storeRm.remove(args[0], function () {
            var err = chrome.runtime.lastError;
            if (err) fail(err.message || String(err));
            else replyHudChrome(requestId, true, null);
          });
          return;
        }
        case "tabs.query":
          if (!chrome.tabs || !chrome.tabs.query) return fail("tabs.query unavailable");
          chrome.tabs.query(args[0] || {}, function (tabs) {
            var err = chrome.runtime.lastError;
            if (err) fail(err.message || String(err));
            else replyHudChrome(requestId, tabs || [], null);
          });
          return;
        case "tabs.get":
          if (!chrome.tabs || !chrome.tabs.get) return fail("tabs.get unavailable");
          chrome.tabs.get(args[0], function (tab) {
            var err = chrome.runtime.lastError;
            if (err) fail(err.message || String(err));
            else replyHudChrome(requestId, tab || null, null);
          });
          return;
        default:
          fail("unsupported hud chrome method: " + method);
      }
    } catch (e) {
      fail(e && e.message ? e.message : String(e));
    }
  }

  function hudToggle() {
    return sendHudMessage({ v: 1, dir: "ext_to_host", type: "toggle_hud" });
  }

  function wireHudLifecycle() {
    if (!isServiceWorkerContext() || hudLifecycleWired) return;
    hudLifecycleWired = true;
    if (!chrome.tabs) return;

    function maybePushTab(tab) {
      if (!isHudMode() || !tab) return;
      hudSendPageContext(tab);
    }

    try {
      if (chrome.tabs.onActivated) {
        chrome.tabs.onActivated.addListener(function (info) {
          if (!isHudMode() || !info || info.tabId == null) return;
          chrome.tabs.get(info.tabId, function (tab) {
            void chrome.runtime.lastError;
            maybePushTab(tab);
          });
        });
      }
      if (chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.addListener(function (_tabId, changeInfo, tab) {
          if (!isHudMode()) return;
          if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
            maybePushTab(tab);
          }
        });
      }
      log("wired HUD page-context listeners");
    } catch (_e) {
      hudLifecycleWired = false;
    }
  }

  function openPanelInHud(tabId, reason) {
    tabId = normalizeTabId(tabId);
    log(
      "openPanelInHud tabId=" +
        tabId +
        " reason=" +
        (reason || "unknown")
    );
    ensureHudPort();
    if (tabId != null) {
      try {
        chrome.tabs.get(tabId, function (tab) {
          void chrome.runtime.lastError;
          if (tab) hudSendPageContext(tab);
        });
      } catch (_e) {
        /* no-op */
      }
    } else {
      pushActivePageContext();
    }
    if (!hudToggle()) {
      notifyOpenFailure(
        "Could not reach Claude HUD. Run: claude-in-arc hud install, then Reload in arc://extensions."
      );
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  function activePanelWidth() {
    if (memSplitTabId != null || effectivePanelMode() === "split") {
      return memSplitWidth || POPUP_WIDTH;
    }
    return POPUP_WIDTH;
  }

  function notifyArcSidebarUnavailable(message) {
    var text =
      message ||
      "Arc blocks in-page sidebars. Using split-panel mode (page margin + docked window) instead.";
    warn(text);
    if (!isArcBrowser()) return;
    if (cachedPanelMode === "sidebar") {
      setPanelMode("split");
    }
    if (!chrome.storage || !chrome.storage.local) {
      notifyOpenFailure(text);
      return;
    }
    try {
      chrome.storage.local.get([ARC_SIDEBAR_BLOCKED_NOTIFIED_KEY], function (stored) {
        void chrome.runtime.lastError;
        if (stored && stored[ARC_SIDEBAR_BLOCKED_NOTIFIED_KEY]) return;
        try {
          if (chrome.notifications && chrome.notifications.create) {
            chrome.notifications.create("claude-in-arc-arc-sidebar-blocked", {
              type: "basic",
              iconUrl: chrome.runtime.getURL("icon-128.png"),
              title: "Claude in Arc",
              message: text,
            });
          }
        } catch (_e2) { /* no-op */ }
        var obj = {};
        obj[ARC_SIDEBAR_BLOCKED_NOTIFIED_KEY] = Date.now();
        chrome.storage.local.set(obj);
      });
    } catch (_e3) {
      notifyOpenFailure(text);
    }
  }

  function notifyArcSplitPanelHint() {
    if (!isArcBrowser()) return;
    var text =
      "Arc cannot embed Claude inside the browser. A narrow window docks beside " +
      "your page (page should shrink left). Drag Arc wider if needed.";
    if (!chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.get([ARC_SPLIT_HINT_NOTIFIED_KEY], function (stored) {
        void chrome.runtime.lastError;
        if (stored && stored[ARC_SPLIT_HINT_NOTIFIED_KEY]) return;
        try {
          if (chrome.notifications && chrome.notifications.create) {
            chrome.notifications.create("claude-in-arc-arc-split-hint", {
              type: "basic",
              iconUrl: chrome.runtime.getURL("icon-128.png"),
              title: "Claude in Arc",
              message: text,
            });
          }
        } catch (_e2) { /* no-op */ }
        var obj = {};
        obj[ARC_SPLIT_HINT_NOTIFIED_KEY] = Date.now();
        chrome.storage.local.set(obj);
      });
    } catch (_e3) {
      /* no-op */
    }
  }

  function notifySplitDegraded(reason, detail) {
    var text =
      reason ||
      "Split panel: page margin unavailable on this URL — using floating window";
    if (detail) {
      warn(text + " (" + detail + ")");
    } else {
      warn(text);
    }
    notifyOpenFailure(text);
  }

  function isSplitDockMode() {
    return effectivePanelMode() === "split" || memSplitTabId != null;
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

  function loadPanelModeFromStorage() {
    if (!chrome.storage || !chrome.storage.local) return;
    try {
      chrome.storage.local.get([PANEL_MODE_KEY], function (stored) {
        void chrome.runtime.lastError;
        var mode = stored && stored[PANEL_MODE_KEY];
        if (mode === "sidebar" || mode === "popup" || mode === "split" || mode === "hud") {
          if (DEFAULT_PANEL_MODE === "hud" && mode !== "hud") {
            cachedPanelMode = "hud";
            setPanelMode("hud");
            if (isHudMode()) {
              ensureHudPort();
              wireHudLifecycle();
            }
            return;
          }
          if (mode === "sidebar" && isArcBrowser()) {
            warn("in-page sidebar is not supported on Arc; using split-panel mode");
            cachedPanelMode = "split";
            setPanelMode("split");
            notifyArcSidebarUnavailable();
          } else if (mode === "popup" && isArcBrowser()) {
            chrome.storage.local.get([ARC_PANEL_MODE_EXPLICIT_KEY], function (stored2) {
              void chrome.runtime.lastError;
              if (stored2 && stored2[ARC_PANEL_MODE_EXPLICIT_KEY]) {
                arcExplicitPopupMode = true;
                cachedPanelMode = "popup";
                log("panel mode=popup (explicit)");
              } else {
                arcExplicitPopupMode = false;
                log("Arc: upgrading stored popup mode to split-panel (default)");
                cachedPanelMode = "split";
                setPanelMode("split");
              }
            });
          } else {
            cachedPanelMode = mode;
            log("panel mode=" + mode);
            if (mode === "hud") {
              ensureHudPort();
              wireHudLifecycle();
            } else {
              disconnectHudPort();
            }
          }
        } else if (DEFAULT_PANEL_MODE === "hud") {
          cachedPanelMode = "hud";
          setPanelMode("hud");
          ensureHudPort();
          wireHudLifecycle();
        }
      });
      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener(function (changes, area) {
          if (area !== "local" || !changes[PANEL_MODE_KEY]) return;
          var next = changes[PANEL_MODE_KEY].newValue;
          if (next === "sidebar" || next === "popup" || next === "split" || next === "hud") {
            cachedPanelMode = next;
            if (isArcBrowser()) {
              arcExplicitPopupMode = next === "popup";
            }
            if (next === "hud") {
              ensureHudPort();
              wireHudLifecycle();
            } else {
              disconnectHudPort();
            }
            log("panel mode changed to " + next);
          }
        });
      }
    } catch (_e) {
      /* no-op */
    }
  }

  function setPanelMode(mode, callback, options) {
    if (mode !== "sidebar" && mode !== "popup" && mode !== "split" && mode !== "hud") {
      if (callback) callback(false);
      return;
    }
    if (mode === "sidebar" && isArcBrowser()) {
      notifyArcSidebarUnavailable(
        "In-page sidebar is not supported on Arc. Using split-panel mode."
      );
      mode = "split";
    }
    if (mode === "split" && !isArcBrowser()) {
      mode = "popup";
    }
    cachedPanelMode = mode;
    if (isArcBrowser()) {
      arcExplicitPopupMode = mode === "popup" && !!(options && options.explicit);
    }
    if (mode === "hud") {
      ensureHudPort();
      wireHudLifecycle();
    } else {
      disconnectHudPort();
    }
    if (!chrome.storage || !chrome.storage.local) {
      if (callback) callback(true);
      return;
    }
    var obj = {};
    obj[PANEL_MODE_KEY] = mode;
    if (options && options.explicit) {
      obj[ARC_PANEL_MODE_EXPLICIT_KEY] = true;
    } else if (isArcBrowser() && mode !== "popup") {
      obj[ARC_PANEL_MODE_EXPLICIT_KEY] = false;
    }
    try {
      chrome.storage.local.set(obj, function () {
        void chrome.runtime.lastError;
        log("saved panel mode=" + mode);
        if (callback) callback(true);
      });
    } catch (_e2) {
      if (callback) callback(false);
    }
  }

  function isRestrictedPageUrl(url) {
    if (!url || typeof url !== "string") return true;
    var lower = url.toLowerCase();
    return (
      lower.indexOf("chrome://") === 0 ||
      lower.indexOf("chrome-extension://") === 0 ||
      lower.indexOf("arc://") === 0 ||
      lower.indexOf("edge://") === 0 ||
      lower.indexOf("about:") === 0 ||
      lower.indexOf("view-source:") === 0
    );
  }

  function isHttpsPageUrl(url) {
    if (!url || typeof url !== "string") return false;
    return url.toLowerCase().indexOf("https://") === 0;
  }

  function splitMarginUnavailableReason(tabUrl, injectErr) {
    if (isRestrictedPageUrl(tabUrl)) {
      return "restricted URL (" + (tabUrl || "unknown") + ")";
    }
    if (!isHttpsPageUrl(tabUrl)) {
      return "non-HTTPS page (" + (tabUrl || "unknown") + ")";
    }
    if (injectErr) return injectErr;
    return "content script could not attach";
  }

  function sidebarBridgeUrl(tabId) {
    var path = SIDEBAR_BRIDGE_PAGE;
    if (tabId != null) {
      path += "?tabId=" + encodeURIComponent(tabId);
    }
    return chrome.runtime.getURL(path);
  }

  function hideSidebarOnTab(tabId, callback) {
    if (tabId == null) {
      if (callback) callback(false);
      return;
    }
    try {
      chrome.tabs.sendMessage(
        tabId,
        { type: "claude-in-arc-sidebar", action: "hide" },
        function (res) {
          void chrome.runtime.lastError;
          if (callback) callback(!!(res && res.ok));
        }
      );
    } catch (_e) {
      if (callback) callback(false);
    }
  }

  function showSidebarOnTab(tabId, url, callback) {
    if (tabId == null) {
      if (callback) callback(false);
      return;
    }
    try {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: "claude-in-arc-sidebar",
          action: "show",
          url: url,
          width: POPUP_WIDTH,
        },
        function (res) {
          void chrome.runtime.lastError;
          if (callback) callback(!!(res && res.ok));
        }
      );
    } catch (_e) {
      if (callback) callback(false);
    }
  }

  function injectSidebarHost(tabId, callback) {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      warn("chrome.scripting unavailable; cannot use in-page sidebar");
      if (callback) callback(false);
      return;
    }
    try {
      chrome.scripting.executeScript(
        {
          target: { tabId: tabId },
          files: [SIDEBAR_HOST_FILE],
        },
        function () {
          var err = chrome.runtime.lastError;
          if (err) {
            warn("sidebar host injection failed:", err.message || String(err));
            if (callback) callback(false);
            return;
          }
          if (callback) callback(true);
        }
      );
    } catch (e) {
      warn("sidebar host injection threw:", e && e.message ? e.message : String(e));
      if (callback) callback(false);
    }
  }

  function injectSplitHost(tabId, tabUrl, callback) {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      var scriptingErr = "chrome.scripting unavailable";
      warn("split host injection failed:", scriptingErr);
      if (callback) callback(false, scriptingErr);
      return;
    }
    try {
      chrome.scripting.executeScript(
        {
          target: { tabId: tabId },
          files: [SPLIT_HOST_FILE],
        },
        function () {
          var err = chrome.runtime.lastError;
          if (err) {
            var msg = err.message || String(err);
            warn(
              "split host injection failed on tabId=" +
                tabId +
                " url=" +
                (tabUrl || "?") +
                ":",
              msg
            );
            if (callback) callback(false, msg);
            return;
          }
          log("split host injected tabId=" + tabId + " url=" + (tabUrl || "?"));
          if (callback) callback(true);
        }
      );
    } catch (e) {
      var thrown = e && e.message ? e.message : String(e);
      warn("split host injection threw:", thrown);
      if (callback) callback(false, thrown);
    }
  }

  function shouldSuppressSplitHide(tabId, explicit) {
    if (explicit) return false;
    tabId = normalizeTabId(tabId);
    if (tabId == null || !tabIdsEqual(splitLastShowTabId, tabId)) return false;
    if (!splitLastShowAt) return false;
    if (Date.now() - splitLastShowAt < SPLIT_HIDE_GUARD_MS) {
      log(
        "split hide suppressed tabId=" +
          tabId +
          " (" +
          (Date.now() - splitLastShowAt) +
          "ms since show)"
      );
      return true;
    }
    return false;
  }

  function hideSplitOnTab(tabId, callback, options) {
    tabId = normalizeTabId(tabId);
    if (tabId == null) {
      if (callback) callback(false);
      return;
    }
    var explicit = !!(options && options.explicit);
    if (shouldSuppressSplitHide(tabId, explicit)) {
      if (callback) callback(false);
      return;
    }
    try {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: "claude-in-arc-split",
          action: "hide",
          explicit: explicit,
        },
        function (res) {
          void chrome.runtime.lastError;
          if (callback) callback(!!(res && res.ok));
        }
      );
    } catch (_e) {
      if (callback) callback(false);
    }
  }

  function showSplitOnTab(tabId, width, callback) {
    tabId = normalizeTabId(tabId);
    if (tabId == null) {
      if (callback) callback(false);
      return;
    }
    splitLastShowAt = Date.now();
    splitLastShowTabId = tabId;
    try {
      chrome.tabs.sendMessage(
        tabId,
        {
          type: "claude-in-arc-split",
          action: "show",
          width: width || activePanelWidth(),
        },
        function (res) {
          var err = chrome.runtime.lastError;
          if (err) {
            warn(
              "split margin show failed tabId=" +
                tabId +
                ":",
              err.message || String(err)
            );
            if (callback) callback(false);
            return;
          }
          if (callback) callback(!!(res && res.ok));
        }
      );
    } catch (e) {
      warn("split margin show threw:", e && e.message ? e.message : String(e));
      if (callback) callback(false);
    }
  }

  function closePopupPanelIfOpen() {
    if (memSplitTabId != null) {
      hideSplitOnTab(memSplitTabId, null, { explicit: true });
      memSplitTabId = null;
    }
    if (memPanelInTab && memPanelTabId != null) {
      try {
        chrome.tabs.remove(memPanelTabId, function () {
          void chrome.runtime.lastError;
        });
      } catch (_e) {
        /* no-op */
      }
      clearPanelTarget();
      return;
    }
    if (memPanelWindowId != null) {
      try {
        chrome.windows.remove(memPanelWindowId, function () {
          void chrome.runtime.lastError;
        });
      } catch (_e2) {
        /* no-op */
      }
      clearPanelTarget();
    }
  }

  function openPanelInSidebar(tabId, reason) {
    tabId = normalizeTabId(tabId);
    if (isArcBrowser()) {
      return openPanelInSplit(tabId, reason);
    }

    var url = sidebarBridgeUrl(tabId);
    log(
      "openPanelInSidebar tabId=" +
        tabId +
        " reason=" +
        (reason || "unknown") +
        " url=" +
        url
    );

    if (shouldDedupePanelOpen(tabId, reason)) {
      return Promise.resolve(true);
    }

    if (tabIdsEqual(memSidebarTabId, tabId)) {
      return new Promise(function (resolve) {
        showSidebarOnTab(tabId, url, function (ok) {
          if (ok) {
            markPanelOpenFinished(tabId);
            resolve(true);
            return;
          }
          injectSidebarHost(tabId, function (injected) {
            if (!injected) {
              warn("sidebar re-show failed; falling back to popup");
              tryOpenWithFallbacks(chrome.runtime.getURL(resolvePath(tabId)), function (ok) {
                markPanelOpenFinished(tabId);
                resolve(!!ok);
              });
              return;
            }
            showSidebarOnTab(tabId, url, function (ok2) {
              markPanelOpenFinished(tabId);
              resolve(!!ok2);
            });
          });
        });
      });
    }

    markPanelOpenStarted(tabId);

    return new Promise(function (resolve) {
      try {
        chrome.tabs.get(tabId, function (tab) {
          var err = chrome.runtime.lastError;
          if (err || !tab) {
            warn("sidebar open: tab lookup failed");
            markPanelOpenFinished(tabId);
            tryOpenWithFallbacks(chrome.runtime.getURL(resolvePath(tabId)), function (ok) {
              resolve(!!ok);
            });
            return;
          }
          if (isRestrictedPageUrl(tab.url)) {
            warn(
              "in-page sidebar unavailable on restricted URL; using popup (" +
                (tab.url || "unknown") +
                ")"
            );
            markPanelOpenFinished(tabId);
            tryOpenWithFallbacks(chrome.runtime.getURL(resolvePath(tabId)), function (ok) {
              resolve(!!ok);
            });
            return;
          }

          closePopupPanelIfOpen();

          var previousSidebarTab = memSidebarTabId;
          if (previousSidebarTab != null && !tabIdsEqual(previousSidebarTab, tabId)) {
            hideSidebarOnTab(previousSidebarTab);
          }

          function finishShow() {
            showSidebarOnTab(tabId, url, function (ok) {
              if (ok) {
                memSidebarTabId = tabId;
                markPanelOpenFinished(tabId);
                resolve(true);
                return;
              }
              warn("sidebar show failed; falling back to popup");
              tryOpenWithFallbacks(chrome.runtime.getURL(resolvePath(tabId)), function (ok2) {
                markPanelOpenFinished(tabId);
                resolve(!!ok2);
              });
            });
          }

          injectSidebarHost(tabId, function (injected) {
            if (injected) {
              finishShow();
              return;
            }
            warn("sidebar injection failed; falling back to popup");
            tryOpenWithFallbacks(chrome.runtime.getURL(resolvePath(tabId)), function (ok3) {
              markPanelOpenFinished(tabId);
              resolve(!!ok3);
            });
          });
        });
      } catch (e) {
        warn("openPanelInSidebar threw:", e && e.message ? e.message : String(e));
        markPanelOpenFinished(tabId);
        resolve(false);
      }
    });
  }

  function openSplitDockedPopup(tabId, url, callback) {
    if (focusExistingPanel(url)) {
      resolveSplitAnchorForTab(tabId, function (anchor) {
        if (anchor) setActiveAnchor(anchor);
        syncSplitPopupToGutter(tabId, function () {
          if (callback) callback(true);
        });
      });
      return;
    }
    resolveSplitAnchorForTab(tabId, function (anchor) {
      if (!anchor) {
        warn("split popup: tab anchor missing; trying last-focused window");
        primeAnchorForOpen(tabId, function (fallbackAnchor) {
          if (!fallbackAnchor) {
            if (callback) callback(false);
            return;
          }
          tryOpenSplitDockedPopup(url, tabId, callback);
        });
        return;
      }
      setActiveAnchor(anchor);
      tryOpenSplitDockedPopup(url, tabId, callback);
    });
  }

  function splitBoundsReady() {
    var bounds = getPanelBoundsSync();
    return bounds.left != null && bounds.top != null;
  }

  function waitForSplitAnchorBounds(tabId, attempt, callback) {
    resolveSplitAnchorForTab(tabId, function (anchor) {
      if (anchor) setActiveAnchor(anchor);
      if (splitBoundsReady()) {
        callback(true);
        return;
      }
      if (attempt >= SPLIT_ANCHOR_WAIT_ATTEMPTS) {
        warn(
          "split popup: anchor bounds still unavailable after " +
            SPLIT_ANCHOR_WAIT_ATTEMPTS +
            " attempts"
        );
        callback(false);
        return;
      }
      setTimeout(function () {
        waitForSplitAnchorBounds(tabId, attempt + 1, callback);
      }, SPLIT_ANCHOR_WAIT_MS * (attempt + 1));
    });
  }

  function refocusAnchorWindowAfterDock() {
    if (memAnchorWindowId == null) return;
    try {
      chrome.windows.update(memAnchorWindowId, { focused: true }, function () {
        void chrome.runtime.lastError;
      });
    } catch (_e) {
      /* no-op */
    }
  }

  function verifySplitDockAlignment(windowId, expectedBounds, callback) {
    if (windowId == null || expectedBounds.left == null) {
      if (callback) callback(false);
      return;
    }
    try {
      chrome.windows.get(windowId, function (win) {
        void chrome.runtime.lastError;
        if (!win || win.left == null) {
          if (callback) callback(true);
          return;
        }
        var delta = Math.abs(win.left - expectedBounds.left);
        var aligned = delta <= SPLIT_DOCK_ALIGN_TOLERANCE_PX;
        if (!aligned) {
          warn(
            "split popup misaligned by " +
              delta +
              "px (expected left=" +
              expectedBounds.left +
              ", got " +
              win.left +
              ")"
          );
        }
        if (callback) callback(aligned);
      });
    } catch (_e2) {
      if (callback) callback(false);
    }
  }

  function notifySplitMisaligned() {
    notifyOpenFailure(
      "Claude panel could not dock flush to Arc. Focus the Arc window and press ⌘E again, " +
        "or run: claude-in-arc upgrade"
    );
  }

  function tryOpenSplitDockedPopup(url, tabId, callback) {
    waitForSplitAnchorBounds(tabId, 0, function (anchorReady) {
      var bounds = getPanelBoundsSync();
      if (!anchorReady || bounds.left == null || bounds.top == null) {
        warn(
          "split popup: anchor bounds unavailable — opening floating panel and retrying dock"
        );
        notifySplitDegraded(
          "Split panel: could not read Arc window position — page margin may be missing"
        );
      }
      log(
        "split dock target @" +
          (bounds.left != null ? bounds.left : "?") +
          "," +
          (bounds.top != null ? bounds.top : "?") +
          " " +
          bounds.width +
          "x" +
          bounds.height
      );
      createPanelWindow(url, "popup", function (ok) {
        if (ok) {
          syncSplitPopupToGutter(tabId, function () {
            refocusAnchorWindowAfterDock();
            if (callback) callback(true);
          });
          return;
        }
        if (shouldSkipNormalWindowFallback()) {
          warn(
            "split popup failed on Arc; skipping type=normal (opens blank arc://new-tab-page/)"
          );
          notifyOpenFailure(
            "Could not open Claude split panel. Run: claude-in-arc install, then Reload in arc://extensions."
          );
          if (callback) callback(false);
          return;
        }
        log("split popup window failed; retrying as type=normal");
        createPanelWindow(url, "normal", function (ok2) {
          if (!ok2) {
            notifyOpenFailure(
              "Could not open Claude split panel. Run: claude-in-arc install, then Reload in arc://extensions."
            );
            if (callback) callback(false);
            return;
          }
          syncSplitPopupToGutter(tabId, function () {
            refocusAnchorWindowAfterDock();
            if (callback) callback(true);
          });
        });
      });
    });
  }

  function resolveSplitAnchorForTab(tabId, callback) {
    if (tabId == null) {
      if (callback) callback(null);
      return;
    }
    try {
      chrome.tabs.get(tabId, function (tab) {
        var err = chrome.runtime.lastError;
        if (err || !tab || tab.windowId == null) {
          if (callback) callback(null);
          return;
        }
        chrome.windows.get(tab.windowId, function (win) {
          void chrome.runtime.lastError;
          var anchor = anchorFromWindow(win);
          if (!anchor) {
            var tabCached = anchorByTabId.get(tabId);
            if (
              tabCached &&
              tabCached.left != null &&
              (tabCached.id == null || tabCached.id === tab.windowId)
            ) {
              anchor = {
                id: tab.windowId,
                left: tabCached.left,
                top: tabCached.top,
                width: tabCached.width,
                height: tabCached.height,
                state: tabCached.state || "normal",
              };
            }
          }
          if (anchor) {
            if (anchor.id != null && anchor.id !== tab.windowId) {
              warn(
                "split anchor id mismatch tab.windowId=" +
                  tab.windowId +
                  " anchor.id=" +
                  anchor.id
              );
            }
            cacheAnchorForTab(tabId, anchor);
            memAnchorWindowId = tab.windowId;
            log(
              "split anchor windowId=" +
                tab.windowId +
                " @" +
                anchor.left +
                "," +
                anchor.top +
                " " +
                anchor.width +
                "x" +
                anchor.height
            );
          }
          if (callback) callback(anchor);
        });
      });
    } catch (_e) {
      if (callback) callback(null);
    }
  }

  function splitGutterBoundsForPanel(anchor) {
    if (!anchor) return getPanelBoundsSync();
    return splitGutterBoundsFromAnchor(anchor);
  }

  function scheduleSplitBoundsRetries(tabId, windowId, callback) {
    if (windowId == null) {
      if (callback) callback();
      return;
    }
    splitBoundsSyncInFlight = true;
    var delays = SPLIT_BOUNDS_RETRY_DELAYS_MS;
    var remaining = delays.length;

    function finishOne() {
      remaining--;
      if (remaining <= 0) {
        splitBoundsSyncInFlight = false;
        if (memPanelWindowId != null && cachedAnchorWindow) {
          var expected = splitGutterBoundsForPanel(cachedAnchorWindow);
          verifySplitDockAlignment(memPanelWindowId, expected, function (aligned) {
            if (!aligned) {
              notifySplitMisaligned();
            }
            refocusAnchorWindowAfterDock();
            if (callback) callback();
          });
          return;
        }
        refocusAnchorWindowAfterDock();
        if (callback) callback();
      }
    }

    for (var i = 0; i < delays.length; i++) {
      (function (delayMs, attempt) {
        setTimeout(function () {
          function applyBounds(anchor) {
            if (anchor) setActiveAnchor(anchor);
            var bounds = splitGutterBoundsForPanel(cachedAnchorWindow);
            forcePanelWindowBounds(windowId, bounds, finishOne);
            if (attempt === 0) {
              log(
                "split gutter sync @" +
                  (bounds.left != null ? bounds.left : "?") +
                  "," +
                  (bounds.top != null ? bounds.top : "?") +
                  " " +
                  bounds.width +
                  "x" +
                  bounds.height
              );
            }
          }
          if (tabId != null) {
            resolveSplitAnchorForTab(tabId, applyBounds);
          } else if (cachedAnchorWindow) {
            applyBounds(cachedAnchorWindow);
          } else {
            finishOne();
          }
        }, delayMs);
      })(delays[i], i);
    }
  }

  function syncSplitPopupToGutter(tabId, callback) {
    resolveSplitAnchorForTab(tabId, function (anchor) {
      if (anchor) setActiveAnchor(anchor);
      scheduleSplitBoundsRetries(tabId, memPanelWindowId, null);
      if (callback) callback();
    });
  }

  function scheduleSplitDockedPopup(tabId, url, splitMarginOk, resolve) {
    notifyArcSplitPanelHint();
    memSplitTabId = tabId;
    var delay = splitMarginOk ? SPLIT_POPUP_DELAY_MS : 0;
    log(
      "split scheduling popup in " +
        delay +
        "ms margin=" +
        (splitMarginOk ? "active" : "inactive")
    );
    setTimeout(function () {
      openSplitDockedPopup(tabId, url, function (ok) {
        if (!ok) {
          hideSplitOnTab(tabId, null, { explicit: true });
          memSplitTabId = null;
          markPanelOpenFinished(tabId);
          resolve(false);
          return;
        }
        memSplitTabId = tabId;
        if (!splitMarginOk) {
          warn("popup opened without split margin on tabId=" + tabId);
        }
        markPanelOpenFinished(tabId);
        resolve(true);
      });
    }, delay);
  }

  function applySplitMarginThenOpen(tabId, tabUrl, url, resolve, retried) {
    function afterInjectSettle(fn) {
      setTimeout(fn, SPLIT_INJECT_SETTLE_MS);
    }
    showSplitOnTab(tabId, activePanelWidth(), function (splitOk) {
      if (splitOk) {
        scheduleSplitDockedPopup(tabId, url, true, resolve);
        return;
      }
      if (!retried) {
        warn("split margin show failed; retrying split host injection");
        injectSplitHost(tabId, tabUrl, function (reinjected, injectErr) {
          if (!reinjected) {
            warn(
              "split host injection failed after retry — popup only:",
              splitMarginUnavailableReason(tabUrl, injectErr)
            );
            notifySplitDegraded();
            scheduleSplitDockedPopup(tabId, url, false, resolve);
            return;
          }
          afterInjectSettle(function () {
            applySplitMarginThenOpen(tabId, tabUrl, url, resolve, true);
          });
        });
        return;
      }
      warn(
        "split margin could not be applied after retry — popup only:",
        splitMarginUnavailableReason(tabUrl)
      );
      notifySplitDegraded();
      scheduleSplitDockedPopup(tabId, url, false, resolve);
    });
  }

  function openPanelInSplit(tabId, reason) {
    tabId = normalizeTabId(tabId);
    var url = chrome.runtime.getURL(resolvePath(tabId));
    log(
      "openPanelInSplit tabId=" +
        tabId +
        " reason=" +
        (reason || "unknown") +
        " url=" +
        url
    );

    if (shouldDedupePanelOpen(tabId, reason)) {
      return Promise.resolve(true);
    }

    markPanelOpenStarted(tabId);

    return new Promise(function (resolve) {
      try {
        chrome.tabs.get(tabId, function (tab) {
          var err = chrome.runtime.lastError;
          if (err || !tab) {
            warn("split open: tab lookup failed");
            markPanelOpenFinished(tabId);
            tryOpenWithFallbacks(url, function (ok) {
              resolve(!!ok);
            });
            return;
          }
          if (isRestrictedPageUrl(tab.url) || !isHttpsPageUrl(tab.url)) {
            warn(
              "split-panel margin unavailable on this URL; using floating window (" +
                (tab.url || "unknown") +
                ")"
            );
            notifySplitDegraded();
            scheduleSplitDockedPopup(tabId, url, false, resolve);
            return;
          }

          var tabUrl = tab.url || "";
          var previousSplitTab = memSplitTabId;
          if (previousSplitTab != null && !tabIdsEqual(previousSplitTab, tabId)) {
            hideSplitOnTab(previousSplitTab, null, { explicit: true });
          }

          function finishExistingSplitPanel() {
            if (focusExistingPanel(url)) {
              syncSplitPopupToGutter(tabId, function () {
                showSplitOnTab(tabId, activePanelWidth(), function () {
                  memSplitTabId = tabId;
                  markPanelOpenFinished(tabId);
                  resolve(true);
                });
              });
              return;
            }
            applySplitMarginThenOpen(tabId, tabUrl, url, resolve, false);
          }

          if (tabIdsEqual(memSplitTabId, tabId)) {
            showSplitOnTab(tabId, activePanelWidth(), function (ok) {
              if (ok) {
                finishExistingSplitPanel();
                return;
              }
              injectSplitHost(tabId, tabUrl, function (injected, injectErr) {
                if (!injected) {
                  warn(
                    "split re-show failed; falling back to popup only:",
                    splitMarginUnavailableReason(tabUrl, injectErr)
                  );
                  notifySplitDegraded();
                  scheduleSplitDockedPopup(tabId, url, false, resolve);
                  return;
                }
                setTimeout(function () {
                  finishExistingSplitPanel();
                }, SPLIT_INJECT_SETTLE_MS);
              });
            });
            return;
          }

          injectSplitHost(tabId, tabUrl, function (injected, injectErr) {
            if (!injected) {
              warn(
                "split host injection failed; falling back to popup only:",
                splitMarginUnavailableReason(tabUrl, injectErr)
              );
              notifySplitDegraded();
              scheduleSplitDockedPopup(tabId, url, false, resolve);
              return;
            }
            setTimeout(function () {
              applySplitMarginThenOpen(tabId, tabUrl, url, resolve, false);
            }, SPLIT_INJECT_SETTLE_MS);
          });
        });
      } catch (e) {
        warn("openPanelInSplit threw:", e && e.message ? e.message : String(e));
        markPanelOpenFinished(tabId);
        resolve(false);
      }
    });
  }

  function wirePanelModeContextMenu() {
    if (!isServiceWorkerContext() || panelModeMenuWired) return;
    if (!chrome.contextMenus || !chrome.contextMenus.create) return;
    panelModeMenuWired = true;
    try {
      chrome.contextMenus.create(
        {
          id: "claude-in-arc-panel-mode-popup",
          title: "Panel mode: Popup window",
          contexts: ["action"],
          type: "radio",
          checked: cachedPanelMode === "popup",
        },
        function () {
          void chrome.runtime.lastError;
        }
      );
      chrome.contextMenus.create(
        {
          id: "claude-in-arc-panel-mode-sidebar",
          title: "Panel mode: In-page sidebar",
          contexts: ["action"],
          type: "radio",
          checked: cachedPanelMode === "sidebar",
        },
        function () {
          void chrome.runtime.lastError;
        }
      );
      chrome.contextMenus.create(
        {
          id: "claude-in-arc-panel-mode-split",
          title: "Panel mode: Split panel (Arc)",
          contexts: ["action"],
          type: "radio",
          checked: cachedPanelMode === "split",
        },
        function () {
          void chrome.runtime.lastError;
        }
      );
      chrome.contextMenus.create(
        {
          id: "claude-in-arc-panel-mode-hud",
          title: "Panel mode: Notch HUD (macOS)",
          contexts: ["action"],
          type: "radio",
          checked: cachedPanelMode === "hud",
        },
        function () {
          void chrome.runtime.lastError;
        }
      );
      chrome.contextMenus.onClicked.addListener(function (info) {
        if (!info || !info.menuItemId) return;
        if (info.menuItemId === "claude-in-arc-panel-mode-popup") {
          setPanelMode("popup", null, { explicit: true });
        } else if (info.menuItemId === "claude-in-arc-panel-mode-sidebar") {
          setPanelMode("sidebar", null, { explicit: true });
        } else if (info.menuItemId === "claude-in-arc-panel-mode-split") {
          setPanelMode("split", null, { explicit: true });
        } else if (info.menuItemId === "claude-in-arc-panel-mode-hud") {
          setPanelMode("hud", null, { explicit: true });
        }
      });
      log("wired action context menu for panel mode");
    } catch (_e) {
      panelModeMenuWired = false;
    }
  }

  function tryOpenWithFallbacksAsPromise(tabId, reason) {
    if (shouldDedupePanelOpen(tabId, reason)) {
      return Promise.resolve(true);
    }
    markPanelOpenStarted(tabId);
    var url = chrome.runtime.getURL(resolvePath(tabId));
    return new Promise(function (resolve) {
      primeAnchorForOpen(tabId, function () {
        tryOpenWithFallbacks(url, function (ok) {
          if (ok && memPanelWindowId != null && memAnchorWindowId != null) {
            syncPanelToAnchor();
          }
          markPanelOpenFinished(tabId);
          resolve(!!ok);
        });
      });
    });
  }

  function handleSidebarIframeBlocked(tabId, reason) {
    log(
      "sidebar iframe blocked tabId=" +
        tabId +
        " reason=" +
        (reason || "unknown")
    );
    notifyArcSidebarUnavailable(
      "Arc blocked the in-page sidebar. Switched to split-panel mode."
    );
    if (tabId != null) {
      hideSidebarOnTab(tabId);
      if (tabIdsEqual(memSidebarTabId, tabId)) memSidebarTabId = null;
    }
    if (isArcBrowser()) {
      return openPanelInSplit(tabId, "sidebar-iframe-blocked");
    }
    return tryOpenWithFallbacksAsPromise(tabId, "sidebar-iframe-blocked");
  }

  function wireSplitLifecycle() {
    if (!isServiceWorkerContext()) return;
    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || !msg.type) return;
        if (msg.type === "claude-in-arc-split-closed") {
          if (memSplitTabId != null) {
            log("split closed on tabId=" + memSplitTabId);
            hideSplitOnTab(memSplitTabId, null, { explicit: true });
            memSplitTabId = null;
          }
          if (memPanelWindowId != null) {
            try {
              chrome.windows.remove(memPanelWindowId, function () {
                void chrome.runtime.lastError;
              });
            } catch (_e) {
              /* no-op */
            }
          }
          clearPanelTarget();
          return;
        }
        if (msg.type === "claude-in-arc-split-resize" && msg.width != null) {
          var w = parseInt(msg.width, 10);
          if (!isNaN(w) && w >= 320 && w <= 720) {
            memSplitWidth = w;
            if (memSplitTabId != null) {
              showSplitOnTab(memSplitTabId, w, function () {
                /* margin width already updated in-page; keep shim state aligned */
              });
            }
            syncPanelToAnchor(true);
          }
        }
      });
      if (chrome.tabs && chrome.tabs.onRemoved) {
        chrome.tabs.onRemoved.addListener(function (closedId) {
          if (tabIdsEqual(memSplitTabId, closedId)) {
            memSplitTabId = null;
          }
        });
      }
    } catch (_e2) {
      /* no-op */
    }
  }

  function wireSidebarLifecycle() {
    if (!isServiceWorkerContext()) return;
    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || !msg.type) return;
        if (msg.type === "claude-in-arc-sidebar-closed") {
          if (memSidebarTabId != null) {
            log("sidebar closed on tabId=" + memSidebarTabId);
            memSidebarTabId = null;
          }
          return;
        }
        if (msg.type === "claude-in-arc-sidebar-iframe-blocked") {
          var blockedTabId = normalizeTabId(msg.tabId);
          if (blockedTabId == null) blockedTabId = memSidebarTabId;
          handleSidebarIframeBlocked(blockedTabId, msg.reason || "host-detected");
        }
      });
      if (chrome.tabs && chrome.tabs.onRemoved) {
        chrome.tabs.onRemoved.addListener(function (closedId) {
          if (tabIdsEqual(memSidebarTabId, closedId)) {
            memSidebarTabId = null;
          }
        });
      }
    } catch (_e) {
      /* no-op */
    }
  }

  function isOurPanelWindow(win) {
    return !!(win && win.id != null && win.id === memPanelWindowId);
  }

  function isExcludedAnchorType(type) {
    return type === "popup" || type === "devtools" || type === "app";
  }

  function isUsableAnchorWindow(win) {
    return !!(
      win &&
      win.id != null &&
      !isOurPanelWindow(win) &&
      !isExcludedAnchorType(win.type) &&
      win.state !== "minimized" &&
      win.left != null &&
      win.top != null &&
      win.width > 0 &&
      win.height > 0
    );
  }

  function anchorFromWindow(win) {
    if (!isUsableAnchorWindow(win)) return null;
    return {
      id: win.id,
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
      state: win.state || "normal",
    };
  }

  function setActiveAnchor(anchor) {
    if (!anchor || anchor.left == null) return;
    cachedAnchorWindow = {
      left: anchor.left,
      top: anchor.top,
      width: anchor.width,
      height: anchor.height,
    };
    if (anchor.id != null) memAnchorWindowId = anchor.id;
  }

  function updateCachedAnchor(win) {
    var anchor = anchorFromWindow(win);
    if (!anchor) return;
    setActiveAnchor(anchor);
  }

  function cacheAnchorForTab(tabId, anchor) {
    if (tabId == null || !anchor) return;
    anchorByTabId.set(tabId, anchor);
    setActiveAnchor(anchor);
  }

  function boundsFromWorkArea(workArea) {
    var margin = PANEL_MARGIN;
    var width = activePanelWidth();
    var height = Math.max(MIN_PANEL_HEIGHT, workArea.height - margin * 2);
    return {
      width: width,
      height: height,
      left: workArea.left + workArea.width - width - margin,
      top: workArea.top + margin,
    };
  }

  // Exact gutter geometry: popup left = anchor.right - panelWidth (flush over margin).
  function splitGutterBoundsFromAnchor(anchor) {
    var width = activePanelWidth();
    var right = anchor.left + anchor.width;
    var left = right - width;
    if (left < anchor.left) {
      left = anchor.left;
      width = Math.min(width, anchor.width);
    }
    return {
      width: width,
      height: anchor.height,
      left: left,
      top: anchor.top,
    };
  }

  // Flush to the browser window's right edge (not screen edge, no vertical inset).
  // Split mode uses exact anchor geometry so the popup lines up with the gutter.
  function boundsFromAnchorWindow(anchor) {
    if (isSplitDockMode()) {
      return splitGutterBoundsFromAnchor(anchor);
    }
    var width = activePanelWidth();
    var height = Math.max(MIN_PANEL_HEIGHT, anchor.height);
    var left = anchor.left + anchor.width - width;
    if (left < anchor.left) left = anchor.left;
    return {
      width: width,
      height: height,
      left: left,
      top: anchor.top,
    };
  }

  // Anchor window beats display work area — work area is fallback for split dock.
  function getPanelBoundsSync() {
    if (isSplitDockMode()) {
      if (cachedAnchorWindow) {
        return boundsFromAnchorWindow(cachedAnchorWindow);
      }
      if (cachedWorkArea) {
        log("split dock: using display work area until anchor resolves");
        return boundsFromWorkArea(cachedWorkArea);
      }
      return { width: activePanelWidth(), height: POPUP_HEIGHT };
    }
    if (cachedAnchorWindow) {
      return boundsFromAnchorWindow(cachedAnchorWindow);
    }
    if (cachedWorkArea) {
      return boundsFromWorkArea(cachedWorkArea);
    }
    return { width: POPUP_WIDTH, height: POPUP_HEIGHT };
  }

  function panelWindowUpdateOpts(bounds, options) {
    var repositionOnly = options && options.repositionOnly;
    var opts = {
      focused: !repositionOnly,
      drawAttention: !repositionOnly,
      width: bounds.width,
      height: bounds.height,
    };
    if (bounds.left != null) opts.left = bounds.left;
    if (bounds.top != null) opts.top = bounds.top;
    return opts;
  }

  function syncPanelToAnchor(repositionOnly) {
    if (memPanelWindowId == null || memPanelInTab) return;
    if (!cachedAnchorWindow) return;
    try {
      chrome.windows.update(
        memPanelWindowId,
        panelWindowUpdateOpts(boundsFromAnchorWindow(cachedAnchorWindow), {
          repositionOnly: !!repositionOnly,
        }),
        function () {
          void chrome.runtime.lastError;
        }
      );
    } catch (_e) {
      /* no-op */
    }
  }

  function handleAnchorWindowChange(win) {
    if (!win || win.id == null || win.id === memPanelWindowId) return;
    if (memAnchorWindowId != null && win.id !== memAnchorWindowId) return;

    if (win.state === "minimized" || win.state === "fullscreen") {
      if (memPanelWindowId != null && !panelHiddenForAnchor) {
        panelHiddenForAnchor = true;
        try {
          chrome.windows.update(memPanelWindowId, { state: "minimized" }, function () {
            void chrome.runtime.lastError;
          });
        } catch (_e) {
          /* no-op */
        }
      }
      return;
    }

    var anchor = anchorFromWindow(win);
    if (!anchor) return;
    setActiveAnchor(anchor);

    if (memPanelWindowId == null) return;

    if (panelHiddenForAnchor && win.state === "normal") {
      panelHiddenForAnchor = false;
      try {
        chrome.windows.update(
          memPanelWindowId,
          Object.assign(panelWindowUpdateOpts(boundsFromAnchorWindow(anchor)), {
            state: "normal",
            focused: false,
          }),
          function () {
            void chrome.runtime.lastError;
          }
        );
        return;
      } catch (_e2) {
        /* fall through */
      }
    }
    syncPanelToAnchor();
  }

  function pickBestBrowserWindow(wins) {
    var best = null;
    var bestArea = 0;
    for (var i = 0; i < (wins || []).length; i++) {
      var w = wins[i];
      var anchor = anchorFromWindow(w);
      if (!anchor) continue;
      var area = anchor.width * anchor.height;
      if (area > bestArea) {
        bestArea = area;
        best = anchor;
      }
    }
    return best;
  }

  function resolveFocusedBrowserWindow(callback) {
    try {
      chrome.windows.getLastFocused(function (win) {
        void chrome.runtime.lastError;
        var anchor = anchorFromWindow(win);
        if (anchor) {
          callback(anchor);
          return;
        }
        chrome.windows.getAll({ populate: false }, function (allWins) {
          void chrome.runtime.lastError;
          callback(pickBestBrowserWindow(allWins));
        });
      });
    } catch (_e) {
      callback(null);
    }
  }

  function resolveAnchorForTab(tabId, callback) {
    if (tabId != null) {
      var tabCached = anchorByTabId.get(tabId);
      if (tabCached && tabCached.left != null) {
        callback(tabCached);
        return;
      }
      try {
        chrome.tabs.get(tabId, function (tab) {
          void chrome.runtime.lastError;
          if (!tab || tab.windowId == null) {
            resolveFocusedBrowserWindow(callback);
            return;
          }
          chrome.windows.get(tab.windowId, function (win) {
            void chrome.runtime.lastError;
            var anchor = anchorFromWindow(win);
            if (anchor) {
              cacheAnchorForTab(tabId, anchor);
              callback(anchor);
              return;
            }
            resolveFocusedBrowserWindow(callback);
          });
        });
        return;
      } catch (_e2) {
        resolveFocusedBrowserWindow(callback);
        return;
      }
    }
    resolveFocusedBrowserWindow(callback);
  }

  function primeAnchorForOpen(tabId, callback) {
    resolveAnchorForTab(tabId, function (anchor) {
      if (anchor) {
        setActiveAnchor(anchor);
        if (tabId != null) cacheAnchorForTab(tabId, anchor);
        log(
          "anchor window id=" +
            (anchor.id != null ? anchor.id : "?") +
            " @" +
            anchor.left +
            "," +
            anchor.top +
            " " +
            anchor.width +
            "x" +
            anchor.height
        );
      }
      if (callback) callback(anchor);
    });
  }

  function refreshDisplayWorkArea() {
    if (!chrome.system || !chrome.system.display || !chrome.system.display.getInfo) {
      return;
    }
    try {
      chrome.system.display.getInfo(function (displays) {
        void chrome.runtime.lastError;
        if (!displays || !displays.length) return;
        var primary =
          displays.find(function (d) {
            return d && d.isPrimary;
          }) || displays[0];
        var work = (primary && (primary.workArea || primary.bounds)) || null;
        if (work && work.width > 0 && work.height > 0) {
          cachedWorkArea = {
            left: work.left,
            top: work.top,
            width: work.width,
            height: work.height,
          };
          log(
            "cached display work area " +
              cachedWorkArea.width +
              "x" +
              cachedWorkArea.height
          );
        }
      });
    } catch (_e) {
      /* no-op */
    }
  }

  function wireAnchorWindowCache() {
    if (!isServiceWorkerContext()) return;
    try {
      chrome.windows.getLastFocused(function (win) {
        void chrome.runtime.lastError;
        updateCachedAnchor(win);
        if (win && win.id != null) memAnchorWindowId = win.id;
      });
      if (chrome.windows.onFocusChanged) {
        chrome.windows.onFocusChanged.addListener(function (windowId) {
          if (windowId === chrome.windows.WINDOW_ID_NONE) return;
          if (
            isSplitDockMode() &&
            memPanelWindowId != null &&
            memSplitTabId != null &&
            (windowId === memPanelWindowId || windowId === memAnchorWindowId)
          ) {
            syncSplitPopupToGutter(memSplitTabId, function () {});
          }
          try {
            chrome.windows.get(windowId, function (win) {
              void chrome.runtime.lastError;
              if (isOurPanelWindow(win)) return;
              updateCachedAnchor(win);
              if (win && win.id != null) memAnchorWindowId = win.id;
            });
          } catch (_e) {
            /* no-op */
          }
        });
      }
      if (chrome.windows.onBoundsChanged) {
        chrome.windows.onBoundsChanged.addListener(function (windowId) {
          try {
            if (windowId === memPanelWindowId) {
              if (isSplitDockMode() && memSplitTabId != null) {
                syncSplitPopupToGutter(memSplitTabId, function () {});
              }
              return;
            }
            chrome.windows.get(windowId, function (win) {
              void chrome.runtime.lastError;
              if (isOurPanelWindow(win)) return;
              if (memAnchorWindowId != null && windowId !== memAnchorWindowId) return;
              handleAnchorWindowChange(win);
            });
          } catch (_e2) {
            /* no-op */
          }
        });
      }
      if (chrome.tabs && chrome.tabs.onActivated) {
        chrome.tabs.onActivated.addListener(function (info) {
          if (!info || info.tabId == null) return;
          try {
            chrome.tabs.get(info.tabId, function (tab) {
              void chrome.runtime.lastError;
              if (!tab || tab.windowId == null) return;
              chrome.windows.get(tab.windowId, function (win) {
                void chrome.runtime.lastError;
                var anchor = anchorFromWindow(win);
                if (anchor) cacheAnchorForTab(info.tabId, anchor);
              });
            });
          } catch (_e3) {
            /* no-op */
          }
        });
      }
    } catch (_e4) {
      /* no-op */
    }
    refreshDisplayWorkArea();
  }

  function forcePanelWindowBounds(windowId, bounds, callback) {
    if (windowId == null || bounds.left == null || bounds.top == null) {
      if (callback) callback();
      return;
    }
    try {
      chrome.windows.update(
        windowId,
        panelWindowUpdateOpts(bounds, { repositionOnly: true }),
        function () {
          var err = chrome.runtime.lastError;
          if (err) {
            warn(
              "windows.update bounds correction failed:",
              err.message || String(err)
            );
          } else {
            log(
              "bounds corrected @" +
                bounds.left +
                "," +
                bounds.top +
                " " +
                bounds.width +
                "x" +
                bounds.height
            );
          }
          if (callback) callback();
        }
      );
    } catch (_e) {
      if (callback) callback();
    }
  }

  // Create a panel window. Calls onDone(true) on success, onDone(false) on failure.
  // Must be invoked synchronously inside a user-gesture handler when possible.
  function createPanelWindow(url, windowType, onDone) {
    if (windowType === "normal" && shouldSkipNormalWindowFallback()) {
      warn("refusing windows.create type=normal on Arc (opens blank arc://new-tab-page/)");
      if (onDone) onDone(false);
      return;
    }
    panelCreatePending = true;
    var bounds = getPanelBoundsSync();
    var splitDock = isSplitDockMode();
    var createOpts = {
      url: url,
      type: windowType,
      width: bounds.width,
      height: bounds.height,
      focused: !(splitDock && windowType === "popup"),
    };
    if (bounds.left != null) createOpts.left = bounds.left;
    if (bounds.top != null) createOpts.top = bounds.top;
    if (windowType === "normal") {
      createOpts.state = "normal";
    }
    if (splitDock && windowType === "popup") {
      log(
        "split dock popup @" +
          bounds.left +
          "," +
          bounds.top +
          " " +
          bounds.width +
          "x" +
          bounds.height
      );
    }
    try {
      chrome.windows.create(createOpts, function (win) {
        var err = chrome.runtime.lastError;
        if (err) {
          warn("windows.create type=" + windowType + " failed:", err.message || String(err));
        }
        if (win && win.id != null) {
          log(
            "opened panel window id=" +
              win.id +
              " type=" +
              windowType +
              " " +
              bounds.width +
              "x" +
              bounds.height +
              (bounds.left != null ? " @" + bounds.left + "," + bounds.top : "")
          );
          var firstTab = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
          persistPanelTarget(win.id, firstTab, false);
          forcePanelWindowBounds(win.id, bounds, function () {
            panelCreatePending = false;
            if (onDone) onDone(true);
          });
          return;
        }
        panelCreatePending = false;
        if (onDone) onDone(false);
      });
    } catch (e) {
      panelCreatePending = false;
      warn("windows.create threw:", e && e.message ? e.message : String(e));
      if (onDone) onDone(false);
    }
  }

  function createPanelTab(url, onDone) {
    if (isSplitDockMode()) {
      warn("split mode: refusing tabs.create fallback (prevents duplicate sidepanel tabs)");
      if (onDone) onDone(false);
      return;
    }
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
      if (shouldSkipNormalWindowFallback()) {
        warn(
          "popup window failed on Arc; skipping type=normal (opens blank arc://new-tab-page/)"
        );
        log("falling back to tabs.create");
        createPanelTab(url, function (ok3) {
          if (!ok3) {
            notifyOpenFailure(
              "Could not open Claude panel. Run: claude-in-arc install, then Reload in arc://extensions."
            );
          }
          if (onDone) onDone(!!ok3);
        });
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
        var bounds = getPanelBoundsSync();
        chrome.windows.update(
          memPanelWindowId,
          panelWindowUpdateOpts(bounds),
          function () {
            void chrome.runtime.lastError;
          }
        );
        if (isSplitDockMode() && memSplitTabId != null) {
          syncSplitPopupToGutter(memSplitTabId, function () {});
        }
        log("focused existing panel window id=" + memPanelWindowId);
        return true;
      } catch (_e) {
        return false;
      }
    }
    return false;
  }

  function shouldDedupePanelOpen(tabId, reason) {
    tabId = normalizeTabId(tabId);
    var now = Date.now();
    if (panelOpenInFlight || panelCreatePending) {
      log(
        "openPanelImmediate deduped (in-flight) tabId=" +
          tabId +
          " reason=" +
          (reason || "unknown")
      );
      return true;
    }
    if (
      tabId != null &&
      tabIdsEqual(panelOpenLastTabId, tabId) &&
      now - panelOpenLastAt < PANEL_OPEN_DEDUPE_MS
    ) {
      log(
        "openPanelImmediate deduped (debounce) tabId=" +
          tabId +
          " reason=" +
          (reason || "unknown")
      );
      return true;
    }
    return false;
  }

  function markPanelOpenStarted(tabId) {
    tabId = normalizeTabId(tabId);
    panelOpenInFlight = true;
    panelOpenLastTabId = tabId;
  }

  function markPanelOpenFinished(tabId) {
    tabId = normalizeTabId(tabId);
    panelOpenInFlight = false;
    panelCreatePending = false;
    panelOpenLastTabId = tabId;
    panelOpenLastAt = Date.now();
  }

  // Synchronous-first open for toolbar clicks (preserves user gesture).
  function openPanelImmediate(tabId, reason) {
    tabId = normalizeTabId(tabId);
    var path = resolvePath(tabId);
    var url = chrome.runtime.getURL(path);
    log(
      "openPanelImmediate tabId=" +
        tabId +
        " reason=" +
        (reason || "unknown") +
        " mode=" +
        cachedPanelMode +
        " effective=" +
        effectivePanelMode() +
        (isArcBrowser() && arcExplicitPopupMode ? " (explicit-popup)" : "") +
        " url=" +
        path
    );

    if (effectivePanelMode() === "hud") {
      return openPanelInHud(tabId, reason);
    }

    if (effectivePanelMode() === "sidebar" && tabId != null) {
      return openPanelInSidebar(tabId, reason);
    }

    if (effectivePanelMode() === "split" && tabId != null) {
      return openPanelInSplit(tabId, reason);
    }

    if (shouldDedupePanelOpen(tabId, reason)) {
      if (focusExistingPanel(url)) {
        return Promise.resolve(true);
      }
      return Promise.resolve(true);
    }

    if (focusExistingPanel(url)) {
      markPanelOpenFinished(tabId);
      return Promise.resolve(true);
    }

    markPanelOpenStarted(tabId);
    panelCreatePending = true;

    return new Promise(function (resolve) {
      primeAnchorForOpen(tabId, function () {
        tryOpenWithFallbacks(url, function (ok) {
          if (ok && memPanelWindowId != null && memAnchorWindowId != null) {
            syncPanelToAnchor();
          }
          markPanelOpenFinished(tabId);
          resolve(ok);
        });
      });
    });
  }

  async function openOrFocusPanel(tabId) {
    if (tabId != null) {
      await openPanelImmediate(tabId, "openOrFocusPanel");
      return;
    }

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

    if (shouldDedupePanelOpen(tabId, "openOrFocusPanel")) {
      if (focusExistingPanel(url)) {
        return;
      }
      return;
    }

    markPanelOpenStarted(tabId);
    await new Promise(function (resolve) {
      primeAnchorForOpen(tabId, function () {
        tryOpenWithFallbacks(url, function (ok) {
          markPanelOpenFinished(tabId);
          resolve(!!ok);
        });
      });
    });
  }

  // When the user closes the panel popup via the OS window chrome (red ×), also
  // remove the page margin so the tab returns to full width. During reopen
  // (panelCreatePending / panelOpenInFlight) we keep the margin to avoid a flash.
  try {
    if (chrome.windows && chrome.windows.onRemoved) {
      chrome.windows.onRemoved.addListener(function (closedId) {
        if (memPanelWindowId === closedId) {
          var replacingPanel =
            panelOpenInFlight ||
            panelCreatePending ||
            splitBoundsSyncInFlight;
          var withinHideGuard = shouldSuppressSplitHide(memSplitTabId, false);
          if (memSplitTabId != null && !replacingPanel && !withinHideGuard) {
            hideSplitOnTab(memSplitTabId, function (hidden) {
              if (hidden) memSplitTabId = null;
            });
          } else if (replacingPanel || withinHideGuard) {
            log(
              "panel window removed during open/guard; keeping split margin tabId=" +
                memSplitTabId
            );
          }
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
  var commandHandlerWired = false;

  // The upstream worker registers chrome.action.onClicked and calls
  // sidePanel.setOptions + sidePanel.open itself. We must NOT also register
  // action.onClicked or open_side_panel message handlers here — both fire on the
  // same user gesture and would open two panel windows before the first create
  // callback persists memPanelWindowId. Panel creation is centralized in
  // sidePanel.open → openPanelImmediate (with single-flight dedupe).
  //
  // Setting action.setPopup to a non-empty path PREVENTS onClicked from firing;
  // Arc often does not show action popups anyway — so we keep popup cleared.
  function wireToolbarOpenHandlers() {
    if (chrome.action && chrome.action.setPopup) {
      try {
        chrome.action.setPopup({ popup: "" }, function () {
          void chrome.runtime.lastError;
        });
        log("cleared action.setPopup so onClicked can fire");
      } catch (_e) { /* no-op */ }
    }

    if (!commandHandlerWired && chrome.commands && chrome.commands.onCommand) {
      commandHandlerWired = true;
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
  }

  var sidePanelPolyfill = {
    // Marker so other code / diagnostics can detect the shim.
    __claudeInArcShim: true,

    setOptions: function (options, callback) {
      try {
        if (options && options.tabId != null) {
          var tid = normalizeTabId(options.tabId);
          if (tid != null) optionsByTab.set(tid, options);
        }
      } catch (_e) { /* no-op */ }
      return settle(callback, undefined);
    },

    getOptions: function (options, callback) {
      var tabId = normalizeTabId(options && options.tabId);
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
        tabId = normalizeTabId(tabId);
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
  loadPanelModeFromStorage();
  wireAnchorWindowCache();
  wireToolbarOpenHandlers();
  wireSidebarLifecycle();
  wireSplitLifecycle();
  wireHudLifecycle();
  wirePanelModeContextMenu();
  if (isHudMode()) {
    ensureHudPort();
  }

  // Upstream may register after us; re-assert cleared popup + handlers.
  if (isServiceWorkerContext()) {
    try {
      setTimeout(wireToolbarOpenHandlers, 0);
      setTimeout(wireToolbarOpenHandlers, 1000);
      setTimeout(wirePanelModeContextMenu, 0);
      setTimeout(wirePanelModeContextMenu, 1000);
    } catch (_e) { /* no-op */ }
  }
})();
