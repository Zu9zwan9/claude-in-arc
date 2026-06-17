/*
 * claude-arc-hud-bridge.js
 * Loaded by claude-in-arc-hud-bridge.html inside the ClaudeInArcHUD WKWebView.
 * Embeds sidepanel.html via the claude-in-arc-ext:// scheme (served from the
 * patched extension directory by the native HUD app).
 */
(function () {
  "use strict";

  var LOG_PREFIX = "[claude-in-arc] hud bridge";
  var LOAD_TIMEOUT_MS = 20000;
  var EXT_SCHEME = "claude-in-arc-ext";

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
    var el = document.getElementById("claude-in-arc-hud-bridge-error");
    if (el) {
      el.textContent = message;
    }
    document.body.setAttribute("data-error", "true");
  }

  function extUrl(path) {
    var clean = String(path || "").replace(/^\//, "");
    return EXT_SCHEME + "://localhost/" + clean;
  }

  var params = new URLSearchParams(location.search || "");
  var tabId = params.get("tabId");
  if (!tabId) {
    warn("missing tabId query param; sidepanel may lack page context");
  }

  var path = "sidepanel.html";
  if (tabId) path += "?tabId=" + encodeURIComponent(tabId);
  var sidepanelUrl = extUrl(path);
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
  }

  frame.addEventListener("load", function () {
    log("sidepanel iframe load event");
    markReady();
  });

  frame.addEventListener("error", function () {
    warn("sidepanel iframe error event");
    clearLoadTimer();
    showError(
      "Claude panel failed to load in the HUD. Run claude-in-arc install --panel-mode hud, claude-in-arc hud install, reload the extension, and ensure only the Load unpacked copy is enabled (remove any Store Claude entry on arc://extensions)."
    );
  });

  loadTimer = setTimeout(function () {
    if (panelReady) return;
    warn("sidepanel iframe load timeout after " + LOAD_TIMEOUT_MS + "ms");
    showError(
      "Claude panel is taking too long to load. Run claude-in-arc doctor — remove any Store Claude copy on arc://extensions, Reload, then press ⌘E again. Check Console.app → ClaudeInArcHUD for scheme 404 errors."
    );
  }, LOAD_TIMEOUT_MS);

  document.body.appendChild(frame);
  log("sidepanel iframe appended");
})();
