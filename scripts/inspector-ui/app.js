// app.js — Inspector frontend (Pool Overview + Settings + Tools + Activity).
//
// Vanilla JS, no build toolchain. Uses createElement + textContent only —
// never innerHTML with dynamic data (XSS prevention even on a localhost UI).
// Auto-refreshes /api/status every 5s on the home page only; Pause toggles.
//
// Routing model: full-page nav (anchor links). On DOMContentLoaded we read
// location.pathname and dispatch to renderHome() / renderSettings() /
// renderTools() / renderActivity().

(function () {
  "use strict";

  const REFRESH_MS = 5000;
  let refreshTimer = null;
  let paused = false;
  // Holds the AbortController for the in-flight /api/status fetch on the
  // home page so a slow response can't pile up requests when the timer
  // fires faster than the network. Bumped on every refresh.
  let homeFetchAbort = null;

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

  async function fetchJson(p, opts) {
    const init = { headers: { Accept: "application/json" } };
    if (opts && opts.signal) init.signal = opts.signal;
    if (opts && opts.method) init.method = opts.method;
    if (opts && opts.body) init.body = opts.body;
    if (opts && opts.headers) Object.assign(init.headers, opts.headers);
    if (opts && opts.credentials) init.credentials = opts.credentials;
    const r = await fetch(p, init);
    if (!r.ok) {
      let body = null;
      try { body = await r.json(); } catch { /* ignore */ }
      const e = new Error(p + " → " + r.status);
      e.status = r.status;
      e.body = body;
      throw e;
    }
    return r.json();
  }

  // ─── HOME (Pool Overview) ─────────────────────────────────────────────

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

    const slotPathMatch = location.pathname.match(/^\/slot\/(\d+)$/);
    const activeSlot = slotPathMatch ? parseInt(slotPathMatch[1], 10) : null;
    const renderList = (target, list, statusClass) => {
      const node = document.getElementById(target);
      clearChildren(node);
      for (const slot of list) {
        const isActive = activeSlot === slot.index;
        node.appendChild(
          el("a", { href: "/slot/" + slot.index, class: "nav-item" + (isActive ? " active" : "") }, [
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
      const reapBtn = el("button", { class: "slot-reap-btn", type: "button" }, "Reap");
      reapBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (window.__inspector && window.__inspector.reapSlot) {
          window.__inspector.reapSlot(slot.index);
        }
      });
      card.appendChild(
        el("div", { class: "orphan-body" }, [
          el("div", { class: "orphan-message" }, orphanMsg),
          reapBtn,
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

    // Claimed. `slot.pid` is the lock-holder PID (the relay's own process) — not Brave.
    // Real Brave PIDs come from `slot.bravePids` (populated by findBraveProcessesForDir).
    // Brave is lazy-launched on first tools/call, so a slot can be claimed with no Brave yet.
    const _bravePid = (slot.bravePids && slot.bravePids[0]) || null;
    const _clientLabel = _bravePid != null
      ? "Brave PID " + _bravePid
      : slot.pid != null
        ? "Owner PID " + slot.pid + " · Brave not launched"
        : "—";
    card.appendChild(el("div", { class: "slot-client" }, _clientLabel));
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

  function renderSlotGrid(status, gridNode, metaNode) {
    clearChildren(gridNode);
    const slots = status.slots || [];
    if (slots.length === 0) {
      gridNode.appendChild(el("div", { class: "empty-msg" }, "No pool slots configured."));
    } else {
      for (const slot of slots) gridNode.appendChild(renderSlotCard(slot));
    }
    clearChildren(metaNode);
    const active = slots.filter((s) => s.state === "claimed").length;
    const idle = slots.filter((s) => s.state === "idle").length;
    const attention = slots.filter((s) => s.state === "orphan").length;
    metaNode.appendChild(el("span", { class: "ok" }, active + " active"));
    metaNode.appendChild(document.createTextNode(" · "));
    metaNode.appendChild(el("span", { class: "idle" }, idle + " idle"));
    metaNode.appendChild(document.createTextNode(" · "));
    metaNode.appendChild(el("span", { class: "err" }, attention + " attention"));
  }

  // Cookie source card — small panel on Pool overview showing the freshness
  // of the configured cookieSourceProfile (the profile whose cookies get
  // snapshotted into every pool slot at launch). One-card-or-empty pattern.
  function renderCookieSourceCard(status, cardNode) {
    clearChildren(cardNode);
    const cs = status.cookieSource || {};
    const statusText = cs.status || "unknown";

    if (!cs.profile) {
      cardNode.appendChild(
        el("div", { class: "cookie-source-card empty" }, [
          el("div", { class: "cookie-source-label" }, "Cookie source"),
          el("div", { class: "cookie-source-value muted" }, "Not configured"),
          el("div", { class: "cookie-source-hint" }, "Set cookieSourceProfile in local-config.json to share saved-login cookies across pool slots."),
        ]),
      );
      return;
    }

    const ageClass = statusText === "fresh" ? "fresh" : statusText === "stale" ? "stale" : "";
    cardNode.appendChild(
      el("div", { class: "cookie-source-card" }, [
        el("div", { class: "cookie-source-head" }, [
          el("span", { class: "cookie-source-label" }, "Cookie source"),
          el("span", { class: "cookie-source-pill " + statusText }, statusText),
        ]),
        el("div", { class: "cookie-source-value mono" }, cs.profile),
        el("div", { class: "cookie-source-meta mono" }, [
          el("span", { class: "k" }, "Last refresh "),
          el("span", { class: "value " + ageClass },
            cs.ageDays != null ? formatCookieAge(cs.ageDays) + " ago" : "—"),
          el("span", { class: "k" }, " · Threshold "),
          el("span", { class: "value" }, cs.thresholdDays + "d"),
        ]),
      ]),
    );
  }

  function renderVault(status, cardNode, metaNode) {
    clearChildren(cardNode);
    clearChildren(metaNode);
    const v = status.vault || {};

    if (!v.enabled) {
      cardNode.appendChild(el("div", { class: "empty-msg" }, "Vault disabled · set BROWSER_RELAY_VAULT_FILES to enable autofill"));
      return;
    }

    metaNode.appendChild(el("span", { class: "ok" }, v.totalEntries + " entries · " + v.uniqueHosts + " hosts"));

    const row = el("div", { class: "vault-row" }, [
      el("span", null, [el("span", { class: "k" }, "Entries"), document.createTextNode(String(v.totalEntries))]),
      el("span", null, [el("span", { class: "k" }, "Hosts"), document.createTextNode(String(v.uniqueHosts))]),
      el("span", null, [el("span", { class: "k" }, "Loaded"), document.createTextNode(String((v.filesLoaded || []).length))]),
      el("span", null, [el("span", { class: "k" }, "Skipped"), document.createTextNode(String((v.filesSkipped || []).length))]),
    ]);
    cardNode.appendChild(row);

    if ((v.filesLoaded || []).length || (v.filesSkipped || []).length) {
      const files = el("div", { class: "vault-files" });
      for (const f of v.filesLoaded || []) {
        files.appendChild(el("div", { class: "file" }, f.path + " · " + f.entries + " entries"));
      }
      for (const f of v.filesSkipped || []) {
        files.appendChild(el("div", { class: "file skipped" }, f.path + " — skipped (" + f.reason + ")"));
      }
      cardNode.appendChild(files);
    }
  }

  function buildHomeShell(main) {
    clearChildren(main);
    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "Pool"),
        el("span", { class: "meta", id: "pool-meta" }),
      ]),
    );
    main.appendChild(el("div", { class: "slot-grid", id: "slot-grid" }, [el("div", { class: "empty-msg" }, "Loading pool slots…")]));

    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "Cookie source"),
        el("span", { class: "meta" }, "feeds saved-login cookies into every pool slot at launch"),
      ]),
    );
    main.appendChild(el("div", { class: "cookie-source-wrap", id: "cookie-source-wrap" }, [el("div", { class: "empty-msg" }, "Loading cookie source…")]));

    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "Vault"),
        el("span", { class: "meta", id: "vault-meta" }),
      ]),
    );
    main.appendChild(el("div", { class: "vault-card", id: "vault-card" }, [el("div", { class: "empty-msg" }, "Loading vault…")]));
  }

  async function refreshHome() {
    // Abort any prior in-flight fetch — prevents request piling on slow
    // networks when the 5s timer fires before the previous fetch completes.
    if (homeFetchAbort) {
      try { homeFetchAbort.abort(); } catch { /* noop */ }
    }
    homeFetchAbort = new AbortController();
    const signal = homeFetchAbort.signal;
    try {
      const status = await fetchJson("/api/status", { signal });
      renderHeader(status);
      renderSidebar(status);
      renderSlotGrid(status, document.getElementById("slot-grid"), document.getElementById("pool-meta"));
      renderCookieSourceCard(status, document.getElementById("cookie-source-wrap"));
      renderVault(status, document.getElementById("vault-card"), document.getElementById("vault-meta"));
    } catch (e) {
      // Aborted-by-newer-request is expected and noisy — swallow it.
      if (e && (e.name === "AbortError" || e.code === 20)) return;
      const pill = document.getElementById("health-pill");
      const label = document.getElementById("health-label");
      pill.classList.remove("warn");
      pill.classList.add("err");
      label.textContent = "Disconnected";
      // eslint-disable-next-line no-console
      console.error("[inspector] /api/status fetch failed:", e);
    }
  }

  function startHomeTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => {
      // Pause polling when the tab isn't visible — saves CPU on the relay
      // and keeps the cookie-source / brave-process probes from firing
      // when no one is looking. Resumes immediately on visibilitychange.
      if (paused || document.hidden) return;
      refreshHome();
    }, REFRESH_MS);
  }

  // Resume polling promptly when the tab becomes visible again rather than
  // waiting up to REFRESH_MS for the next interval tick.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !paused && (location.pathname === "/" || location.pathname === "/index.html")) {
      refreshHome();
    }
  });

  function renderHome(main) {
    buildHomeShell(main);
    refreshHome();
    startHomeTimer();
  }

  // ─── SETTINGS ─────────────────────────────────────────────────────────

  // Determine the "source" of a config value for the small caption under
  // each card. If a corresponding env var is set we say so; otherwise we
  // call it auto-detect (the only other path the inspector knows about).
  function configSource(envSetMap, envName, hasValue) {
    if (envName && envSetMap[envName]) return "env: " + envName;
    if (hasValue) return "auto-detect / wrapper";
    return "default";
  }

  function configCard(label, value, source) {
    return el("div", { class: "config-card" }, [
      el("div", { class: "config-key" }, label),
      el("div", { class: "config-value" + (value == null ? " muted" : "") }, value == null ? "—" : value),
      el("div", { class: "config-source" }, source),
    ]);
  }

  function copyButton(text) {
    const btn = el("button", { class: "copy-btn", type: "button" }, [
      svgIcon("0 0 24 24", [
        { tag: "rect", attrs: { x: "9", y: "9", width: "13", height: "13", rx: "2", ry: "2" } },
        { attrs: { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" } },
      ], { width: "12", height: "12", strokeWidth: "1.8" }),
      el("span", null, "Copy"),
    ]);
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback for older browsers / permission denied.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch { /* noop */ }
        document.body.removeChild(ta);
      }
      btn.classList.add("copied");
      btn.lastChild.textContent = "Copied";
      setTimeout(() => {
        btn.classList.remove("copied");
        btn.lastChild.textContent = "Copy";
      }, 1500);
    });
    return btn;
  }

  function snippetBlock(title, hint, snippetText) {
    const wrap = el("div", { class: "snippet-block" });
    const head = el("div", { class: "snippet-head" }, [
      el("span", { class: "snippet-title" }, title),
      copyButton(snippetText),
    ]);
    wrap.appendChild(head);
    if (hint) wrap.appendChild(el("div", { class: "snippet-hint" }, hint));
    wrap.appendChild(el("pre", null, snippetText));
    return wrap;
  }

  function envRow(name, isSet) {
    return el("div", { class: "env-row" + (isSet ? " set" : "") }, [
      el("span", { class: "env-dot" }),
      el("span", { class: "env-name mono" }, name),
      el("span", { class: "env-status" }, isSet ? "set" : "unset"),
    ]);
  }

  // Standard MCP-registration snippet for ~/.claude.json. Path placeholders
  // are obvious — we don't read the user's .claude.json. Kept in sync with
  // what scripts/setup.js prints (same key, same entry point).
  function buildMcpSnippet() {
    return JSON.stringify({
      "browser-mcp-relay": {
        command: "node",
        args: ["<absolute-path-to-repo>/src/index.js"],
      },
    }, null, 2);
  }

  async function renderSettings(main) {
    clearChildren(main);
    main.appendChild(el("div", { class: "empty-msg" }, "Loading settings…"));

    let data;
    try {
      data = await fetchJson("/api/settings");
    } catch (e) {
      clearChildren(main);
      main.appendChild(el("div", { class: "empty-msg" }, "Failed to load /api/settings: " + e.message));
      return;
    }

    clearChildren(main);

    main.appendChild(
      el("div", { class: "page-header" }, [
        el("h2", null, "Settings"),
        el("span", { class: "page-sub" }, "Configuration for this relay instance · read-only"),
      ]),
    );

    // Banner: local-config.json present?
    const banner = el("div", { class: "banner " + (data.localConfigExists ? "ok" : "info") });
    if (data.localConfigExists) {
      banner.appendChild(
        svgIcon("0 0 24 24", [{ attrs: { points: "20 6 9 17 4 12" }, tag: "polyline" }], { width: "16", height: "16", strokeWidth: "2.2" }),
      );
      banner.appendChild(el("span", null, "local-config.json found"));
      banner.appendChild(el("span", { class: "banner-detail" }, "values from disk applied under env-var overrides"));
    } else {
      banner.appendChild(
        svgIcon("0 0 24 24", [
          { tag: "circle", attrs: { cx: "12", cy: "12", r: "10" } },
          { tag: "line", attrs: { x1: "12", y1: "16", x2: "12", y2: "12" } },
          { tag: "line", attrs: { x1: "12", y1: "8", x2: "12.01", y2: "8" } },
        ], { width: "16", height: "16", strokeWidth: "1.8" }),
      );
      banner.appendChild(el("span", null, "local-config.json not found"));
      banner.appendChild(el("span", { class: "banner-detail" }, "using auto-detect / env vars only — see snippet below"));
    }
    main.appendChild(banner);

    // Resolved config
    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "Resolved config"),
        el("span", { class: "meta" }, "what this relay is using right now"),
      ]),
    );
    const env = data.env || {};
    const cfg = data.config || {};
    const grid = el("div", { class: "config-grid" });
    grid.appendChild(configCard("Mode", cfg.mode, configSource(env, null, true)));
    grid.appendChild(configCard("Brave path", cfg.bravePath, configSource(env, "BROWSER_RELAY_BRAVE_PATH", !!cfg.bravePath)));
    grid.appendChild(configCard("Brave profile dir", cfg.braveProfileDir, configSource(env, "BROWSER_RELAY_BRAVE_PROFILE_DIR", !!cfg.braveProfileDir)));
    const poolDirsLabel = (cfg.poolDirs || []).length > 0 ? cfg.poolDirs.join(", ") : null;
    grid.appendChild(configCard("Pool dirs", poolDirsLabel, configSource(env, "BROWSER_RELAY_POOL_DIR", !!poolDirsLabel)));
    grid.appendChild(configCard("Cookie source profile", cfg.cookieSourceProfile, configSource(env, null, !!cfg.cookieSourceProfile)));
    grid.appendChild(configCard("Cookie freshness threshold", cfg.cookieFreshnessWarnDays + " days", "default"));
    main.appendChild(grid);

    // Env vars
    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "Environment variables"),
        el("span", { class: "meta" }, "set · unset (values not shown)"),
      ]),
    );
    const envGrid = el("div", { class: "env-grid" });
    for (const [k, v] of Object.entries(env)) {
      envGrid.appendChild(envRow(k, !!v));
    }
    main.appendChild(envGrid);

    // local-config.json snippet
    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "local-config.json"),
        el("span", { class: "meta" }, "paste-ready · gitignored"),
      ]),
    );
    main.appendChild(
      snippetBlock(
        "Paste into <repo>/local-config.json",
        "Replace basenames with absolute paths on your machine. Reference: " + (data.localConfigExamplePath || "local-config.example.json"),
        data.localConfigSnippet || "{}",
      ),
    );

    // MCP-registration snippet
    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "MCP registration"),
        el("span", { class: "meta" }, "for ~/.claude.json or your IDE's MCP config"),
      ]),
    );
    main.appendChild(
      snippetBlock(
        "Add to mcpServers",
        "Substitute <absolute-path-to-repo> with this clone's location.",
        buildMcpSnippet(),
      ),
    );
  }

  // ─── TOOLS (catalog) ──────────────────────────────────────────────────

  // Stable display order for the left-pane subgroups. Both first-party and
  // forwarded categories are union'd here; we filter to whatever's actually
  // present at render time.
  const TOOLS_CATEGORY_ORDER = [
    "performance", "device", "tabs", "forms", "network", "session", "downloads", "data",
    "accessibility", "content", "debug", "interaction", "navigation", "observability",
    "react", "stub", "scenario", "execute", "sync",
  ];
  const TOOLS_CATEGORY_LABELS = {
    performance: "Performance & diagnostics",
    device: "Device emulation",
    tabs: "Multi-tab control",
    forms: "Forms, dialogs, files",
    network: "Network capture",
    session: "Session & cookies",
    downloads: "Downloads",
    data: "Data extraction",
    accessibility: "Accessibility",
    content: "Content extraction",
    debug: "Debug probes",
    interaction: "Page interaction",
    navigation: "Navigation",
    observability: "Observability",
    react: "React introspection",
    stub: "HTTP stubbing",
    scenario: "Scenarios",
    execute: "Other",
    sync: "Sync",
  };

  // Module-level tools state — fetched once, then driven by user input. We
  // don't poll /api/tools (it's static for the lifetime of the inspector).
  let toolsState = {
    catalog: null,        // raw /api/tools payload
    selected: null,       // tool name
    filter: "",           // search string
    sourceFilter: "all",  // "all" | "first-party" | "forwarded"
  };

  function matchesFilter(tool, filterText) {
    if (!filterText) return true;
    const q = filterText.toLowerCase();
    return (
      tool.name.toLowerCase().includes(q) ||
      (tool.description || "").toLowerCase().includes(q)
    );
  }

  function renderToolRow(tool, isOwn) {
    const row = el("div", {
      class: "tool-row" + (toolsState.selected === tool.name ? " active" : ""),
      "data-name": tool.name,
    }, [
      el("span", { class: "tool-name" }, tool.name),
      el("span", { class: "tool-desc" }, tool.description || ""),
    ]);
    row.addEventListener("click", () => {
      toolsState.selected = tool.name;
      renderToolsList();
      renderToolDetail();
    });
    row._isOwn = isOwn;
    return row;
  }

  function groupByCategory(tools) {
    const map = new Map();
    for (const t of tools) {
      const cat = t.category || "data";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat).push(t);
    }
    return map;
  }

  function renderToolsList() {
    const scroll = document.getElementById("tools-list-scroll");
    if (!scroll) return;
    clearChildren(scroll);

    const cat = toolsState.catalog;
    if (!cat) {
      scroll.appendChild(el("div", { class: "tools-empty" }, "Loading…"));
      return;
    }

    const showOwn = toolsState.sourceFilter !== "forwarded";
    const showFwd = toolsState.sourceFilter !== "first-party";

    const ownFiltered = (cat.own || []).filter((t) => matchesFilter(t, toolsState.filter));
    const fwdFiltered = (cat.forwarded || []).filter((t) => matchesFilter(t, toolsState.filter));

    let totalShown = 0;

    if (showOwn && ownFiltered.length) {
      scroll.appendChild(
        el("div", { class: "tools-group-label" }, [
          el("span", null, "First-party"),
          el("span", { class: "group-count" }, String(ownFiltered.length)),
        ]),
      );
      const groups = groupByCategory(ownFiltered);
      for (const cat of TOOLS_CATEGORY_ORDER) {
        const list = groups.get(cat);
        if (!list || !list.length) continue;
        scroll.appendChild(el("div", { class: "tools-subgroup-label" }, TOOLS_CATEGORY_LABELS[cat] || cat));
        for (const t of list) scroll.appendChild(renderToolRow(t, true));
        totalShown += list.length;
      }
    }

    if (showFwd && fwdFiltered.length) {
      scroll.appendChild(
        el("div", { class: "tools-group-label" }, [
          el("span", null, "Forwarded"),
          el("span", { class: "group-count" }, String(fwdFiltered.length)),
        ]),
      );
      const groups = groupByCategory(fwdFiltered);
      for (const cat of TOOLS_CATEGORY_ORDER) {
        const list = groups.get(cat);
        if (!list || !list.length) continue;
        scroll.appendChild(el("div", { class: "tools-subgroup-label" }, TOOLS_CATEGORY_LABELS[cat] || cat));
        for (const t of list) scroll.appendChild(renderToolRow(t, false));
        totalShown += list.length;
      }
    }

    if (!totalShown) {
      scroll.appendChild(el("div", { class: "tools-empty" }, "No tools match."));
    }
  }

  function lookupSelected() {
    const cat = toolsState.catalog;
    if (!cat || !toolsState.selected) return null;
    for (const t of cat.own || []) {
      if (t.name === toolsState.selected) return { tool: t, isOwn: true };
    }
    for (const t of cat.forwarded || []) {
      if (t.name === toolsState.selected) return { tool: t, isOwn: false };
    }
    return null;
  }

  function renderToolDetail() {
    const pane = document.getElementById("tools-detail-pane");
    if (!pane) return;
    clearChildren(pane);

    const sel = lookupSelected();
    if (!sel) {
      pane.appendChild(el("div", { class: "tools-empty" }, "Select a tool from the list."));
      return;
    }
    const { tool, isOwn } = sel;

    pane.appendChild(el("div", { class: "tool-detail-name" }, tool.name));
    pane.appendChild(
      el("div", { class: "tool-detail-badges" }, [
        el("span", { class: "tool-source-pill " + (isOwn ? "first-party" : "forwarded") }, isOwn ? "First-party" : "Forwarded"),
        tool.category ? el("span", { class: "tool-cat-chip" }, TOOLS_CATEGORY_LABELS[tool.category] || tool.category) : null,
      ]),
    );
    pane.appendChild(el("div", { class: "tool-detail-desc" }, tool.description || "(no description)"));

    if (isOwn) {
      if (tool.sourceFile) {
        pane.appendChild(
          el("div", { class: "tool-detail-section" }, [
            el("span", { class: "section-key" }, "Source"),
            el("span", { class: "section-value" }, "src/own-tools/" + tool.sourceFile),
          ]),
        );
      }
      if (tool.inputSchemaPreview) {
        pane.appendChild(
          el("div", { class: "tool-detail-section" }, [
            el("span", { class: "section-key" }, "Input schema (top-level fields)"),
            el("span", { class: "section-value" }, tool.inputSchemaPreview),
          ]),
        );
      } else {
        pane.appendChild(
          el("div", { class: "tool-detail-section" }, [
            el("span", { class: "section-key" }, "Input schema"),
            el("span", { class: "section-value muted" }, "(no input fields)"),
          ]),
        );
      }
    } else {
      const upstream = tool.upstreamSource || "browser-devtools-mcp";
      pane.appendChild(
        el("div", { class: "tool-detail-section" }, [
          el("span", { class: "section-key" }, "Upstream"),
          el("a", {
            href: "https://github.com/serkan-ozal/browser-devtools-mcp",
            target: "_blank",
            rel: "noopener noreferrer",
          }, "From " + upstream),
        ]),
      );
    }

    const tryBtn = el("button", {
      class: "tool-try-btn",
      type: "button",
      disabled: "",
      title: "Requires running relay (W10)",
    }, "Try it");
    pane.appendChild(tryBtn);
  }

  function buildToolsShell(main) {
    clearChildren(main);

    const filterInput = el("input", {
      type: "text",
      placeholder: "Filter tools…",
      id: "tools-filter-input",
      autocomplete: "off",
      spellcheck: "false",
    });
    filterInput.addEventListener("input", () => {
      toolsState.filter = filterInput.value || "";
      renderToolsList();
    });

    const filterWrap = el("div", { class: "tools-filter" }, [
      svgIcon("0 0 24 24", [
        { tag: "circle", attrs: { cx: "11", cy: "11", r: "8" } },
        { tag: "line", attrs: { x1: "21", y1: "21", x2: "16.65", y2: "16.65" } },
      ], { width: "13", height: "13", strokeWidth: "1.8" }),
      filterInput,
      el("kbd", null, "⌘F"),
    ]);

    const pillAll = el("button", { class: "tools-pill" + (toolsState.sourceFilter === "all" ? " active" : ""), type: "button" }, "All");
    const pillOwn = el("button", { class: "tools-pill" + (toolsState.sourceFilter === "first-party" ? " active" : ""), type: "button" }, "First-party");
    const pillFwd = el("button", { class: "tools-pill" + (toolsState.sourceFilter === "forwarded" ? " active" : ""), type: "button" }, "Forwarded");
    const setSource = (val) => () => {
      toolsState.sourceFilter = val;
      pillAll.classList.toggle("active", val === "all");
      pillOwn.classList.toggle("active", val === "first-party");
      pillFwd.classList.toggle("active", val === "forwarded");
      renderToolsList();
    };
    pillAll.addEventListener("click", setSource("all"));
    pillOwn.addEventListener("click", setSource("first-party"));
    pillFwd.addEventListener("click", setSource("forwarded"));

    const titleRow = el("div", { class: "tools-list-titlerow" }, [
      el("h2", null, "Tools"),
      el("span", { class: "count", id: "tools-count" }, "—"),
    ]);

    const header = el("div", { class: "tools-list-header" }, [
      titleRow,
      filterWrap,
      el("div", { class: "tools-pills" }, [pillAll, pillOwn, pillFwd]),
    ]);

    const scroll = el("div", { class: "tools-list-scroll", id: "tools-list-scroll" }, [
      el("div", { class: "tools-empty" }, "Loading…"),
    ]);

    const listPane = el("div", { class: "tools-list-pane" }, [header, scroll]);
    const detailPane = el("div", { class: "tools-detail-pane", id: "tools-detail-pane" }, [
      el("div", { class: "tools-empty" }, "Loading…"),
    ]);

    main.appendChild(el("div", { class: "tools-layout" }, [listPane, detailPane]));

    // Focus filter on ⌘/Ctrl+F. Page-local — doesn't intercept the browser's
    // built-in find when typing in inputs/textareas elsewhere on the page.
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && document.querySelector(".tools-layout")) {
        e.preventDefault();
        filterInput.focus();
        filterInput.select();
      }
    };
    document.addEventListener("keydown", onKey);
  }

  async function renderTools(main) {
    buildToolsShell(main);
    let data;
    try {
      data = await fetchJson("/api/tools");
    } catch (e) {
      const scroll = document.getElementById("tools-list-scroll");
      if (scroll) {
        clearChildren(scroll);
        scroll.appendChild(el("div", { class: "tools-empty" }, "Failed to load /api/tools: " + e.message));
      }
      return;
    }
    toolsState.catalog = data;
    // Default selection: lighthouse_audit if present, else the first own tool.
    if (!toolsState.selected) {
      const def = (data.own || []).find((t) => t.name === "lighthouse_audit");
      toolsState.selected = def ? def.name : (data.own && data.own[0] ? data.own[0].name : null);
    }
    const counter = document.getElementById("tools-count");
    if (counter) counter.textContent = String(data.total);
    renderToolsList();
    renderToolDetail();
  }

  // ─── SLOT DETAIL (per-slot Inspector page) ───────────────────────────
  //
  // Layout: top breadcrumb, "Recent activity" feed (WS-driven), "Detail"
  // section that shows the selected event's request + response. Standalone
  // mode receives no live events; we show the standalone empty state.

  // Module-level state for the live feed. Reset on each renderSlotDetail.
  let slotState = {
    n: null,
    feed: [],          // array of merged request/response events (newest first)
    selectedId: null,  // event id whose request/response we're showing
    eventMap: new Map(), // id → { request: {...}, response: {...} }
    ws: null,
    wsAttempts: 0,
    wsLive: false,
    wsStandalone: false,
    wsReconnectTimer: null,
    sigToken: 0,        // bumps on each renderSlotDetail; stale handlers no-op
  };

  const FEED_CAP = 100;

  function formatHHMMSS(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const pad = (n) => String(n).padStart(2, "0");
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function formatMs(ms) {
    if (ms == null || !Number.isFinite(ms)) return "—";
    if (ms >= 1000) return (ms / 1000).toFixed(1) + "s";
    return Math.round(ms) + "ms";
  }

  function summariseArgs(args) {
    if (args == null) return "";
    if (typeof args === "string") return args;
    try {
      const json = JSON.stringify(args);
      if (json.length > 110) return json.slice(0, 109) + "…";
      return json;
    } catch {
      return String(args);
    }
  }

  function renderActivityCard(merged) {
    const { request, response, id } = merged;
    const isInFlight = !response;
    const status = response ? response.status : "pending";
    const iconClass = isInFlight ? "pending" : (status === "error" ? "err" : "ok");
    const sourceClass = request && request.source === "own" ? "first-party" : "";
    const sourceLabel = request && request.source === "own" ? "First-party" : "Forwarded";
    const card = el("div", { class: "activity-card" + (slotState.selectedId === id ? " active" : ""), "data-id": String(id) }, [
      el("span", { class: "activity-icon " + iconClass }),
      el("div", { class: "activity-body" }, [
        el("div", { class: "activity-title" }, [
          el("span", { class: "activity-tool" }, request ? request.name : "(unknown)"),
          el("span", { class: "activity-source " + sourceClass }, sourceLabel),
        ]),
        el("div", { class: "activity-args mono" }, request ? summariseArgs(request.args) : ""),
      ]),
      el("div", { class: "activity-meta" }, [
        el("span", { class: "activity-duration mono" + (response && response.durationMs > 1000 ? " slow" : "") },
          response ? formatMs(response.durationMs) : "in flight"),
        el("span", { class: "activity-time mono" }, request ? formatHHMMSS(request.time) : "—"),
      ]),
    ]);
    card.addEventListener("click", () => {
      slotState.selectedId = id;
      renderActivityFeed();
      renderSlotDetailSelected();
    });
    return card;
  }

  function renderActivityFeed() {
    const node = document.getElementById("slot-activity-feed");
    if (!node) return;
    clearChildren(node);

    if (slotState.wsStandalone) {
      node.appendChild(
        el("div", { class: "activity-empty" },
          "Inspector running standalone — live traffic requires launching the relay with BROWSER_RELAY_INSPECTOR_PORT set."),
      );
      updateActivityMeta(0, 0, 0);
      return;
    }

    if (slotState.feed.length === 0) {
      node.appendChild(
        el("div", { class: "activity-empty" },
          "Listening for activity. Make a request via your MCP client to see it here."),
      );
      updateActivityMeta(0, 0, 0);
      return;
    }

    let ok = 0, err = 0, pending = 0;
    for (const m of slotState.feed) {
      node.appendChild(renderActivityCard(m));
      if (!m.response) pending++;
      else if (m.response.status === "error") err++;
      else ok++;
    }
    updateActivityMeta(ok, err, pending);
  }

  function updateActivityMeta(ok, err, pending) {
    const meta = document.getElementById("slot-activity-meta");
    if (!meta) return;
    clearChildren(meta);
    meta.appendChild(el("span", { class: "ok" }, ok + " ok"));
    meta.appendChild(document.createTextNode(" · "));
    meta.appendChild(el("span", { class: "err" }, err + " error"));
    if (pending > 0) {
      meta.appendChild(document.createTextNode(" · "));
      meta.appendChild(el("span", null, pending + " in flight"));
    }
  }

  function renderSlotDetailSelected() {
    const pane = document.getElementById("slot-detail-pane");
    const title = document.getElementById("slot-detail-title");
    if (!pane) return;
    clearChildren(pane);

    const merged = slotState.feed.find((m) => m.id === slotState.selectedId);
    if (!merged) {
      if (title) title.textContent = "Detail";
      pane.appendChild(el("div", { class: "slot-detail-empty" }, "Select an event from the feed to view its request/response."));
      return;
    }

    const { request, response } = merged;
    if (title) title.textContent = "Detail · " + (request ? request.name : "");

    const head = el("div", { class: "detail-head" }, [
      el("div", { class: "detail-tool" }, request ? request.name : ""),
      el("div", { class: "detail-badges" }, [
        el("span", { class: "badge " + (request && request.source === "own" ? "first-party" : "") },
          request && request.source === "own" ? "First-party" : "Forwarded"),
        response
          ? el("span", { class: "badge " + (response.status === "error" ? "err" : "ok") },
              response.status === "error" ? "Error" : "OK")
          : el("span", { class: "badge" }, "In flight"),
        el("span", { class: "badge mono" }, formatHHMMSS(request ? request.time : null)),
        response ? el("span", { class: "badge mono" }, formatMs(response.durationMs)) : null,
      ]),
    ]);
    pane.appendChild(head);

    pane.appendChild(detailSection("Request", JSON.stringify({
      method: request ? request.method : "tools/call",
      params: { name: request ? request.name : "", arguments: request ? request.args : {} },
    }, null, 2)));

    if (response) {
      // response.response is the actual MCP response payload (may be a
      // string from the relay's truncate path).
      const rendered = typeof response.response === "string"
        ? response.response
        : JSON.stringify(response.response, null, 2);
      pane.appendChild(detailSection("Response", rendered));
    }
  }

  function detailSection(label, body) {
    return el("div", { class: "detail-section" }, [
      el("div", { class: "detail-section-label" }, label),
      el("pre", { class: "json-block mono" }, body || ""),
    ]);
  }

  function ingestEvent(evt) {
    if (!evt || !evt.type || evt.id == null) return;

    if (evt.type === "request") {
      const merged = { id: evt.id, request: evt, response: null };
      slotState.eventMap.set(evt.id, merged);
      slotState.feed.unshift(merged);
      if (slotState.feed.length > FEED_CAP) {
        const dropped = slotState.feed.splice(FEED_CAP);
        for (const m of dropped) slotState.eventMap.delete(m.id);
      }
      // Default-select first event if user hasn't picked one yet.
      if (slotState.selectedId == null) slotState.selectedId = evt.id;
      return;
    }

    if (evt.type === "response") {
      const m = slotState.eventMap.get(evt.id);
      if (m) m.response = evt;
      return;
    }
  }

  function applyBackfill(events) {
    if (!Array.isArray(events)) return;
    // Backfill events arrive oldest → newest. Process in order to fold
    // request+response pairs.
    for (const e of events) ingestEvent(e);
  }

  function teardownWs() {
    if (slotState.ws) {
      try { slotState.ws.onopen = null; slotState.ws.onclose = null; slotState.ws.onerror = null; slotState.ws.onmessage = null; } catch {}
      try { slotState.ws.close(); } catch {}
      slotState.ws = null;
    }
    if (slotState.wsReconnectTimer) {
      clearTimeout(slotState.wsReconnectTimer);
      slotState.wsReconnectTimer = null;
    }
  }

  function connectWs(token) {
    teardownWs();
    if (token !== slotState.sigToken) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws;
    try {
      ws = new WebSocket(proto + "//" + location.host + "/ws/traffic");
    } catch (e) {
      // Browser refused (e.g. invalid URL) — no live updates available.
      slotState.wsLive = false;
      updateLivePill();
      return;
    }
    slotState.ws = ws;

    ws.onopen = () => {
      if (token !== slotState.sigToken) { try { ws.close(); } catch {}; return; }
      slotState.wsAttempts = 0;
      slotState.wsLive = true;
      slotState.wsStandalone = false;
      updateLivePill();
    };
    ws.onmessage = (msgEvt) => {
      if (token !== slotState.sigToken) return;
      let data;
      try { data = JSON.parse(msgEvt.data); }
      catch { return; }
      if (data.type === "no-emitter") {
        slotState.wsStandalone = true;
        slotState.wsLive = false;
        updateLivePill();
        renderActivityFeed();
        return;
      }
      if (data.type === "backfill") {
        applyBackfill(data.events);
        renderActivityFeed();
        renderSlotDetailSelected();
        return;
      }
      if (data.type === "request" || data.type === "response") {
        ingestEvent(data);
        renderActivityFeed();
        if (data.id === slotState.selectedId) renderSlotDetailSelected();
        return;
      }
    };
    ws.onclose = () => {
      if (token !== slotState.sigToken) return;
      slotState.wsLive = false;
      updateLivePill();
      // Only reconnect if we never got a definitive "no-emitter" from the
      // server. Standalone mode closes intentionally; reconnecting would
      // just bounce off the same wall.
      if (slotState.wsStandalone) return;
      slotState.wsAttempts++;
      const delay = Math.min(30_000, 500 * Math.pow(2, slotState.wsAttempts - 1));
      slotState.wsReconnectTimer = setTimeout(() => connectWs(token), delay);
    };
    ws.onerror = () => {
      // Browser fires onclose right after onerror; let onclose handle backoff.
      slotState.wsLive = false;
      updateLivePill();
    };
  }

  function updateLivePill() {
    const pill = document.getElementById("slot-live-pill");
    if (!pill) return;
    if (slotState.wsStandalone) {
      pill.className = "live-pill warn";
      pill.textContent = "Standalone";
      return;
    }
    if (slotState.wsLive) {
      pill.className = "live-pill ok";
      pill.textContent = "Live";
      return;
    }
    pill.className = "live-pill";
    pill.textContent = "Reconnecting…";
  }

  function buildSlotDetailShell(main, n, total) {
    clearChildren(main);

    const breadcrumb = el("div", { class: "slot-breadcrumb" }, [
      el("a", { href: "/" }, "Pool"),
      el("span", { class: "slot-breadcrumb-sep" }, "·"),
      el("span", null, "Slot " + n),
      el("span", { id: "slot-live-pill", class: "live-pill" }, "Connecting…"),
    ]);
    main.appendChild(breadcrumb);

    main.appendChild(el("div", { id: "slot-summary-card", class: "slot-summary-card" }, [
      el("div", { class: "empty-msg" }, "Loading slot…"),
    ]));

    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "Recent activity"),
        el("span", { class: "meta", id: "slot-activity-meta" }),
      ]),
    );
    main.appendChild(el("div", { class: "activity-feed", id: "slot-activity-feed" }, [
      el("div", { class: "activity-empty" }, "Connecting…"),
    ]));

    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", { id: "slot-detail-title" }, "Detail"),
        el("span", { class: "meta" }, total ? "slot " + n + " of " + total : ""),
      ]),
    );
    main.appendChild(el("div", { class: "detail-block", id: "slot-detail-pane" }, [
      el("div", { class: "slot-detail-empty" }, "Select an event from the feed to view its request/response."),
    ]));
  }

  function renderSlotSummaryCard(slot) {
    const node = document.getElementById("slot-summary-card");
    if (!node) return;
    clearChildren(node);
    const stateLabel = slot.state === "claimed" ? "Active" :
                       slot.state === "orphan" ? "Orphan" : "Idle";
    const stateClass = slot.state === "claimed" ? "ok" :
                       slot.state === "orphan" ? "err" : "idle";
    const headLeft = el("div", null, [
      el("div", { class: "slot-summary-name" }, "Slot " + slot.index),
      el("div", { class: "slot-summary-dir mono" }, slot.dir || "—"),
    ]);
    const headRight = el("div", { class: "slot-summary-stats mono" }, [
      el("span", null, [el("span", { class: "k" }, "STATE"), el("span", { class: "v " + stateClass }, stateLabel)]),
      el("span", null, [el("span", { class: "k" }, "PID"), el("span", { class: "v" }, slot.pid != null ? String(slot.pid) : "—")]),
      el("span", null, [el("span", { class: "k" }, "ROLE"), el("span", { class: "v" }, slot.role || "default")]),
      el("span", null, [el("span", { class: "k" }, "UP"), el("span", { class: "v" }, slot.lockHeldMs != null ? formatDuration(slot.lockHeldMs / 1000) : "—")]),
      el("span", null, [el("span", { class: "k" }, "COOKIE"), el("span", { class: "v" }, formatCookieAge(slot.cookieAgeDays))]),
    ]);
    node.appendChild(el("div", { class: "slot-summary-head" }, [headLeft, headRight]));
  }

  async function renderSlotDetail(main, n) {
    // Reset state for this view.
    teardownWs();
    slotState = {
      n,
      feed: [],
      selectedId: null,
      eventMap: new Map(),
      ws: null,
      wsAttempts: 0,
      wsLive: false,
      wsStandalone: false,
      wsReconnectTimer: null,
      sigToken: slotState.sigToken + 1,
    };
    const token = slotState.sigToken;

    let detail;
    try {
      detail = await fetchJson("/api/slot/" + n);
    } catch (e) {
      // Most likely 404 (slot out of range) — bounce home.
      location.replace("/");
      return;
    }
    if (token !== slotState.sigToken) return;

    buildSlotDetailShell(main, n, detail.totalSlots);
    renderSlotSummaryCard(detail.slot);

    // Backfill from the GET first (HTTP-fast); WS will then provide a more
    // recent backfill on connect + live updates.
    if (Array.isArray(detail.recentTraffic) && detail.recentTraffic.length > 0) {
      applyBackfill(detail.recentTraffic);
      renderActivityFeed();
      renderSlotDetailSelected();
    } else {
      renderActivityFeed();
    }

    connectWs(token);
  }

  // ─── Toast (W11) ──────────────────────────────────────────────────────

  function showToast(message, kind) {
    const container = document.getElementById("toast-container");
    if (!container) return;
    const t = el("div", { class: "toast " + (kind === "error" ? "error" : kind === "info" ? "info" : "ok") }, [
      el("span", { class: "toast-dot" }),
      el("span", { class: "toast-msg" }, message),
    ]);
    container.appendChild(t);
    // CSS animates in via a class added on next frame.
    requestAnimationFrame(() => t.classList.add("in"));
    setTimeout(() => {
      t.classList.add("out");
      setTimeout(() => { try { container.removeChild(t); } catch { /* gone */ } }, 250);
    }, 4000);
  }

  // ─── ACTIVITY (cross-slot history) ───────────────────────────────────
  //
  // /api/activity returns the same ring buffer that /api/slot/:n exposes,
  // but here we surface it as a global activity log with type filters and
  // a time-range picker. WS not used — page is read-on-load + manual refresh.

  let activityState = {
    raw: [],
    filter: "all",     // all | requests | responses | errors
    range: "1h",       // 5m | 1h | 24h
  };

  const ACTIVITY_RANGE_MS = {
    "5m": 5 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
  };

  // Pure helper exposed for tests: filter the ring-buffer events by
  // {filter, range}. Returns events sorted newest-first.
  function filterActivityEvents(events, filter, range, now) {
    const cutoff = now - (ACTIVITY_RANGE_MS[range] || ACTIVITY_RANGE_MS["1h"]);
    const out = [];
    for (const e of events || []) {
      const t = e.time ? Date.parse(e.time) : 0;
      if (!Number.isFinite(t) || t < cutoff) continue;
      if (filter === "requests" && e.method !== "tools/call") continue;
      if (filter === "responses" && e.status == null) continue;
      if (filter === "errors" && e.status !== "error") continue;
      out.push(e);
    }
    // Newest first.
    out.sort((a, b) => Date.parse(b.time || 0) - Date.parse(a.time || 0));
    return out;
  }

  function renderActivityCardEntry(evt) {
    const isRequest = evt.method === "tools/call";
    const isError = evt.status === "error";
    const iconClass = isRequest ? "pending" : (isError ? "err" : "ok");
    const sourceClass = evt.source === "own" ? "first-party" : "";
    const sourceLabel = evt.source === "own" ? "First-party" : evt.source ? "Forwarded" : "";
    const title = isRequest ? evt.name : ("Response · " + (evt.status || "ok"));
    const sub = isRequest
      ? summariseArgs(evt.args)
      : (evt.durationMs != null ? formatMs(evt.durationMs) : "");
    return el("div", { class: "activity-card" }, [
      el("span", { class: "activity-icon " + iconClass }),
      el("div", { class: "activity-body" }, [
        el("div", { class: "activity-title" }, [
          el("span", { class: "activity-tool" }, title),
          sourceLabel ? el("span", { class: "activity-source " + sourceClass }, sourceLabel) : null,
        ]),
        el("div", { class: "activity-args mono" }, sub || ""),
      ]),
      el("div", { class: "activity-meta" }, [
        el("span", { class: "activity-time mono" }, formatHHMMSS(evt.time)),
      ]),
    ]);
  }

  function renderActivityList() {
    const node = document.getElementById("activity-list");
    if (!node) return;
    clearChildren(node);
    const filtered = filterActivityEvents(activityState.raw, activityState.filter, activityState.range, Date.now());
    if (filtered.length === 0) {
      node.appendChild(
        el("div", { class: "activity-empty" },
          activityState.raw.length === 0
            ? "No activity captured yet. Make an MCP tool call to see it appear here."
            : "No events match the current filter."),
      );
      return;
    }
    for (const evt of filtered) node.appendChild(renderActivityCardEntry(evt));
    const meta = document.getElementById("activity-meta");
    if (meta) {
      clearChildren(meta);
      meta.appendChild(el("span", null, filtered.length + " event" + (filtered.length === 1 ? "" : "s")));
      meta.appendChild(document.createTextNode(" · "));
      meta.appendChild(el("span", { class: "muted" }, "of " + activityState.raw.length + " captured"));
    }
  }

  function buildActivityShell(main) {
    clearChildren(main);

    main.appendChild(
      el("div", { class: "page-header" }, [
        el("h2", null, "Activity history"),
        el("span", { class: "page-sub" }, "Cross-slot ring buffer · last ~200 events · standalone Inspector shows nothing"),
      ]),
    );

    // Filter pills + range picker.
    const pills = ["all", "requests", "responses", "errors"].map((kind) =>
      el("button", { class: "tools-pill" + (activityState.filter === kind ? " active" : ""), type: "button", "data-kind": kind },
        kind === "all" ? "All" : kind === "requests" ? "Requests" : kind === "responses" ? "Responses" : "Errors"),
    );
    pills.forEach((b) => {
      b.addEventListener("click", () => {
        activityState.filter = b.dataset.kind;
        pills.forEach((p) => p.classList.toggle("active", p.dataset.kind === activityState.filter));
        renderActivityList();
      });
    });

    const rangeButtons = ["5m", "1h", "24h"].map((r) =>
      el("button", { class: "tools-pill" + (activityState.range === r ? " active" : ""), type: "button", "data-range": r }, r),
    );
    rangeButtons.forEach((b) => {
      b.addEventListener("click", () => {
        activityState.range = b.dataset.range;
        rangeButtons.forEach((p) => p.classList.toggle("active", p.dataset.range === activityState.range));
        renderActivityList();
      });
    });

    main.appendChild(
      el("div", { class: "activity-controls" }, [
        el("div", { class: "activity-filter-group" }, pills),
        el("div", { class: "activity-range-group" }, [
          el("span", { class: "activity-range-label" }, "Range"),
          ...rangeButtons,
        ]),
        el("span", { class: "meta", id: "activity-meta" }),
      ]),
    );

    main.appendChild(el("div", { class: "activity-feed", id: "activity-list" }, [
      el("div", { class: "activity-empty" }, "Loading…"),
    ]));
  }

  async function renderActivity(main) {
    buildActivityShell(main);
    let data;
    try {
      data = await fetchJson("/api/activity");
    } catch (e) {
      const node = document.getElementById("activity-list");
      if (node) {
        clearChildren(node);
        node.appendChild(el("div", { class: "activity-empty" }, "Failed to load /api/activity: " + e.message));
      }
      return;
    }
    activityState.raw = Array.isArray(data.events) ? data.events : [];
    renderActivityList();
  }

  // ─── Mutating action wiring (W11) ─────────────────────────────────────

  async function reapSlotAction(slotIndex) {
    try {
      const r = await fetch("/api/slots/" + slotIndex + "/reap", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      let body = null;
      try { body = await r.json(); } catch { /* ignore */ }
      if (!r.ok) {
        showToast((body && body.message) || ("Reap failed (" + r.status + ")"), "error");
        return;
      }
      showToast((body && body.message) || "Slot reaped", "ok");
      // Refresh state so the slot turns idle.
      if (location.pathname === "/" || location.pathname === "/index.html") refreshHome();
      else if (/^\/slot\/\d+$/.test(location.pathname)) location.reload();
    } catch (e) {
      showToast("Reap failed: " + e.message, "error");
    }
  }

  // Expose the reap action so the orphan-slot card can wire its button up.
  window.__inspector = window.__inspector || {};
  window.__inspector.reapSlot = reapSlotAction;
  window.__inspector.showToast = showToast;
  // Test seam — exposed on window so unit tests can drive the pure filter
  // without spinning up a DOM.
  window.__inspector.filterActivityEvents = filterActivityEvents;

  // ─── Header / sidebar wiring (chrome shared across views) ─────────────

  // Header buttons. Refresh + Pause only matter on Home.
  function bindControls() {
    const refreshBtn = document.getElementById("btn-refresh");
    if (refreshBtn) {
      refreshBtn.addEventListener("click", () => {
        if (location.pathname === "/" || location.pathname === "/index.html") {
          refreshHome();
        } else {
          location.reload();
        }
      });
    }
    const pauseBtn = document.getElementById("btn-pause");
    if (pauseBtn) {
      pauseBtn.addEventListener("click", () => {
        paused = !paused;
        pauseBtn.classList.toggle("paused", paused);
        pauseBtn.title = paused ? "Resume auto-refresh" : "Pause auto-refresh";
      });
    }
  }

  // Highlight the active sidebar link for the current pathname.
  function applyActiveNav(pathname) {
    const map = {
      "/": "home", "/index.html": "home",
      "/tools": "tools",
      "/activity": "activity",
      "/settings": "settings",
    };
    const want = map[pathname] || "home";
    const items = document.querySelectorAll(".nav-item[data-nav]");
    items.forEach((n) => {
      n.classList.toggle("active", n.dataset.nav === want);
    });
  }

  // Off-home pages don't need the live stat strip / health pill — clear them
  // so they don't show stale data, but keep the chrome present.
  function blankStatStrip() {
    const stats = document.querySelectorAll("[data-stat]");
    stats.forEach((n) => { n.textContent = "—"; });
    const label = document.getElementById("health-label");
    if (label) label.textContent = "Read-only";
    const pill = document.getElementById("health-pill");
    if (pill) pill.classList.remove("warn", "err");
  }

  // Off-home pages also don't have live pool data → clear the slot-list
  // sections so they don't show "—" forever.
  function blankSidebarLists() {
    for (const id of ["nav-active-list", "nav-idle-list", "nav-attention-list"]) {
      const node = document.getElementById(id);
      if (node) clearChildren(node);
    }
    for (const id of ["nav-active-count", "nav-idle-count", "nav-attention-count"]) {
      const node = document.getElementById(id);
      if (node) node.textContent = "—";
    }
  }

  // Route a slot detail page. Refresh sidebar (so slot links highlight)
  // before mounting the detail view.
  async function refreshSlotSidebar() {
    try {
      const status = await fetchJson("/api/status");
      renderSidebar(status);
    } catch {
      // Sidebar can stay empty if status fails — page still renders.
    }
  }

  function route() {
    const main = document.getElementById("main");
    if (!main) return;
    const pathname = location.pathname;
    applyActiveNav(pathname);

    // Per-slot detail page. /slot/:n where :n is a positive integer.
    const slotMatch = pathname.match(/^\/slot\/(.+)$/);
    if (slotMatch) {
      const n = parseInt(slotMatch[1], 10);
      if (!Number.isInteger(n) || n < 1 || String(n) !== slotMatch[1]) {
        location.replace("/");
        return;
      }
      blankStatStrip();
      // Sidebar still shows pool slots — refresh it so this slot is highlighted.
      refreshSlotSidebar();
      renderSlotDetail(main, n);
      return;
    }

    if (pathname === "/settings") {
      blankStatStrip();
      blankSidebarLists();
      renderSettings(main);
    } else if (pathname === "/tools") {
      blankStatStrip();
      blankSidebarLists();
      renderTools(main);
    } else if (pathname === "/activity") {
      blankStatStrip();
      blankSidebarLists();
      renderActivity(main);
    } else {
      renderHome(main);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindControls();
    route();
  });
})();
