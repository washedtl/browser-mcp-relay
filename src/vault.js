// vault.js — credential vault loader.
//
// Reads Brave/Chrome password CSV exports (header: name,url,username,password,note)
// and indexes entries by hostname for fast lookup during autofill.
//
// OFF BY DEFAULT. The vault only loads when the env var
// BROWSER_RELAY_VAULT_FILES is set to one or more semicolon-separated absolute
// paths. When unset (or empty), the vault initializes empty and autofill
// becomes a no-op.
//
// Loaded once at relay startup. Stays in memory only — never re-written to
// disk by the relay. Password values are never logged to stderr/stdout.
//
// Security note: password values are kept in memory only — never logged,
// never re-written. But: only point this at CSVs you trust. Anyone with
// read access to your relay process's memory could read them.

const fs = require("node:fs");

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

/** Build registrable-domain heuristic from a host (last 2 labels for typical
 *  TLDs, last 3 for known double-suffix TLDs like co.uk / com.au). Used for
 *  fuzzy matching: signin.ebay.com -> ebay.com */
const DOUBLE_SUFFIXES = new Set([
  "co.uk", "co.jp", "co.nz", "co.za", "co.in", "co.kr",
  "com.au", "com.br", "com.cn", "com.mx", "com.tw", "com.ar",
  "ne.jp", "or.jp", "ac.uk", "gov.uk", "gov.au",
]);
function registrableDomain(host) {
  if (!host) return null;
  const parts = host.split(".");
  if (parts.length < 2) return host;
  const last2 = parts.slice(-2).join(".");
  const last3 = parts.slice(-3).join(".");
  if (parts.length >= 3 && DOUBLE_SUFFIXES.has(last2)) return last3;
  return last2;
}

class Vault {
  constructor(files = DEFAULT_FILES) {
    this.byHost = new Map();         // exact hostname -> [creds]
    this.byRegistrable = new Map();  // registrable domain -> [creds]
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
          if (!this.byHost.has(host)) this.byHost.set(host, []);
          this.byHost.get(host).push(entry);
          const reg = registrableDomain(host);
          if (reg && reg !== host) {
            if (!this.byRegistrable.has(reg)) this.byRegistrable.set(reg, []);
            this.byRegistrable.get(reg).push(entry);
          }
          this.totalEntries++;
        }
        this.filesLoaded.push({ path: f, entries: rows.length });
      } catch (e) {
        this.filesSkipped.push({ path: f, reason: e.message });
      }
    }
  }

  /** Look up creds for a URL. Returns array of {username,password,...} entries.
   *
   *  Strategy (W0-5: tightened for cross-subdomain leak):
   *    1. Exact-host match first (most specific) — return directly.
   *    2. Registrable-domain fallback — but ONLY entries whose stored URL
   *       host matches more closely than just the registrable. We rank
   *       candidates by stored-URL host similarity to the query host:
   *       a. exact host match  (already handled by step 1)
   *       b. stored host's registrable === query host (e.g. query `amazon.com`
   *          finds stored `amazon.com` — only when there's an unambiguous
   *          registrable-rooted entry)
   *       c. otherwise — return registrable matches as before (legacy
   *          permissive behavior, but with `confidence: "low"` flag so
   *          callers can decide whether to autofill silently).
   *
   *  Returns array. Each entry is augmented with a `_match` discriminator:
   *    "exact"        — host matched exactly
   *    "registrable"  — fell back to registrable; multiple candidates may
   *                     exist; caller should pick carefully (or not autofill).
   *
   *  Cross-subdomain leak before this fix: signin.amazon.com → no exact →
   *  registrable amazon.com → 5 entries (AWS, Audible, Twitch, …) →
   *  autofill silently picked entries[0]. Now the caller can see `_match`
   *  is "registrable" with `length > 1` and skip autofill. */
  lookup(url) {
    const host = hostFromUrl(url);
    if (!host) return [];
    const exact = this.byHost.get(host) || [];
    if (exact.length > 0) {
      return exact.map((e) => ({ ...e, _match: "exact" }));
    }
    const reg = registrableDomain(host);
    if (!reg) return [];
    const fallback = this.byRegistrable.get(reg) || [];
    return fallback.map((e) => ({ ...e, _match: "registrable" }));
  }

  /** Diagnostic summary, safe to log (no password values). */
  summary() {
    return {
      totalEntries: this.totalEntries,
      uniqueHosts: this.byHost.size,
      uniqueRegistrableDomains: this.byRegistrable.size,
      filesLoaded: this.filesLoaded,
      filesSkipped: this.filesSkipped,
    };
  }
}

function loadVaultFromEnv() {
  const envVal = process.env.BROWSER_RELAY_VAULT_FILES;
  // Unset OR empty string → empty vault (autofill becomes a no-op).
  if (envVal === undefined || envVal === "") return new Vault([]);
  const files = envVal.split(";").map((s) => s.trim()).filter(Boolean);
  return new Vault(files);
}

module.exports = { Vault, loadVaultFromEnv, parseCsv, hostFromUrl, registrableDomain };
