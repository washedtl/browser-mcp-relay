// background.js — cookie-bridge MV3 service worker (W2F-ext).
//
// This file is the ONLY place that touches chrome.*. It imports the policy
// (W2F-core's policy.js) and the pure bridge logic (bridge-core.js), wires the
// real Chrome APIs into the bridge's injected dependencies, and opens the
// first-run review page. All sync behaviour lives in bridge-core.js.
//
// The native port keeps this worker alive while syncing; when it is idle and
// Chrome stops the worker, this module simply re-runs on the next event and
// bridge-core re-reads its state from chrome.storage.local.

import * as policyModule from "./policy.js"; // W2F-core; may export classify or set it on globalThis
import "./bridge-core.js"; // side effect: globalThis.CookieBridgeCore

const Core = globalThis.CookieBridgeCore;

// policy.js is written to work in Node (module.exports) and the extension; it
// may surface classify as an ES export, or on globalThis. Accept either.
function resolveClassify() {
  // policy.js is a plain IIFE: it sets globalThis.CookieBridgePolicy (and, in
  // Node, module.exports). It has no ES exports, so the namespace import is
  // only a fallback for a future module-style policy. Read globalThis first.
  const p = globalThis.CookieBridgePolicy || globalThis.cookieBridgePolicy;
  const candidates = [
    p && p.classify,
    globalThis.classify,
    policyModule && policyModule.classify,
    policyModule && policyModule.default && policyModule.default.classify,
  ];
  for (const c of candidates) if (typeof c === "function") return c;
  return null;
}

// A native-messaging port the way bridge-core expects it: onDisconnect must
// carry the failure reason, which Chrome exposes via runtime.lastError during
// the callback rather than as an argument.
function connectNative(name) {
  const real = chrome.runtime.connectNative(name);
  return {
    name: real.name,
    postMessage: (m) => real.postMessage(m),
    disconnect: () => real.disconnect(),
    onMessage: real.onMessage,
    onDisconnect: {
      addListener: (fn) =>
        real.onDisconnect.addListener(() =>
          fn(chrome.runtime.lastError ? chrome.runtime.lastError.message : undefined)),
    },
  };
}

const deps = {
  cookies: chrome.cookies,
  connectNative,
  classify: resolveClassify(),
  storage: {
    get: (keys) => chrome.storage.local.get(keys),
    set: (obj) => chrome.storage.local.set(obj),
    onChanged: {
      addListener: (fn) =>
        chrome.storage.onChanged.addListener((changes, area) => { if (area === "local") fn(changes); }),
    },
  },
  action: chrome.action,
  timers: { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (id) => clearTimeout(id) },
  now: () => Date.now(),
  // Status lines only — never a cookie, never a value. (The one console call
  // in this file; cookie values are confined to the native port.)
  log: (msg) => console.log("[cookie-bridge]", msg),
};

export const bridge = Core.createBridge(deps);

// First run: send the owner straight to the review page. Updates don't re-open.
chrome.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === "install") chrome.runtime.openOptionsPage();
});
// Clicking the toolbar icon opens the review page too (the badge lives there).
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
