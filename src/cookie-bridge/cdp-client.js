// cdp-client.js — a minimal CDP client on Brave's browser-level endpoint,
// for the cookie bridge's Storage.setCookies calls (no Playwright: one
// websocket, request/response by id). Errors carry the CDP message only,
// never the params (they hold cookie values).

"use strict";

const WebSocket = require("ws");

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;

/**
 * @param {string} cdpUrl — http://127.0.0.1:<port>
 * @returns {Promise<{send: (method: string, params?: object) => Promise<object>, close: () => void, closed: boolean}>}
 */
async function openBrowserCdp(cdpUrl, { connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
  let version;
  try {
    const res = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(connectTimeoutMs) });
    version = res.ok ? await res.json() : null;
  } catch (e) {
    throw new Error(`no CDP endpoint at ${cdpUrl} (${e.name === "TimeoutError" ? "timed out" : "fetch failed"})`);
  }
  if (!version || typeof version.webSocketDebuggerUrl !== "string") throw new Error(`no CDP browser endpoint at ${cdpUrl}`);

  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error(`CDP websocket at ${cdpUrl} did not open within ${connectTimeoutMs} ms`)); }, connectTimeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(); });
    ws.once("error", (e) => { clearTimeout(timer); reject(new Error(`CDP websocket at ${cdpUrl}: ${e.code || "connect failed"}`)); });
  });

  let nextId = 1;
  const pending = new Map(); // id → {resolve, reject, timer}
  const conn = {
    closed: false,
    send(method, params = {}) {
      if (conn.closed) return Promise.reject(new Error(`${method}: the CDP connection is closed`));
      return new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: timed out after ${callTimeoutMs} ms`));
        }, callTimeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      shut();
      ws.close();
    },
  };
  function shut() {
    if (conn.closed) return;
    conn.closed = true;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(new Error(`${p.method}: the CDP connection closed`));
    }
  }
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = msg && pending.get(msg.id);
    if (!p) return; // an event, or a reply we stopped waiting for
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message || "CDP error"}`));
    else p.resolve(msg.result || {});
  });
  ws.on("close", shut);
  ws.on("error", () => { /* 'close' follows */ });
  return conn;
}

module.exports = { openBrowserCdp };
