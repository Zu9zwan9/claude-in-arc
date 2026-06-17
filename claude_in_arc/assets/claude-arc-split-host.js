/*
 * claude-arc-split-host.js
 * -----------------------------------------------------------------------------
 * Arc split-panel host: shrinks page content with margin-right and a thin
 * invisible resize strip. Claude renders in a docked popup window flush to the
 * gutter — not in a page iframe (Arc blocks those). No visible gutter chrome:
 * the popup fills the margin column so users do not see an empty white strip.
 * -----------------------------------------------------------------------------
 */
(function () {
  "use strict";

  var STYLE_ID = "claude-in-arc-split-style";
  var GUTTER_ID = "claude-in-arc-split-gutter";
  var LOG_PREFIX = "[claude-in-arc] split";
  var DEFAULT_WIDTH = 410;
  var MIN_WIDTH = 320;
  var MAX_WIDTH = 720;
  var Z_INDEX = 2147483645;
  var HIDE_GUARD_MS = 500;

  if (window.__claudeInArcSplitHost) {
    return;
  }
  window.__claudeInArcSplitHost = true;

  var state = {
    visible: false,
    width: DEFAULT_WIDTH,
    lastShowAt: 0,
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

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "html.claude-in-arc-split-open{overflow-x:hidden!important}" +
      "body.claude-in-arc-split-open{margin-right:var(--claude-in-arc-split-width," +
      DEFAULT_WIDTH +
      "px)!important;transition:margin-right .15s ease}" +
      "#" +
      GUTTER_ID +
      "{position:fixed;top:0;right:0;height:100vh;width:var(--claude-in-arc-split-width," +
      DEFAULT_WIDTH +
      "px);z-index:" +
      Z_INDEX +
      ";background:transparent!important;pointer-events:none;display:none}" +
      "#" +
      GUTTER_ID +
      '[data-open="true"]{display:block}' +
      "#" +
      GUTTER_ID +
      " .claude-in-arc-split-resize{position:absolute;left:0;top:0;width:8px;height:100%;cursor:col-resize;z-index:2;pointer-events:auto}" +
      "#" +
      GUTTER_ID +
      " .claude-in-arc-split-edge{display:none}" +
      "#" +
      GUTTER_ID +
      " .claude-in-arc-split-close{display:none}";
    (document.head || document.documentElement).appendChild(style);
  }

  function applyWidth(width) {
    var w = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width || DEFAULT_WIDTH));
    state.width = w;
    document.documentElement.style.setProperty("--claude-in-arc-split-width", w + "px");
    var gutter = document.getElementById(GUTTER_ID);
    if (gutter) gutter.style.setProperty("--claude-in-arc-split-width", w + "px");
    return w;
  }

  function ensureGutter() {
    ensureStyles();
    var gutter = document.getElementById(GUTTER_ID);
    if (gutter) return gutter;

    gutter = document.createElement("div");
    gutter.id = GUTTER_ID;
    gutter.setAttribute("data-open", "false");
    gutter.setAttribute("aria-hidden", "true");

    var edge = document.createElement("div");
    edge.className = "claude-in-arc-split-edge";

    var resize = document.createElement("div");
    resize.className = "claude-in-arc-split-resize";
    resize.setAttribute("aria-hidden", "true");
    wireResize(resize);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "claude-in-arc-split-close";
    closeBtn.setAttribute("aria-label", "Close Claude panel");
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", function () {
      hideSplit();
      try {
        chrome.runtime.sendMessage({ type: "claude-in-arc-split-closed" });
      } catch (_e2) {
        /* no-op */
      }
    });

    gutter.appendChild(edge);
    gutter.appendChild(resize);
    gutter.appendChild(closeBtn);
    (document.body || document.documentElement).appendChild(gutter);
    log("split host injected gutter=" + GUTTER_ID);
    return gutter;
  }

  function wireResize(handle) {
    var dragging = false;
    var startX = 0;
    var startW = 0;

    function onMove(ev) {
      if (!dragging) return;
      var dx = startX - (ev.clientX || 0);
      var w = applyWidth(startW + dx);
      try {
        chrome.runtime.sendMessage({
          type: "claude-in-arc-split-resize",
          width: w,
        });
      } catch (_e) {
        /* no-op */
      }
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

  function showSplit(width) {
    applyWidth(width || DEFAULT_WIDTH);
    var gutter = ensureGutter();
    gutter.setAttribute("data-open", "true");
    gutter.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("claude-in-arc-split-open");
    if (document.body) document.body.classList.add("claude-in-arc-split-open");
    state.visible = true;
    state.lastShowAt = Date.now();
    log("show width=" + state.width);
    return true;
  }

  function hideSplit() {
    var gutter = document.getElementById(GUTTER_ID);
    if (gutter) {
      gutter.setAttribute("data-open", "false");
      gutter.setAttribute("aria-hidden", "true");
    }
    document.documentElement.classList.remove("claude-in-arc-split-open");
    if (document.body) document.body.classList.remove("claude-in-arc-split-open");
    state.visible = false;
    log("hidden");
    return true;
  }

  try {
    chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
      if (!msg || msg.type !== "claude-in-arc-split") return;
      var ok = false;
      if (msg.action === "show") ok = showSplit(msg.width);
      else if (msg.action === "hide") {
        if (
          !msg.explicit &&
          state.visible &&
          state.lastShowAt &&
          Date.now() - state.lastShowAt < HIDE_GUARD_MS
        ) {
          log(
            "hide suppressed (" +
              (Date.now() - state.lastShowAt) +
              "ms since show)"
          );
          ok = false;
        } else {
          ok = hideSplit();
        }
      }
      else if (msg.action === "update") ok = showSplit(msg.width);
      log("message action=" + (msg.action || "?") + " ok=" + ok);
      sendResponse({ ok: ok, visible: state.visible, width: state.width });
      return true;
    });
    log("message listener registered");
  } catch (e) {
    log("message listener failed:", e && e.message ? e.message : String(e));
  }
})();
