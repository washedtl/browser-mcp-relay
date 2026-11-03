// options.js — cookie-bridge first-run REVIEW page (W2F-ext).
//
// Nothing syncs until the owner clicks "Approve & start sync" here. The page
// lists every cookie domain grouped Will sync / Held / Blocked, with a
// per-domain toggle, a pause switch, and broker/sync status. All of the
// decision logic lives in bridge-core.js (fully unit-tested); this file is
// thin glue over chrome.cookies and chrome.storage. It reads domains and
// counts only — never a cookie value, and never logs.

import * as policyModule from "./policy.js";
import "./bridge-core.js";

const Core = globalThis.CookieBridgeCore;
const {
  buildReviewModel, approveSettings, markReviewed, toggleOverride,
  withDefaults, defaultSettings, defaultStatus, normDomain,
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

let state = { settings: defaultSettings(), status: defaultStatus(), cookies: [] };

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
  // the storage listener re-renders; render now too for snappiness
  render();
}

// ── render ──────────────────────────────────────────────────────────────────

function fmtTime(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
}

function brokerDot(status, settings) {
  if (settings.paused) return { cls: "paused", label: "paused" };
  if (status.broker === "up") return { cls: "up", label: "broker up" };
  if (status.broker === "down") return { cls: "down", label: "broker down" };
  return { cls: "", label: status.approved ? "connecting" : "not started" };
}

function render() {
  const { settings, status, cookies } = state;
  const model = buildReviewModel(cookies, classify, settings);

  renderStatus(model, status, settings);
  renderActions(settings, model);

  const groupsEl = document.getElementById("groups");
  groupsEl.replaceChildren(
    groupSection("Will sync", "allow", model.groups.allow, settings,
      "These logins will be copied into the broker browser and kept in sync. Untick any you want to keep out."),
    groupSection("Held for review", "hold", model.groups.hold, settings,
      "Flagged by a keyword guard. None sync unless you tick them."),
    groupSection("Blocked", "deny", model.groups.deny, settings,
      "Banking, email, and other sensitive categories. Blocked by default; tick one only if you are sure."),
  );
}

function renderStatus(model, status, settings) {
  const bd = brokerDot(status, settings);
  const strip = document.getElementById("status");
  const stat = (label, value) => el("div", { class: "stat" }, [
    el("span", { class: "label-caps", text: label }),
    el("b", {}, [value]),
  ]);
  const brokerVal = el("span", {}, [el("span", { class: "dot " + bd.cls }), document.createTextNode(bd.label)]);
  const children = [
    stat("Broker", brokerVal),
    stat("Will sync", `${model.totals.syncDomains} domains · ${model.totals.syncCookies} cookies`),
    stat("Held", String(model.totals.held)),
    stat("Blocked", String(model.totals.blocked)),
  ];
  if (settings.approved) {
    children.push(stat("Last sync", fmtTime(status.lastSyncAt)));
    children.push(stat("Applied", `${status.applied}`));
    if (status.rejected) children.push(stat("Rejected", `${status.rejected}`));
  }
  strip.replaceChildren(...children);

  const rej = document.getElementById("rejections");
  if (settings.approved && status.rejections && status.rejections.length) {
    rej.replaceChildren(
      el("div", { text: "The broker rejected some domains:" }),
      el("ul", {}, status.rejections.slice(-6).map((r) =>
        el("li", { text: `${r.domain} — ${r.reason}` }))),
    );
  } else rej.replaceChildren();
}

function renderActions(settings, model) {
  const bar = document.getElementById("actions");
  const approveBtn = el("button", {
    class: "primary",
    text: settings.approved ? "Sync approved" : "Approve & start sync",
    disabled: settings.approved,
    "aria-label": settings.approved ? "Sync already approved" : "Approve and start syncing cookies",
  });
  approveBtn.addEventListener("click", async () => {
    const heldSeen = model.groups.hold.map((r) => r.domain);
    await writeSettings(approveSettings(state.settings, heldSeen, Date.now()));
  });

  const pauseWrap = el("label", { class: "switch", "aria-label": "Pause sync" });
  const pauseInput = el("input", { type: "checkbox" });
  pauseInput.checked = !!settings.paused;
  pauseInput.disabled = !settings.approved;
  pauseInput.addEventListener("change", async () => {
    await writeSettings({ ...state.settings, paused: pauseInput.checked });
  });
  pauseWrap.append(pauseInput, el("span", { class: "track" }), el("span", { class: "label-caps", text: "Pause sync" }));

  const nodes = [approveBtn, el("span", { class: "spacer" })];
  if (settings.approved) nodes.push(pauseWrap);
  bar.replaceChildren(...nodes);
}

function groupSection(title, kind, rows, settings, note) {
  const pendingCount = rows.filter((r) => r.pending).length;
  const head = el("div", { class: "group-head" }, [
    el("span", { class: "label-caps", text: title }),
    el("span", { class: "count", text: `${rows.length} domain${rows.length === 1 ? "" : "s"}` }),
  ]);
  const section = el("section", { class: "group" }, [head, el("p", { class: "group-note", text: note })]);

  if (pendingCount) {
    const keep = el("button", { text: `Keep all ${pendingCount} held` });
    keep.addEventListener("click", async () => {
      const domains = rows.filter((r) => r.pending).map((r) => r.domain);
      await writeSettings(markReviewed(state.settings, domains, Date.now()));
    });
    section.querySelector(".group-head").append(keep);
  }

  if (!rows.length) {
    section.append(el("div", { class: "list" }, [el("div", { class: "empty", text: "Nothing here." })]));
    return section;
  }
  const list = el("div", { class: "list", role: "group", "aria-label": title });
  for (const row of rows) list.append(renderRow(row));
  section.append(list);
  return section;
}

function renderRow(row) {
  const rowEl = el("div", { class: "row" + (row.pending ? " pending" : "") });

  const meta = [];
  meta.push(el("span", {}, [`${row.cookies} cookie${row.cookies === 1 ? "" : "s"}`]));
  if (row.category) meta.push(el("span", { class: "cat", text: " · " + row.category }));
  if (row.userOverride) meta.push(el("span", {}, [" · re-allowed by you"]));
  else if (row.override === "off") meta.push(el("span", {}, [" · kept out by you"]));

  const info = el("div", { class: "domain" }, [
    el("span", { class: "name", title: row.domain, text: row.domain }),
    el("span", { class: "meta" }, meta),
  ]);

  const id = "tg-" + row.domain.replace(/[^a-z0-9]/gi, "-");
  const input = el("input", { type: "checkbox", id, "aria-label": `Sync cookies for ${row.domain}` });
  input.checked = !!row.sync;
  input.addEventListener("change", async () => {
    await writeSettings(toggleOverride(state.settings, row.domain, input.checked, classify, Date.now()));
  });
  const toggle = el("label", { class: "toggle", for: id }, [input, el("span", { class: "track" })]);

  rowEl.append(info);
  if (row.pending) rowEl.append(el("span", { class: "badge-pending", text: "review" }));
  rowEl.append(toggle);
  return rowEl;
}

// ── wire up ──────────────────────────────────────────────────────────────────

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.status) state.status = { ...defaultStatus(), ...(changes.status.newValue || {}) };
  if (changes.settings) state.settings = withDefaults(changes.settings.newValue);
  render();
});

// re-read cookies periodically so new logins show up without a manual reload
async function refresh() { await loadAll(); render(); }

(async () => {
  await loadAll();
  render();
  setInterval(refresh, 5000);
})();
