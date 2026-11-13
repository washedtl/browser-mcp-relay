// sessions.js — the broker's SessionRegistry: (connection, tab) → upstream
// session context.
//
// One MCP connection = one Claude session (its subagents share it). Each
// connection has a "main" tab plus any tabs a parallel subagent opened with
// its own tabId; every tab is one upstream ToolSessionContext, i.e. one page
// in its own window (W2B's newPage hook).
//
// Rules this module owns:
//   - Context creation is serialized (one mutex for the whole broker):
//     upstream caches its CDP connection check-then-set, so concurrent first
//     calls would open several connections to the one Brave.
//   - No poisoned promises: a failed creation is forgotten, so the next call
//     retries (upstream itself caches a rejected promise forever).
//   - Brave going down (supervisor 'down', or a cached context whose browser
//     disconnected) drops every context. Before handing out a cached context
//     the supervisor's checkAlive() turns a PID already gone (its exit and
//     disconnect not processed yet) into that 'down'. The next call on such a tab gets a
//     fresh page and, once, a reset notice to show the agent; a silent
//     about:blank would be misread as "my page is blank".
//   - A context that finishes creating after a reset (or after its
//     connection closed) is closed and never handed out.
//   - A tab with no call for a while is closed (closeIdle), as a reset: a
//     session that stays open no longer keeps the windows of work it has
//     finished. A tab with a call in flight (hold) is never closed.

"use strict";

const MAIN_TAB = "main";

const sessionKeyOf = (connId, tabKey) => `${connId}:${tabKey}`;

function resetNoticeText(reason) {
  return (
    `[browser-mcp-relay] This tab was reset because ${reason}: its page, URL, console/network buffers, ` +
    "element refs, stubs and emulation are gone. Navigate again before relying on earlier state."
  );
}

/** True unless the context's browser is known to be disconnected. */
function isAlive(ctx) {
  try {
    const browser = ctx.browserContext.browser();
    return !browser || typeof browser.isConnected !== "function" || browser.isConnected();
  } catch {
    return true; // shape we can't inspect: let the call itself fail if it's dead
  }
}

function goneMessage(connectionGone, tabKey) {
  return connectionGone ? `connection closed before tab "${tabKey}" was ready` : `tab "${tabKey}" was closed before it was ready`;
}

async function closeQuietly(ctx, log) {
  try {
    await ctx.close();
  } catch (e) {
    log(`closing a session context failed (ignored): ${e.message}`);
  }
}

class SessionRegistry {
  /**
   * @param {object} opts
   * @param {{createContext: (sessionKey: string) => Promise<object>}} opts.upstream — W2B loadUpstream() result (or a lazy facade)
   * @param {{ensure: () => Promise<object>, on?: Function, checkAlive?: () => boolean}} opts.supervisor — W2C BraveSupervisor
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ upstream, supervisor, log } = {}) {
    if (!upstream || typeof upstream.createContext !== "function") {
      throw new Error("SessionRegistry: needs upstream.createContext(sessionKey)");
    }
    if (!supervisor || typeof supervisor.ensure !== "function") {
      throw new Error("SessionRegistry: needs supervisor.ensure()");
    }
    this.upstream = upstream;
    this.supervisor = supervisor;
    // own-tools (W2D): not legacy's "context" — the BrowserContext is shared
    // by every connection, so tools touch only the caller's own tabs
    this.scope = "connection";
    this._log = log || (() => {});
    this._conns = new Map(); // connId → Map<tabKey, entry {promise, ctx}>
    this._notices = new Map(); // connId → Map<tabKey, reason>
    this._closedConns = new Set(); // connIds that left: a late call must not open a tab for them
    this._use = new Map(); // connId → Map<tabKey, {busy: calls in flight, last: when one last started or ended}>
    this._epoch = 0; // bumped by invalidateAll; a creation from an older epoch is stale
    this._lock = Promise.resolve(); // context-creation mutex
    if (typeof supervisor.on === "function") {
      supervisor.on("down", (reason) => this.invalidateAll(`the browser went down (${reason})`));
    }
  }

  /**
   * The upstream session context ({ page, browserContext, ... }) for this
   * connection's tab, created (and Brave launched) on first use. Its page is
   * open: upstream's ensureSessionPageOpen re-creates a closed one.
   * @returns {Promise<object>}
   */
  async getCtx(connId, tabKey = MAIN_TAB) {
    const ctx = await this._ctxFor(connId, tabKey);
    await ctx.ensureSessionPageOpen();
    return ctx;
  }

  _ctxFor(connId, tabKey) {
    // the session left while this call was on its way (e.g. awaiting the
    // first upstream import): open nothing for it
    if (this._closedConns.has(connId)) return Promise.reject(new Error(`[broker] ${goneMessage(true, tabKey)}`));
    const tabs = this._tabs(connId, true);
    if (tabs.get(tabKey)?.ctx) this._checkAlive(); // a dead Brave → 'down' → this tab is dropped
    const entry = tabs.get(tabKey);
    if (entry) {
      if (!entry.ctx) return entry.promise; // creation in flight: share it
      if (isAlive(entry.ctx)) return entry.promise;
      tabs.delete(tabKey);
      this._setNotice(connId, tabKey, "the browser disconnected");
    }
    const fresh = { ctx: null, promise: null, openedAt: Date.now() };
    tabs.set(tabKey, fresh);
    fresh.promise = this._create(connId, tabKey, fresh);
    // never cache a rejected creation
    fresh.promise.catch(() => {
      const current = this._conns.get(connId);
      if (current && current.get(tabKey) === fresh) current.delete(tabKey);
    });
    return fresh.promise;
  }

  /** Why this creation is no longer wanted (connection or tab gone), or null. */
  _gone(connId, tabKey, entry) {
    const current = this._conns.get(connId);
    if (current && current.get(tabKey) === entry) return null;
    return goneMessage(!current || this._closedConns.has(connId), tabKey);
  }

  async _create(connId, tabKey, entry) {
    // A reset while we create means the context belongs to the dead browser
    // (or died with it, e.g. ensure() joined a launch just before an idle
    // close): discard it and create again (bounded, in case Brave flaps).
    for (let attempt = 1; ; attempt++) {
      let gone = this._gone(connId, tabKey, entry);
      if (gone) throw new Error(`[broker] ${gone}`);
      let epoch;
      let ctx;
      try {
        ctx = await this._serialized(async () => {
          await this.supervisor.ensure();
          // read after ensure(): it may have waited out an idle close whose
          // 'down' already reset everything; this Brave is the new one
          epoch = this._epoch;
          return this.upstream.createContext(sessionKeyOf(connId, tabKey));
        });
      } catch (e) {
        gone = this._gone(connId, tabKey, entry);
        if (gone) throw new Error(`[broker] ${gone}`);
        // retry only a creation a reset cut short (not an ensure() failure)
        if (epoch === undefined || epoch === this._epoch || attempt >= 3) throw e;
        continue;
      }
      gone = this._gone(connId, tabKey, entry);
      if (gone) {
        await closeQuietly(ctx, this._log);
        throw new Error(`[broker] ${gone}`);
      }
      if (epoch === this._epoch) {
        entry.ctx = ctx;
        return ctx;
      }
      await closeQuietly(ctx, this._log);
      if (attempt >= 3) throw new Error(`[broker] the browser kept restarting while tab "${tabKey}" was opening; retry the call`);
    }
  }

  _checkAlive() {
    if (typeof this.supervisor.checkAlive === "function") this.supervisor.checkAlive();
  }

  _serialized(fn) {
    const run = this._lock.then(fn);
    this._lock = run.then(() => {}, () => {});
    return run;
  }

  _tabs(connId, create) {
    let tabs = this._conns.get(connId);
    if (!tabs && create) {
      tabs = new Map();
      this._conns.set(connId, tabs);
    }
    return tabs;
  }

  _setNotice(connId, tabKey, reason) {
    let notices = this._notices.get(connId);
    if (!notices) {
      notices = new Map();
      this._notices.set(connId, notices);
    }
    if (!notices.has(tabKey)) notices.set(tabKey, reason); // keep the first reason
  }

  /**
   * This connection's tabs, main first: state "open" (page ready), "opening"
   * (being created) or "reset" (dropped by a browser restart, or closed by
   * closeIdle; reopens on the next call with this tabKey).
   * @returns {Array<{tabKey: string, state: "open"|"opening"|"reset", page: object|null}>}
   */
  listTabs(connId) {
    const out = new Map();
    for (const [tabKey, entry] of this._conns.get(connId) || []) {
      let page = null;
      if (entry.ctx) {
        try { page = entry.ctx.page; } catch { /* page getter on a closed context */ }
      }
      out.set(tabKey, { tabKey, state: entry.ctx ? "open" : "opening", page });
    }
    for (const tabKey of (this._notices.get(connId) || new Map()).keys()) {
      if (!out.has(tabKey)) out.set(tabKey, { tabKey, state: "reset", page: null });
    }
    const tabs = [...out.values()];
    const main = tabs.findIndex((t) => t.tabKey === MAIN_TAB);
    if (main > 0) tabs.unshift(tabs.splice(main, 1)[0]);
    return tabs;
  }

  /** Close one tab (its window). Resolves true if the tab existed. */
  async closeTab(connId, tabKey) {
    const tabs = this._conns.get(connId);
    const entry = tabs && tabs.get(tabKey);
    const notices = this._notices.get(connId);
    const hadNotice = Boolean(notices && notices.delete(tabKey));
    const uses = this._use.get(connId);
    if (uses && !(uses.get(tabKey)?.busy > 0)) uses.delete(tabKey); // a call still holding it keeps a reopened tab from closing under it
    if (!entry) return hadNotice;
    tabs.delete(tabKey);
    if (entry.ctx) await closeQuietly(entry.ctx, this._log);
    // an in-flight creation sees it was dropped and closes its own context
    return true;
  }

  /** The connection went away: close all its tabs and forget it. */
  async closeConn(connId) {
    this._closedConns.add(connId); // ids are random per connection and never reused
    const tabs = this._conns.get(connId);
    this._conns.delete(connId);
    this._notices.delete(connId);
    this._use.delete(connId);
    if (!tabs) return;
    await Promise.all([...tabs.values()].filter((e) => e.ctx).map((e) => closeQuietly(e.ctx, this._log)));
  }

  /**
   * A call on this tab has started: until the returned release() runs, the
   * tab is in use and closeIdle leaves it open. Its idle time counts from
   * the later of the call's start and end.
   * @returns {() => void}
   */
  hold(connId, tabKey) {
    if (this._closedConns.has(connId)) return () => {}; // nothing left to keep open
    let uses = this._use.get(connId);
    if (!uses) this._use.set(connId, (uses = new Map()));
    const use = uses.get(tabKey) || { busy: 0, last: 0 };
    uses.set(tabKey, use);
    use.busy++;
    use.last = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      use.busy--;
      use.last = Date.now();
    };
  }

  /**
   * Close every open tab with no call in flight and none started or ended
   * for idleMs (counted from its opening when it had none). Its next call
   * opens a fresh page with a reset notice giving `reason`, as after a
   * browser restart. Resolves how many tabs were closed.
   */
  async closeIdle(idleMs, reason) {
    const now = Date.now();
    const closing = [];
    for (const [connId, tabs] of this._conns) {
      for (const [tabKey, entry] of tabs) {
        if (!entry.ctx) continue; // still opening
        const use = this._use.get(connId)?.get(tabKey);
        if (use && use.busy > 0) continue;
        if (now - Math.max(entry.openedAt, use ? use.last : 0) < idleMs) continue;
        tabs.delete(tabKey);
        this._setNotice(connId, tabKey, reason);
        closing.push(closeQuietly(entry.ctx, this._log));
      }
    }
    await Promise.all(closing);
    return closing.length;
  }

  /**
   * Drop every context (Brave died or is being closed). Their pages die
   * with the browser, so nothing is closed here. Returns how many open tabs
   * were reset.
   */
  invalidateAll(reason) {
    this._epoch++;
    let n = 0;
    for (const [connId, tabs] of this._conns) {
      for (const [tabKey, entry] of tabs) {
        if (!entry.ctx) continue; // still opening: it retries against the new browser
        tabs.delete(tabKey);
        this._setNotice(connId, tabKey, reason);
        n++;
      }
    }
    if (n) this._log(`reset ${n} tab(s): ${reason}`);
    return n;
  }

  /**
   * Record that this connection's tab was reset elsewhere (e.g. its session
   * survived a broker restart): its next use carries the notice.
   */
  noteReset(connId, tabKey, reason) {
    this._setNotice(connId, tabKey, reason);
  }

  /** An open context of any connection (none is created), or null. */
  anyOpenCtx() {
    this._checkAlive();
    for (const tabs of this._conns.values()) {
      for (const entry of tabs.values()) if (entry.ctx && isAlive(entry.ctx)) return entry.ctx;
    }
    return null;
  }

  /** The one-shot notice for a tab reset since the agent last used it, or null. */
  takeResetNotice(connId, tabKey) {
    const notices = this._notices.get(connId);
    if (!notices || !notices.has(tabKey)) return null;
    const reason = notices.get(tabKey);
    notices.delete(tabKey);
    return resetNoticeText(reason);
  }
}

module.exports = { SessionRegistry, MAIN_TAB, sessionKeyOf, resetNoticeText };
