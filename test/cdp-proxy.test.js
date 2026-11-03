// cdp-proxy.test.js — W2G: the broker's CDP lockdown, without a browser.
//
// Brave runs on --remote-debugging-pipe (no TCP port). The broker keeps the
// pipe's root session and serves every other CDP client on
// ws://127.0.0.1:<port>/<64-hex secret>/devtools/browser, one browser session
// (Target.attachToBrowserTarget) per client. Here the "browser" is a fake
// that speaks NUL-delimited JSON over in-memory streams; the real-Brave proof
// is test/cdp-lockdown.test.js.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const WebSocket = require("ws");

const {
  PipeConnection,
  CdpProxy,
  redact,
  redactCdpUrl,
  BLOCKED_CLIENT_METHODS,
  REDACTED,
} = require("../src/broker/cdp-proxy.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(5);
  }
}

const { fakePipeBrowser: fakeBrowser } = require("./fixtures/fake-pipe-browser.js");

/** A CDP client on the proxy: send() → its reply; events and close recorded. */
function cdpClient(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const events = [];
    const c = {
      ws,
      events,
      closed: null,
      send(method, params, sessionId) {
        const i = ++id;
        ws.send(JSON.stringify({ id: i, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }));
        return new Promise((res) => pending.set(i, res));
      },
      raw: (data) => ws.send(data),
    };
    c.closedP = new Promise((res) => ws.on("close", (code, reason) => { c.closed = { code, reason: String(reason) }; res(c.closed); }));
    ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else events.push(m);
    });
    ws.once("open", () => resolve(c));
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once("error", reject);
  });
}

/** Upgrade outcome without throwing: "OPEN" or "HTTP <status>". */
function tryUpgrade(url, headers = {}) {
  return cdpClient(url, headers).then((c) => { c.ws.terminate(); return "OPEN"; }, (e) => (e.status ? `HTTP ${e.status}` : `error ${e.message}`));
}

function httpGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

function collectLog() {
  const lines = [];
  const log = (m) => lines.push(String(m));
  log.lines = lines;
  return log;
}

/** A listening proxy (+ a fake Brave unless browser:false); closed after the test. */
async function served(t, { browser = true, ...opts } = {}) {
  const log = collectLog();
  const proxy = new CdpProxy({ log, ...opts });
  const { wsUrl, port } = await proxy.listen();
  const fake = browser ? fakeBrowser() : null;
  if (fake) proxy.setPipe(fake.pipe);
  t.after(() => proxy.close());
  return { proxy, wsUrl, port, fake, log };
}

// ─────────────── PipeConnection ───────────────

test("PipeConnection: NUL-delimited JSON both ways; frames split across chunks or coalesced are reassembled in order", async () => {
  const out = new PassThrough();
  const inp = new PassThrough();
  const pipe = new PipeConnection(out, inp);
  const got = [];
  pipe.on("message", (m) => got.push(m));
  inp.write(`${JSON.stringify({ method: "A" })}\0${JSON.stringify({ method: "B" })}\0{"meth`);
  inp.write('od":"C","params":{"s":"é');
  inp.write('"}}\0');
  await until(() => got.length === 3, 1000, "3 messages");
  assert.deepStrictEqual(got, [{ method: "A" }, { method: "B" }, { method: "C", params: { s: "é" } }]);
  out.setEncoding("utf8");
  assert.strictEqual(pipe.send({ id: 7, method: "X" }), true);
  assert.strictEqual(out.read(), '{"id":7,"method":"X"}\0');
});

test("PipeConnection: an unparseable frame is skipped, the next one still arrives", async () => {
  const inp = new PassThrough();
  const pipe = new PipeConnection(new PassThrough(), inp);
  const got = [];
  pipe.on("message", (m) => got.push(m));
  inp.write(`{not json\0${JSON.stringify({ method: "ok" })}\0`);
  await until(() => got.length === 1, 1000, "the good frame");
  assert.deepStrictEqual(got, [{ method: "ok" }]);
});

test("PipeConnection.call(): the root session's replies resolve call() and are not emitted; everything else is", async () => {
  const fake = fakeBrowser();
  const emitted = [];
  fake.pipe.on("message", (m) => emitted.push(m));
  const r = await fake.pipe.call("Browser.getVersion");
  assert.deepStrictEqual(r.result, { echo: "Browser.getVersion", on: null });
  const onSession = await fake.pipe.call("Runtime.evaluate", { expression: "1" }, { sessionId: "S9" });
  assert.deepStrictEqual(onSession.result, { echo: "Runtime.evaluate", on: "S9" });
  assert.deepStrictEqual(emitted, [], "replies to call() are the caller's only");
  await fake.pipe.call("Fake.emit", { name: "Root.event" });
  await until(() => emitted.length === 1, 1000, "the root event");
  assert.strictEqual(emitted[0].method, "Root.event");
  // ids come from one counter: allocId() never collides with call()'s
  const id = fake.pipe.allocId();
  const ids = fake.received.map((m) => m.id);
  assert.ok(!ids.includes(id), `${id} already used by call(): ${ids}`);
});

test("PipeConnection: browser EOF → 'close' once; pending and later call()s resolve null, send() returns false", async () => {
  const out = new PassThrough();
  const inp = new PassThrough();
  const pipe = new PipeConnection(out, inp);
  const closes = [];
  pipe.on("close", (why) => closes.push(why));
  const pending = pipe.call("Never.answered", null, { timeoutMs: 60_000 });
  inp.end();
  assert.strictEqual(await pending, null);
  await until(() => closes.length === 1, 1000, "'close'");
  assert.strictEqual(pipe.closed, true);
  assert.strictEqual(await pipe.call("After.close"), null);
  assert.strictEqual(pipe.send({ id: 1, method: "X" }), false);
  await sleep(20);
  assert.strictEqual(closes.length, 1, "'close' fires once");
});

test("PipeConnection.call(): a reply that never comes resolves null after timeoutMs", async () => {
  const pipe = new PipeConnection(new PassThrough(), new PassThrough());
  const t0 = Date.now();
  assert.strictEqual(await pipe.call("Slow", null, { timeoutMs: 60 }), null);
  assert.ok(Date.now() - t0 >= 50);
});

test("PipeConnection.close(): ends our side, fires 'close', pending calls resolve null", async () => {
  const out = new PassThrough();
  const pipe = new PipeConnection(out, new PassThrough());
  let ended = false;
  out.on("finish", () => { ended = true; });
  const pending = pipe.call("X", null, { timeoutMs: 60_000 });
  const closed = new Promise((r) => pipe.once("close", r));
  pipe.close();
  await closed;
  assert.strictEqual(await pending, null);
  await until(() => ended, 1000, "our write end to finish");
});

// ─────────────── CdpProxy: listening, refusals ───────────────

test("listen(): ws://127.0.0.1:<port>/<64 hex>/devtools/browser on loopback; each proxy has its own secret", async (t) => {
  const a = await served(t, { browser: false });
  const b = await served(t, { browser: false });
  for (const { proxy, wsUrl, port } of [a, b]) {
    assert.match(wsUrl, /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/devtools\/browser$/);
    assert.strictEqual(proxy.wsUrl, wsUrl);
    assert.strictEqual(new URL(wsUrl).port, String(port));
  }
  assert.notStrictEqual(a.proxy.secret, b.proxy.secret);
  assert.strictEqual(a.proxy._server.address().address, "127.0.0.1");
});

test("HTTP discovery is refused: every /json endpoint → 404, with or without the secret, and never echoes it", async (t) => {
  const { proxy, port, fake } = await served(t);
  for (const p of ["/json/version", "/json/list", "/json", "/json/new?about:blank", "/json/protocol", `/${proxy.secret}/json/version`, `/${proxy.secret}/devtools/browser`, "/"]) {
    const r = await httpGet(port, p);
    assert.strictEqual(r.status, 404, p);
    assert.ok(!r.body.includes(proxy.secret), `${p} echoed the secret`);
  }
  assert.deepStrictEqual(fake.received, [], "nothing reached the browser");
});

test("upgrades without the exact secret path, with an Origin (a web page) or a foreign Host (DNS rebinding) → 403", async (t) => {
  const { proxy, port, wsUrl, fake, log } = await served(t);
  const base = `ws://127.0.0.1:${port}`;
  const cases = {
    "no secret": `${base}/devtools/browser`,
    "wrong secret, same length": `${base}/${"0".repeat(64)}/devtools/browser`,
    "secret + suffix": `${wsUrl}/x`,
    "secret, other path": `${base}/${proxy.secret}/devtools/page/1`,
    "uppercased secret": `${base}/${proxy.secret.toUpperCase()}/devtools/browser`,
    "secret + query": `${wsUrl}?x=1`,
  };
  for (const [what, url] of Object.entries(cases)) assert.strictEqual(await tryUpgrade(url), "HTTP 403", what);
  assert.strictEqual(await tryUpgrade(wsUrl, { Origin: "https://evil.example" }), "HTTP 403", "Origin");
  assert.strictEqual(await tryUpgrade(wsUrl, { Origin: "null" }), "HTTP 403", "Origin: null");
  assert.strictEqual(await tryUpgrade(wsUrl, { Host: `evil.example:${port}` }), "HTTP 403", "foreign Host");
  assert.strictEqual(await tryUpgrade(wsUrl, { Host: "127.0.0.1:1" }), "HTTP 403", "Host with another port");
  assert.deepStrictEqual(fake.received, [], "nothing reached the browser");
  assert.ok(log.lines.length > 0, "refusals are logged");
  assert.ok(!log.lines.some((l) => l.includes(proxy.secret)), log.lines.join("\n"));
  // the good URL still works, with Host 127.0.0.1:<port> or localhost:<port>
  assert.strictEqual(await tryUpgrade(wsUrl), "OPEN");
  assert.strictEqual(await tryUpgrade(wsUrl, { Host: `localhost:${port}` }), "OPEN");
});

test("refusals are logged without the secret, and only the first few (a local process can't flood the broker log)", async (t) => {
  const { port, proxy, log } = await served(t, { browser: false });
  for (let i = 0; i < 60; i++) await httpGet(port, `/json/version?${proxy.secret}`);
  assert.ok(log.lines.length <= 25, `${log.lines.length} log lines`);
  assert.ok(log.lines.some((l) => /not logged/i.test(l)), log.lines.join("\n"));
  assert.ok(!log.lines.some((l) => l.includes(proxy.secret)), log.lines.join("\n"));
});

test("503 while Brave is down: before the first pipe, and after the pipe closed", async (t) => {
  const { proxy, wsUrl } = await served(t, { browser: false });
  assert.strictEqual(await tryUpgrade(wsUrl), "HTTP 503", "no Brave yet");
  const fake = fakeBrowser();
  proxy.setPipe(fake.pipe);
  assert.strictEqual(await tryUpgrade(wsUrl), "OPEN");
  fake.crash();
  await until(() => fake.pipe.closed, 1000, "pipe EOF");
  assert.strictEqual(await tryUpgrade(wsUrl), "HTTP 503", "Brave went down");
});

// ─────────────── CdpProxy: routing ───────────────

test("a client gets its own browser session: its ids are remapped, replies come back with its ids and no sessionId", async (t) => {
  const { wsUrl, fake } = await served(t);
  const c = await cdpClient(wsUrl);
  const r = await c.send("Browser.getVersion");
  const browserSession = r.result.on;
  assert.match(browserSession, /^B\d+$/);
  assert.deepStrictEqual(r, { id: 1, result: { echo: "Browser.getVersion", on: browserSession } });
  const [attach] = fake.sent("Target.attachToBrowserTarget");
  assert.strictEqual(attach.sessionId, undefined, "attached on the root session");
  const [routed] = fake.sent("Browser.getVersion");
  assert.strictEqual(routed.sessionId, browserSession, "routed to the client's browser session");
  assert.notStrictEqual(routed.id, 1, "ids are the proxy's, not the client's");
  // events on its browser session arrive without the sessionId (as on a plain connection)
  await c.send("Fake.emit", { name: "Target.targetCreated", on: browserSession, n: 1 });
  await until(() => c.events.length === 1, 1000, "the event");
  assert.deepStrictEqual(c.events[0], { method: "Target.targetCreated", params: { n: 1 } });
  // root-session events stay the supervisor's
  await c.send("Fake.emit", { name: "Root.only", n: 2 });
  await sleep(50);
  assert.strictEqual(c.events.length, 1, JSON.stringify(c.events));
});

test("messages a client sends before its browser session is attached are delivered, in order", async (t) => {
  const { wsUrl } = await served(t);
  const c = await cdpClient(wsUrl);
  const replies = await Promise.all([c.send("A.one"), c.send("A.two"), c.send("A.three")]);
  assert.deepStrictEqual(replies.map((r) => [r.id, r.result.echo]), [[1, "A.one"], [2, "A.two"], [3, "A.three"]]);
});

test("two clients: separate browser sessions; one can't use the other's session (-32001, never sent); events reach the owner only", async (t) => {
  const { wsUrl, fake } = await served(t);
  const a = await cdpClient(wsUrl);
  const b = await cdpClient(wsUrl);
  const ra = await a.send("Browser.getVersion");
  const rb = await b.send("Browser.getVersion");
  assert.notStrictEqual(ra.result.on, rb.result.on);
  const { result: { sessionId: pageOfA } } = await a.send("Target.attachToTarget", { targetId: "T1", flatten: true });
  assert.deepStrictEqual((await a.send("Runtime.evaluate", { expression: "1" }, pageOfA)).result, { echo: "Runtime.evaluate", on: pageOfA });
  const before = fake.received.length;
  const stolen = await b.send("Runtime.evaluate", { expression: "document.cookie" }, pageOfA);
  assert.deepStrictEqual(stolen, { id: stolen.id, error: { code: -32001, message: "Session with given id not found." }, sessionId: pageOfA });
  assert.deepStrictEqual(await b.send("Runtime.evaluate", {}, ra.result.on).then((r) => r.error.code), -32001, "nor its browser session");
  assert.strictEqual(fake.received.length, before, "nothing was forwarded");
  await a.send("Fake.emit", { name: "Page.loadEventFired", on: pageOfA, n: 3 });
  await until(() => a.events.length === 1, 1000, "A's event");
  await sleep(30);
  assert.deepStrictEqual(a.events, [{ method: "Page.loadEventFired", params: { n: 3 }, sessionId: pageOfA }]);
  assert.deepStrictEqual(b.events, []);
});

test("sessions announced by a Target.attachedToTarget event belong to the client whose session got the event", async (t) => {
  const { wsUrl } = await served(t);
  const a = await cdpClient(wsUrl);
  const b = await cdpClient(wsUrl);
  const { result: { sessionId: child } } = await a.send("Fake.autoAttach");
  await until(() => a.events.some((e) => e.method === "Target.attachedToTarget"), 1000, "the attach event");
  assert.strictEqual((await a.send("DOM.enable", {}, child)).result.on, child);
  assert.strictEqual((await b.send("DOM.enable", {}, child)).error.code, -32001);
});

test("Browser.close, Browser.crash, Browser.crashGpuProcess and non-flat sendMessageToTarget are refused for clients, on any session", async (t) => {
  const { wsUrl, fake, proxy } = await served(t);
  assert.deepStrictEqual([...BLOCKED_CLIENT_METHODS].sort(), ["Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Target.sendMessageToTarget"]);
  const c = await cdpClient(wsUrl);
  const { result: { sessionId: nested } } = await c.send("Target.attachToBrowserTarget");
  for (const method of BLOCKED_CLIENT_METHODS) {
    for (const sessionId of [undefined, nested]) {
      const r = await c.send(method, method === "Target.sendMessageToTarget" ? { sessionId: nested, message: '{"id":1,"method":"Browser.close"}' } : undefined, sessionId);
      assert.ok(r.error && r.error.code === -32000 && r.error.message.includes(method), `${method} on ${sessionId}: ${JSON.stringify(r)}`);
    }
    assert.deepStrictEqual(fake.sent(method), [], `${method} reached the browser`);
  }
  assert.strictEqual((await c.send("Browser.getVersion")).result.echo, "Browser.getVersion", "the client still works");
  // the broker itself (root session) can still close Brave
  void proxy;
  assert.ok(await fake.pipe.call("Browser.close"));
  assert.strictEqual(fake.sent("Browser.close").length, 1);
});

test("a leaving client's browser session is detached (Chromium drops its child sessions with it)", async (t) => {
  const { wsUrl, fake } = await served(t);
  const a = await cdpClient(wsUrl);
  const b = await cdpClient(wsUrl);
  const sa = (await a.send("Browser.getVersion")).result.on;
  await b.send("Browser.getVersion");
  a.ws.close();
  await until(() => fake.sent("Target.detachFromTarget").length === 1, 2000, "the detach");
  assert.deepStrictEqual(fake.sent("Target.detachFromTarget")[0].params, { sessionId: sa });
  assert.strictEqual(fake.sent("Target.detachFromTarget")[0].sessionId, undefined, "on the root session");
  assert.strictEqual((await b.send("Browser.getVersion")).result.echo, "Browser.getVersion", "the other client is unaffected");
});

test("a client whose browser session Brave detaches is closed", async (t) => {
  const { wsUrl, fake } = await served(t);
  const c = await cdpClient(wsUrl);
  const sid = (await c.send("Browser.getVersion")).result.on;
  fake.send({ method: "Target.detachedFromTarget", params: { sessionId: sid } });
  const closed = await c.closedP;
  assert.strictEqual(closed.code, 1011);
});

test("bad client frames (not JSON, no numeric id, no method) close that client (1007); others carry on", async (t) => {
  const { wsUrl } = await served(t);
  const good = await cdpClient(wsUrl);
  await good.send("Browser.getVersion");
  for (const frame of ["{nope", JSON.stringify({ method: "X" }), JSON.stringify({ id: "1", method: "X" }), JSON.stringify({ id: 1 }), JSON.stringify({ id: 1, method: "X", sessionId: 5 })]) {
    const bad = await cdpClient(wsUrl);
    await bad.send("Browser.getVersion");
    bad.raw(frame);
    assert.strictEqual((await bad.closedP).code, 1007, frame);
  }
  assert.strictEqual((await good.send("Browser.getVersion")).result.echo, "Browser.getVersion");
});

test("a client message over maxPayload closes that client (1009), nothing is forwarded", async (t) => {
  const { wsUrl, fake } = await served(t, { maxPayload: 1024 });
  const c = await cdpClient(wsUrl);
  await c.send("Browser.getVersion");
  const before = fake.received.length;
  c.send("Runtime.evaluate", { expression: "x".repeat(4096) });
  assert.strictEqual((await c.closedP).code, 1009);
  assert.strictEqual(fake.received.length, before);
});

test("Brave going down closes every client (1011), then 503; a relaunch is served behind the same URL with fresh sessions", async (t) => {
  const { proxy, wsUrl, fake } = await served(t);
  const a = await cdpClient(wsUrl);
  const sa = (await a.send("Browser.getVersion")).result.on;
  fake.crash();
  assert.strictEqual((await a.closedP).code, 1011);
  assert.strictEqual(await tryUpgrade(wsUrl), "HTTP 503");
  const next = fakeBrowser();
  proxy.setPipe(next.pipe);
  const b = await cdpClient(wsUrl);
  assert.strictEqual((await b.send("Browser.getVersion")).result.echo, "Browser.getVersion");
  assert.strictEqual((await b.send("X.y", {}, sa)).error.code, -32001, "the old Brave's sessions are forgotten");
  // the old pipe's late traffic is ignored
  fake.send({ method: "Late.event", sessionId: sa });
  await sleep(30);
  assert.deepStrictEqual(b.events, []);
  assert.deepStrictEqual(fake.sent("Target.detachFromTarget"), [], "no detach is sent to a dead Brave");
});

test("close(): clients are dropped and the port stops listening", async (t) => {
  const { proxy, wsUrl, port } = await served(t);
  const c = await cdpClient(wsUrl);
  await c.send("Browser.getVersion");
  await proxy.close();
  await c.closedP;
  await assert.rejects(httpGet(port, "/json/version"), /ECONNREFUSED/);
});

// ─────────────── redaction ───────────────

test("redact(): every live proxy's secret becomes <redacted>, wherever it appears; a closed proxy's is forgotten", async (t) => {
  const { proxy, wsUrl } = await served(t, { browser: false });
  const other = new CdpProxy();
  await other.listen();
  const text = `connect ${wsUrl} failed\n  - <ws connecting> ${wsUrl}\n${JSON.stringify({ endpoint: other.wsUrl })}`;
  const out = redact(text);
  assert.ok(!out.includes(proxy.secret) && !out.includes(other.secret), out);
  assert.strictEqual(REDACTED, "<redacted>");
  assert.ok(out.includes(`ws://127.0.0.1:${proxy.port}/<redacted>/devtools/browser`), out);
  assert.strictEqual(redact("nothing secret"), "nothing secret");
  assert.strictEqual(redact(undefined), "undefined");
  await other.close();
  assert.ok(redact(other.secret).includes(other.secret), "unregistered on close");
});

test("redactCdpUrl(): a CDP URL without its secret path; other URLs unchanged", () => {
  const secret = "a".repeat(64);
  assert.strictEqual(redactCdpUrl(`ws://127.0.0.1:5/${secret}/devtools/browser`), "ws://127.0.0.1:5/<redacted>/devtools/browser");
  assert.strictEqual(redactCdpUrl("http://127.0.0.1:9333"), "http://127.0.0.1:9333");
  assert.strictEqual(redactCdpUrl(undefined), "undefined");
});
