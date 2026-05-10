const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Vault, loadVaultFromEnv, parseCsv, hostFromUrl, registrableDomain } =
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

// ─────────────────────── registrableDomain ───────────────────────────

test("registrableDomain: single-suffix TLD returns last 2 labels", () => {
  assert.strictEqual(registrableDomain("ebay.com"), "ebay.com");
  assert.strictEqual(registrableDomain("signin.ebay.com"), "ebay.com");
  assert.strictEqual(registrableDomain("a.b.c.example.org"), "example.org");
});

test("registrableDomain: double-suffix TLD returns last 3 labels", () => {
  assert.strictEqual(registrableDomain("foo.co.uk"), "foo.co.uk");
  assert.strictEqual(registrableDomain("signin.foo.co.uk"), "foo.co.uk");
  assert.strictEqual(registrableDomain("example.com.au"), "example.com.au");
  assert.strictEqual(registrableDomain("login.example.com.au"), "example.com.au");
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

test("Vault: single file loads entries indexed by host + registrable", () => {
  const csv = "name,url,username,password,note\n" +
    "ebay,https://signin.ebay.com/login,alice,pw1,\n" +
    "amazon,https://www.amazon.com/,bob,pw2,note";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    assert.strictEqual(v.totalEntries, 2);
    assert.strictEqual(v.byHost.get("signin.ebay.com").length, 1);
    assert.strictEqual(v.byHost.get("www.amazon.com").length, 1);
    assert.strictEqual(v.byRegistrable.get("ebay.com").length, 1);
    assert.strictEqual(v.byRegistrable.get("amazon.com").length, 1);
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
    assert.ok(v.byHost.has("d.com"));
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

test("Vault.lookup: registrable-domain fallback when exact host miss", () => {
  const csv = "name,url,username,password,note\n,https://www.ebay.com/,bob,pw,\n";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    // Stored under www.ebay.com; lookup against signin.ebay.com falls back
    // to ebay.com registrable domain.
    const r = v.lookup("https://signin.ebay.com/login");
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].username, "bob");
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

test("loadVaultFromEnv: env unset → empty vault (DEFAULT_FILES is empty)", () => {
  const orig = process.env.BROWSER_RELAY_VAULT_FILES;
  delete process.env.BROWSER_RELAY_VAULT_FILES;
  try {
    const v = loadVaultFromEnv();
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
    const v = loadVaultFromEnv();
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
    const v = loadVaultFromEnv();
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
// W0-5: lookup tags entries with `_match` so the autofill-injector can
// distinguish exact-host matches from registrable-fallback matches.
// Cross-subdomain leak prevention.
// ──────────────────────────────────────────────────────────────────

test("W0-5: lookup tags exact-host matches with _match='exact'", () => {
  const csv =
    "name,url,username,password,note\n" +
    "Foo,https://signin.amazon.com,alice,pwd,\n";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    const m = v.lookup("https://signin.amazon.com/login");
    assert.strictEqual(m.length, 1);
    assert.strictEqual(m[0]._match, "exact");
  } finally {
    fs.unlinkSync(f);
  }
});

test("W0-5: lookup tags registrable-fallback matches with _match='registrable'", () => {
  const csv =
    "name,url,username,password,note\n" +
    "AWS,https://aws.amazon.com,aws-user,pwd,\n" +
    "Audible,https://www.audible.com.amazon.com,audible-user,pwd,\n";
  const f = tmpFile(csv);
  try {
    const v = new Vault([f]);
    // Query for signin.amazon.com — no exact match → falls back to
    // registrable amazon.com → both stored entries surface.
    const m = v.lookup("https://signin.amazon.com/ap/signin");
    assert.ok(m.length >= 1, "registrable fallback must return ≥1 candidate");
    for (const c of m) {
      assert.strictEqual(c._match, "registrable",
        "fallback candidates must be tagged registrable so autofill can decide whether to skip");
    }
  } finally {
    fs.unlinkSync(f);
  }
});
