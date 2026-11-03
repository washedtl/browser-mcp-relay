// bridge-core.js — cookie-bridge pure logic (W2F-ext).
//
// No chrome.* here: every dependency is injected (see createBridge's `deps`),
// so the same code runs under node --test with fakes and in the MV3 worker
// with the real APIs. background.js is the only file that touches chrome.*.
//
// What it does, once the owner has approved on the review page:
//   - connects to the native host (hello), batched full sync on request,
//     live cookies.onChanged deltas, resync on demand, reconnect with backoff
//   - re-reads all state from storage on every (re)start, so an MV3 worker
//     that was stopped and restarted picks up exactly where it left off
//
// Cookie VALUES never go to a log line or to chrome.storage.local — only to
// the native host. The review page reads domains and counts, never values.
//
// Dual-publish: CommonJS for node --test, and a globalThis handle for the
// extension (background.js imports this file for its side effect).

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.CookieBridgeCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const HOST_NAME = "com.browser_mcp_relay.cookie_bridge";
  // Native messaging caps a host→ext message at 1 MB; we send ext→host, but
  // keep the same ceiling and leave generous headroom for JSON overhead.
  const MAX_BATCH_BYTES = 256 * 1024;
  const RECONNECT_BASE_MS = 1000;
  const RECONNECT_MAX_MS = 20_000; // < 30 s so a retry lands before an idle MV3 worker is stopped
  const DELTA_DEBOUNCE_MS = 150; // coalesce a burst of onChanged into one message
  const BADGE_COLOR = "#b4531f";

  const STATUS_KEY = "status";
  const SETTINGS_KEY = "settings";

  // ── settings helpers (what the review page writes, pure) ──────────────────

  function normDomain(domain) {
    return String(domain == null ? "" : domain).trim().toLowerCase().replace(/^\.+/, "");
  }

  function defaultSettings() {
    return { approved: false, approvedAt: 0, paused: false, overrides: {}, reviewed: {} };
  }
  function withDefaults(s) {
    const d = defaultSettings();
    s = s && typeof s === "object" ? s : {};
    return {
      approved: !!s.approved,
      approvedAt: s.approvedAt || 0,
      paused: !!s.paused,
      overrides: s.overrides && typeof s.overrides === "object" ? { ...s.overrides } : d.overrides,
      reviewed: s.reviewed && typeof s.reviewed === "object" ? { ...s.reviewed } : d.reviewed,
    };
  }

  /** Approve & start sync. Records every held domain the owner saw, so only LATER ones prompt. */
  function approveSettings(prev, heldDomainsSeen, now) {
    const s = withDefaults(prev);
    s.approved = true;
    s.approvedAt = now;
    s.paused = false;
    for (const d of heldDomainsSeen || []) s.reviewed[normDomain(d)] = now;
    return s;
  }

  /** "Keep held" on pending domains: mark them reviewed without allowing them. */
  function markReviewed(prev, domains, now) {
    const s = withDefaults(prev);
    for (const d of domains || []) s.reviewed[normDomain(d)] = now;
    return s;
  }

  /**
   * Per-domain toggle from the review page. `on` = should sync.
   * Stores only the DIFFERENCE from the effective default so overrides stay
   * small: ticking an allowed domain, or un-re-allowing a deny/hold one,
   * clears the stored override. A parent "off" (block) lowers the default for
   * its subdomains; a parent "on" (re-allow) does not, so a re-allow is exact.
   */
  function toggleOverride(prev, domain, on, classify, now) {
    const s = withDefaults(prev);
    const d = normDomain(domain);
    const def = safeDecision(classify, d).decision === "allow"; // syncs by default?
    const parent = parentOverride(s.overrides, d); // only an inherited "off" counts
    const effectiveDefault = parent === "off" ? false : def;
    if (on === effectiveDefault) delete s.overrides[d];
    else s.overrides[d] = on ? "on" : "off";
    s.reviewed[d] = now;
    return s;
  }

  // ── classification (policy.js is injected; fail closed) ───────────────────

  function safeDecision(classify, domain) {
    try {
      const r = classify(normDomain(domain));
      if (r && (r.decision === "allow" || r.decision === "deny" || r.decision === "hold")) return r;
    } catch (_) { /* fall through */ }
    return { decision: "deny", category: "unknown", reason: "classifier unavailable or invalid" };
  }

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /** Nearest strict-parent override that is "off" (a block inherits down; a re-allow does not). */
  function parentOverride(overrides, domain) {
    const parts = normDomain(domain).split(".");
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join(".");
      if (hasOwn(overrides, parent) && overrides[parent] === "off") return "off";
    }
    return null;
  }

  /** The override in effect for `domain`: an exact match (on/off) wins, else an inherited "off". */
  function effectiveOverride(overrides, domain) {
    const d = normDomain(domain);
    if (hasOwn(overrides, d)) return overrides[d];
    return parentOverride(overrides, d);
  }

  /**
   * The syncability of a bare domain. Returns {sync, userOverride, cls}.
   * userOverride is true only when the owner re-allowed a domain policy would
   * not sync (deny/hold) — the broker trusts those only when flagged.
   */
  function decide(domain, classify, settings) {
    const s = withDefaults(settings);
    const cls = safeDecision(classify, domain);
    const ov = effectiveOverride(s.overrides, domain);
    if (ov === "off") return { sync: false, userOverride: false, cls };
    if (ov === "on") return { sync: true, userOverride: cls.decision !== "allow", cls };
    return { sync: cls.decision === "allow", userOverride: false, cls };
  }

  /** Syncability of an actual cookie: a partitioned cookie also needs its top-level site syncable. */
  function cookieDecision(cookie, classify, settings) {
    const own = decide(cookie.domain, classify, settings);
    if (!own.sync) return own;
    const top = cookie.partitionKey && cookie.partitionKey.topLevelSite;
    if (top) {
      const host = siteHost(top);
      const td = decide(host, classify, settings);
      if (!td.sync) return { sync: false, userOverride: false, cls: td.cls };
      return { sync: true, userOverride: own.userOverride || td.userOverride, cls: own.cls };
    }
    return own;
  }

  function siteHost(site) {
    try { return new URL(site).hostname; } catch { return normDomain(String(site).replace(/^https?:\/\//, "")); }
  }

  /** Tag a cookie for the wire: add userOverride:true only when re-allowed. */
  function wireCookie(cookie, userOverride) {
    return userOverride ? { ...cookie, userOverride: true } : { ...cookie };
  }

  // ── batching ──────────────────────────────────────────────────────────────

  function encodedSize(obj) { return Buffer.byteLength(JSON.stringify(obj), "utf8"); }

  /** Split cookies into batches each at or under maxBytes (a lone oversized cookie goes alone). */
  function batchCookies(cookies, maxBytes) {
    const batches = [];
    let cur = [];
    let curBytes = 2; // []
    for (const c of cookies) {
      const sz = encodedSize(c) + 1;
      if (cur.length && curBytes + sz > maxBytes) { batches.push(cur); cur = []; curBytes = 2; }
      cur.push(c);
      curBytes += sz;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  // ── review model (what options.js renders) ────────────────────────────────

  function rootName(domain) { return normDomain(domain); }

  /**
   * Group every cookie domain into allow / hold / deny for the review page.
   * One row per domain, with its cookie count, current effective sync state,
   * stored override (if any), category/reason, and whether it is pending
   * (a held domain the owner has not yet seen).
   */
  function buildReviewModel(cookies, classify, settings) {
    const s = withDefaults(settings);
    const byDomain = new Map();
    for (const c of cookies) {
      const d = rootName(c.domain);
      if (!byDomain.has(d)) byDomain.set(d, 0);
      byDomain.set(d, byDomain.get(d) + 1);
    }
    const rows = [];
    for (const [domain, count] of byDomain) {
      const dec = decide(domain, classify, s);
      const cls = dec.cls;
      rows.push({
        domain,
        cookies: count,
        sync: dec.sync,
        userOverride: dec.userOverride,
        override: Object.prototype.hasOwnProperty.call(s.overrides, domain) ? s.overrides[domain] : null,
        group: cls.decision,
        category: cls.category || null,
        reason: cls.reason || null,
        pending: cls.decision === "hold" && !s.reviewed[domain] && !Object.prototype.hasOwnProperty.call(s.overrides, domain),
      });
    }
    // allow first, then hold, then deny; alphabetical, but keep a domain family together
    const cmp = (a, b) => familyKey(a.domain).localeCompare(familyKey(b.domain));
    const groups = {
      allow: rows.filter((r) => r.group === "allow").sort(cmp),
      hold: rows.filter((r) => r.group === "hold").sort(cmp),
      deny: rows.filter((r) => r.group === "deny").sort(cmp),
    };
    const ordered = [...groups.allow, ...groups.hold, ...groups.deny];
    const syncRows = rows.filter((r) => r.sync);
    const totals = {
      domains: rows.length,
      cookies: cookies.length,
      syncDomains: syncRows.length,
      syncCookies: syncRows.reduce((n, r) => n + r.cookies, 0),
      held: groups.hold.length,
      blocked: groups.deny.length,
    };
    return { rows: ordered, groups, totals };
  }

  /** Sort key that keeps a registrable domain next to its subdomains (reverse labels). */
  function familyKey(domain) {
    const parts = normDomain(domain).split(".");
    const root = parts.slice(-2).join(".");
    const sub = parts.slice(0, -2).reverse().join(".");
    return root + (sub ? " " + sub : "");
  }

  // ── status (the review page reads this; never holds cookie values) ─────────

  function defaultStatus() {
    return {
      host: "off", broker: "unknown", error: null,
      sent: 0, applied: 0, rejected: 0, inflight: 0,
      rejections: [], pending: [],
      lastSyncAt: null, lastFullAt: null, updatedAt: 0,
    };
  }

  // ── the bridge ─────────────────────────────────────────────────────────────

  /**
   * deps: { cookies, connectNative, classify, storage, action, timers:{setTimeout,clearTimeout}, now, log }
   * Returns { ready, stop, fullSync }.
   */
  function createBridge(deps) {
    const { cookies, connectNative, classify, storage, action, now } = deps;
    const setTimeout = deps.timers.setTimeout;
    const clearTimeout = deps.timers.clearTimeout;
    const log = deps.log || (() => {});

    let settings = defaultSettings();
    let status = defaultStatus();
    let stopped = false;

    let port = null;
    let seq = 0;
    let fullRun = 0; // id of the current full sync; a new resync supersedes an older in-flight one
    let fullInFlight = false;
    const pendingAcks = new Map(); // seq → { last:boolean }
    let reconnectDelay = RECONNECT_BASE_MS;
    let reconnectTimer = null;
    let connectedAt = 0; // when the current port was opened (0 when none)

    let deltaBuf = [];
    let deltaTimer = null;

    let booting = true; // true until storage has loaded; buffer wake events meanwhile
    const bootQueue = [];

    // status is persisted so the review page and a restarted worker can read it.
    let saveTimer = null;
    function persistStatus() {
      status.updatedAt = now();
      if (saveTimer) return;
      saveTimer = setTimeout(() => {
        saveTimer = null;
        const snapshot = JSON.parse(JSON.stringify(status));
        Promise.resolve(storage.set({ [STATUS_KEY]: snapshot })).catch(() => {});
      }, 0);
    }
    function setStatus(patch) { Object.assign(status, patch); persistStatus(); }

    function setBadge() {
      const n = status.pending.length;
      let text = n ? String(n) : "";
      let title = "Cookie bridge";
      if (!settings.approved) { text = "!"; title = "Cookie bridge — review and approve to start"; }
      else if (n) title = `Cookie bridge — ${n} domain${n === 1 ? "" : "s"} waiting for review`;
      try {
        action.setBadgeText({ text });
        if (action.setBadgeBackgroundColor) action.setBadgeBackgroundColor({ color: BADGE_COLOR });
        if (action.setTitle) action.setTitle({ title });
      } catch (_) { /* action may be unavailable in some contexts */ }
    }

    // ── connection ──
    function connect() {
      if (stopped || !settings.approved || settings.paused) return;
      if (!canClassify()) { setStatus({ host: "off", error: "policy.js did not load a classify function" }); return; }
      if (port) return;
      clearReconnect();
      setStatus({ host: "connecting" }); // keep the last error until a connection succeeds
      let p;
      try { p = connectNative(HOST_NAME); }
      catch (e) { onDisconnect(errText(e) || "could not start native host"); return; }
      port = p;
      connectedAt = now();
      p.onMessage.addListener(onHostMessage);
      p.onDisconnect.addListener((arg) => onDisconnect(errText(arg)));
      safePost({ t: "hello", v: 1 });
      // The host asks us to resync on connect; we don't push cookies unprompted.
    }

    function disconnect(reason) {
      if (port) {
        const p = port;
        port = null;
        try { p.disconnect(); } catch (_) { /* already gone */ }
      }
      connectedAt = 0;
      fullInFlight = false;
      pendingAcks.clear();
      deltaBuf = [];
      if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
    }

    function onDisconnect(reason) {
      const wasConnectedLongEnough = connectedAt && now() - connectedAt >= 30_000;
      disconnect(reason);
      if (stopped || !settings.approved || settings.paused) {
        setStatus({ host: settings.paused ? "paused" : "off", broker: "unknown", error: reason || status.error });
        return;
      }
      if (wasConnectedLongEnough) reconnectDelay = RECONNECT_BASE_MS;
      setStatus({ host: "retrying", broker: "unknown", error: reason || "native host disconnected" });
      scheduleReconnect();
    }

    function scheduleReconnect() {
      clearReconnect();
      const delay = reconnectDelay;
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    }
    function clearReconnect() { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } }

    function safePost(msg) {
      if (!port) return false;
      try { port.postMessage(msg); return true; }
      catch (e) { onDisconnect(errText(e) || "post failed"); return false; }
    }

    // ── host → ext ──
    function onHostMessage(msg) {
      if (!msg || typeof msg !== "object") return;
      switch (msg.t) {
        case "status":
          setStatus({ host: "connected", broker: msg.broker === "up" ? "up" : "down", error: null });
          break;
        case "resync":
          if (status.host !== "connected") setStatus({ host: "connected", error: null });
          runFullSync("host-resync");
          break;
        case "ack":
          onAck(msg);
          break;
        default:
          break;
      }
    }

    function onAck(msg) {
      if (typeof msg.seq !== "number" || !pendingAcks.has(msg.seq)) return;
      const info = pendingAcks.get(msg.seq);
      pendingAcks.delete(msg.seq);
      const applied = Number.isFinite(msg.applied) ? msg.applied : 0;
      const rejected = Array.isArray(msg.rejected) ? msg.rejected : [];
      const patch = {
        applied: status.applied + applied,
        rejected: status.rejected + rejected.length,
        inflight: pendingAcks.size,
        lastSyncAt: now(),
      };
      if (rejected.length) patch.rejections = rejected.map((r) => ({ domain: normDomain(r.domain), reason: String(r.reason || "") })).slice(-50);
      if (info.last) patch.lastFullAt = patch.lastSyncAt;
      setStatus(patch);
    }

    // ── full sync ──
    async function runFullSync(why) {
      if (!port || !settings.approved || settings.paused) return;
      const run = ++fullRun;
      fullInFlight = true;
      let all;
      try { all = await cookies.getAll({ partitionKey: {} }); }
      catch (e) { fullInFlight = false; setStatus({ error: "cookies.getAll failed" }); log("bridge: full sync read failed"); return; }
      if (run !== fullRun || !port || stopped) { fullInFlight = false; return; } // superseded

      const wire = [];
      const held = [];
      for (const c of all) {
        const dec = cookieDecision(c, classify, settings);
        if (dec.sync) wire.push(wireCookie(c, dec.userOverride));
        else if (dec.cls.decision === "hold" && !settings.reviewed[rootName(c.domain)] &&
                 !Object.prototype.hasOwnProperty.call(settings.overrides, rootName(c.domain))) held.push(rootName(c.domain));
      }
      updatePending(held);

      const batches = batchCookies(wire, MAX_BATCH_BYTES);
      if (batches.length === 0) batches.push([]);
      let sent = 0;
      for (let i = 0; i < batches.length; i++) {
        if (run !== fullRun || !port) { fullInFlight = false; return; }
        const s = ++seq;
        const last = i === batches.length - 1;
        pendingAcks.set(s, { last });
        if (!safePost({ t: "full", seq: s, cookies: batches[i], last })) { fullInFlight = false; return; }
        sent += batches[i].length;
      }
      fullInFlight = false;
      setStatus({ sent: status.sent + sent, inflight: pendingAcks.size });
      log(`bridge: full sync (${why}) sent ${sent} cookies in ${batches.length} batch(es)`);
      flushDeltas(); // any deltas buffered during the read go out now, after the full
    }

    // ── live deltas ──
    function onCookieChanged(info) {
      // MV3 may wake the worker with this very event before storage has
      // loaded; buffer until start() has settled so it isn't lost.
      if (booting) { bootQueue.push(info); return; }
      if (stopped || !settings.approved || settings.paused || !port) return;
      const cookie = info && info.cookie;
      if (!cookie) return;
      const dec = cookieDecision(cookie, classify, settings);
      const domain = rootName(cookie.domain);
      if (!dec.sync) {
        // a held domain changing is a reason to surface it for review
        if (dec.cls.decision === "hold" && !settings.reviewed[domain] &&
            !Object.prototype.hasOwnProperty.call(settings.overrides, domain) && !status.pending.includes(domain)) {
          updatePending(status.pending.concat(domain));
        }
        return;
      }
      // Chrome's overwrite = a remove(cause:overwrite) then an explicit add; the
      // broker upserts, so the paired removal is noise — drop it.
      if (info.removed && info.cause === "overwrite") return;
      deltaBuf.push({ removed: !!info.removed, cause: info.cause, cookie: wireCookie(cookie, dec.userOverride) });
      scheduleDeltaFlush();
    }

    function scheduleDeltaFlush() {
      if (deltaTimer || fullInFlight) return;
      deltaTimer = setTimeout(() => { deltaTimer = null; flushDeltas(); }, DELTA_DEBOUNCE_MS);
    }

    function flushDeltas() {
      if (!port || fullInFlight || deltaBuf.length === 0) return;
      const changes = deltaBuf;
      deltaBuf = [];
      const batches = batchChanges(changes, MAX_BATCH_BYTES);
      for (const b of batches) {
        if (!port) return;
        const s = ++seq;
        pendingAcks.set(s, { last: false });
        if (!safePost({ t: "delta", seq: s, changes: b })) return;
      }
      setStatus({ inflight: pendingAcks.size });
    }

    function batchChanges(changes, maxBytes) {
      const batches = [];
      let cur = [];
      let bytes = 2;
      for (const ch of changes) {
        const sz = encodedSize(ch) + 1;
        if (cur.length && bytes + sz > maxBytes) { batches.push(cur); cur = []; bytes = 2; }
        cur.push(ch);
        bytes += sz;
      }
      if (cur.length) batches.push(cur);
      return batches;
    }

    // Owner un-ticked (or un-re-allowed) a domain that was syncing: tell the
    // broker to drop those cookies. Called when settings change.
    async function reconcileRemovals(prevSettings) {
      if (!port || !settings.approved || settings.paused) return;
      let all;
      try { all = await cookies.getAll({ partitionKey: {} }); } catch { return; }
      const removals = [];
      for (const c of all) {
        const before = cookieDecision(c, classify, prevSettings);
        const after = cookieDecision(c, classify, settings);
        if (before.sync && !after.sync) {
          // flag with the OLD userOverride so the broker still accepts the delete for a deny domain
          removals.push({ removed: true, cause: "explicit", cookie: wireCookie(c, before.userOverride) });
        } else if (!before.sync && after.sync) {
          deltaBuf.push({ removed: false, cause: "explicit", cookie: wireCookie(c, after.userOverride) });
        }
      }
      if (removals.length) { deltaBuf.unshift(...removals); }
      if (deltaBuf.length) flushDeltas();
    }

    function updatePending(list) {
      const next = [...new Set(list.map(normDomain))].filter((d) => {
        const dec = decide(d, classify, settings);
        return dec.cls.decision === "hold" && !dec.sync && !settings.reviewed[d] &&
               !Object.prototype.hasOwnProperty.call(settings.overrides, d);
      }).sort();
      if (JSON.stringify(next) !== JSON.stringify(status.pending)) { setStatus({ pending: next }); setBadge(); }
    }

    function canClassify() {
      try { const r = classify && classify("example.com"); return !!(r && r.decision); }
      catch { return true; } // throwing is fine — safeDecision fails closed per-domain
    }

    // ── settings changes (from the review page, via storage.onChanged) ──
    async function onSettingsChanged(next) {
      const prev = settings;
      settings = withDefaults(next);
      if (!settings.approved) { disconnect("approval revoked"); setStatus({ host: "off", broker: "unknown" }); setBadge(); return; }
      if (settings.paused) { disconnect("paused by owner"); setStatus({ host: "paused", broker: "unknown" }); setBadge(); return; }
      setBadge();
      if (!port) { connect(); return; }
      // still connected: push the effect of the owner's edits
      await reconcileRemovals(prev);
      // a domain newly marked reviewed/allowed may clear pending
      updatePending(status.pending);
    }

    // ── startup: re-read everything from storage, then act ──
    async function start() {
      const got = await storage.get([SETTINGS_KEY, STATUS_KEY]);
      settings = withDefaults(got[SETTINGS_KEY]);
      // keep durable counters/pending/rejections across a worker restart; re-learn live host/broker state
      const prev = got[STATUS_KEY];
      status = { ...defaultStatus(), ...(prev && typeof prev === "object" ? prev : {}) };
      status.host = "off"; status.broker = "unknown"; status.inflight = 0;
      setBadge();
      if (settings.approved && !settings.paused) connect();
      else setStatus({ host: settings.paused ? "paused" : "off" });
      // storage has loaded: replay the events that woke us, then go live.
      booting = false;
      const queued = bootQueue.splice(0);
      for (const info of queued) onCookieChanged(info);
    }

    // Register listeners synchronously (before start() awaits) so a waking
    // event is never dropped while storage is still loading.
    cookies.onChanged.addListener(onCookieChanged);
    storage.onChanged.addListener((changes, area) => {
      if (area && area !== "local") return;
      if (changes && changes[SETTINGS_KEY]) onSettingsChanged(changes[SETTINGS_KEY].newValue);
    });

    function stop() {
      stopped = true;
      disconnect("stopped");
      clearReconnect();
      if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    }

    const ready = start();

    return {
      ready,
      stop,
      onSettingsChanged,
      fullSync: (why) => runFullSync(why || "manual"),
    };
  }

  function errText(arg) {
    if (!arg) return "";
    if (typeof arg === "string") return arg;
    if (arg.message) return String(arg.message);
    if (arg.error && arg.error.message) return String(arg.error.message);
    return "";
  }

  return {
    createBridge,
    HOST_NAME,
    MAX_BATCH_BYTES,
    RECONNECT_BASE_MS,
    RECONNECT_MAX_MS,
    DELTA_DEBOUNCE_MS,
    normDomain,
    decide,
    cookieDecision,
    batchCookies,
    buildReviewModel,
    approveSettings,
    markReviewed,
    toggleOverride,
    defaultSettings,
    withDefaults,
    defaultStatus,
  };
});
