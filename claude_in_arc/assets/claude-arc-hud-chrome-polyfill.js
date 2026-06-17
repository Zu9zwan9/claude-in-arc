/*
 * claude-arc-hud-chrome-polyfill.js
 * Injected at document start into claude-in-arc-ext:// pages inside the HUD
 * WKWebView. Proxies chrome.* calls to the patched extension via native messaging.
 */
(function () {
  "use strict";

  if (window.__claudeInArcHudChrome) return;
  window.__claudeInArcHudChrome = true;

  var EXT_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
  var EXT_SCHEME = "claude-in-arc-ext";
  var pending = Object.create(null);
  var nextId = 1;

  function hasBridge() {
    return !!(
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.hudChrome
    );
  }

  function extUrl(path) {
    var clean = String(path || "").replace(/^\//, "");
    return EXT_SCHEME + "://localhost/" + clean;
  }

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      if (!hasBridge()) {
        reject(new Error("HUD chrome bridge unavailable"));
        return;
      }
      var id = String(nextId++);
      pending[id] = { resolve: resolve, reject: reject };
      try {
        window.webkit.messageHandlers.hudChrome.postMessage({
          requestId: id,
          method: method,
          args: args || [],
        });
      } catch (e) {
        delete pending[id];
        reject(e);
      }
    });
  }

  window.__claudeInArcHudChromeResolve = function (id, result, error) {
    var entry = pending[id];
    if (!entry) return;
    delete pending[id];
    if (error) entry.reject(new Error(error));
    else entry.resolve(result);
  };

  window.__claudeInArcHudChromeDispatch = function (payload) {
    if (!payload || !payload.id) return;
    window.__claudeInArcHudChromeResolve(payload.id, payload.result, payload.error);
  };

  function storageArea(area) {
    return {
      get: function (keys, callback) {
        var p = call("storage." + area + ".get", [keys]);
        if (typeof callback === "function") p.then(callback);
        return p;
      },
      set: function (items, callback) {
        var p = call("storage." + area + ".set", [items]).then(function () {
          return undefined;
        });
        if (typeof callback === "function") p.then(callback);
        return p;
      },
      remove: function (keys, callback) {
        var p = call("storage." + area + ".remove", [keys]);
        if (typeof callback === "function") p.then(callback);
        return p;
      },
    };
  }

  var runtime = {
    id: EXT_ID,
    getURL: extUrl,
    sendMessage: function (message, optionsOrCallback, callback) {
      var cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
      var p = call("runtime.sendMessage", [message]);
      if (typeof cb === "function") {
        p.then(function (r) {
          cb(r);
        });
      }
      return p;
    },
    connect: function () {
      return {
        onMessage: { addListener: function () {} },
        postMessage: function () {},
        disconnect: function () {},
      };
    },
    onMessage: { addListener: function () {} },
    getManifest: function () {
      return { name: "Claude" };
    },
  };

  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = runtime;
  window.chrome.storage = {
    local: storageArea("local"),
    session: storageArea("session"),
    sync: storageArea("sync"),
    onChanged: { addListener: function () {} },
  };
  window.chrome.tabs = {
    query: function (query, callback) {
      var p = call("tabs.query", [query]);
      if (typeof callback === "function") p.then(callback);
      return p;
    },
    get: function (tabId, callback) {
      var p = call("tabs.get", [tabId]);
      if (typeof callback === "function") p.then(callback);
      return p;
    },
  };
})();
