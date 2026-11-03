// emulate-device-proxy.test.js — v0.4.1, on a real Brave behind the
// broker's CdpProxy (W2G), as src/broker/main.js wires them: emulate_device
// (STEALTH2-5) auto-attaches a tab's cross-origin iframes and workers paused
// and resumes them over the non-flat Target.sendMessageToTarget. The proxy
// used to refuse that channel outright, so after emulate_device{userAgent}
// every cross-site iframe in the tab stayed paused and never loaded.
// Proven here: the iframe loads and reports the spoofed UA, and so does a
// dedicated worker; the call reports no failure.
//
// A throwaway profile under .tmp-profiles, headless unless BMR_TEST_HEADFUL=1.
// Only the Brave this file's supervisor launched is closed.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const { braveAvailable, headfulRequested, makeProfileDir, removeProfile } = require("./fixtures/temp-brave.js");
const { BraveSupervisor } = require("../src/broker/brave-supervisor.js");
const { CdpProxy } = require("../src/broker/cdp-proxy.js");
const emulate = require("../src/own-tools/emulate-device.js");

const SKIP = !braveAvailable() && "needs Windows + Brave";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** /parent embeds a cross-site iframe (localhost vs 127.0.0.1) and starts a worker; both post their UA. */
function startSite() {
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    if (req.url.startsWith("/parent")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><title>parent</title><script>
        window.childMsg = null; window.workerMsg = null;
        addEventListener("message", (e) => { window.childMsg = String(e.data); });
        const w = new Worker("/worker.js"); w.onmessage = (e) => { window.workerMsg = String(e.data); };
      </script><iframe src="http://localhost:${port}/child"></iframe>`);
    } else if (req.url.startsWith("/child")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><script>parent.postMessage(navigator.userAgent, "*")</script>`);
    } else if (req.url.startsWith("/worker.js")) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("postMessage(navigator.userAgent)");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function messages(page, ms) {
  const t0 = Date.now();
  let st = {};
  while (Date.now() - t0 < ms) {
    st = await page.evaluate(() => ({ child: window.childMsg, worker: window.workerMsg })).catch(() => ({}));
    if (st.child && st.worker) break;
    await sleep(100);
  }
  return st;
}

test("v0.4.1 real Brave through the CDP proxy: after emulate_device{userAgent}, a cross-site iframe loads (it isn't left paused) and reports the spoofed UA, like a worker", { skip: SKIP, timeout: 120_000 }, async (t) => {
  const { chromium } = require("playwright-core");
  const profileDir = makeProfileDir("v041-emulate-proxy");
  const sup = new BraveSupervisor({ profileDir, headless: !headfulRequested(), log: () => {} });
  const proxyLog = [];
  const proxy = new CdpProxy({ log: (m) => proxyLog.push(m) });
  await proxy.listen();
  sup.on("pipe", (p) => proxy.setPipe(p));
  const site = await startSite();
  const base = `http://127.0.0.1:${site.address().port}`;
  let browser = null;
  t.after(async () => {
    if (browser) await browser.close().catch(() => {});
    await sup.closeGracefully().catch(() => {});
    await proxy.close();
    site.close();
    await removeProfile(profileDir).catch(() => {});
  });

  await sup.ensure();
  browser = await chromium.connectOverCDP(proxy.wsUrl);
  const context = browser.contexts()[0];
  const page = await context.newPage();
  await page.goto(`${base}/parent?before`);
  const before = await messages(page, 10_000);
  assert.ok(before.child && !before.child.includes("Macintosh"), `the iframe loads before emulation too: ${JSON.stringify(before)}`);

  const r = await emulate.handler({ userAgent: MAC_UA }, { page, context });
  assert.ok(!r.isError, r.content[0].text);

  const t0 = Date.now();
  await page.goto(`${base}/parent?after`, { timeout: 30_000 });
  const after = await messages(page, 15_000);
  assert.strictEqual(after.child, MAC_UA, `the cross-site iframe loaded with the spoofed UA (${Date.now() - t0} ms): ${JSON.stringify(after)}`);
  assert.strictEqual(after.worker, MAC_UA);
  assert.ok(page.frames().some((f) => f.url().startsWith("http://localhost:")), "the iframe's frame exists");
  assert.ok(!proxyLog.some((l) => /refused/.test(l)), proxyLog.join("\n"));
  // a later call reports no deferred resume failure either
  const again = await emulate.handler({ viewport: { width: 900, height: 700 } }, { page, context });
  assert.ok(!again.isError, again.content[0].text);
});
