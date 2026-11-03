// vault.js — credential vault loader.
//
// Reads Brave/Chrome password CSV exports (header: name,url,username,password,note)
// and indexes entries by https origin for exact-match lookup during autofill.
//
// OFF BY DEFAULT. The vault only loads when BROWSER_RELAY_VAULT_FILES (env
// var, or the same key in local-config.json) is set to one or more
// path-delimiter-separated absolute paths. When unset (or empty), the vault
// initializes empty and autofill becomes a no-op.
//
// Loaded once at relay startup. Stays in memory only — never re-written to
// disk by the relay. Password values are never logged to stderr/stdout.
//
// Security note: password values are kept in memory only — never logged,
// never re-written. But: only point this at CSVs you trust. Anyone with
// read access to your relay process's memory could read them.

const fs = require("node:fs");
const { applyLocalConfigToEnv } = require("./local-config.js");

// Empty by default — friend must explicitly opt in via env var.
const DEFAULT_FILES = [];

/** Minimal CSV parser. Handles quoted fields with embedded commas / quotes /
 *  newlines per RFC 4180. Returns an array of row objects keyed by header. */
function parseCsv(text) {
  const rows = [];
  let i = 0;
  const n = text.length;
  function readField() {
    let s = "";
    if (text[i] === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++; break;
        }
        s += text[i++];
      }
    } else {
      while (i < n && text[i] !== "," && text[i] !== "\r" && text[i] !== "\n") s += text[i++];
    }
    return s;
  }
  function readRow() {
    const row = [];
    while (i < n) {
      row.push(readField());
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "\r") i++;
      if (text[i] === "\n") { i++; break; }
      if (i >= n) break;
    }
    return row;
  }
  const header = readRow();
  while (i < n) {
    const row = readRow();
    if (row.length === 1 && row[0] === "") continue; // blank line
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = row[j] ?? "";
    rows.push(obj);
  }
  return rows;
}

/** Extract hostname from a URL string. Returns lowercase host or null. */
function hostFromUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** Origin ("https://host[:port]") of an https URL; null for any other
 *  scheme or an unparseable URL. Autofill matches on exactly this. */
function httpsOrigin(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? u.origin : null;
  } catch { return null; }
}

class Vault {
  constructor(files = DEFAULT_FILES) {
    // W1E-5: https origin -> [creds]. Only https entries are fillable.
    this.byOrigin = new Map();
    this.hosts = new Set(); // for the summary count
    this.totalEntries = 0;
    this.filesLoaded = [];
    this.filesSkipped = [];
    for (const f of files) {
      try {
        if (!fs.existsSync(f)) { this.filesSkipped.push({ path: f, reason: "not found" }); continue; }
        let text = fs.readFileSync(f, "utf8");
        // W0-4: strip UTF-8 BOM. Brave/Chrome on Windows often exports CSVs
        // with a leading U+FEFF. Without this strip, the FIRST header column
        // becomes "﻿name" instead of "name", and EVERY row's r.name is
        // empty. If `url` is the first column on some Brave version, the
        // entire vault would silently load empty.
        if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
        const rows = parseCsv(text);
        for (const r of rows) {
          if (!r.url || !r.username || !r.password) continue;
          const host = hostFromUrl(r.url);
          if (!host) continue;
          const entry = { url: r.url, username: r.username, password: r.password, name: r.name || "", note: r.note || "" };
          this.hosts.add(host);
          const origin = httpsOrigin(r.url);
          if (origin) {
            if (!this.byOrigin.has(origin)) this.byOrigin.set(origin, []);
            this.byOrigin.get(origin).push(entry);
          }
          this.totalEntries++;
        }
        this.filesLoaded.push({ path: f, entries: rows.length });
      } catch (e) {
        this.filesSkipped.push({ path: f, reason: e.message });
      }
    }
  }

  /** Look up creds for a URL. Returns array of {username,password,...}
   *  entries (copies).
   *
   *  W1E-5 (2026-11-03): exact scheme+host+port match, HTTPS only — the
   *  same rule Chromium applies before filling without a user gesture.
   *  No subdomain / registrable-domain fallback: the old last-two-labels
   *  guess gave mycompany.atlassian.net's password to evil.atlassian.net
   *  (a multi-tenant suffix the heuristic can't know about; a real PSL
   *  isn't a dependency here). An http:// page, or an entry saved for
   *  http://, never matches. */
  lookup(url) {
    const origin = httpsOrigin(url);
    if (!origin) return [];
    return (this.byOrigin.get(origin) || []).map((e) => ({ ...e }));
  }

  /** Diagnostic summary, safe to log (no password values). */
  summary() {
    return {
      totalEntries: this.totalEntries,
      uniqueHosts: this.hosts.size,
      filesLoaded: this.filesLoaded,
      filesSkipped: this.filesSkipped,
    };
  }
}

// Most recent vault loadVaultFromEnv built in this process. The in-process
// inspector reports this one instead of re-parsing the CSVs on every
// status poll (W1E-2).
let loadedVault = null;

/** The vault loadVaultFromEnv last built in this process, or null. */
function getLoadedVault() {
  return loadedVault;
}

/** Build the vault from BROWSER_RELAY_VAULT_FILES.
 *
 *  W1E-4 (2026-11-03): reads the local-config-merged env, so the key
 *  documented in local-config.example.json works (a set env var still
 *  wins). It used to read process.env only and silently ignore the file.
 *
 *  @param {object} [opts]
 *  @param {NodeJS.ProcessEnv} [opts.env=process.env]
 *  @param {string} [opts.localConfigPath] — test seam: local-config.json path */
function loadVaultFromEnv({ env = process.env, localConfigPath } = {}) {
  const merged = applyLocalConfigToEnv(env, localConfigPath ? { path: localConfigPath } : {});
  loadedVault = buildVaultFromEnv(merged);
  return loadedVault;
}

/** Same inputs as loadVaultFromEnv, but returns only the summary (counts +
 *  file list, no credentials) and doesn't become the loaded vault — the
 *  parsed entries are dropped. For the standalone inspector (W1E V1-4). */
function summarizeVaultFromEnv({ env = process.env, localConfigPath } = {}) {
  const merged = applyLocalConfigToEnv(env, localConfigPath ? { path: localConfigPath } : {});
  return buildVaultFromEnv(merged).summary();
}

function buildVaultFromEnv(env) {
  const envVal = env.BROWSER_RELAY_VAULT_FILES;
  // Unset OR empty string → empty vault (autofill becomes a no-op).
  if (envVal === undefined || envVal === "") return new Vault([]);
  // F0-1 (2026-05-10): use the platform's native PATH delimiter. Node's
  // `path.delimiter` is `;` on Windows and `:` on POSIX — matches user
  // muscle-memory from PATH. Windows path `C:\foo` doesn't get
  // mis-split because `path.delimiter` is `;` there.
  // Previously this was hardcoded `;` which meant Mac/Linux users typing
  // the natural `:`-separated form got ONE non-existent "file" with the
  // whole string and silently empty vault.
  const path = require("node:path");
  const files = envVal.split(path.delimiter).map((s) => s.trim()).filter(Boolean);
  return new Vault(files);
}

module.exports = { Vault, loadVaultFromEnv, summarizeVaultFromEnv, getLoadedVault, parseCsv, hostFromUrl, httpsOrigin };
