// importer.js — the broker's side of the cookie bridge (W2F).
//
// Cookies from the owner's Chrome arrive over the bridge connection
// (control.js serveBridge: cookies.full / cookies.delta). Every cookie is
// classified again here (policy.js), on its own domain AND, for a
// partitioned cookie, its top-level site: deny and hold are refused unless
// the owner re-allowed them (userOverride:true), whatever the extension
// decided. Accepted cookies go into an in-memory snapshot that is
//   - applied to Brave at once when Brave is up (CDP Storage.setCookies on a
//     browser-level session: the default context every session shares), and
//   - applied again after every Brave (re)launch: the supervisor's 'pipe'
//     event (W2G: once per launch, as the CdpProxy starts serving it) starts
//     the apply, and main.js ensureBrave → braveReady waits for it before
//     any tool uses that Brave. Session cookies don't survive a restart.
// The CDP connection is the broker's own: its CdpProxy's secret ws URL
// (openCdp, injected by main.js in-process); Brave has no debugging port.
// Brave is never launched for the bridge. An add replaces the cookie with
// the same name/domain/path/partition. A removal in Chrome expires that
// cookie in Brave (now, or once at the next launch); for a deny/hold domain
// only when the bridge manages that cookie or the owner flagged it, so
// Chrome deleting its own bank cookie never touches one Brave set itself.
//
// The bridge-managed set — every cookie the bridge put into Brave, by
// identity (name, url, domain, path, partitionKey and flags; NEVER a value)
// — and the deletions not yet applied are persisted (stateFile, written
// atomically, user-private), so a broker restart forgets nothing: a full
// resync (last:true) expires every managed cookie Chrome no longer has, and
// deletions queued while Brave was down apply at the next launch.
//
// Chromium writes cookie changes to disk only every ~30 s (and at a
// graceful close), so a Brave killed right after a deletion comes back with
// the cookie. An applied deletion therefore stays as an "unflushed"
// tombstone, tagged with the launch (epoch) it went to, until that Brave
// has stayed up for FLUSH_MS after it; a launch re-applies the tombstones
// an earlier Brave may have lost. Re-syncing the cookie drops its tombstone.
//
// The owner's always-allow list (BROWSER_RELAY_BRIDGE_ALLOW, opts.allow)
// lifts the keyword guard for those domains on this side; deny categories
// still need the review page's re-allow (userOverride), as before.
//
// One bridge at a time (one Chrome profile is the single source of truth).
// Cookie values live only in the in-memory snapshot and the CDP calls:
// never in the log, the replies, status() or the state file.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const policy = require("../../extensions/cookie-bridge/policy.js");
const { toCdpCookie, cookieKey, expireParam, isExpired } = require("./cdp-cookies.js");

const DEFAULT_BATCH = 200;
const DEFAULT_APPLY_TIMEOUT_MS = 15_000;
const STATE_VERSION = 1;
// Chromium's cookie store commits every 30 s: twice that, and a deletion is on disk
const DEFAULT_FLUSH_MS = 60_000;
const IDENTITY_FIELDS = ["name", "url", "domain", "path", "secure", "httpOnly", "sameSite", "partitionKey"];

const domainOf = (c) => (c && typeof c === "object" && typeof c.domain === "string" ? policy.normalizeDomain(c.domain) : "");

/** A CookieParam without its value or expiry: what the state file keeps. */
function identityOf(param) {
  const id = {};
  for (const f of IDENTITY_FIELDS) if (param[f] !== undefined) id[f] = param[f];
  return id;
}

function validIdentity(id) {
  return Boolean(id) && typeof id === "object" && typeof id.name === "string"
    && typeof id.url === "string" && /^https?:\/\/[^/\s]+\/$/.test(id.url)
    && typeof id.path === "string" && id.path.startsWith("/")
    && (id.domain === undefined || (typeof id.domain === "string" && id.domain.startsWith(".")))
    && (id.partitionKey === undefined || (id.partitionKey && typeof id.partitionKey.topLevelSite === "string"));
}

/** The host of a partition's top-level site ("https://chase.com" → "chase.com"). */
function siteHost(site) {
  try {
    return new URL(site).hostname;
  } catch {
    return policy.normalizeDomain(String(site).replace(/^https?:\/\//, ""));
  }
}

/** Where a broker keeps the bridge state for one Brave profile (next to its key). */
function stateFileFor(dir, profileDir) {
  let p = path.resolve(profileDir);
  if (process.platform === "win32") p = p.toLowerCase();
  return path.join(dir, `cookie-bridge-${crypto.createHash("sha256").update(p).digest("hex").slice(0, 12)}.json`);
}

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
   * @param {() => Promise<{send: Function, close: Function, closed: boolean}>} opts.openCdp — a browser-level
   *   CDP connection to the broker's Brave (the broker decides how: cdp-client.js openBrowserCdp today)
   * @param {string|null} [opts.stateFile] — where the bridge-managed keys persist (null: memory only)
   * @param {(msg: string) => void} [opts.log]
   * @param {string[]} [opts.allow] — the owner's always-allow domains (policy.parseAllowList)
   * @param {() => number} [opts.now] — ms clock (test seam)
   * @param {number} [opts.batchSize] — cookies per Storage.setCookies call
   * @param {number} [opts.applyTimeoutMs] — the longest a tool call or a sync reply waits on Brave
   * @param {number} [opts.flushMs] — how long an applied deletion is kept for re-applying after a crash (test seam)
   */
  constructor({ supervisor, openCdp, stateFile = null, log = () => {}, allow = [], now = Date.now, batchSize = DEFAULT_BATCH, applyTimeoutMs = DEFAULT_APPLY_TIMEOUT_MS, flushMs = DEFAULT_FLUSH_MS }) {
    if (typeof openCdp !== "function") throw new Error("CookieImporter: openCdp is required");
    this._supervisor = supervisor;
    this._openCdp = openCdp;
    this._allow = Object.freeze([...allow]);
    this._stateFile = stateFile;
    this._log = (m) => log(`cookie bridge: ${m}`);
    this._now = now;
    this._batch = batchSize;
    this._applyTimeoutMs = applyTimeoutMs;
    this._flushMs = flushMs;
    this._snapshot = new Map(); // key → CDP CookieParam (with its value; memory only)
    this._managed = new Map(); // key → identity: every cookie the bridge put into Brave (persisted)
    this._pendingDeletes = new Map(); // key → expired CookieParam, not yet applied to Brave (persisted)
    this._unflushed = new Map(); // key → {param, at, epoch}: applied, maybe not on disk yet (persisted as pending)
    this._seen = new Map(); // key → identity: every cookie the bridge has put into Brave in this broker's life (masked, purged)
    this._purged = false; // bridge:uninstall --purge ran: no state file until a bridge connects again
    this._epoch = 0; // bumped whenever Brave goes down: the running Brave's tombstones carry it
    this._staging = new Map(); // bridge id → {keys, fresh} of the full sync in progress
    this._bridge = null; // the one connected bridge
    this._queue = Promise.resolve(); // CDP work, strictly in order
    this._cdp = null;
    this._ready = null; // the apply for the running Brave
    this._readyPid = null;
    this._launch = 0; // bumped on every 'pipe' (one per launch that came up)
    this._readyLaunch = 0;
    this._lastSyncAt = null;
    this._dirty = false;
    this._loadState();
    if (supervisor && typeof supervisor.on === "function") {
      supervisor.on("down", () => this.braveDown());
      // W2G: emitted once per launch, after the CdpProxy took the new pipe
      // and before ensure() resolves: the new Brave gets the snapshot now.
      supervisor.on("pipe", () => this.braveLaunched());
    }
  }

  /**
   * ctl handlers for the bridge connection (control.js serveBridge), once it
   * authenticated. Throws EBUSY while another bridge is connected.
   */
  handlers(bridgeId) {
    if (this._bridge !== null) {
      throw Object.assign(new Error("another cookie bridge is already connected (one Chrome profile syncs at a time)"), { code: "EBUSY" });
    }
    this._bridge = bridgeId;
    this._purged = false;
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
    if (this._bridge === bridgeId) this._bridge = null;
    this._staging.delete(bridgeId);
  }

  /**
   * One batch of a full sync. With last, every bridge-managed cookie the
   * whole full sync didn't include is deleted (Chrome no longer has it),
   * including ones an earlier broker synced. A cookie a delta changed while
   * this full sync was being sent is skipped: the delta is newer.
   * Rejects (EAPPLY) when Brave is up but didn't take the cookies.
   */
  async full(bridgeId, cookies, last = true) {
    const refusals = new Refusals();
    let st = this._staging.get(bridgeId);
    if (!st) {
      st = { keys: new Set(), fresh: new Set() };
      this._staging.set(bridgeId, st);
    }
    const nowSec = this._now() / 1000;
    const touched = [];
    let accepted = 0;
    let stale = 0;
    for (const c of cookies) {
      const a = this._admit(c, refusals);
      if (!a || isExpired(a.param, nowSec)) continue; // refused, or not in Chrome's live set
      accepted++;
      if (st.fresh.has(a.key)) continue; // a delta during this full sync is newer
      this._setSynced(a.key, a.param);
      st.keys.add(a.key);
      touched.push(a.key);
    }
    if (last) {
      this._staging.delete(bridgeId);
      for (const key of [...this._managed.keys()]) {
        if (st.keys.has(key)) continue;
        this._forget(key);
        stale++;
      }
    }
    try {
      const refused = await this._applyNow(touched, refusals);
      const applied = accepted - refused;
      this._lastSyncAt = new Date(this._now()).toISOString();
      this._log(`full sync batch: ${applied} cookie(s) accepted${last ? `, ${stale} no longer in Chrome` : ""}${refusals.size ? `; refused: ${refusals.summary()}` : ""} (snapshot ${this._snapshot.size}, managed ${this._managed.size}, Brave ${this._isUp() ? "up" : "down"})`);
      return { applied, rejected: refusals.list() };
    } finally {
      this._saveState();
    }
  }

  /**
   * chrome.cookies.onChanged changes: the last change per cookie wins.
   * Rejects (EAPPLY) when Brave is up but didn't take them.
   */
  async delta(changes) {
    const refusals = new Refusals();
    const nowSec = this._now() / 1000;
    const last = new Map(); // key → {removed, param}
    let accepted = 0;
    for (const ch of changes) {
      if (!ch || typeof ch !== "object") {
        refusals.add("", "malformed change");
        continue;
      }
      const mapped = this._map(ch.cookie, refusals);
      if (!mapped) continue;
      const removed = ch.removed === true || isExpired(mapped.param, nowSec);
      if (removed) {
        // Deleting is safe, except a deny/hold domain's cookie the bridge
        // never put there: that one is Brave's own.
        // (The always-allow list doesn't count here: it never lets a deletion
        // reach a cookie the bridge didn't put into Brave.)
        const verdict = this._managed.has(mapped.key) || ch.cookie.userOverride === true ? null : this._verdict(mapped, ch.cookie, { allow: [] });
        if (verdict) {
          refusals.add(verdict.domain, verdict.reason);
          continue;
        }
      } else if (!this._admit(ch.cookie, refusals, mapped)) {
        continue;
      }
      accepted++;
      last.delete(mapped.key); // keep the map in the order of each cookie's last change
      last.set(mapped.key, { removed, param: mapped.param });
    }
    const touched = [];
    for (const [key, { removed, param }] of last) {
      for (const st of this._staging.values()) {
        st.fresh.add(key); // a later batch of that full sync holds an older read
        if (removed) st.keys.delete(key);
        else st.keys.add(key);
      }
      if (removed) {
        this._forget(key, param);
      } else {
        this._setSynced(key, param);
        touched.push(key);
      }
    }
    try {
      const applied = accepted - (await this._applyNow(touched, refusals));
      this._lastSyncAt = new Date(this._now()).toISOString();
      this._log(`delta: ${applied} change(s) accepted${refusals.size ? `; refused: ${refusals.summary()}` : ""}`);
      return { applied, rejected: refusals.list() };
    } finally {
      this._saveState();
    }
  }

  /**
   * Called by ensureBrave after every supervisor.ensure(): the first call
   * for a new Brave applies the snapshot (and pending deletions); later
   * calls for the same Brave share it. Never throws; waits at most
   * applyTimeoutMs. A failed apply (even one that fails after the wait) is
   * retried on the next call.
   */
  braveReady(info) {
    const pid = info && info.pid;
    if (this._ready && this._readyPid === pid && this._readyLaunch === this._launch) return this._ready;
    this._readyPid = pid;
    this._readyLaunch = this._launch;
    const run = this._enqueue(async () => {
      const lostDeletes = [...this._unflushed.values()].some((u) => u.epoch !== this._epoch);
      if (!this._snapshot.size && !this._pendingDeletes.size && !lostDeletes) return;
      const t0 = this._now();
      const nowSec = t0 / 1000;
      const sets = [];
      for (const [key, param] of this._snapshot) {
        if (!isExpired(param, nowSec)) {
          sets.push([key, param]);
          continue;
        }
        this._snapshot.delete(key); // Brave expires it too
        if (this._managed.delete(key)) this._dirty = true;
      }
      // and the deletions an earlier Brave may not have written to disk
      const deletes = [...this._pendingDeletes];
      for (const [key, u] of this._unflushed) if (u.epoch !== this._epoch) deletes.push([key, u.param]);
      try {
        const refused = await this._apply(sets, deletes);
        this._dropRefused(refused);
        const domains = new Set(sets.map(([, p]) => p.domain || p.url));
        this._log(`applied ${sets.length - refused.length} synced cookie(s) (${domains.size} domain(s))${deletes.length ? ` and ${deletes.length} deletion(s)` : ""} to Brave pid ${pid} in ${this._now() - t0} ms${refused.length ? `; Brave refused ${refused.length}` : ""}`);
      } finally {
        this._saveState();
      }
    });
    const ready = withTimeout(run, this._applyTimeoutMs, "applying the synced cookies to Brave").catch((e) => this._log(e.message));
    this._ready = ready;
    run.catch(() => { if (this._ready === ready) this._ready = null; }); // retry on the next call
    return ready;
  }

  /**
   * W2G 'pipe': a Brave launch came up. Whatever was applied belongs to an
   * earlier Brave (even one with the same PID): start this one's apply.
   * Never throws (it runs inside the supervisor's emit).
   */
  braveLaunched() {
    this.braveDown();
    this._launch++;
    let pid = null;
    try { pid = this._supervisor.pid; } catch { /* a fake without it */ }
    this.braveReady({ pid });
  }

  /**
   * npm run bridge:uninstall -- --purge (control.js "bridge-purge"): expire in
   * Brave every cookie the bridge has put there (managed, pending, not yet on
   * disk, or seen in this broker's life), forget them all, and delete the
   * state file; none is written again until a bridge connects. Refused
   * (EBUSY) while a bridge is connected: it would sync them straight back.
   * Brave must be up (main.js launches it first). Never logs a value.
   * @returns {Promise<{expired: number}>}
   */
  async purge() {
    if (this._bridge !== null) {
      throw Object.assign(new Error("the cookie bridge extension is still connected, and would sync the cookies straight back: remove it in chrome://extensions (or turn on Pause sync on its review page), then purge again"), { code: "EBUSY" });
    }
    if (!this._isUp()) throw Object.assign(new Error("Brave is not running"), { code: "EDOWN" });
    const all = new Map();
    for (const [key, id] of this._seen) all.set(key, expireParam(id));
    for (const [key, id] of this._managed) all.set(key, expireParam(id));
    for (const [key, u] of this._unflushed) all.set(key, u.param);
    for (const [key, p] of this._pendingDeletes) all.set(key, p);
    this._snapshot.clear();
    this._managed.clear();
    this._seen.clear();
    this._staging.clear();
    this._unflushed.clear();
    this._pendingDeletes = all;
    this._dirty = true;
    const expired = all.size; // _apply moves each applied one out of _pendingDeletes
    await this._enqueue(() => this._apply([], [...all]));
    // applied; kept as tombstones in memory only (re-applied if this Brave crashes before its next disk write)
    this._purged = true;
    this._dirty = false;
    if (this._stateFile) {
      try {
        fs.rmSync(this._stateFile, { force: true });
      } catch (e) {
        this._log(`could not delete the bridge state ${this._stateFile}: ${e.code || e.message}`);
      }
    }
    this._log(`purged: ${expired} bridge cookie(s) expired in Brave, state file deleted`);
    return { expired };
  }

  /** Brave went down: the next launch gets the snapshot (and the unflushed deletions) again. */
  braveDown() {
    this._settle(); // deletions this Brave held long enough are on disk
    this._epoch++;
    this._saveState();
    this._ready = null;
    this._readyPid = null;
    const cdp = this._cdp;
    this._cdp = null;
    if (cdp) Promise.resolve(cdp).then((c) => c.close(), () => {});
  }

  /**
   * A matcher for cookies as cookies_export reads them from Brave
   * ({name, domain, path}): true for one the bridge manages or has put
   * into Brave in this broker's life, whose value cookies_export then hides.
   * Built from those sets as they are now (one per export). Matched on name, domain (host-only or not) and path,
   * ignoring the partition: a doubt hides a value rather than shows it.
   * @returns {(cookie: {name: string, domain: string, path?: string}) => boolean}
   */
  managedMatcher() {
    const index = new Set();
    // managed now, or put there earlier and not certainly gone (a deletion
    // pending or not on disk yet, a refused update over an earlier value)
    for (const key of new Set([...this._seen.keys(), ...this._managed.keys(), ...this._pendingDeletes.keys(), ...this._unflushed.keys()])) {
      const [name, where, path] = key.split("\u0000");
      index.add(`${name}\u0000${where.toLowerCase()}\u0000${path}`);
    }
    return (cookie) => {
      if (!index.size || !cookie || typeof cookie.name !== "string" || typeof cookie.domain !== "string") return false;
      const d = cookie.domain.trim().toLowerCase();
      const where = d.startsWith(".") ? d : `host:${d}/`;
      const path = typeof cookie.path === "string" ? cookie.path : "/";
      return index.has(`${cookie.name}\u0000${where}\u0000${path}`);
    };
  }

  /** What broker:status shows: counts only (and the owner's own allow list). */
  status() {
    const domains = new Set();
    for (const p of this._snapshot.values()) domains.add(p.domain ? p.domain.replace(/^\./, "") : p.url.replace(/^https?:\/\/|\/$/g, ""));
    return {
      bridges: this._bridge === null ? 0 : 1,
      cookies: this._snapshot.size,
      domains: domains.size,
      managed: this._managed.size,
      pendingDeletes: this._pendingDeletes.size,
      lastSyncAt: this._lastSyncAt,
      allow: [...this._allow],
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

  /** The policy refusal for a cookie's domain or partition site, or null when both are allowed. */
  _verdict(mapped, cookie, opts = { allow: this._allow }) {
    const own = policy.classify(mapped.host, opts);
    if (own.decision !== "allow") return { domain: domainOf(cookie), reason: `${own.decision}:${own.category}` };
    const pk = mapped.param.partitionKey;
    if (pk) {
      const top = siteHost(pk.topLevelSite);
      const v = policy.classify(top, opts);
      if (v.decision !== "allow") return { domain: policy.normalizeDomain(top), reason: `${v.decision}:${v.category}` };
    }
    return null;
  }

  /** {key, param} for a cookie the policy accepts to SET, else null (refusal noted). */
  _admit(cookie, refusals, mapped = this._map(cookie, refusals)) {
    if (!mapped) return null;
    const verdict = this._verdict(mapped, cookie);
    if (verdict && cookie.userOverride !== true) {
      refusals.add(verdict.domain, verdict.reason);
      return null;
    }
    return mapped;
  }

  /** Snapshot it; the bridge manages it from now on. */
  _setSynced(key, param) {
    this._snapshot.set(key, param);
    this._seen.set(key, identityOf(param));
    const id = identityOf(param);
    const was = this._managed.get(key);
    if (!was || JSON.stringify(was) !== JSON.stringify(id)) {
      this._managed.set(key, id);
      this._dirty = true;
    }
    if (this._pendingDeletes.delete(key)) this._dirty = true;
    if (this._unflushed.delete(key)) this._dirty = true; // a tombstone must never undo it at a relaunch
  }

  /** Delete it from Brave (now or at the next launch) and stop managing it. */
  _forget(key, param = null) {
    const id = this._managed.get(key) || identityOf(this._snapshot.get(key) || param);
    this._snapshot.delete(key);
    this._managed.delete(key);
    this._pendingDeletes.set(key, expireParam(id));
    this._unflushed.delete(key); // the new deletion supersedes it
    this._dirty = true;
  }

  _dropRefused(refused) {
    for (const [key] of refused) {
      this._snapshot.delete(key);
      if (this._managed.delete(key)) this._dirty = true;
    }
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
   * next launch applies them. Throws EAPPLY when Brave didn't take them:
   * they stay in the snapshot, and the next ensureBrave re-applies it all.
   */
  async _applyNow(keys, refusals) {
    if (!this._isUp() || (!keys.length && !this._pendingDeletes.size)) return 0;
    const run = this._enqueue(async () => {
      try {
        const sets = keys.filter((k) => this._snapshot.has(k)).map((k) => [k, this._snapshot.get(k)]);
        const refused = await this._apply(sets, [...this._pendingDeletes]);
        for (const [, param] of refused) {
          refusals.add(policy.normalizeDomain(param.domain || param.url.replace(/^https?:\/\/|\/$/g, "")), "brave refused the cookie");
        }
        this._dropRefused(refused);
        return refused.length;
      } finally {
        this._saveState();
      }
    });
    // failed, even after the wait below: the running Brave gets the whole snapshot again
    run.catch(() => { this._ready = null; this._readyPid = null; });
    try {
      return await withTimeout(run, this._applyTimeoutMs, "applying synced cookies to Brave");
    } catch (e) {
      this._log(e.message);
      if (e.code === "ETIMEDOUT") return 0; // still going; kept in the snapshot either way
      throw Object.assign(new Error(`not applied to Brave (${e.message}); kept, and applied at Brave's next use`), { code: "EAPPLY" });
    }
  }

  /**
   * Storage.setCookies for `sets` ([key, param]) in batches, then the
   * deletions ([key, expired param]). A batch Brave rejects is retried one
   * cookie at a time; returns the [key, param] pairs Brave refused. Applied
   * deletions leave pendingDeletes.
   */
  async _apply(sets, deletes) {
    const epoch = this._epoch; // the Brave these go to (a 'down' mid-apply bumps it)
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
    const at = this._now();
    for (const [key, param] of deletes) {
      const pending = this._pendingDeletes.get(key) === param;
      const u = this._unflushed.get(key);
      if (!pending && !(u && u.param === param)) continue; // re-synced or deleted again meanwhile
      if (pending) this._pendingDeletes.delete(key);
      this._unflushed.set(key, { param, at, epoch });
      this._dirty = true;
    }
    return refused;
  }

  async _connection() {
    if (this._cdp) {
      const c = await this._cdp.catch(() => null);
      if (c && !c.closed) return c;
    }
    const opening = Promise.resolve().then(() => this._openCdp());
    this._cdp = opening;
    opening.catch(() => { if (this._cdp === opening) this._cdp = null; });
    return opening;
  }

  _loadState() {
    if (!this._stateFile) return;
    let raw;
    try {
      raw = fs.readFileSync(this._stateFile, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") this._log(`could not read the bridge state ${this._stateFile} (${e.code}); starting without it`);
      return;
    }
    let data = null;
    try { data = JSON.parse(raw); } catch { /* never the parse error: it would quote the file */ }
    if (!data || data.v !== STATE_VERSION) {
      this._log(`ignoring an unreadable bridge state file ${this._stateFile}`);
      return;
    }
    for (const id of Array.isArray(data.managed) ? data.managed : []) {
      if (validIdentity(id)) { this._managed.set(cookieKey(id), identityOf(id)); this._seen.set(cookieKey(id), identityOf(id)); }
    }
    for (const id of Array.isArray(data.pendingDeletes) ? data.pendingDeletes : []) {
      if (validIdentity(id)) { this._pendingDeletes.set(cookieKey(id), expireParam(identityOf(id))); this._seen.set(cookieKey(id), identityOf(id)); }
    }
    if (this._managed.size || this._pendingDeletes.size) {
      this._log(`state: ${this._managed.size} bridge-managed cookie(s), ${this._pendingDeletes.size} pending deletion(s) from an earlier broker`);
    }
  }

  /** Drop the tombstones the running Brave has held for flushMs: they are on disk. */
  _settle() {
    const now = this._now();
    for (const [key, u] of this._unflushed) {
      if (u.epoch === this._epoch && now - u.at >= this._flushMs) {
        this._unflushed.delete(key);
        this._dirty = true;
      }
    }
  }

  /**
   * Atomic (temp file + rename), user-private; identities only, never values.
   * Unflushed tombstones are saved as pending: a new broker re-applies them.
   */
  _saveState() {
    if (this._unflushed.size && this._isUp()) this._settle();
    if (!this._stateFile || !this._dirty || this._purged) return;
    this._dirty = false;
    const pending = new Map(this._pendingDeletes);
    for (const [key, u] of this._unflushed) if (!pending.has(key)) pending.set(key, u.param);
    const data = JSON.stringify({
      v: STATE_VERSION,
      managed: [...this._managed.values()],
      pendingDeletes: [...pending.values()].map(identityOf),
    });
    const tmp = `${this._stateFile}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this._stateFile), { recursive: true });
      fs.writeFileSync(tmp, data, { mode: 0o600 });
      fs.renameSync(tmp, this._stateFile);
    } catch (e) {
      this._dirty = true;
      this._log(`could not save the bridge state ${this._stateFile}: ${e.code || e.message}`);
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    }
  }
}

module.exports = { CookieImporter, stateFileFor, identityOf };
