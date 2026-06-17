/*
 * arc-shim-prelude.js
 * -----------------------------------------------------------------------------
 * Runs before claude-arc-shim.js in the Arc service worker import chain.
 * Arc extension service workers often omit "Arc/" from navigator.userAgent while
 * still exposing no-op native chrome.sidePanel bindings — the shim must install
 * anyway. This tiny module sets that flag synchronously during the first import
 * evaluation (ES module imports are hoisted and ordered).
 * -----------------------------------------------------------------------------
 */
"use strict";

globalThis.__CLAUDE_IN_ARC_FORCE_POLYFILL = true;

try {
  console.log("[claude-in-arc] arc-shim-prelude loaded (service worker)");
} catch (_e) { /* no-op */ }
