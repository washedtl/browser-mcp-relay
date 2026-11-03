// core-cdp-client.test.js — W2F: the importer's browser-level CDP client
// (src/cookie-bridge/cdp-client.js) against a local fake endpoint.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { WebSocketServer } = require("ws");

const { openBrowserCdp } = require("../../src/cookie-bridge/cdp-client.js");

async function fakeBrowser(t, onCall) {
  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ Browser: "Chrome/147", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/x` }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  const wss = new WebSocketServer({ server });
  const sockets = [];
  wss.on("connection", (ws) => {
    sockets.push(ws);
    ws.on("message", (data) => {
      const msg = JSON.parse(data);
      const reply = onCall(msg, ws);
      if (reply !== undefined) ws.send(JSON.stringify({ id: msg.id, ...reply }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { for (const s of sockets) s.terminate(); wss.close(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, sockets };
}

test("cdp-client: send() resolves the result, matched by id, also out of order", async (t) => {
  const pending = [];
  const b = await fakeBrowser(t, (msg, ws) => {
    pending.push({ msg, ws });
    if (pending.length === 2) {
      for (const p of pending.reverse()) p.ws.send(JSON.stringify({ id: p.msg.id, result: { echo: p.msg.method } }));
    }
    return undefined;
  });
  const cdp = await openBrowserCdp(b.url);
  const [a, c] = await Promise.all([cdp.send("A.one", {}), cdp.send("B.two", {})]);
  assert.deepStrictEqual([a, c], [{ echo: "A.one" }, { echo: "B.two" }]);
  cdp.close();
});

test("cdp-client: a CDP error rejects with its message only (never the params)", async (t) => {
  const b = await fakeBrowser(t, () => ({ error: { code: -32602, message: "Invalid cookie fields", data: "params.cookies[0].value" } }));
  const cdp = await openBrowserCdp(b.url);
  await assert.rejects(cdp.send("Storage.setCookies", { cookies: [{ name: "a", value: "SENTINEL-secret" }] }), (e) => {
    assert.strictEqual(e.message, "Storage.setCookies: Invalid cookie fields");
    assert.ok(!JSON.stringify(e).includes("SENTINEL"));
    return true;
  });
  cdp.close();
});

test("cdp-client: a dropped connection rejects pending calls and marks it closed", async (t) => {
  const b = await fakeBrowser(t, (msg, ws) => { ws.terminate(); return undefined; });
  const cdp = await openBrowserCdp(b.url);
  await assert.rejects(cdp.send("X.y", {}), /closed/);
  assert.strictEqual(cdp.closed, true);
  await assert.rejects(cdp.send("X.z", {}), /closed/);
});

test("cdp-client: a call with no answer times out", async (t) => {
  const b = await fakeBrowser(t, () => undefined);
  const cdp = await openBrowserCdp(b.url, { callTimeoutMs: 100 });
  await assert.rejects(cdp.send("Slow.call", {}), /timed out/);
  cdp.close();
});

test("cdp-client: no browser behind the URL → a clear error", async () => {
  await assert.rejects(openBrowserCdp("http://127.0.0.1:1", { connectTimeoutMs: 1500 }), /CDP|connect|fetch/i);
});
