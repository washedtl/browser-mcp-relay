// ext-fakes.js — fake Chrome APIs for the cookie-bridge extension tests
// (ext-*.test.js). Not a test file itself. Everything the bridge core talks
// to is injected, so these fakes are the whole world: a manual clock, a
// chrome.storage.local, chrome.cookies, native ports and the action badge.

const SECRET = "s3cr3t-cookie-value-DO-NOT-LOG";

/** A manual clock: timers only fire on advance(). */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  let nextId = 1;
  const timers = new Map();
  const clock = {
    now: () => t,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: t + Math.max(0, ms || 0), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    /** Advance time, firing due timers in order, draining promises between them. */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await flush();
        let due = null;
        for (const [id, tm] of timers) if (tm.at <= end && (!due || tm.at < due[1].at)) due = [id, tm];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
      await flush();
    },
  };
  return clock;
}

/** Let queued promise callbacks run (several rounds: chains of awaits). */
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

/** chrome.storage.local: get/set + onChanged(changes). Backing object survives "SW restarts". */
function fakeStorage(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const listeners = [];
  const writes = [];
  return {
    data,
    writes,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        const copy = JSON.parse(JSON.stringify(v));
        changes[k] = { oldValue: data[k], newValue: copy };
        data[k] = copy;
      }
      writes.push(JSON.stringify(obj));
      for (const fn of listeners) fn(JSON.parse(JSON.stringify(changes)));
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
  };
}

function cookie(domain, name = "sid", extra = {}) {
  return {
    domain, name, value: SECRET, path: "/", secure: true, httpOnly: true,
    hostOnly: !domain.startsWith("."), session: false, expirationDate: 1_900_000_000,
    sameSite: "lax", storeId: "0", ...extra,
  };
}

/** chrome.cookies: getAll over a mutable jar + onChanged emitter. */
function fakeCookies(initial = []) {
  const jar = initial.slice();
  const listeners = [];
  const calls = [];
  return {
    jar,
    calls,
    listeners,
    async getAll(details) {
      calls.push(details);
      // like Chrome: partitioned cookies only come back when partitionKey is given
      return jar.filter((c) => !c.partitionKey || (details && details.partitionKey)).map((c) => ({ ...c }));
    },
    onChanged: { addListener: (fn) => listeners.push(fn) },
    /** Mutate the jar the way Chrome would, then fire onChanged. */
    set(c) {
      const i = jar.findIndex((x) => x.domain === c.domain && x.name === c.name && x.path === c.path);
      if (i >= 0) {
        const old = jar[i];
        jar.splice(i, 1);
        for (const fn of listeners) fn({ removed: true, cause: "overwrite", cookie: { ...old } });
      }
      jar.push(c);
      for (const fn of listeners) fn({ removed: false, cause: "explicit", cookie: { ...c } });
    },
    remove(c, cause = "explicit") {
      const i = jar.findIndex((x) => x.domain === c.domain && x.name === c.name && x.path === c.path);
      if (i >= 0) jar.splice(i, 1);
      for (const fn of listeners) fn({ removed: true, cause, cookie: { ...c } });
    },
  };
}

/** A native-messaging port the way runtime.connectNative returns it. */
function fakePort(name) {
  const msgL = [];
  const discL = [];
  const port = {
    name,
    sent: [],
    disconnected: false,
    postMessage(m) {
      if (port.disconnected) throw new Error("Attempting to use a disconnected port object");
      port.sent.push(JSON.parse(JSON.stringify(m)));
    },
    disconnect() { port.disconnected = true; },
    onMessage: { addListener: (fn) => msgL.push(fn) },
    onDisconnect: { addListener: (fn) => discL.push(fn) },
    /** host → extension */
    emit(m) { for (const fn of msgL) fn(m); },
    /** host died / was never found: Chrome fires onDisconnect, we pass lastError's text */
    crash(error = "Native host has exited.") {
      port.disconnected = true;
      for (const fn of discL) fn(error);
    },
    ofType: (t) => port.sent.filter((m) => m.t === t),
  };
  return port;
}

function fakeAction() {
  const a = { text: "", color: null, title: "" };
  return {
    state: a,
    setBadgeText: ({ text }) => { a.text = text; },
    setBadgeBackgroundColor: ({ color }) => { a.color = color; },
    setTitle: ({ title }) => { a.title = title; },
  };
}

/** A classifier stand-in for policy.js (owned by W2F-core). */
function fakeClassify(domain) {
  const d = String(domain).replace(/^\.+/, "");
  const under = (root) => d === root || d.endsWith("." + root);
  if (under("chase.com") || under("paypal.com")) return { decision: "deny", category: "banking", reason: "built-in denylist" };
  if (under("accounts.google.com") || under("mail.google.com")) return { decision: "deny", category: "email-identity", reason: "built-in denylist" };
  if (/bank|wallet|tax|health/.test(d)) return { decision: "hold", category: "keyword", reason: "keyword guard" };
  return { decision: "allow", category: null, reason: "not on a denylist" };
}

/**
 * Everything a bridge needs, wired to fakes. `env.restart()` simulates an MV3
 * service-worker restart: new cookies listeners / ports / timers, SAME storage.
 */
function makeEnv({ cookies = [], storage = {}, classify = fakeClassify } = {}) {
  const env = {};
  env.clock = fakeClock();
  env.store = fakeStorage(storage);
  env.cookies = fakeCookies(cookies);
  env.ports = [];
  env.action = fakeAction();
  env.logs = [];
  env.classify = classify;
  env.connectNative = (name) => { const p = fakePort(name); env.ports.push(p); return p; };
  env.deps = () => ({
    cookies: env.cookies,
    connectNative: env.connectNative,
    classify: env.classify,
    storage: env.store,
    action: env.action,
    timers: { setTimeout: env.clock.setTimeout, clearTimeout: env.clock.clearTimeout },
    now: env.clock.now,
    log: (msg) => env.logs.push(String(msg)),
  });
  Object.defineProperty(env, "port", { get: () => env.ports[env.ports.length - 1] });
  /** MV3 stops the worker: listeners, timers and ports die; storage data and the cookie jar survive. */
  env.restart = () => {
    if (env.port && !env.port.disconnected) env.port.crash("Native host has exited.");
    env.clock = fakeClock(env.clock.now() + 5000);
    env.store = fakeStorage(env.store.data);
    env.cookies = fakeCookies(env.cookies.jar);
    env.ports.length = 0;
    env.action = fakeAction();
  };
  return env;
}

const APPROVED = { settings: { approved: true, approvedAt: 1, paused: false, overrides: {}, reviewed: {} } };

module.exports = { SECRET, fakeClock, flush, fakeStorage, fakeCookies, fakePort, fakeAction, fakeClassify, cookie, makeEnv, APPROVED };
