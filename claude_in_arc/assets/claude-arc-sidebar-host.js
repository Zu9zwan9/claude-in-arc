/*
 * claude-arc-sidebar-host.js
 * -----------------------------------------------------------------------------
 * In-page sidebar host injected into the active tab by claude-arc-shim.js when
 * panel mode is "sidebar". Renders a fixed right-hand column with an iframe
 * pointing at claude-arc-sidebar-bridge.html (extension origin).
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  var ROOT_ID = "claude-in-arc-sidebar-root";
  var STYLE_ID = "claude-in-arc-sidebar-style";
  var LOG_PREFIX = "[claude-in-arc] sidebar";
  var DEFAULT_WIDTH = 410;
  var MIN_WIDTH = 320;
  var MAX_WIDTH = 720;
  var Z_INDEX = 2147483646;
  var LOAD_TIMEOUT_MS = 12000;

  if (window.__claudeInArcSidebarHost) {
    return;
  }
  window.__claudeInArcSidebarHost = true;

  var state = {
    visible: false,
    width: DEFAULT_WIDTH,
    url: "",
    loadTimer: null,
    panelReady: false,
  };

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

  function tabIdFromBridgeUrl(url) {
    if (!url) return null;
    try {
      var q = url.indexOf("?");
      if (q === -1) return null;
      var params = new URLSearchParams(url.slice(q));
      return params.get("tabId");
    } catch (_e) {
      return null;
    }
  }

  function detectBlockedIframe(frame) {
    try {
      var doc =
        frame.contentDocument ||
        (frame.contentWindow && frame.contentWindow.document);
      if (!doc) return false;
      var title = (doc.title || "").toLowerCase();
      var bodyText = doc.body
        ? doc.body.innerText || doc.body.textContent || ""
        : "";
      var text = (title + " " + bodyText).toLowerCase();
      return (
        text.indexOf("blocked by arc") !== -1 ||
        text.indexOf("this page has been blocked") !== -1
      );
    } catch (_e2) {
      return false;
    }
  }

  function reportIframeBlocked(root, frame) {
    clearLoadTimer();
    state.panelReady = false;
    root.setAttribute("data-panel-ready", "false");
    setPanelStatus(
      root,
      "Arc blocked in-page sidebar — opening docked popup\u2026",
      true
    );
    warn("bridge iframe blocked by Arc url=" + (frame.src || ""));
    try {
      chrome.runtime.sendMessage({
        type: "claude-in-arc-sidebar-iframe-blocked",
        tabId: tabIdFromBridgeUrl(frame.src || state.url),
        reason: "arc-iframe-block",
      });
    } catch (_e3) {
      /* no-op */
    }
  }

  function scheduleBlockDetection(root, frame) {
    setTimeout(function () {
      if (state.panelReady || !state.visible) return;
      if (detectBlockedIframe(frame)) {
        reportIframeBlocked(root, frame);
      }
    }, 800);
  }

  function clearLoadTimer() {
    if (state.loadTimer != null) {
      clearTimeout(state.loadTimer);
      state.loadTimer = null;
    }
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "#" +
      ROOT_ID +
      "{position:fixed;top:0;right:0;height:100vh;min-height:100vh;width:var(--claude-in-arc-sidebar-width," +
      DEFAULT_WIDTH +
      "px);z-index:" +
      Z_INDEX +
      ";box-shadow:-2px 0 12px rgba(0,0,0,.18);background:#1a1a1a;display:none;overflow:hidden}" +
      "#" +
      ROOT_ID +
      '[data-open="true"]{display:flex;flex-direction:column}' +
      "#" +
      ROOT_ID +
      " .claude-in-arc-frame-wrap{position:relative;flex:1 1 auto;min-height:0;width:100%;display:flex;flex-direction:column}" +
      "#" +
      ROOT_ID +
      " iframe{border:0;flex:1 1 auto;min-height:0;width:100%;height:100%;background:#1a1a1a}" +
      "#" +
      ROOT_ID +
      " .claude-in-arc-status{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;text-align:center;color:#e8e8e8;font:13px/1.4 system-ui,-apple-system,sans-serif;pointer-events:none;z-index:1}" +
      "#" +
      ROOT_ID +
      '[data-panel-ready="true"] .claude-in-arc-status{display:none}' +
      "#" +
      ROOT_ID +
      " .claude-in-arc-resize{position:absolute;left:0;top:0;width:6px;height:100%;cursor:col-resize;z-index:3}" +
      "#" +
      ROOT_ID +
      " .claude-in-arc-close{position:absolute;top:8px;left:8px;z-index:4;width:28px;height:28px;border:0;border-radius:6px;background:rgba(0,0,0,.45);color:#fff;font-size:18px;line-height:1;cursor:pointer}" +
      "html.claude-in-arc-sidebar-open{overflow-x:hidden!important}" +
      "body.claude-in-arc-sidebar-open{margin-right:var(--claude-in-arc-sidebar-width," +
      DEFAULT_WIDTH +
      "px)!important;transition:margin-right .15s ease}";
    (document.head || document.documentElement).appendChild(style);
  }

  function setPanelStatus(root, message, isError) {
    var status = root.querySelector(".claude-in-arc-status");
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? "#ffb4b4" : "#e8e8e8";
    root.setAttribute("data-panel-ready", "false");
  }

  function markPanelReady(root) {
    state.panelReady = true;
    clearLoadTimer();
    root.setAttribute("data-panel-ready", "true");
    log("panel ready");
  }

  function wireBridgeMessages(root) {
    if (window.__claudeInArcSidebarBridgeListener) return;
    window.__claudeInArcSidebarBridgeListener = true;
    window.addEventListener("message", function (ev) {
      var data = ev && ev.data;
      if (!data || !state.visible) return;
      if (data.type === "claude-in-arc-sidebar-panel-ready") {
        markPanelReady(root);
        return;
      }
      if (data.type === "claude-in-arc-sidebar-panel-error") {
        clearLoadTimer();
        setPanelStatus(
          root,
          data.message ||
            "Sidebar failed to load. Try popup mode (right-click extension icon) or reload the page.",
          true
        );
      }
    });
  }

  function wireFrameLoad(root, frame) {
    clearLoadTimer();
    state.panelReady = false;
    root.setAttribute("data-panel-ready", "false");
    setPanelStatus(root, "Loading Claude\u2026", false);

    frame.addEventListener(
      "load",
      function onBridgeLoad() {
        log("bridge iframe load event url=" + (frame.src || ""));
        if (detectBlockedIframe(frame)) {
          reportIframeBlocked(root, frame);
          return;
        }
        scheduleBlockDetection(root, frame);
      },
      { once: true }
    );

    frame.addEventListener(
      "error",
      function onBridgeError() {
        warn("bridge iframe error url=" + (frame.src || ""));
        setPanelStatus(
          root,
          "Sidebar failed to load. Try popup mode (right-click extension icon) or reload the page.",
          true
        );
        clearLoadTimer();
      },
      { once: true }
    );

    state.loadTimer = setTimeout(function () {
      if (state.panelReady) return;
      if (detectBlockedIframe(frame)) {
        reportIframeBlocked(root, frame);
        return;
      }
      warn("load timeout after " + LOAD_TIMEOUT_MS + "ms url=" + (frame.src || ""));
      setPanelStatus(
        root,
        "Sidebar is taking too long to load. Check the service worker console, reload the page, or switch to popup mode.",
        true
      );
      try {
        chrome.runtime.sendMessage({
          type: "claude-in-arc-sidebar-iframe-blocked",
          tabId: tabIdFromBridgeUrl(frame.src || state.url),
          reason: "load-timeout",
        });
      } catch (_e4) {
        /* no-op */
      }
    }, LOAD_TIMEOUT_MS);
  }

  function ensureRoot() {
    ensureStyles();
    var root = document.getElementById(ROOT_ID);
    if (root) return root;

    root = document.createElement("div");
    root.id = ROOT_ID;
    root.setAttribute("data-open", "false");
    root.setAttribute("data-panel-ready", "false");

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "claude-in-arc-close";
    closeBtn.setAttribute("aria-label", "Close Claude sidebar");
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", function () {
      hideSidebar();
      try {
        chrome.runtime.sendMessage({ type: "claude-in-arc-sidebar-closed" });
      } catch (_e) {
        /* no-op */
      }
    });

    var resize = document.createElement("div");
    resize.className = "claude-in-arc-resize";
    resize.setAttribute("aria-hidden", "true");
    wireResize(resize, root);

    var frameWrap = document.createElement("div");
    frameWrap.className = "claude-in-arc-frame-wrap";

    var status = document.createElement("div");
    status.className = "claude-in-arc-status";
    status.textContent = "Loading Claude\u2026";

    var frame = document.createElement("iframe");
    frame.setAttribute("title", "Claude");
    frame.setAttribute("allow", "clipboard-read; clipboard-write");

    frameWrap.appendChild(status);
    frameWrap.appendChild(frame);
    root.appendChild(resize);
    root.appendChild(closeBtn);
    root.appendChild(frameWrap);
    (document.body || document.documentElement).appendChild(root);

    wireBridgeMessages(root);
    log("host injected root=" + ROOT_ID);
    return root;
  }

  function applyWidth(width) {
    var w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width || DEFAULT_WIDTH));
    state.width = w;
    document.documentElement.style.setProperty("--claude-in-arc-sidebar-width", w + "px");
  }

  function wireResize(handle, root) {
    var dragging = false;
    var startX = 0;
    var startW = 0;

    function onMove(ev) {
      if (!dragging) return;
      var dx = startX - (ev.clientX || 0);
      applyWidth(startW + dx);
      ev.preventDefault();
    }

    function onUp() {
      dragging = false;
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("mouseup", onUp, true);
    }

    handle.addEventListener("mousedown", function (ev) {
      dragging = true;
      startX = ev.clientX || 0;
      startW = state.width;
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onUp, true);
      ev.preventDefault();
    });
  }

  function showSidebar(url, width) {
    var root = ensureRoot();
    var frame = root.querySelector("iframe");
    if (!frame) {
      warn("show failed: iframe missing");
      return false;
    }

    if (!url) {
      warn("show failed: missing bridge url");
      setPanelStatus(root, "Sidebar URL missing. Reload the extension and try again.", true);
      return false;
    }

    applyWidth(width || DEFAULT_WIDTH);
    log("show url=" + url + " width=" + state.width);

    if (url !== state.url) {
      wireFrameLoad(root, frame);
      frame.src = url;
      state.url = url;
    } else if (!state.panelReady) {
      wireFrameLoad(root, frame);
      frame.src = url;
    }

    root.setAttribute("data-open", "true");
    document.documentElement.classList.add("claude-in-arc-sidebar-open");
    if (document.body) document.body.classList.add("claude-in-arc-sidebar-open");
    state.visible = true;
    return true;
  }

  function hideSidebar() {
    var root = document.getElementById(ROOT_ID);
    if (root) root.setAttribute("data-open", "false");
    document.documentElement.classList.remove("claude-in-arc-sidebar-open");
    if (document.body) document.body.classList.remove("claude-in-arc-sidebar-open");
    state.visible = false;
    state.panelReady = false;
    clearLoadTimer();
    log("hidden");
    return true;
  }

  function toggleSidebar(url, width) {
    if (state.visible) return hideSidebar();
    return showSidebar(url, width);
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (!msg || msg.type !== "claude-in-arc-sidebar") return;
      var ok = false;
      if (msg.action === "show") ok = showSidebar(msg.url, msg.width);
      else if (msg.action === "hide") ok = hideSidebar();
      else if (msg.action === "toggle") ok = toggleSidebar(msg.url, msg.width);
      else if (msg.action === "update") ok = showSidebar(msg.url, msg.width);
      log("message action=" + (msg.action || "?") + " ok=" + ok);
      sendResponse({ ok: ok, visible: state.visible });
      return true;
    });
    log("message listener registered");
  } catch (e) {
    warn("message listener failed:", e && e.message ? e.message : String(e));
  }
})();
