// importer.js — the broker's side of the cookie bridge (W2F).
//
// Cookies from the owner's Chrome arrive over the bridge connection
// (control.js serveBridge: cookies.full / cookies.delta). Every cookie is
// classified again here (policy.js): deny and hold domains are refused
// unless the owner re-allowed them (userOverride:true), whatever the
// extension decided. Accepted cookies go into an in-memory snapshot that is
//   - applied to Brave at once when Brave is up (CDP Storage.setCookies on a
//     browser-level session: the default context every session shares), and
//   - applied again after every Brave (re)launch (main.js ensureBrave →
//     braveReady): session cookies don't survive a restart.
// Brave is never launched for the bridge. A removal in Chrome expires that
// cookie in Brave (now, or once at the next launch). Removals pass for any
// well-formed cookie, whatever its domain's policy: deleting is always safe,
// and an earlier broker may have synced it. An add replaces the cookie with
// the same name/domain/path/partition. One-way: Chrome → Brave.
//
// Cookie values live only in that snapshot and in the CDP calls: never in
// the log, the replies or status().

"use strict";

const policy = require("../../extensions/cookie-bridge/policy.js");
const { toCdpCookie, cookieKey, expireParam, isExpired } = require("./cdp-cookies.js");

const DEFAULT_BATCH = 200;
const DEFAULT_APPLY_TIMEOUT_MS = 15_000;

const domainOf = (c) => (c && typeof c === "object" && typeof c.domain === "string" ? policy.normalizeDomain(c.domain) : "");

/** Collects {domain, reason} refusals, counted, in first-seen order. */
class Refusals {
  constructor() { this._m = new Map(); }
  add(domain, reason) {
    const k = `${domain}\u0000${reason}`;
    const e = this._m.get(k);
    if (e) e.count++;
    else this._m.set(k, { domain, reason, count: 1 });
  }
  get size() { return this._m.size; }
  list() { return [...this._m.values()]; }
  summary(max = 5) {
    const l = this.list();
    const shown = l.slice(0, max).map((r) => `${r.domain || "?"} (${r.reason}${r.count > 1 ? ` x${r.count}` : ""})`).join(", ");
    return l.length > max ? `${shown}, +${l.length - max} more` : shown;
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms} ms (still applying in the background)`), { code: "ETIMEDOUT" })), ms); }),
  ]).finally(() => clearTimeout(timer));
}

class CookieImporter {
  /**
   * @param {object} opts
   * @param {{isUp: () => boolean, on?: Function}} opts.supervisor — W2C BraveSupervisor ('down' → the next launch re-applies)
   * @param {string} opts.cdpUrl — the broker's fixed CDP URL
   * @param {(msg: string) => void} [opts.log]
   * @param {(cdpUrl: string) => Promise<{send: Function, close: Function, closed: boolean}>} [opts.openCdp] — test seam
   * @param {() => number} [opts.now] — ms clock (test seam)
   * @param {number} [opts.batchSize] — cookies per Storage.setCookies call
   * @param {number} [opts.applyTimeoutMs] — the longest a tool call waits for the snapshot after a launch
   */
  constructor({ supervisor, cdpUrl, log = () => {}, openCdp = null, now = Date.now, batchSize = DEFAULT_BATCH, applyTimeoutMs = DEFAULT_APPLY_TIMEOUT_MS }) {
    this._supervisor = supervisor;
    this._cdpUrl = cdpUrl;
    this._log = (m) => log(`cookie bridge: ${m}`);
    this._openCdp = openCdp || ((url) => require("./cdp-client.js").openBrowserCdp(url));
    this._now = now;
    this._batch = batchSize;
    this._applyTimeoutMs = applyTimeoutMs;
    this._snapshot = new Map(); // key → CDP CookieParam
    this._pendingDeletes = new Map(); // key → expired CookieParam, for a Brave that was down
    this._staging = new Map(); // bridge id → keys of the full sync in progress
    this._bridges = new Set();
    this._queue = Promise.resolve(); // CDP work, strictly in order
    this._cdp = null;
    this._ready = null; // the apply for the running Brave
    this._readyPid = null;
    this._lastSyncAt = null;
    if (supervisor && typeof supervisor.on === "function") supervisor.on("down", () => this.braveDown());
  }

  /** ctl handlers for one bridge connection (control.js serveBridge). */
  handlers(bridgeId) {
    this._bridges.add(bridgeId);
    return {
      "cookies.full": async (msg) => {
        if (!Array.isArray(msg.cookies)) throw new Error("cookies must be an array");
        return this.full(bridgeId, msg.cookies, msg.last !== false);
      },
      "cookies.delta": async (msg) => {
        if (!Array.isArray(msg.changes)) throw new Error("changes must be an array");
        return this.delta(msg.changes);
      },
      close: () => this.connClosed(bridgeId),
    };
  }

  connClosed(bridgeId) {
    this._bridges.delete(bridgeId);
    this._staging.delete(bridgeId);
  }

  /**
   * One batch of a full sync. With last, every synced cookie the whole full
   * sync didn't include is deleted (Chrome no longer has it).
   */
  async full(bridgeId, cookies, last = true) {
    const refusals = new Refusals();
    const keys = this._staging.get(bridgeId) || new Set();
    this._staging.set(bridgeId, keys);
    const touched = [];
    for (const c of cookies) {
      const a = this._admit(c, refusals);
      if (!a) continue;
      if (isExpired(a.param, this._now() / 1000)) continue; // not in Chrome's live set
      this._snapshot.set(a.key, a.param);
      this._pendingDeletes.delete(a.key);
      keys.add(a.key);
      touched.push(a.key);
    }
    let stale = 0;
    if (last) {
      this._staging.delete(bridgeId);
      for (const [key, param] of this._snapshot) {
        if (keys.has(key)) continue;
        this._snapshot.delete(key);
        this._pendingDeletes.set(key, expireParam(param));
        stale++;
      }
    }
    const applied = touched.length - (await this._applyNow(touched, refusals));
    this._lastSyncAt = new Date(this._now()).toISOString();
    this._log(`full sync batch: ${applied} cookie(s) accepted${last ? `, ${stale} no longer in Chrome` : ""}${refusals.size ? `; refused: ${refusals.summary()}` : ""} (snapshot ${this._snapshot.size}, Brave ${this._isUp() ? "up" : "down"})`);
    return { applied, rejected: refusals.list() };
  }

  /** chrome.cookies.onChanged changes: the last change per cookie wins. */
  async delta(changes) {
    const refusals = new Refusals();
    const last = new Map(); // key → {removed, param}
    let accepted = 0;
    for (const ch of changes) {
      if (!ch || typeof ch !== "object") {
        refusals.add("", "malformed change");
        continue;
      }
      // a removal (or an add already expired) only has to be a well-formed
      // cookie: deleting is always safe, whatever the domain's policy (the
      // owner unticking a re-allowed deny domain sends exactly that)
      const mapped = this._map(ch.cookie, refusals);
      if (!mapped) continue;
      const removed = ch.removed === true || isExpired(mapped.param, this._now() / 1000);
      const a = removed ? mapped : this._admit(ch.cookie, refusals, mapped);
      if (!a) continue;
      accepted++;
      last.delete(a.key); // keep the map in the order of each cookie's last change
      last.set(a.key, { removed, param: a.param });
    }
    const touched = [];
    for (const [key, { removed, param }] of last) {
      if (removed) {
        // also when an earlier broker synced it (Brave's profile kept it)
        this._pendingDeletes.set(key, expireParam(this._snapshot.get(key) || param));
        this._snapshot.delete(key);
      } else {
        this._snapshot.set(key, param);
        this._pendingDeletes.delete(key);
        touched.push(key);
      }
    }
    const applied = accepted - (await this._applyNow(touched, refusals));
    this._lastSyncAt = new Date(this._now()).toISOString();
    this._log(`delta: ${applied} change(s) accepted${refusals.size ? `; refused: ${refusals.summary()}` : ""}`);
    return { applied, rejected: refusals.list() };
  }

  /**
   * Called by ensureBrave after every supervisor.ensure(): the first call
   * for a new Brave applies the snapshot (and pending deletions); later
   * calls for the same Brave share it. Never throws; waits at most
   * applyTimeoutMs.
   */
  braveReady(info) {
    const pid = info && info.pid;
    if (this._ready && this._readyPid === pid) return this._ready;
    this._readyPid = pid;
    const run = this._enqueue(async () => {
      if (!this._snapshot.size && !this._pendingDeletes.size) return;
      const t0 = this._now();
      const nowSec = t0 / 1000;
      const sets = [];
      for (const [key, param] of this._snapshot) {
        if (isExpired(param, nowSec)) this._snapshot.delete(key);
        else sets.push([key, param]);
      }
      const deletes = [...this._pendingDeletes];
      const refused = await this._apply(sets, deletes);
      for (const [key] of refused) this._snapshot.delete(key);
      const domains = new Set(sets.map(([, p]) => p.domain || p.url));
      this._log(`applied ${sets.length - refused.length} synced cookie(s) (${domains.size} domain(s))${deletes.length ? ` and ${deletes.length} deletion(s)` : ""} to Brave pid ${pid} in ${this._now() - t0} ms${refused.length ? `; Brave refused ${refused.length}` : ""}`);
    });
    const ready = withTimeout(run, this._applyTimeoutMs, "applying the synced cookies to Brave").catch((e) => {
      this._log(`${e.message}`);
      if (e.code !== "ETIMEDOUT" && this._ready === ready) this._ready = null; // retry on the next call
    });
    this._ready = ready;
    return ready;
  }

  /** Brave went down: the next launch gets the snapshot again. */
  braveDown() {
    this._ready = null;
    this._readyPid = null;
    const cdp = this._cdp;
    this._cdp = null;
    if (cdp) Promise.resolve(cdp).then((c) => c.close(), () => {});
  }

  /** What broker:status shows: counts only. */
  status() {
    const domains = new Set();
    for (const p of this._snapshot.values()) domains.add(p.domain ? p.domain.replace(/^\./, "") : p.url.replace(/^https?:\/\/|\/$/g, ""));
    return {
      bridges: this._bridges.size,
      cookies: this._snapshot.size,
      domains: domains.size,
      pendingDeletes: this._pendingDeletes.size,
      lastSyncAt: this._lastSyncAt,
    };
  }

  // ── internals ──

  _isUp() {
    try {
      return Boolean(this._supervisor && this._supervisor.isUp());
    } catch {
      return false;
    }
  }

  /** {key, param, host} for a well-formed cookie, else null (refusal noted). */
  _map(cookie, refusals) {
    const mapped = toCdpCookie(cookie);
    if (mapped.error) {
      refusals.add(domainOf(cookie), mapped.error);
      return null;
    }
    return { key: cookieKey(mapped.param), param: mapped.param, host: mapped.host };
  }

  /** {key, param} for a cookie the policy (and CDP) accept to SET, else null (refusal noted). */
  _admit(cookie, refusals, mapped = this._map(cookie, refusals)) {
    if (!mapped) return null;
    const verdict = policy.classify(mapped.host);
    if (verdict.decision !== "allow" && cookie.userOverride !== true) {
      refusals.add(domainOf(cookie), `${verdict.decision}:${verdict.category}`);
      return null;
    }
    return mapped;
  }

  _enqueue(fn) {
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  /**
   * Brave up: apply these snapshot keys and the pending deletions now (in
   * queue order, reading the snapshot when it runs). Returns how many of
   * `keys` Brave refused (noted in refusals and dropped). Brave down: 0, the
   * next launch applies them.
   */
  async _applyNow(keys, refusals) {
    if (!this._isUp() || (!keys.length && !this._pendingDeletes.size)) return 0;
    const run = this._enqueue(async () => {
      const sets = keys.filter((k) => this._snapshot.has(k)).map((k) => [k, this._snapshot.get(k)]);
      const refused = await this._apply(sets, [...this._pendingDeletes]);
      for (const [key, param] of refused) {
        this._snapshot.delete(key);
        refusals.add(policy.normalizeDomain(param.domain || param.url.replace(/^https?:\/\/|\/$/g, "")), "brave refused the cookie");
      }
      return refused.length;
    });
    try {
      return await withTimeout(run, this._applyTimeoutMs, "applying synced cookies to Brave");
    } catch (e) {
      this._log(e.message); // kept in the snapshot: the next launch applies them
      return 0;
    }
  }

  /**
   * Storage.setCookies for `sets` ([key, param]) in batches, then the
   * deletions ([key, expired param]). A batch Brave rejects is retried one
   * cookie at a time; returns the [key, param] pairs Brave refused. Applied
   * deletions leave pendingDeletes.
   */
  async _apply(sets, deletes) {
    const cdp = await this._connection();
    const refused = [];
    const setAll = async (pairs, onRefused) => {
      for (let i = 0; i < pairs.length; i += this._batch) {
        const chunk = pairs.slice(i, i + this._batch);
        try {
          await cdp.send("Storage.setCookies", { cookies: chunk.map(([, p]) => p) });
        } catch (e) {
          if (cdp.closed) throw e;
          for (const pair of chunk) {
            try {
              await cdp.send("Storage.setCookies", { cookies: [pair[1]] });
            } catch (e2) {
              if (cdp.closed) throw e2;
              onRefused(pair);
            }
          }
        }
      }
    };
    await setAll(sets, (pair) => refused.push(pair));
    await setAll(deletes, ([key]) => this._log(`Brave refused a deletion (${key.split("\u0000")[1]})`));
    for (const [key, param] of deletes) if (this._pendingDeletes.get(key) === param) this._pendingDeletes.delete(key);
    return refused;
  }

  async _connection() {
    if (this._cdp) {
      const c = await this._cdp.catch(() => null);
      if (c && !c.closed) return c;
    }
    const opening = this._openCdp(this._cdpUrl);
    this._cdp = opening;
    opening.catch(() => { if (this._cdp === opening) this._cdp = null; });
    return opening;
  }
}

module.exports = { CookieImporter };
