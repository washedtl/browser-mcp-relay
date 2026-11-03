// ext-no-secrets.test.js — W2F-ext: cookie values never reach console.*,
// the injected logger, or chrome.storage.local (the review page's state),
// on the happy path or the error paths.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { makeEnv, cookie, SECRET, APPROVED } = require("./ext-fakes.js");
const { createBridge, toggleOverride, markReviewed } = require("../../extensions/cookie-bridge/bridge-core.js");

const EXT = path.join(__dirname, "..", "..", "extensions", "cookie-bridge");

function captureConsole() {
  const out = [];
  const saved = {};
  for (const k of ["log", "info", "warn", "error", "debug", "trace"]) {
    saved[k] = console[k];
    console[k] = (...a) => out.push(a.map((x) => { try { return typeof x === "string" ? x : JSON.stringify(x); } catch { return String(x); } }).join(" "));
  }
  return { out, restore: () => Object.assign(console, saved) };
}

test("a full flow incl. failures never logs or stores a cookie value", async (t) => {
  const cap = captureConsole();
  t.after(cap.restore);
  let throwOnce = true;
  const classify = (d) => {
    if (d === "boom.example" && throwOnce) { throwOnce = false; throw new Error(`classifier exploded on ${d}`); }
    return require("./ext-fakes.js").fakeClassify(d);
  };
  const env = makeEnv({
    cookies: [cookie(".amazon.com"), cookie("boom.example"), cookie(".chase.com"), cookie("newbank.example"),
      cookie("widget.example", "p", { partitionKey: { topLevelSite: "https://chase.com" } })],
    storage: APPROVED, classify,
  });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  env.port.emit({ t: "status", broker: "up" });
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  const full = env.port.ofType("full")[0];
  env.port.emit({ t: "ack", seq: full.seq, applied: 0, rejected: [{ domain: "amazon.com", reason: "broker said no" }] });
  env.cookies.set(cookie("github.com"));
  env.cookies.remove(cookie(".amazon.com"));
  await env.clock.advance(1000);
  await env.store.set({ settings: toggleOverride(env.store.data.settings, "chase.com", true, classify, 1) });
  await env.store.set({ settings: markReviewed(env.store.data.settings, ["newbank.example"], 2) });
  await env.clock.advance(1000);
  env.port.disconnected = true; // post fails
  env.cookies.set(cookie("github.com", "again"));
  await env.clock.advance(1000);
  env.port.crash("Native host has exited.");
  await env.clock.advance(5000);
  env.port.emit({ t: "ack", seq: "not-a-number", applied: "x", rejected: "nope" });
  await env.clock.advance(1000);

  assert.ok(env.ports[0].sent.some((m) => JSON.stringify(m).includes(SECRET)), "sanity: values DO go to the host");
  const logged = [...cap.out, ...env.logs].join("\n");
  assert.ok(env.logs.length > 0, "sanity: the bridge does log status lines");
  assert.ok(!logged.includes(SECRET), "a cookie value reached a log line");
  assert.ok(!env.store.writes.join("\n").includes(SECRET), "a cookie value reached chrome.storage.local");
});

test("extension sources: console.* only in background.js's one logger, never in the core or the page", () => {
  const files = fs.readdirSync(EXT).filter((f) => f.endsWith(".js") && f !== "policy.js");
  assert.ok(files.includes("bridge-core.js") && files.includes("background.js") && files.includes("options.js"));
  for (const f of files) {
    const src = fs.readFileSync(path.join(EXT, f), "utf8");
    const calls = src.match(/console\.\w+\(/g) || [];
    if (f === "background.js") assert.ok(calls.length <= 2, `${f}: ${calls.length} console calls`);
    else assert.deepStrictEqual(calls, [], `${f} must not call console.* (log through the injected logger)`);
  }
});
