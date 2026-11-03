// cdp-client.js — a minimal CDP client on the broker's browser-level
// endpoint, for the cookie bridge's Storage.setCookies calls (no Playwright:
// one websocket, request/response by id). Errors carry the CDP message only,
// never the params (they hold cookie values).
//
// W2G: the broker's Brave has no TCP debugging port. The only endpoint is
// the broker's CdpProxy at ws://127.0.0.1:<port>/<secret>/devtools/browser,
// which the broker hands the importer in-process. That URL is connected to
// as it is (no /json discovery: the proxy serves none), only on loopback,
// and it never appears in an error: the secret in its path is a bearer
// token (the broker's log redacts it too, see cdp-proxy.js redact()).
//
// A call that times out closes the connection: a hung Brave fails the rest
// of the work at once instead of costing a timeout per call.

"use strict";

const WebSocket = require("ws");

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_CALL_TIMEOUT_MS = 10_000;
// What errors call the endpoint: never the URL (it carries the secret).
const LABEL = "the broker's CDP endpoint";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * @param {string} wsUrl — the broker's CDP URL (CdpProxy.wsUrl): ws://127.0.0.1:<port>/<secret>/devtools/browser
 * @returns {Promise<{send: (method: string, params?: object) => Promise<object>, close: () => void, closed: boolean}>}
 */
async function openBrowserCdp(wsUrl, { connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
  let url;
  try {
    url = new URL(String(wsUrl));
  } catch {
    throw new Error(`${LABEL} is not a valid URL`);
  }
  // the proxy listens on 127.0.0.1 only; anything else is a wiring mistake
  if (url.protocol !== "ws:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port) {
    throw new Error(`${LABEL} must be a ws:// URL on 127.0.0.1 with a port`);
  }
  // No Origin header (the proxy refuses any upgrade that has one) and no compression.
  const ws = new WebSocket(url.href, { perMessageDeflate: false });
  return wrapWebSocket(ws, { connectTimeoutMs, callTimeoutMs });
}

/**
 * A CDP connection over an already-created browser-level websocket.
 * `label` names the endpoint in errors: never pass a URL that carries a secret.
 */
async function wrapWebSocket(ws, { label = LABEL, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS, callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
  // terminate() during the handshake emits 'error' too: never leave one unheard
  ws.on("error", () => {});
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch { /* not open */ }
      reject(new Error(`${label}: ${why}`));
    };
    const timer = setTimeout(() => fail(`the websocket did not open within ${connectTimeoutMs} ms`), connectTimeoutMs);
    ws.once("open", () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); });
    // The status only: 503 = Brave is down, 403 = refused (wrong secret, Origin, Host).
    ws.once("unexpected-response", (_req, res) => fail(`HTTP ${res.statusCode}${res.statusCode === 503 ? " (Brave is not running)" : ""}`));
    // e.code only: ws error messages can quote the URL
    ws.once("error", (e) => fail(e.code || "connect failed"));
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
          conn.close(); // a Brave that stopped answering: fail the rest at once
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
  ws.on("close", shut); // after an 'error' too
  return conn;
}

module.exports = { openBrowserCdp, wrapWebSocket };
