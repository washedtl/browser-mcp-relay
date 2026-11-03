// options.js — cookie-bridge first-run REVIEW page (W2F-ext).
//
// Nothing syncs until the owner clicks "Approve & start sync" here. The page
// lists every cookie domain grouped Will sync / Held / Blocked, with a
// per-domain toggle, a pause switch, and host/broker/sync status. The
// decision logic lives in bridge-core.js; this file is thin glue over
// chrome.cookies and chrome.storage. It reads domains and counts only —
// never a cookie value — and never logs.

import * as policyModule from "./policy.js";
import "./bridge-core.js";

const Core = globalThis.CookieBridgeCore;
const {
  buildReviewModel, approveSettings, markReviewed, toggleOverride,
  withDefaults, defaultSettings, defaultStatus,
} = Core;

function resolveClassify() {
  // policy.js sets globalThis.CookieBridgePolicy (plain IIFE, no ES exports).
  const p = globalThis.CookieBridgePolicy || globalThis.cookieBridgePolicy;
  const c = [
    p && p.classify,
    globalThis.classify,
    policyModule && policyModule.classify,
    policyModule && policyModule.default && policyModule.default.classify,
  ];
  for (const fn of c) if (typeof fn === "function") return fn;
  return () => ({ decision: "deny", category: "unknown", reason: "policy.js did not load" });
}
const classify = resolveClassify();

// ── pure view helpers (exported for tests) ──────────────────────────────────

const HOST_LABEL = {
  off: "Native host not started",
  paused: "Sync paused",
  connecting: "Connecting to the native host",
  connected: "Native host connected",
  retrying: "Native host unavailable, retrying",
};

/** The fix for a native-host / policy error, with `commands` in backticks. */
export function hostHint(error) {
  if (!error) return "";
  const e = String(error);
  if (/not found/i.test(e)) return "Native host not installed: run `npm run bridge:install`, then reload this extension.";
  if (/forbidden/i.test(e)) return "The native host doesn't allow this extension: re-run `npm run bridge:install` (it registers this extension's ID).";
  if (/policy/i.test(e)) return "policy.js failed to load, so nothing will sync. Reload the extension; if it persists, check `extensions/cookie-bridge/policy.js`.";
  return e;
}

/** Broker dot + labels. Approval comes from settings, never from status. */
export function statusView(settings, status) {
  const s = settings || {};
  const st = status || {};
  if (!s.approved) return { dot: "", broker: "not started", host: "Waiting for your approval", hint: "" };
  if (s.paused) return { dot: "paused", broker: "paused", host: HOST_LABEL.paused, hint: "" };
  const host = HOST_LABEL[st.host] || HOST_LABEL.off;
  if (st.host === "connected") {
    if (st.broker === "up") return { dot: "up", broker: "broker up", host, hint: "" };
    if (st.broker === "down") {
      return { dot: "down", broker: "broker down", host,
        hint: "The broker isn't running. It starts with an agent's browser session; the host resyncs then." };
    }
    return { dot: "", broker: "broker unknown", host, hint: "" };
  }
  return { dot: st.host === "retrying" ? "down" : "", broker: "broker unknown", host, hint: hostHint(st.error) };
}

function fmtTime(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
}

// ── DOM helpers ─────────────────────────────────────────────────────────────

const el = (tag, props = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("aria") || k === "role" || k === "for" || k === "id" || k === "type") n.setAttribute(k, v);
    else n[k] = v;
  }
  for (const c of [].concat(children)) if (c != null) n.append(c);
  return n;
};

/** Text with `backticked` spans rendered as <code>. */
function withCode(text) {
  return String(text).split("`").map((part, i) => (i % 2 ? el("code", { text: part }) : part));
}

/** Rewrite a region only when its text actually changes (no needless re-announcements). */
function setRegion(node, key, build) {
  if (!node || node.dataKey === key) return;
  node.dataKey = key;
  node.replaceChildren(...build());
}

// ── state ───────────────────────────────────────────────────────────────────

let state = { settings: defaultSettings(), status: defaultStatus(), cookies: [] };
let lastKey = "";

async function loadAll() {
  const [cookies, stored] = await Promise.all([
    chrome.cookies.getAll({ partitionKey: {} }).catch(() => []),
    chrome.storage.local.get(["settings", "status"]).catch(() => ({})),
  ]);
  state = {
    cookies,
    settings: withDefaults(stored.settings),
    status: { ...defaultStatus(), ...(stored.status && typeof stored.status === "object" ? stored.status : {}) },
  };
}

async function writeSettings(next) {
  state.settings = withDefaults(next);
  await chrome.storage.local.set({ settings: state.settings });
  render();
}

// ── render ──────────────────────────────────────────────────────────────────

function render() {
  const { settings, status, cookies } = state;
  const model = buildReviewModel(cookies, classify, settings);
  const view = statusView(settings, status);

  // Live region: host state + the fix for its error. Updated only on change.
  const line = view.hint ? `${view.host}. ${view.hint}` : view.host;
  setRegion(document.getElementById("host-line"), line, () => withCode(line));

  // Skip the rebuild when nothing visible changed (bookkeeping like
  // updatedAt/inflight doesn't count); just refresh the relative time.
  const key = JSON.stringify([model, view, settings.approved, settings.paused,
    status.lastSyncAt, status.sent, status.applied, status.rejected, status.rejections]);
  if (key === lastKey) { tickTimes(); return; }
  lastKey = key;

  const active = document.activeElement;
  const focusId = active && active.id;

  renderStatus(model, status, settings, view);
  renderRejections(settings, status);
  renderActions(settings, model);
  const groupsEl = document.getElementById("groups");
  groupsEl.replaceChildren(
    groupSection("Will sync", "allow", model.groups.allow,
      "These logins are copied into the broker browser and kept in sync. Untick any you want to keep out."),
    groupSection("Held for review", "hold", model.groups.hold,
      "Flagged by a keyword guard. None sync unless you tick them."),
    groupSection("Blocked", "deny", model.groups.deny,
      "Banking, email, and other sensitive categories. Blocked by default; tick one only if you are sure."),
  );

  if (focusId) {
    const again = document.getElementById(focusId);
    if (again && again !== document.activeElement) again.focus();
  }
}

function tickTimes() {
  const n = document.getElementById("last-sync");
  if (!n) return;
  const t = fmtTime(state.status.lastSyncAt);
  if (n.textContent !== t) n.textContent = t;
}

function renderStatus(model, status, settings, view) {
  const stat = (label, value, id) => el("div", { class: "stat" }, [
    el("span", { class: "label-caps", text: label }),
    el("b", id ? { id } : {}, [value]),
  ]);
  const brokerVal = el("span", { class: "broker" }, [el("span", { class: "dot " + view.dot }), view.broker]);
  const children = [
    stat("Broker", brokerVal),
    stat("Will sync", `${model.totals.syncDomains} domains · ${model.totals.syncCookies} cookies`),
    stat("Held", String(model.totals.held)),
    stat("Blocked", String(model.totals.blocked)),
  ];
  if (settings.approved) {
    children.push(stat("Last sync", fmtTime(status.lastSyncAt), "last-sync"));
    children.push(stat("Applied", String(status.applied || 0)));
    if (status.rejected) children.push(stat("Rejected", String(status.rejected)));
  }
  document.getElementById("status").replaceChildren(...children);
}

function renderRejections(settings, status) {
  const list = settings.approved && Array.isArray(status.rejections) ? status.rejections.slice(-6) : [];
  const key = JSON.stringify(list);
  setRegion(document.getElementById("rejections"), key, () => (list.length ? [
    el("div", { text: "The broker rejected some domains:" }),
    el("ul", {}, list.map((r) => el("li", { text: `${r.domain} — ${r.reason}` }))),
  ] : []));
}

function renderActions(settings, model) {
  const approveBtn = el("button", {
    id: "approve",
    class: "primary",
    text: settings.approved ? "Sync approved" : "Approve & start sync",
    disabled: settings.approved,
  });
  approveBtn.addEventListener("click", async () => {
    const heldSeen = model.groups.hold.map((r) => r.domain);
    await writeSettings(approveSettings(state.settings, heldSeen, Date.now()));
  });

  const nodes = [approveBtn, el("span", { class: "spacer" })];
  if (settings.approved) {
    const pauseInput = el("input", { type: "checkbox", id: "pause" });
    pauseInput.checked = !!settings.paused;
    pauseInput.addEventListener("change", async () => {
      await writeSettings({ ...state.settings, paused: pauseInput.checked });
    });
    nodes.push(el("label", { class: "switch", for: "pause" }, [
      pauseInput, el("span", { class: "track" }), el("span", { class: "label-caps", text: "Pause sync" }),
    ]));
  }
  document.getElementById("actions").replaceChildren(...nodes);
}

function groupSection(title, kind, rows, note) {
  const pending = rows.filter((r) => r.pending);
  const head = el("div", { class: "group-head" }, [
    el("h2", { class: "label-caps", text: title }),
    el("span", { class: "count", text: `${rows.length} domain${rows.length === 1 ? "" : "s"}` }),
  ]);
  if (pending.length) {
    const keep = el("button", { id: "keep-held-" + kind, class: "small", text: `Keep all ${pending.length} held` });
    keep.addEventListener("click", async () => {
      await writeSettings(markReviewed(state.settings, pending.map((r) => r.domain), Date.now()));
    });
    head.append(keep);
  }
  const section = el("section", { class: "group", "aria-label": title }, [head, el("p", { class: "group-note", text: note })]);
  if (!rows.length) {
    section.append(el("div", { class: "list" }, [el("div", { class: "empty", text: "Nothing here." })]));
    return section;
  }
  section.append(el("div", { class: "list" }, rows.map(renderRow)));
  return section;
}

function renderRow(row) {
  const meta = [`${row.cookies} cookie${row.cookies === 1 ? "" : "s"}`];
  // the category matters only where it's the reason a domain isn't syncing
  if (row.group !== "allow" && row.category) meta.push(el("span", { class: "cat", text: " · " + row.category }));
  if (row.userOverride) meta.push(" · re-allowed by you");
  else if (row.override === "off") meta.push(" · kept out by you");

  const id = "tg-" + row.domain;
  const input = el("input", { type: "checkbox", id, "aria-label": `Sync cookies for ${row.domain}` });
  input.checked = !!row.sync;
  input.addEventListener("change", async () => {
    await writeSettings(toggleOverride(state.settings, row.domain, input.checked, classify, Date.now()));
  });

  return el("div", { class: "row" + (row.pending ? " pending" : "") }, [
    el("div", { class: "domain" }, [
      el("span", { class: "name", title: row.domain, text: row.domain }),
      el("span", { class: "meta" }, meta),
    ]),
    row.pending ? el("span", { class: "badge-pending", text: "review" }) : null,
    el("label", { class: "toggle", for: id }, [input, el("span", { class: "track" })]),
  ]);
}

// ── wire up ─────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.status) state.status = { ...defaultStatus(), ...(changes.status.newValue || {}) };
  if (changes.settings) state.settings = withDefaults(changes.settings.newValue);
  render();
});

// Re-read periodically so new logins show up; render() skips unchanged data.
async function refresh() { await loadAll(); render(); }

export const ready = (async () => {
  await loadAll();
  render();
  setInterval(refresh, 5000);
})();
