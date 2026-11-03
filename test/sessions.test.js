// sessions.test.js — W2A: SessionRegistry, the broker's (connection, tab) →
// upstream session-context map. Upstream (W2B) and the Brave supervisor
// (W2C) are fakes here; only the registry's own rules are under test.

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { SessionRegistry, MAIN_TAB, sessionKeyOf } = require("../src/broker/sessions.js");

const tick = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A fake upstream session context: page + a browser whose connection we control. */
function fakeCtx(sessionKey) {
  const browser = { connected: true, isConnected() { return this.connected; } };
  let pages = 0;
  const newPage = () => ({ n: ++pages, closed: false, url: () => `about:blank#${sessionKey}` });
  return {
    sessionKey,
    closed: 0,
    opens: 0,
    page: newPage(),
    browserContext: { browser: () => browser },
    browser,
    // upstream's: re-creates the session page if it was closed
    async ensureSessionPageOpen() { this.opens++; if (this.page.closed) this.page = newPage(); },
    async close() { this.closed++; },
  };
}

/** Fake W2B upstream: createContext(sessionKey) with a per-call override hook. */
function fakeUpstream() {
  const up = {
    calls: [],
    created: [],
    active: 0,
    maxActive: 0,
    next: null, // optional (sessionKey) => Promise<ctx> for the next call only
    async createContext(sessionKey) {
      up.calls.push(sessionKey);
      up.active++;
      up.maxActive = Math.max(up.maxActive, up.active);
      try {
        const hook = up.next;
        up.next = null;
        const ctx = hook ? await hook(sessionKey) : (await tick(), fakeCtx(sessionKey));
        up.created.push(ctx);
        return ctx;
      } finally {
        up.active--;
      }
    },
  };
  return up;
}

/** Fake W2C supervisor: ensure() + 'down' events. */
function fakeSupervisor() {
  const sup = new EventEmitter();
  sup.ensures = 0;
  sup.fail = null;
  sup.ensure = async () => {
    sup.ensures++;
    if (sup.fail) throw sup.fail;
    return { cdpUrl: "http://127.0.0.1:1", pid: 1 };
  };
  return sup;
}

function setup() {
  const upstream = fakeUpstream();
  const supervisor = fakeSupervisor();
  const registry = new SessionRegistry({ upstream, supervisor, log: () => {} });
  return { upstream, supervisor, registry };
}

test("sessionKeyOf: <connId>:<tabKey>; MAIN_TAB is the default tab", () => {
  assert.strictEqual(MAIN_TAB, "main");
  assert.strictEqual(sessionKeyOf("c1", "sub1"), "c1:sub1");
});

test("getCtx: one context per (connection, tab), reused on later calls", async () => {
  const { upstream, registry } = setup();
  const a = await registry.getCtx("c1");
  const again = await registry.getCtx("c1", MAIN_TAB);
  const sub = await registry.getCtx("c1", "sub1");
  const other = await registry.getCtx("c2");
  assert.strictEqual(a, again);
  assert.notStrictEqual(a, sub);
  assert.notStrictEqual(a, other);
  assert.deepStrictEqual(upstream.calls, ["c1:main", "c1:sub1", "c2:main"]);
});

test("scope: per connection, never legacy's whole-context \"context\"", () => {
  const { registry } = setup();
  assert.strictEqual(registry.scope, "connection");
});

test("getCtx: always hands out an OPEN page (upstream's ensureSessionPageOpen), cached or new", async () => {
  const { upstream, registry } = setup();
  const ctx = await registry.getCtx("c1");
  assert.strictEqual(ctx.opens, 1);
  ctx.page.closed = true; // e.g. the user closed the window
  const again = await registry.getCtx("c1");
  assert.strictEqual(again, ctx, "same session context");
  assert.strictEqual(again.opens, 2);
  assert.strictEqual(again.page.closed, false);
  assert.strictEqual(again.page.n, 2, "a re-created page");
  assert.strictEqual(upstream.calls.length, 1);
});

test("getCtx: ensures Brave before creating a context", async () => {
  const { supervisor, upstream, registry } = setup();
  let ensuredBeforeCreate = null;
  upstream.next = async (key) => { ensuredBeforeCreate = supervisor.ensures > 0; return fakeCtx(key); };
  await registry.getCtx("c1");
  assert.strictEqual(ensuredBeforeCreate, true);
});

test("getCtx: concurrent calls for one tab share one createContext", async () => {
  const { upstream, registry } = setup();
  const [x, y, z] = await Promise.all([registry.getCtx("c1"), registry.getCtx("c1"), registry.getCtx("c1", "main")]);
  assert.strictEqual(x, y);
  assert.strictEqual(y, z);
  assert.strictEqual(upstream.calls.length, 1);
});

test("mutex: context creation never runs concurrently, even across connections and tabs", async () => {
  const { upstream, registry } = setup();
  const ctxs = await Promise.all([
    registry.getCtx("c1"), registry.getCtx("c1", "sub1"), registry.getCtx("c2"), registry.getCtx("c3", "x"),
  ]);
  assert.strictEqual(new Set(ctxs).size, 4);
  assert.strictEqual(upstream.maxActive, 1);
});

test("poisoned promise: a failed creation is not cached; the next call retries and succeeds", async () => {
  const { upstream, registry } = setup();
  upstream.next = async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9333"); };
  await assert.rejects(registry.getCtx("c1"), /ECONNREFUSED/);
  const ctx = await registry.getCtx("c1");
  assert.strictEqual(ctx.sessionKey, "c1:main");
  assert.strictEqual(upstream.calls.length, 2);
});

test("poisoned promise: a failed ensure() is not cached either", async () => {
  const { supervisor, upstream, registry } = setup();
  supervisor.fail = new Error("brave cdp timeout");
  await assert.rejects(registry.getCtx("c1"), /brave cdp timeout/);
  assert.strictEqual(upstream.calls.length, 0);
  supervisor.fail = null;
  assert.ok(await registry.getCtx("c1"));
});

test("mutex: a rejected creation releases the lock for the next one", async () => {
  const { upstream, registry } = setup();
  upstream.next = async () => { throw new Error("boom"); };
  const [bad, good] = await Promise.allSettled([registry.getCtx("c1"), registry.getCtx("c2")]);
  assert.strictEqual(bad.status, "rejected");
  assert.strictEqual(good.status, "fulfilled");
});

test("invalidateAll: next getCtx creates a fresh context and gets a one-shot reset notice", async () => {
  const { upstream, registry } = setup();
  const old = await registry.getCtx("c1");
  assert.strictEqual(registry.takeResetNotice("c1", MAIN_TAB), null, "no notice before any reset");
  assert.strictEqual(registry.invalidateAll("the browser went down (cdp disconnected)"), 1);
  const fresh = await registry.getCtx("c1");
  assert.notStrictEqual(fresh, old);
  assert.strictEqual(upstream.calls.length, 2);
  const notice = registry.takeResetNotice("c1", MAIN_TAB);
  assert.match(notice, /the browser went down \(cdp disconnected\)/);
  assert.match(notice, /reset/);
  assert.strictEqual(registry.takeResetNotice("c1", MAIN_TAB), null, "the notice is delivered once");
});

test("invalidateAll: notices are per tab; a tab that never had a context gets none", async () => {
  const { registry } = setup();
  await registry.getCtx("c1");
  await registry.getCtx("c1", "sub1");
  registry.invalidateAll("x");
  assert.ok(registry.takeResetNotice("c1", "sub1"));
  assert.ok(registry.takeResetNotice("c1", MAIN_TAB));
  assert.strictEqual(registry.takeResetNotice("c1", "never"), null);
  assert.strictEqual(registry.takeResetNotice("c2", MAIN_TAB), null);
});

test("invalidateAll: a second reset before the tab is used keeps the first reason", async () => {
  const { registry } = setup();
  await registry.getCtx("c1");
  registry.invalidateAll("the browser was closed after 20 min without tool calls");
  assert.strictEqual(registry.invalidateAll("the browser went down (closed)"), 0);
  assert.match(registry.takeResetNotice("c1", MAIN_TAB), /20 min/);
});

test("supervisor 'down' invalidates every context", async () => {
  const { supervisor, registry } = setup();
  const old = await registry.getCtx("c1");
  supervisor.emit("down", "cdp disconnected");
  assert.notStrictEqual(await registry.getCtx("c1"), old);
  assert.match(registry.takeResetNotice("c1", MAIN_TAB), /cdp disconnected/);
});

test("a creation that resolves after a reset is discarded and redone", async () => {
  const { upstream, registry } = setup();
  const gate = deferred();
  upstream.next = async (key) => { await gate.promise; return fakeCtx(key); };
  const pending = registry.getCtx("c1");
  await tick();
  registry.invalidateAll("the browser went down (cdp disconnected)");
  gate.resolve();
  const ctx = await pending;
  assert.strictEqual(upstream.calls.length, 2, "recreated against the new browser");
  assert.strictEqual(upstream.created[0].closed, 1, "the stale context is closed");
  assert.strictEqual(ctx, upstream.created[1]);
  assert.strictEqual(registry.takeResetNotice("c1", MAIN_TAB), null, "the agent never saw the stale tab");
});

test("a creation that fails because the browser went down meanwhile is retried (idle-close race)", async () => {
  // ensure() joined a launch right before an idle closeGracefully(): the
  // context creation dies with that Brave, then 'down' resets everything.
  const { supervisor, upstream, registry } = setup();
  const gate = deferred();
  upstream.next = async () => { await gate.promise; throw new Error("Target page, context or browser has been closed"); };
  const pending = registry.getCtx("c1");
  await tick();
  supervisor.emit("down", "closed");
  gate.resolve();
  const ctx = await pending;
  assert.strictEqual(ctx.sessionKey, "c1:main");
  assert.strictEqual(upstream.calls.length, 2);
  assert.strictEqual(supervisor.ensures, 2, "the retry relaunches Brave");
});

test("a creation failure with no reset in between is not retried", async () => {
  const { upstream, registry } = setup();
  upstream.next = async () => { throw new Error("boom"); };
  await assert.rejects(registry.getCtx("c1"), /boom/);
  assert.strictEqual(upstream.calls.length, 1);
});

test("getCtx: a cached context whose browser disconnected is replaced, with a notice", async () => {
  const { upstream, registry } = setup();
  const old = await registry.getCtx("c1");
  old.browser.connected = false;
  const fresh = await registry.getCtx("c1");
  assert.notStrictEqual(fresh, old);
  assert.strictEqual(upstream.calls.length, 2);
  assert.match(registry.takeResetNotice("c1", MAIN_TAB), /disconnected/);
});

test("listTabs: the connection's tabs only, main first", async () => {
  const { registry } = setup();
  await registry.getCtx("c1", "sub2");
  await registry.getCtx("c1");
  await registry.getCtx("c2", "theirs");
  const tabs = registry.listTabs("c1");
  assert.deepStrictEqual(tabs.map((t) => t.tabKey), ["main", "sub2"]);
  assert.deepStrictEqual(tabs.map((t) => t.state), ["open", "open"]);
  assert.strictEqual(tabs[0].page.url(), "about:blank#c1:main");
  assert.deepStrictEqual(registry.listTabs("nobody"), []);
});

test("listTabs: a reset tab is still listed until it is used again", async () => {
  const { registry } = setup();
  await registry.getCtx("c1", "sub1");
  registry.invalidateAll("x");
  assert.deepStrictEqual(registry.listTabs("c1").map((t) => [t.tabKey, t.state, t.page]), [["sub1", "reset", null]]);
});

test("closeTab: closes that tab's context only and forgets it", async () => {
  const { upstream, registry } = setup();
  const main = await registry.getCtx("c1");
  const sub = await registry.getCtx("c1", "sub1");
  assert.strictEqual(await registry.closeTab("c1", "sub1"), true);
  assert.strictEqual(sub.closed, 1);
  assert.strictEqual(main.closed, 0);
  assert.deepStrictEqual(registry.listTabs("c1").map((t) => t.tabKey), ["main"]);
  assert.strictEqual(await registry.closeTab("c1", "sub1"), false, "already gone");
  assert.notStrictEqual(await registry.getCtx("c1", "sub1"), sub, "reopening creates a new one");
  assert.strictEqual(upstream.calls.length, 3);
  assert.strictEqual(registry.takeResetNotice("c1", "sub1"), null, "a tab the agent closed is not 'reset'");
});

test("closeTab: a context.close() failure is swallowed", async () => {
  const { registry } = setup();
  const ctx = await registry.getCtx("c1");
  ctx.close = async () => { throw new Error("Target closed"); };
  assert.strictEqual(await registry.closeTab("c1", MAIN_TAB), true);
});

test("closeConn: closes every tab of that connection, not others'", async () => {
  const { registry } = setup();
  const a = await registry.getCtx("c1");
  const b = await registry.getCtx("c1", "sub1");
  const c = await registry.getCtx("c2");
  await registry.closeConn("c1");
  assert.deepStrictEqual([a.closed, b.closed, c.closed], [1, 1, 0]);
  assert.deepStrictEqual(registry.listTabs("c1"), []);
  assert.strictEqual(registry.listTabs("c2").length, 1);
});

test("closeConn while a creation is in flight: the late context is closed, the call rejects", async () => {
  const { upstream, registry } = setup();
  const gate = deferred();
  upstream.next = async (key) => { await gate.promise; return fakeCtx(key); };
  const pending = registry.getCtx("c1");
  await tick();
  await registry.closeConn("c1");
  gate.resolve();
  await assert.rejects(pending, /connection closed/);
  assert.strictEqual(upstream.created[0].closed, 1);
  assert.deepStrictEqual(registry.listTabs("c1"), []);
});

test("closeConn drops pending reset notices", async () => {
  const { registry } = setup();
  await registry.getCtx("c1");
  registry.invalidateAll("x");
  await registry.closeConn("c1");
  assert.strictEqual(registry.takeResetNotice("c1", MAIN_TAB), null);
});

test("a getCtx for a connection that already closed creates nothing (session left mid-call)", async () => {
  // e.g. the socket closed while the call awaited the first upstream import
  const { supervisor, upstream, registry } = setup();
  await registry.closeConn("c1");
  await assert.rejects(registry.getCtx("c1"), /connection closed/);
  assert.strictEqual(upstream.calls.length, 0);
  assert.strictEqual(supervisor.ensures, 0, "no Brave launched for nobody");
  assert.deepStrictEqual(registry.listTabs("c1"), []);
});

test("a creation that failed across a reset is not retried once its connection has closed", async () => {
  const { supervisor, upstream, registry } = setup();
  const gate = deferred();
  upstream.next = async () => { await gate.promise; throw new Error("Target closed"); };
  const pending = registry.getCtx("c1");
  await tick();
  supervisor.emit("down", "closed");
  await registry.closeConn("c1");
  gate.resolve();
  await assert.rejects(pending, /connection closed/);
  assert.strictEqual(upstream.calls.length, 1, "no retry for a gone connection");
});

test("an ensure() that waits out an idle close ('down' fires inside it) creates the context once", async () => {
  // W2C: ensure() waits for a closeGracefully in progress, which emits 'down',
  // then relaunches; the context made on the new Brave is good.
  const { supervisor, upstream, registry } = setup();
  let first = true;
  supervisor.ensure = async () => {
    supervisor.ensures++;
    if (first) { first = false; supervisor.emit("down", "closed"); }
  };
  await registry.getCtx("c1");
  assert.strictEqual(upstream.calls.length, 1);
  assert.strictEqual(upstream.created[0].closed, 0);
});

test("closeTab while the tab is still opening: the call rejects saying the tab was closed", async () => {
  const { upstream, registry } = setup();
  const gate = deferred();
  upstream.next = async (key) => { await gate.promise; return fakeCtx(key); };
  const pending = registry.getCtx("c1", "sub1");
  await tick();
  await registry.closeTab("c1", "sub1");
  gate.resolve();
  await assert.rejects(pending, /tab "sub1" was closed/);
  assert.strictEqual(upstream.created[0].closed, 1);
});

test("anyOpenCtx: an open context of any connection, else null; creates nothing", async () => {
  const { upstream, registry } = setup();
  assert.strictEqual(registry.anyOpenCtx(), null);
  const ctx = await registry.getCtx("c2", "sub");
  assert.strictEqual(registry.anyOpenCtx(), ctx);
  registry.invalidateAll("x");
  assert.strictEqual(registry.anyOpenCtx(), null);
  assert.strictEqual(upstream.calls.length, 1);
});

test("constructor: needs upstream.createContext and supervisor.ensure", () => {
  assert.throws(() => new SessionRegistry({ supervisor: fakeSupervisor() }), /upstream/);
  assert.throws(() => new SessionRegistry({ upstream: fakeUpstream() }), /supervisor/);
});

// ── W2E: the PID is gone before the CDP disconnect is processed ──
//
// W2C's isUp() reads false as soon as Brave's PID is gone; Playwright's
// isConnected() and the supervisor's 'down' lag behind (e2e: a call 24 ms
// after the kill got the cached context, and upstream's newPage on the dead
// context failed with "Target page, context or browser has been closed").

/** A supervisor like W2C's: isUp() PID-based; a relaunch emits the old Brave's late 'down' before it resolves. */
function pidSupervisor() {
  const sup = new EventEmitter();
  Object.assign(sup, {
    up: false,
    pendingDown: false,
    ensures: 0,
    launches: 0,
    gate: null, // optional deferred a launch waits for
    isUp: () => sup.up,
    async ensure() {
      sup.ensures++;
      if (sup.up) return { pid: sup.launches };
      if (sup.gate) await sup.gate.promise;
      if (sup.pendingDown) { sup.pendingDown = false; sup.emit("down", "cdp disconnected"); }
      if (!sup.up) { sup.up = true; sup.launches++; }
      return { pid: sup.launches };
    },
    // the process died; nothing has been processed yet
    killPid() { sup.up = false; sup.pendingDown = true; },
  });
  return sup;
}

const deadCtx = (ctx) => {
  ctx.page.closed = true;
  ctx.ensureSessionPageOpen = async () => { throw new Error("browserContext.newPage: Target page, context or browser has been closed"); };
};

test("W2E: PID gone, isConnected() still true: the next call relaunches and gets a fresh tab with a reset notice, not the dead context", async () => {
  const upstream = fakeUpstream();
  const supervisor = pidSupervisor();
  const registry = new SessionRegistry({ upstream, supervisor, log: () => {} });
  const a1 = await registry.getCtx("c1");
  const b1 = await registry.getCtx("c2");
  supervisor.killPid();
  deadCtx(a1);
  deadCtx(b1);
  assert.strictEqual(a1.browser.isConnected(), true, "the race: Playwright hasn't noticed yet");

  const a2 = await registry.getCtx("c1");
  assert.notStrictEqual(a2, a1);
  assert.strictEqual(supervisor.launches, 2, "Brave relaunched");
  assert.match(registry.takeResetNotice("c1", MAIN_TAB), /This tab was reset because the browser went down/);
  assert.strictEqual(registry.takeResetNotice("c1", MAIN_TAB), null, "once");

  // the old Brave's late 'down' came inside the relaunch: the new tab survives it
  assert.strictEqual(await registry.getCtx("c1"), a2);
  assert.strictEqual(registry.takeResetNotice("c1", MAIN_TAB), null, "no spurious second reset");
  // the other session's tab died too: fresh on its next call, with its notice
  const b2 = await registry.getCtx("c2");
  assert.notStrictEqual(b2, b1);
  assert.match(registry.takeResetNotice("c2", MAIN_TAB), /This tab was reset/);
  assert.strictEqual(registry.anyOpenCtx() === a2 || registry.anyOpenCtx() === b2, true);
});

test("W2E: anyOpenCtx never hands out a context of a Brave whose PID is gone", async () => {
  const supervisor = pidSupervisor();
  const registry = new SessionRegistry({ upstream: fakeUpstream(), supervisor, log: () => {} });
  await registry.getCtx("c1");
  supervisor.killPid();
  assert.strictEqual(registry.anyOpenCtx(), null);
});

test("W2E: no spurious resets while isUp() is false for a first launch or a relaunch in flight", async () => {
  const upstream = fakeUpstream();
  const supervisor = pidSupervisor();
  const registry = new SessionRegistry({ upstream, supervisor, log: () => {} });
  // first launch: isUp() false until it is done; concurrent first calls
  supervisor.gate = deferred();
  const first = [registry.getCtx("c1"), registry.getCtx("c2"), registry.getCtx("c1")];
  await tick();
  assert.strictEqual(supervisor.isUp(), false);
  supervisor.gate.resolve();
  const [a, b, a2] = await Promise.all(first);
  assert.strictEqual(a, a2);
  assert.strictEqual(upstream.calls.length, 2);
  assert.strictEqual(await registry.getCtx("c1"), a);
  assert.strictEqual(await registry.getCtx("c2"), b);
  assert.strictEqual(registry.takeResetNotice("c1", MAIN_TAB), null);
  assert.strictEqual(registry.takeResetNotice("c2", MAIN_TAB), null);

  // relaunch in flight: contexts made against the new Brave stay
  supervisor.killPid();
  supervisor.gate = deferred();
  const again = [registry.getCtx("c1"), registry.getCtx("c2")];
  await tick();
  supervisor.gate.resolve();
  const [a3, b3] = await Promise.all(again);
  assert.notStrictEqual(a3, a);
  assert.notStrictEqual(b3, b);
  assert.strictEqual(supervisor.launches, 2, "one relaunch for both");
  assert.strictEqual(await registry.getCtx("c1"), a3);
  assert.strictEqual(await registry.getCtx("c2"), b3);
  assert.strictEqual(upstream.calls.length, 4);
  assert.match(registry.takeResetNotice("c1", MAIN_TAB), /reset/);
  assert.match(registry.takeResetNotice("c2", MAIN_TAB), /reset/);
  assert.strictEqual(registry.takeResetNotice("c1", MAIN_TAB), null);
});
