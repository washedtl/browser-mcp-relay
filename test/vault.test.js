const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Vault, loadVaultFromEnv, summarizeVaultFromEnv, getLoadedVault, parseCsv, hostFromUrl, httpsOrigin } =
  require("../src/vault.js");

// ───────────────────────────── parseCsv ──────────────────────────────

test("parseCsv: basic header + rows", () => {
  const text = "name,url,username,password,note\nfoo,https://a.com,u,p,\nbar,https://b.com,u2,p2,n";
  const rows = parseCsv(text);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].name, "foo");
  assert.strictEqual(rows[0].url, "https://a.com");
  assert.strictEqual(rows[1].password, "p2");
});

test("parseCsv: quoted fields with embedded commas", () => {
  const text = `name,url,username,password,note\n"a, b",https://a.com,u,p,"x, y"`;
  const rows = parseCsv(text);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, "a, b");
  assert.strictEqual(rows[0].note, "x, y");
});

test("parseCsv: quoted fields with embedded newlines", () => {
  const text = `name,url,username,password,note\n"line1\nline2",https://a.com,u,p,n`;
  const rows = parseCsv(text);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, "line1\nline2");
});

test("parseCsv: doubled quotes escape to single quote (RFC 4180)", () => {
  const text = `name,url,username,password,note\n"he said ""hi""",https://a.com,u,p,n`;
  const rows = parseCsv(text);
  assert.strictEqual(rows[0].name, 'he said "hi"');
});

test("parseCsv: blank lines are skipped", () => {
  const text = "name,url,username,password,note\nfoo,https://a.com,u,p,\n\nbar,https://b.com,u2,p2,n\n";
  const rows = parseCsv(text);
  assert.strictEqual(rows.length, 2);
});

// ───────────────────────────── hostFromUrl ───────────────────────────

test("hostFromUrl: valid URL returns lowercase host", () => {
  assert.strictEqual(hostFromUrl("https://Example.COM/path"), "example.com");
});

test("hostFromUrl: invalid URL returns null", () => {
  assert.strictEqual(hostFromUrl("not a url"), null);
  assert.strictEqual(hostFromUrl(""), null);
});

// ─────────────────────────── httpsOrigin ─────────────────────────────

test("httpsOrigin: https URL → scheme+host+port origin (default port dropped, host lower-cased)", () => {
  assert.strictEqual(httpsOrigin("https://Example.COM/login?x=1"), "https://example.com");
  assert.strictEqual(httpsOrigin("https://example.com:443/"), "https://example.com");
  assert.strictEqual(httpsOrigin("https://example.com:8443/a"), "https://example.com:8443");
});

test("httpsOrigin: non-https or unparseable → null", () => {
  assert.strictEqual(httpsOrigin("http://example.com/"), null);
  assert.strictEqual(httpsOrigin("android://hash@com.example.app/"), null);
  assert.strictEqual(httpsOrigin("not a url"), null);
  assert.strictEqual(httpsOrigin(""), null);
});

// ─────────────────────────────── Vault ───────────────────────────────

function tmpFile(contents) {
  const p = path.join(os.tmpdir(), `vault-test-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
  fs.writeFileSync(p, contents);
  return p;
}

test("Vault: empty file list → totalEntries=0, summary safe", () => {
  const v = new Vault([]);
  assert.strictEqual(v.totalEntries, 0);
  const s = v.summary();
  assert.strictEqual(s.totalEntries, 0);
  assert.strictEqual(s.uniqueHosts, 0);
  assert.deepStrictEqual(s.filesLoaded, []);
});

test("Vault: single file loads entries indexed by https origin", () => {
  const csv = "name,url,username,password,note\n" +
    "ebay,https://signin.ebay.com/login,alice,pw1,\n" +
    "amazon,https://www.amazon.com/,bob,pw2,note";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    assert.strictEqual(v.totalEntries, 2);
    assert.strictEqual(v.byOrigin.get("https://signin.ebay.com").length, 1);
    assert.strictEqual(v.byOrigin.get("https://www.amazon.com").length, 1);
    assert.strictEqual(v.summary().uniqueHosts, 2);
  } finally {
    fs.unlinkSync(f);
  }
});

test("Vault: multiple files merge, missing file is recorded as skipped", () => {
  const csv1 = "name,url,username,password,note\n,https://a.com,u1,p1,\n";
  const csv2 = "name,url,username,password,note\n,https://b.com,u2,p2,\n";
  const f1 = tmpFile(csv1);
  const f2 = tmpFile(csv2);
  const missing = path.join(os.tmpdir(), `nonexistent-${Date.now()}.csv`);
  try {
    const v = new Vault([f1, f2, missing]);
    assert.strictEqual(v.totalEntries, 2);
    assert.strictEqual(v.filesLoaded.length, 2);
    assert.strictEqual(v.filesSkipped.length, 1);
    assert.strictEqual(v.filesSkipped[0].reason, "not found");
  } finally {
    fs.unlinkSync(f1);
    fs.unlinkSync(f2);
  }
});

test("Vault: malformed rows (missing url/username/password) are skipped", () => {
  const csv = "name,url,username,password,note\n" +
    ",https://a.com,,p1,\n" +     // missing username
    ",https://b.com,u2,,\n" +     // missing password
    ",,u3,p3,\n" +                // missing url
    ",https://d.com,u4,p4,\n";    // valid
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    assert.strictEqual(v.totalEntries, 1);
    assert.strictEqual(v.lookup("https://d.com/").length, 1);
  } finally {
    fs.unlinkSync(f);
  }
});

// ─────────────────────────── Vault.lookup ────────────────────────────

test("Vault.lookup: exact host match", () => {
  const csv = "name,url,username,password,note\n,https://signin.ebay.com/,alice,pw,\n";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    const r = v.lookup("https://signin.ebay.com/login");
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].username, "alice");
  } finally {
    fs.unlinkSync(f);
  }
});

test("Vault.lookup: no fallback to a sibling subdomain (exact origin only)", () => {
  const csv = "name,url,username,password,note\n,https://www.ebay.com/,bob,pw,\n";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    // Stored under www.ebay.com; signin.ebay.com is a different origin.
    assert.deepStrictEqual(v.lookup("https://signin.ebay.com/login"), []);
  } finally {
    fs.unlinkSync(f);
  }
});

test("Vault.lookup: no match returns empty array", () => {
  const csv = "name,url,username,password,note\n,https://a.com,u,p,\n";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    assert.deepStrictEqual(v.lookup("https://notfound.example.org/"), []);
    assert.deepStrictEqual(v.lookup("not a url"), []);
  } finally {
    fs.unlinkSync(f);
  }
});

// ─────────────────────────── Vault.summary ───────────────────────────

test("Vault.summary: never includes password values", () => {
  const csv = "name,url,username,password,note\n,https://a.com,alice,supersecret,\n";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    const s = v.summary();
    const json = JSON.stringify(s);
    assert.ok(!json.includes("supersecret"), "summary leaked password");
    assert.ok(!json.includes("alice"), "summary leaked username");
  } finally {
    fs.unlinkSync(f);
  }
});

// ──────────────────────── loadVaultFromEnv ───────────────────────────

// Hermetic: never layer the developer's real local-config.json (which may
// point at real password exports) under these env-driven tests.
const NO_LOCAL_CONFIG = path.join(os.tmpdir(), `no-local-config-${process.pid}.json`);

test("loadVaultFromEnv: env unset → empty vault (DEFAULT_FILES is empty)", () => {
  const orig = process.env.BROWSER_RELAY_VAULT_FILES;
  delete process.env.BROWSER_RELAY_VAULT_FILES;
  try {
    const v = loadVaultFromEnv({ localConfigPath: NO_LOCAL_CONFIG });
    assert.strictEqual(v.totalEntries, 0);
    assert.deepStrictEqual(v.filesLoaded, []);
    assert.deepStrictEqual(v.filesSkipped, []);
  } finally {
    if (orig !== undefined) process.env.BROWSER_RELAY_VAULT_FILES = orig;
  }
});

test("loadVaultFromEnv: env empty string → explicitly disabled (empty vault)", () => {
  const orig = process.env.BROWSER_RELAY_VAULT_FILES;
  process.env.BROWSER_RELAY_VAULT_FILES = "";
  try {
    const v = loadVaultFromEnv({ localConfigPath: NO_LOCAL_CONFIG });
    assert.strictEqual(v.totalEntries, 0);
  } finally {
    if (orig === undefined) delete process.env.BROWSER_RELAY_VAULT_FILES;
    else process.env.BROWSER_RELAY_VAULT_FILES = orig;
  }
});

test("loadVaultFromEnv: env semicolon-separated paths loads each file", () => {
  const csv1 = "name,url,username,password,note\n,https://a.com,u1,p1,\n";
  const csv2 = "name,url,username,password,note\n,https://b.com,u2,p2,\n";
  const f1 = tmpFile(csv1);
  const f2 = tmpFile(csv2);
  const orig = process.env.BROWSER_RELAY_VAULT_FILES;
  process.env.BROWSER_RELAY_VAULT_FILES = `${f1};${f2}`;
  try {
    const v = loadVaultFromEnv({ localConfigPath: NO_LOCAL_CONFIG });
    assert.strictEqual(v.totalEntries, 2);
    assert.strictEqual(v.filesLoaded.length, 2);
  } finally {
    fs.unlinkSync(f1);
    fs.unlinkSync(f2);
    if (orig === undefined) delete process.env.BROWSER_RELAY_VAULT_FILES;
    else process.env.BROWSER_RELAY_VAULT_FILES = orig;
  }
});

// ──────────────────────────────────────────────────────────────────
// W0-4: CSV with UTF-8 BOM at file start. Brave/Chrome on Windows
// often exports CSVs with BOM; without strip the first column header
// becomes "﻿name" → first column is silently dropped from every
// row. If `url` is the first column on some Brave version, the entire
// vault would silently load empty.
// ──────────────────────────────────────────────────────────────────

test("W0-4: Vault strips UTF-8 BOM from CSV file", () => {
  const csvWithBom =
    "﻿" + // BOM
    "name,url,username,password,note\n" +
    "Test,https://example.com,alice,pwd,\n";
  const f = tmpFile(csvWithBom);
  try {
    const v = new Vault([f]);
    assert.strictEqual(v.totalEntries, 1, "entry must load despite BOM");
    const matches = v.lookup("https://example.com/login");
    assert.strictEqual(matches.length, 1, "lookup must find the entry — header row was correctly parsed despite BOM");
    assert.strictEqual(matches[0].username, "alice");
    // The `name` field must also have been read correctly (was empty pre-W0-4 because header became "﻿name").
    assert.strictEqual(matches[0].name, "Test", "first-column value must be preserved");
  } finally {
    fs.unlinkSync(f);
  }
});

// ──────────────────────────────────────────────────────────────────
// W1E-5 (2026-11-03): autofill credentials match on exact
// scheme+host+port, HTTPS only. The old last-two-labels "registrable"
// fallback handed mycompany.atlassian.net's password to
// evil.atlassian.net (atlassian.net is a multi-tenant suffix), and http://
// pages matched https:// entries by hostname alone.
// ──────────────────────────────────────────────────────────────────

test("W1E-5: lookalike tenant on a shared suffix gets nothing", () => {
  const f = tmpFile("name,url,username,password,note\n,https://mycompany.atlassian.net/login,alice,pw,\n");
  try {
    const v = new Vault([f]);
    assert.deepStrictEqual(v.lookup("https://evil.atlassian.net/login"), []);
    assert.strictEqual(v.lookup("https://mycompany.atlassian.net/wiki").length, 1);
  } finally {
    fs.unlinkSync(f);
  }
});

test("W1E-5: http:// page never matches, even for the same host", () => {
  const f = tmpFile("name,url,username,password,note\n,https://example.com/login,alice,pw,\n");
  try {
    const v = new Vault([f]);
    assert.deepStrictEqual(v.lookup("http://example.com/login"), []);
  } finally {
    fs.unlinkSync(f);
  }
});

test("W1E-5: an http:// vault entry is never used", () => {
  const f = tmpFile("name,url,username,password,note\n,http://example.com/login,alice,pw,\n");
  try {
    const v = new Vault([f]);
    assert.strictEqual(v.totalEntries, 1, "still counted as a loaded entry");
    assert.deepStrictEqual(v.lookup("https://example.com/login"), []);
    assert.deepStrictEqual(v.lookup("http://example.com/login"), []);
  } finally {
    fs.unlinkSync(f);
  }
});

test("W1E-5: port is part of the match", () => {
  const f = tmpFile("name,url,username,password,note\n,https://example.com:8443/,alice,pw,\n");
  try {
    const v = new Vault([f]);
    assert.deepStrictEqual(v.lookup("https://example.com/"), []);
    assert.strictEqual(v.lookup("https://example.com:8443/login").length, 1);
  } finally {
    fs.unlinkSync(f);
  }
});

test("W1E-5: matching ignores path and host case; summary has no registrable index", () => {
  const f = tmpFile("name,url,username,password,note\n,https://Accounts.Example.com/signin/v2,alice,pw,\n");
  try {
    const v = new Vault([f]);
    const m = v.lookup("https://accounts.example.com/other/path?q=1");
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0].username, "alice");
    assert.strictEqual(v.summary().uniqueRegistrableDomains, undefined);
  } finally {
    fs.unlinkSync(f);
  }
});

// ──────────────────────────────────────────────────────────────────
// W1E-4 (2026-11-03): the vault reads the local-config-merged env.
// local-config.json documents BROWSER_RELAY_VAULT_FILES, but the loader
// read process.env only, so the documented key was silently ignored.
// ──────────────────────────────────────────────────────────────────

function tmpLocalConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-localcfg-"));
  const cfgPath = path.join(dir, "local-config.json");
  fs.writeFileSync(cfgPath, JSON.stringify(obj));
  return { dir, cfgPath };
}

test("W1E-4: loadVaultFromEnv honours BROWSER_RELAY_VAULT_FILES from local-config.json", () => {
  const csv = tmpFile("name,url,username,password,note\n,https://a.example,u1,p1,\n");
  const { dir, cfgPath } = tmpLocalConfig({ BROWSER_RELAY_VAULT_FILES: csv });
  try {
    const v = loadVaultFromEnv({ env: {}, localConfigPath: cfgPath });
    assert.strictEqual(v.totalEntries, 1);
    assert.strictEqual(v.filesLoaded.length, 1);
  } finally {
    fs.unlinkSync(csv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1E-4: a set env var still wins over local-config.json", () => {
  const fromEnv = tmpFile("name,url,username,password,note\n,https://a.example,u1,p1,\n,https://b.example,u2,p2,\n");
  const fromCfg = tmpFile("name,url,username,password,note\n,https://c.example,u3,p3,\n");
  const { dir, cfgPath } = tmpLocalConfig({ BROWSER_RELAY_VAULT_FILES: fromCfg });
  try {
    const v = loadVaultFromEnv({ env: { BROWSER_RELAY_VAULT_FILES: fromEnv }, localConfigPath: cfgPath });
    assert.strictEqual(v.totalEntries, 2);
  } finally {
    fs.unlinkSync(fromEnv);
    fs.unlinkSync(fromCfg);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1E V1-4: summarizeVaultFromEnv returns counts only and doesn't become the loaded vault", () => {
  const csv = tmpFile("name,url,username,password,note\n,https://a.example,alice,fake-secret,\n");
  const { dir, cfgPath } = tmpLocalConfig({});
  try {
    const before = getLoadedVault();
    const s = summarizeVaultFromEnv({ env: { BROWSER_RELAY_VAULT_FILES: csv }, localConfigPath: cfgPath });
    assert.strictEqual(s.totalEntries, 1);
    assert.strictEqual(s.filesLoaded.length, 1);
    assert.ok(!JSON.stringify(s).includes("fake-secret"));
    assert.strictEqual(typeof s.lookup, "undefined", "a summary, not a vault");
    assert.strictEqual(getLoadedVault(), before, "must not replace the relay's loaded vault");
  } finally {
    fs.unlinkSync(csv);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
