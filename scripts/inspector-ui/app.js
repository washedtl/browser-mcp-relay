// app.js — Inspector frontend (W7 Pool Overview).
//
// Vanilla JS, no build toolchain. Uses createElement + textContent only —
// never innerHTML with dynamic data (XSS prevention even on a localhost UI).
// Auto-refreshes /api/status every 5s; Pause button toggles the interval.

(function () {
  "use strict";

  const REFRESH_MS = 5000;
  let refreshTimer = null;
  let paused = false;

  // ─── small DOM/format helpers ─────────────────────────────────────────

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") node.className = v;
        else if (k === "data") {
          for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
        } else if (k === "title") node.title = v;
        else node.setAttribute(k, v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null) continue;
        if (typeof c === "string" || typeof c === "number") node.appendChild(document.createTextNode(String(c)));
        else node.appendChild(c);
      }
    }
    return node;
  }

  function svgIcon(viewBox, paths, opts) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", viewBox || "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", (opts && opts.strokeWidth) || "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    if (opts && opts.width) svg.setAttribute("width", opts.width);
    if (opts && opts.height) svg.setAttribute("height", opts.height);
    if (opts && opts.class) svg.setAttribute("class", opts.class);
    svg.setAttribute("aria-hidden", "true");
    for (const p of paths) {
      const path = document.createElementNS(NS, p.tag || "path");
      for (const [k, v] of Object.entries(p.attrs || {})) path.setAttribute(k, v);
      svg.appendChild(path);
    }
    return svg;
  }

  function formatDuration(seconds) {
    if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
    const s = Math.floor(seconds);
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m " + (s % 60) + "s";
    const h = Math.floor(m / 60);
    return h + "h " + (m % 60) + "m";
  }

  function formatCookieAge(days) {
    if (days == null || !Number.isFinite(days)) return "—";
    if (days < 1 / 24) return Math.round(days * 24 * 60) + "m";
    if (days < 1) return Math.round(days * 24) + "h";
    return days.toFixed(1) + "d";
  }

  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ─── data fetch ───────────────────────────────────────────────────────

  async function fetchStatus() {
    const r = await fetch("/api/status", { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error("status " + r.status);
    return r.json();
  }

  // ─── render ───────────────────────────────────────────────────────────

  function renderHeader(status) {
    const setStat = (key, val) => {
      const node = document.querySelector('[data-stat="' + key + '"]');
      if (node) node.textContent = val;
    };
    const slots = status.slots || [];
    const active = slots.filter((s) => s.state === "claimed").length;
    setStat("tools", String(status.tools.total));
    setStat("pool", active + " / " + slots.length + " active");
    setStat("mode", status.config.mode);
    const vault = status.vault || {};
    setStat("vault", vault.enabled ? vault.totalEntries + " entries" : "off");
    setStat("uptime", formatDuration(status.server.uptimeSeconds));

    // Health pill: "Healthy" if no orphan slots, "Attention" otherwise.
    const orphans = slots.filter((s) => s.state === "orphan").length;
    const pill = document.getElementById("health-pill");
    const label = document.getElementById("health-label");
    pill.classList.remove("warn", "err");
    if (orphans > 0) {
      pill.classList.add("warn");
      label.textContent = orphans + " need" + (orphans === 1 ? "s" : "") + " attention";
    } else {
      label.textContent = "Healthy";
    }
  }

  function renderSidebar(status) {
    const slots = status.slots || [];
    const active = slots.filter((s) => s.state === "claimed");
    const idle = slots.filter((s) => s.state === "idle");
    const attention = slots.filter((s) => s.state === "orphan");

    document.getElementById("nav-active-count").textContent = active.length;
    document.getElementById("nav-idle-count").textContent = idle.length;
    document.getElementById("nav-attention-count").textContent = attention.length;
    const specialtyCount = Object.keys(status.specialty || {}).length;
    document.getElementById("nav-specialty-count").textContent = specialtyCount;

    const renderList = (target, list, statusClass) => {
      const node = document.getElementById(target);
      clearChildren(node);
      for (const slot of list) {
        node.appendChild(
          el("div", { class: "nav-item" }, [
            el("span", { class: "nav-status " + statusClass }),
            el("span", { class: "name mono" }, "Slot " + slot.index),
            statusClass === "warn" ? el("span", { class: "nav-meta" }, "orphan") : null,
          ]),
        );
      }
    };
    renderList("nav-active-list", active, "ok");
    renderList("nav-idle-list", idle, "idle");
    renderList("nav-attention-list", attention, "warn");
  }

  function renderSlotCard(slot) {
    const card = el("div", { class: "slot-card " + (slot.state === "claimed" ? "active" : slot.state === "orphan" ? "orphan" : "idle") });

    const head = el("div", { class: "slot-head" }, [
      el("span", { class: "slot-name" }, "Slot " + slot.index),
    ]);
    if (slot.state === "claimed") {
      head.appendChild(
        el("span", { class: "slot-status active" }, [
          svgIcon("0 0 24 24", [{ attrs: { points: "20 6 9 17 4 12" }, tag: "polyline" }], { width: "10", height: "10", strokeWidth: "2.2" }),
        ]),
      );
    } else if (slot.state === "orphan") {
      head.appendChild(
        el("span", { class: "slot-status warn" }, [
          svgIcon("0 0 24 24", [
            { attrs: { d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" } },
            { tag: "line", attrs: { x1: "12", y1: "9", x2: "12", y2: "13" } },
            { tag: "line", attrs: { x1: "12", y1: "17", x2: "12.01", y2: "17" } },
          ], { width: "11", height: "11", strokeWidth: "2" }),
        ]),
      );
    } else {
      head.appendChild(
        el("span", { class: "slot-status" }, [
          svgIcon("0 0 24 24", [{ tag: "circle", attrs: { cx: "12", cy: "12", r: "9" } }], { width: "10", height: "10" }),
        ]),
      );
    }
    card.appendChild(head);

    if (slot.state === "idle") {
      card.appendChild(
        el("div", { class: "idle-body" }, [
          el("span", null, "Idle"),
          el("span", { class: "small" }, "Available"),
        ]),
      );
      card.appendChild(
        el("div", { class: "slot-footer" }, [
          el("span", { class: "mono" }, slot.dir),
        ]),
      );
      return card;
    }

    if (slot.state === "orphan") {
      card.appendChild(el("div", { class: "slot-client", style: "color: var(--error);" }, "Orphan · stale lock"));
      card.appendChild(
        el("span", { class: "slot-role" + (slot.role && slot.role !== "default" ? " " + slot.role : "") }, slot.role || "default"),
      );
      const meta = el("div", { class: "slot-meta-row" }, [
        slot.pid != null
          ? el("span", null, [el("span", { class: "k" }, "Stale PID"), el("span", { class: "v" }, String(slot.pid))])
          : null,
      ]);
      card.appendChild(meta);

      const orphanMsg = slot.pid != null
        ? "PID " + slot.pid + " not alive · lock held " + formatDuration(slot.lockHeldMs ? slot.lockHeldMs / 1000 : null)
        : "Stale lock · " + formatDuration(slot.lockHeldMs ? slot.lockHeldMs / 1000 : null);
      card.appendChild(
        el("div", { class: "orphan-body" }, [
          el("div", { class: "orphan-message" }, orphanMsg),
        ]),
      );
      card.appendChild(
        el("div", { class: "slot-footer" }, [
          el("span", { class: "mono" }, slot.dir),
          el("span", null, "cookie " + formatCookieAge(slot.cookieAgeDays)),
        ]),
      );
      return card;
    }

    // Claimed
    card.appendChild(el("div", { class: "slot-client" }, "Brave PID " + (slot.pid ?? "—")));
    card.appendChild(
      el("span", { class: "slot-role" + (slot.role && slot.role !== "default" ? " " + slot.role : "") }, slot.role || "default"),
    );
    card.appendChild(
      el("div", { class: "slot-meta-row" }, [
        slot.pid != null
          ? el("span", null, [el("span", { class: "k" }, "PID"), el("span", { class: "v" }, String(slot.pid))])
          : null,
        slot.lockHeldMs != null
          ? el("span", null, [el("span", { class: "k" }, "Up"), el("span", { class: "v" }, formatDuration(slot.lockHeldMs / 1000))])
          : null,
      ]),
    );
    card.appendChild(
      el("div", { class: "slot-footer" }, [
        el("span", { class: "mono" }, slot.dir),
        el("span", null, "cookie " + formatCookieAge(slot.cookieAgeDays)),
      ]),
    );

    return card;
  }

  function renderSlotGrid(status) {
    const grid = document.getElementById("slot-grid");
    clearChildren(grid);
    const slots = status.slots || [];
    if (slots.length === 0) {
      grid.appendChild(el("div", { class: "empty-msg" }, "No pool slots configured."));
    } else {
      for (const slot of slots) grid.appendChild(renderSlotCard(slot));
    }

    const meta = document.getElementById("pool-meta");
    clearChildren(meta);
    const active = slots.filter((s) => s.state === "claimed").length;
    const idle = slots.filter((s) => s.state === "idle").length;
    const attention = slots.filter((s) => s.state === "orphan").length;
    meta.appendChild(el("span", { class: "ok" }, active + " active"));
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(el("span", { class: "idle" }, idle + " idle"));
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(el("span", { class: "err" }, attention + " attention"));
  }

  function renderSpecialtyCard(name, info) {
    const status = info.status || "unknown";
    const head = el("div", { class: "specialty-head" }, [
      el("span", { class: "specialty-name" }, name),
      el("span", { class: "specialty-pill " + status }, status),
    ]);
    const body = [head];
    if (info.description) body.push(el("div", { class: "specialty-desc" }, info.description));
    let metaText = "";
    if (info.cookieAgeDays != null) {
      metaText = "cookie " + formatCookieAge(info.cookieAgeDays) + " · threshold " + info.thresholdDays + "d";
    } else if (info.note) {
      metaText = info.note;
    } else {
      metaText = "Standalone · not introspectable";
    }
    body.push(el("div", { class: "specialty-meta" }, metaText));
    return el("div", { class: "specialty-card" }, body);
  }

  function renderSpecialty(status) {
    const grid = document.getElementById("specialty-grid");
    clearChildren(grid);
    const meta = document.getElementById("specialty-meta");
    clearChildren(meta);

    const entries = Object.entries(status.specialty || {});
    if (entries.length === 0) {
      grid.appendChild(el("div", { class: "empty-msg" }, "No specialty MCPs."));
      return;
    }
    let ready = 0, stale = 0;
    for (const [name, info] of entries) {
      grid.appendChild(renderSpecialtyCard(name, info));
      if (info.status === "fresh" || info.status === "ready") ready++;
      else if (info.status === "stale") stale++;
    }
    meta.appendChild(el("span", { class: "ok" }, ready + " ready"));
    if (stale > 0) {
      meta.appendChild(document.createTextNode(" · "));
      meta.appendChild(el("span", { class: "err" }, stale + " stale source"));
    }
  }

  function renderVault(status) {
    const card = document.getElementById("vault-card");
    clearChildren(card);
    const meta = document.getElementById("vault-meta");
    clearChildren(meta);
    const v = status.vault || {};

    if (!v.enabled) {
      card.appendChild(el("div", { class: "empty-msg" }, "Vault disabled · set BROWSER_RELAY_VAULT_FILES to enable autofill"));
      return;
    }

    meta.appendChild(el("span", { class: "ok" }, v.totalEntries + " entries · " + v.uniqueHosts + " hosts"));

    const row = el("div", { class: "vault-row" }, [
      el("span", null, [el("span", { class: "k" }, "Entries"), document.createTextNode(String(v.totalEntries))]),
      el("span", null, [el("span", { class: "k" }, "Hosts"), document.createTextNode(String(v.uniqueHosts))]),
      el("span", null, [el("span", { class: "k" }, "Loaded"), document.createTextNode(String((v.filesLoaded || []).length))]),
      el("span", null, [el("span", { class: "k" }, "Skipped"), document.createTextNode(String((v.filesSkipped || []).length))]),
    ]);
    card.appendChild(row);

    if ((v.filesLoaded || []).length || (v.filesSkipped || []).length) {
      const files = el("div", { class: "vault-files" });
      for (const f of v.filesLoaded || []) {
        files.appendChild(el("div", { class: "file" }, f.path + " · " + f.entries + " entries"));
      }
      for (const f of v.filesSkipped || []) {
        files.appendChild(el("div", { class: "file skipped" }, f.path + " — skipped (" + f.reason + ")"));
      }
      card.appendChild(files);
    }
  }

  function render(status) {
    renderHeader(status);
    renderSidebar(status);
    renderSlotGrid(status);
    renderSpecialty(status);
    renderVault(status);
  }

  async function refresh() {
    try {
      const status = await fetchStatus();
      render(status);
    } catch (e) {
      const pill = document.getElementById("health-pill");
      const label = document.getElementById("health-label");
      pill.classList.remove("warn");
      pill.classList.add("err");
      label.textContent = "Disconnected";
      // eslint-disable-next-line no-console
      console.error("[inspector] /api/status fetch failed:", e);
    }
  }

  function startTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!paused) refresh(); }, REFRESH_MS);
  }

  function bindControls() {
    document.getElementById("btn-refresh").addEventListener("click", refresh);
    const pauseBtn = document.getElementById("btn-pause");
    pauseBtn.addEventListener("click", () => {
      paused = !paused;
      pauseBtn.classList.toggle("paused", paused);
      pauseBtn.title = paused ? "Resume auto-refresh" : "Pause auto-refresh";
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindControls();
    refresh();
    startTimer();
  });
})();
