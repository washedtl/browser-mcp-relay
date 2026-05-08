// app.js — Inspector frontend (W7 Pool Overview + W8 Settings + Specialty).
//
// Vanilla JS, no build toolchain. Uses createElement + textContent only —
// never innerHTML with dynamic data (XSS prevention even on a localhost UI).
// Auto-refreshes /api/status every 5s on the home page only; Pause toggles.
//
// Routing model: full-page nav (anchor links). On DOMContentLoaded we read
// location.pathname and dispatch to renderHome() / renderSettings() /
// renderSpecialty(). pushState routing is W11.

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

  async function fetchJson(p) {
    const r = await fetch(p, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(p + " → " + r.status);
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
    card.appendChild(el("div", { class: "slot-client" }, "Brave PID " + (slot.pid != null ? slot.pid : "—")));
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

  function renderSpecialtyGridHome(status, gridNode, metaNode) {
    clearChildren(gridNode);
    clearChildren(metaNode);

    const entries = Object.entries(status.specialty || {});
    if (entries.length === 0) {
      gridNode.appendChild(el("div", { class: "empty-msg" }, "No specialty MCPs."));
      return;
    }
    let ready = 0, stale = 0;
    for (const [name, info] of entries) {
      gridNode.appendChild(renderSpecialtyCard(name, info));
      if (info.status === "fresh" || info.status === "ready") ready++;
      else if (info.status === "stale") stale++;
    }
    metaNode.appendChild(el("span", { class: "ok" }, ready + " ready"));
    if (stale > 0) {
      metaNode.appendChild(document.createTextNode(" · "));
      metaNode.appendChild(el("span", { class: "err" }, stale + " stale source"));
    }
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
        el("h2", null, "Specialty MCPs"),
        el("span", { class: "meta", id: "specialty-meta" }),
      ]),
    );
    main.appendChild(el("div", { class: "specialty-grid", id: "specialty-grid" }, [el("div", { class: "empty-msg" }, "Loading specialty MCPs…")]));

    main.appendChild(
      el("div", { class: "section-title" }, [
        el("h2", null, "Vault"),
        el("span", { class: "meta", id: "vault-meta" }),
      ]),
    );
    main.appendChild(el("div", { class: "vault-card", id: "vault-card" }, [el("div", { class: "empty-msg" }, "Loading vault…")]));
  }

  async function refreshHome() {
    try {
      const status = await fetchJson("/api/status");
      renderHeader(status);
      renderSidebar(status);
      renderSlotGrid(status, document.getElementById("slot-grid"), document.getElementById("pool-meta"));
      renderSpecialtyGridHome(status, document.getElementById("specialty-grid"), document.getElementById("specialty-meta"));
      renderVault(status, document.getElementById("vault-card"), document.getElementById("vault-meta"));
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

  function startHomeTimer() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (!paused) refreshHome(); }, REFRESH_MS);
  }

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
  // are obvious — we don't read the user's .claude.json.
  function buildMcpSnippet() {
    return JSON.stringify({
      "browser-devtools-mcp-relay": {
        command: "node",
        args: ["<absolute-path-to-repo>/scripts/wrap-browser-devtools-mcp.js"],
        env: {},
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

  // ─── SPECIALTY (detail) ───────────────────────────────────────────────

  function specialtyDetailCard(item) {
    const card = el("div", { class: "specialty-detail-card" });

    const head = el("div", { class: "specialty-detail-head" }, [
      el("span", { class: "name" }, item.displayName || item.id),
      el("span", { class: "role-chip " + (item.role || "") }, item.role || ""),
      el("span", { class: "specialty-pill " + (item.status || "unknown") }, item.status || "unknown"),
    ]);
    card.appendChild(head);

    if (item.description) {
      card.appendChild(el("div", { class: "specialty-desc" }, item.description));
    }

    if (item.id === "browser-devtools-mcp-2") {
      // Cookie source dedicated subsection
      const block = el("div", { class: "cookie-source-block" });
      block.appendChild(el("span", { class: "label" }, "Cookie source"));
      const profileLine = el("div", null, [
        el("span", { class: "label" }, "Profile · "),
        el("span", { class: "value" }, item.cookieSourceProfile || "—"),
      ]);
      block.appendChild(profileLine);
      const ageClass = item.status === "fresh" ? "fresh" : item.status === "stale" ? "stale" : "";
      block.appendChild(
        el("div", null, [
          el("span", { class: "label" }, "Age · "),
          el("span", { class: "value " + ageClass }, formatCookieAge(item.cookieAgeDays)),
          el("span", { class: "label" }, " · Threshold · "),
          el("span", { class: "value" }, item.thresholdDays + "d"),
        ]),
      );
      card.appendChild(block);
    } else {
      card.appendChild(
        el("div", { class: "standalone-block" }, "Optional · standalone — refer to docs / repo to install + configure separately."),
      );
    }

    // Meta footer with links
    const meta = el("div", { class: "specialty-meta-row" });
    meta.appendChild(
      el("span", null, [
        el("span", { class: "k" }, "Last invocation"),
        document.createTextNode(item.id === "browser-devtools-mcp-2" ? "—" : "—"),
      ]),
    );
    if (item.docsUrl) {
      const a = el("a", { href: item.docsUrl, target: "_blank", rel: "noopener noreferrer" }, "docs");
      meta.appendChild(el("span", null, [el("span", { class: "k" }, "Docs"), a]));
    }
    if (item.sourceRepoUrl) {
      const a = el("a", { href: item.sourceRepoUrl, target: "_blank", rel: "noopener noreferrer" }, "repo");
      meta.appendChild(el("span", null, [el("span", { class: "k" }, "Source"), a]));
    }
    card.appendChild(meta);

    return card;
  }

  async function renderSpecialty(main) {
    clearChildren(main);
    main.appendChild(el("div", { class: "empty-msg" }, "Loading specialty MCPs…"));

    let data;
    try {
      data = await fetchJson("/api/specialty");
    } catch (e) {
      clearChildren(main);
      main.appendChild(el("div", { class: "empty-msg" }, "Failed to load /api/specialty: " + e.message));
      return;
    }

    clearChildren(main);
    main.appendChild(
      el("div", { class: "page-header" }, [
        el("h2", null, "Specialty MCPs"),
        el("span", { class: "page-sub" }, "Auxiliary servers used alongside the relay · read-only"),
      ]),
    );

    const list = el("div", { class: "specialty-list" });
    for (const item of data.items || []) {
      list.appendChild(specialtyDetailCard(item));
    }
    if (!(data.items || []).length) {
      list.appendChild(el("div", { class: "empty-msg" }, "No specialty MCPs registered."));
    }
    main.appendChild(list);
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
    const map = { "/": "home", "/index.html": "home", "/tools": "tools", "/specialty": "specialty", "/settings": "settings" };
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
    for (const id of ["nav-active-count", "nav-idle-count", "nav-attention-count", "nav-specialty-count"]) {
      const node = document.getElementById(id);
      if (node) node.textContent = "—";
    }
  }

  function route() {
    const main = document.getElementById("main");
    if (!main) return;
    const pathname = location.pathname;
    applyActiveNav(pathname);
    if (pathname === "/settings") {
      blankStatStrip();
      blankSidebarLists();
      renderSettings(main);
    } else if (pathname === "/specialty") {
      blankStatStrip();
      blankSidebarLists();
      renderSpecialty(main);
    } else if (pathname === "/tools") {
      blankStatStrip();
      blankSidebarLists();
      renderTools(main);
    } else {
      renderHome(main);
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindControls();
    route();
  });
})();
