/*
 * claude-arc-sidebar-bridge.js
 * Loaded by claude-arc-sidebar-bridge.html (extension origin). MV3 CSP blocks
 * inline scripts on extension pages, so this must be an external file.
 */
(function () {
  "use strict";

  var LOG_PREFIX = "[claude-in-arc] sidebar bridge";
  var LOAD_TIMEOUT_MS = 12000;

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(LOG_PREFIX);
      console.log.apply(console, args);
    } catch (_e) {
      /* no-op */
    }
  }

  function warn() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(LOG_PREFIX);
      console.warn.apply(console, args);
    } catch (_e2) {
      /* no-op */
    }
  }

  function showError(message) {
    var el = document.getElementById("claude-in-arc-bridge-error");
    if (el) {
      el.textContent = message;
    }
    document.body.setAttribute("data-error", "true");
    try {
      window.parent.postMessage(
        { type: "claude-in-arc-sidebar-panel-error", message: message },
        "*"
      );
    } catch (_e3) {
      /* no-op */
    }
  }

  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) {
    warn("chrome.runtime unavailable; cannot load sidepanel");
    showError("Sidebar bridge cannot access extension APIs. Reload the extension.");
    return;
  }

  var params = new URLSearchParams(location.search || "");
  var tabId = params.get("tabId");
  if (!tabId) {
    warn("missing tabId query param; sidepanel may lack page context");
  }

  var path = "sidepanel.html";
  if (tabId) path += "?tabId=" + encodeURIComponent(tabId);
  var sidepanelUrl = chrome.runtime.getURL(path);
  log("creating sidepanel iframe url=" + sidepanelUrl);

  var frame = document.createElement("iframe");
  frame.src = sidepanelUrl;
  frame.setAttribute("allow", "clipboard-read; clipboard-write");
  frame.setAttribute("title", "Claude");

  var loadTimer = null;
  var panelReady = false;

  function clearLoadTimer() {
    if (loadTimer != null) {
      clearTimeout(loadTimer);
      loadTimer = null;
    }
  }

  function markReady() {
    panelReady = true;
    clearLoadTimer();
    document.body.removeAttribute("data-error");
    log("sidepanel iframe ready");
    try {
      window.parent.postMessage(
        { type: "claude-in-arc-sidebar-panel-ready", tabId: tabId },
        "*"
      );
    } catch (_e4) {
      /* no-op */
    }
  }

  frame.addEventListener("load", function () {
    log("sidepanel iframe load event");
    markReady();
  });

  frame.addEventListener("error", function () {
    warn("sidepanel iframe error event");
    clearLoadTimer();
    showError(
      "Claude panel failed to load inside the sidebar. Try popup mode (right-click extension icon) or reload."
    );
  });

  loadTimer = setTimeout(function () {
    if (panelReady) return;
    warn("sidepanel iframe load timeout after " + LOAD_TIMEOUT_MS + "ms");
    showError(
      "Claude panel is taking too long to load. Check arc://extensions service worker console or switch to popup mode."
    );
  }, LOAD_TIMEOUT_MS);

  document.body.appendChild(frame);
  log("sidepanel iframe appended");
})();
