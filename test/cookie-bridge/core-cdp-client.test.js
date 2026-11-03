// core-cdp-client.test.js — W2F: the importer's browser-level CDP client
// (src/cookie-bridge/cdp-client.js). W2G: it connects straight to the
// broker's secret ws URL (no /json discovery, no TCP debugging port), and no
// error it raises ever contains that URL. Against a local fake ws endpoint,
// and against the real CdpProxy in front of a fake pipe browser.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { WebSocketServer } = require("ws");

const { openBrowserCdp } = require("../../src/cookie-bridge/cdp-client.js");
const { CdpProxy } = require("../../src/broker/cdp-proxy.js");
const { fakePipeBrowser } = require("../fixtures/fake-pipe-browser.js");

const SECRET = "a".repeat(64);

/** A ws-only endpoint at /<SECRET>/devtools/browser (any other path: 403, plain HTTP: 404). */
async function fakeBrowser(t, onCall) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ noServer: true });
  const sockets = [];
  const upgrades = [];
  server.on("upgrade", (req, socket, head) => {
    upgrades.push({ url: req.url, origin: req.headers.origin, host: req.headers.host });
    if (req.url !== `/${SECRET}/devtools/browser`) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("message", (data) => {
        const msg = JSON.parse(data);
        const reply = onCall(msg, ws);
        if (reply !== undefined) ws.send(JSON.stringify({ id: msg.id, ...reply }));
      });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { for (const s of sockets) s.terminate(); wss.close(); server.close(); });
  const port = server.address().port;
  return { url: `ws://127.0.0.1:${port}/${SECRET}/devtools/browser`, port, sockets, requests, upgrades };
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

test("cdp-client (W2G): connects to the ws URL as given: no /json discovery, no plain HTTP, no Origin header", async (t) => {
  const b = await fakeBrowser(t, () => ({ result: { ok: 1 } }));
  const cdp = await openBrowserCdp(b.url);
  assert.deepStrictEqual(await cdp.send("X.y", {}), { ok: 1 });
  cdp.close();
  assert.deepStrictEqual(b.requests, [], "no plain HTTP request (the broker's proxy serves no /json/*)");
  assert.deepStrictEqual(b.upgrades, [{ url: `/${SECRET}/devtools/browser`, origin: undefined, host: `127.0.0.1:${b.port}` }]);
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

test("cdp-client: a call with no answer times out AND closes the connection (a hung Brave can't stall the queue call after call)", async (t) => {
  const b = await fakeBrowser(t, () => undefined);
  const cdp = await openBrowserCdp(b.url, { callTimeoutMs: 100 });
  await assert.rejects(cdp.send("Slow.call", {}), /timed out/);
  assert.strictEqual(cdp.closed, true);
  const t0 = Date.now();
  await assert.rejects(cdp.send("Next.call", {}), /closed/);
  assert.ok(Date.now() - t0 < 50, "the next call fails at once");
});

test("cdp-client (W2G): no error ever quotes the URL (its path is the CDP secret)", async (t) => {
  const b = await fakeBrowser(t, () => undefined);
  const wrongSecret = b.url.replace(SECRET, "b".repeat(64));
  const closedPort = `ws://127.0.0.1:1/${SECRET}/devtools/browser`;
  const cases = [
    [wrongSecret, /HTTP 403/],
    [closedPort, /ECONNREFUSED|connect/],
  ];
  for (const [url, re] of cases) {
    await assert.rejects(openBrowserCdp(url, { connectTimeoutMs: 3000 }), (e) => {
      assert.match(e.message, re);
      assert.match(e.message, /the broker's CDP endpoint/);
      assert.ok(!e.message.includes(SECRET) && !e.message.includes("b".repeat(64)), e.message);
      assert.ok(!(e.stack || "").includes(SECRET), "nor the stack");
      return true;
    });
  }
});

test("cdp-client (W2G): only a ws:// URL on loopback with a port is accepted (the proxy's)", async () => {
  for (const bad of [
    `http://127.0.0.1:9222`,
    `wss://127.0.0.1:9222/${SECRET}/devtools/browser`,
    `ws://192.168.1.10:9222/${SECRET}/devtools/browser`,
    `ws://example.com:9222/${SECRET}/devtools/browser`,
    `ws://127.0.0.1/${SECRET}/devtools/browser`,
    "not a url",
    undefined,
  ]) {
    await assert.rejects(openBrowserCdp(bad), (e) => {
      assert.match(e.message, /the broker's CDP endpoint (must be|is not)/, String(bad));
      assert.ok(!e.message.includes(SECRET));
      return true;
    });
  }
});

test("cdp-client (W2G): through the real CdpProxy: works behind the secret URL, 503 (Brave down) is a clear error, a relaunch is served at the same URL", async (t) => {
  const proxy = new CdpProxy({});
  await proxy.listen();
  t.after(() => proxy.close());
  await assert.rejects(openBrowserCdp(proxy.wsUrl), (e) => {
    assert.match(e.message, /HTTP 503 \(Brave is not running\)/);
    assert.ok(!e.message.includes(proxy.secret));
    return true;
  });
  const first = fakePipeBrowser();
  proxy.setPipe(first.pipe);
  const cdp = await openBrowserCdp(proxy.wsUrl);
  const r = await cdp.send("Storage.setCookies", { cookies: [] });
  assert.strictEqual(r.echo, "Storage.setCookies");
  assert.match(String(r.on), /^B\d+$/, "on the client's own browser session (Target.attachToBrowserTarget)");
  // Brave dies: the connection closes; the next Brave is behind the same URL
  first.crash();
  const t0 = Date.now();
  while (!cdp.closed && Date.now() - t0 < 3000) await new Promise((res) => setTimeout(res, 10));
  assert.strictEqual(cdp.closed, true);
  const second = fakePipeBrowser();
  proxy.setPipe(second.pipe);
  const again = await openBrowserCdp(proxy.wsUrl);
  assert.strictEqual((await again.send("Storage.getCookies", {})).echo, "Storage.getCookies");
  again.close();
});
