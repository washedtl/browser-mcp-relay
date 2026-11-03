// profile-seed.test.js — W2E: the broker profile is seeded once, from the
// legacy pool slot with the freshest cookies.
//
// Fake pool dirs only (mkdtemp): nothing here reads a real profile.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const seed = require("../src/broker/profile-seed.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-seed-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const tmp = (label) => path.join(root, `${label}-${++n}`);

function write(file, content = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A fake pool slot: profile files, caches, and cookies written `ageMs` ago. */
function fakeSlot(label, { ageMs = 0, cookies = true } = {}) {
  const dir = tmp(label);
  write(path.join(dir, "Local State"), JSON.stringify({ os_crypt: { encrypted_key: `key-${label}` } }));
  write(path.join(dir, "Default", "Preferences"), "{}");
  write(path.join(dir, "Default", "Local Storage", "leveldb", "000003.log"), `ls-${label}`);
  write(path.join(dir, "Default", "Cache", "Cache_Data", "data_0"), "c".repeat(5000));
  write(path.join(dir, "Default", "Code Cache", "js", "index"), "c");
  write(path.join(dir, "Default", "GPUCache", "data_1"), "c");
  write(path.join(dir, "Default", "Service Worker", "CacheStorage", "abc", "index"), "c");
  write(path.join(dir, "Default", "Service Worker", "Database", "MANIFEST-000001"), "sw-db");
  write(path.join(dir, "Default", "Sessions", "Tabs_1"), "old tabs");
  write(path.join(dir, "GrShaderCache", "data_0"), "c"); // top level: never copied
  write(path.join(dir, "component_crx_cache", "x.crx"), "c");
  write(path.join(dir, ".mcp-wrapper-lock-unrelated"), "c");
  if (cookies) {
    const c = path.join(dir, "Default", "Network", "Cookies");
    write(c, `cookies-${label}`);
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(c, t, t);
  }
  return dir;
}

function listTree(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

const snapshot = (dir) => listTree(dir).map((r) => [r, fs.statSync(path.join(dir, r)).mtimeMs, fs.readFileSync(path.join(dir, r), "utf8")]);

// ───────────────────────────── picking the source ─────────────────────────────

test("pickSeedSource: the slot whose Default/Network/Cookies was written most recently", () => {
  const old = fakeSlot("old", { ageMs: 3 * 86400e3 });
  const fresh = fakeSlot("fresh", { ageMs: 60e3 });
  const none = fakeSlot("nocookies", { cookies: false });
  const r = seed.pickSeedSource({ poolDirs: [old, none, fresh], braveCommands: [], isSlotClaimed: () => false });
  assert.strictEqual(r.dir, fresh);
  assert.ok(Math.abs(r.cookiesMtimeMs - (Date.now() - 60e3)) < 5000);
  assert.deepStrictEqual(r.skipped.map((s) => [s.dir, s.why]), [[none, "no Default/Network/Cookies"]]);
});

test("pickSeedSource: a slot with a running Brave (exact --user-data-dir) or a live lock owner is skipped", () => {
  const busy = fakeSlot("busy", { ageMs: 1e3 });
  const claimed = fakeSlot("claimed", { ageMs: 2e3 });
  const idle = fakeSlot("idle", { ageMs: 86400e3 });
  const commands = [
    `"C:\\brave.exe" --type=renderer --user-data-dir="${busy}" --foo`,
    `"C:\\brave.exe" --user-data-dir=${idle}-other`, // a different dir that merely starts the same
  ];
  const r = seed.pickSeedSource({ poolDirs: [busy, claimed, idle], braveCommands: commands, isSlotClaimed: (d) => d === claimed });
  assert.strictEqual(r.dir, idle);
  assert.deepStrictEqual(r.skipped.map((s) => s.why), ["Brave is running on it", "a legacy relay holds it"]);
});

test("pickSeedSource: null when no slot qualifies", () => {
  const busy = fakeSlot("busy2");
  const r = seed.pickSeedSource({ poolDirs: [busy, tmp("missing")], braveCommands: [`brave.exe --user-data-dir=${busy}`], isSlotClaimed: () => false });
  assert.strictEqual(r.dir, null);
  assert.strictEqual(r.skipped.length, 2);
});

// ───────────────────────────── planning + copying ─────────────────────────────

test("planSeed: Default/ minus caches and old sessions, plus Local State; sizes add up", async () => {
  const src = fakeSlot("plan");
  const plan = await seed.planSeed(src, { measureExcluded: true });
  assert.deepStrictEqual(plan.files.map((f) => f.rel).sort(), [
    "Default/Local Storage/leveldb/000003.log",
    "Default/Network/Cookies",
    "Default/Preferences",
    "Default/Service Worker/Database/MANIFEST-000001",
    "Local State",
  ]);
  assert.strictEqual(plan.bytes, plan.files.reduce((a, f) => a + f.size, 0));
  assert.deepStrictEqual(plan.excluded.map((e) => e.rel).sort(), ["Default/Cache", "Default/Code Cache", "Default/GPUCache", "Default/Service Worker/CacheStorage", "Default/Sessions"]);
  assert.ok(plan.excluded.find((e) => e.rel === "Default/Cache").bytes >= 5000);
});

test("copySeed: copies the plan into a new profile dir and never modifies the source", async () => {
  const src = fakeSlot("copy");
  const before = snapshot(src);
  const dst = path.join(tmp("target-parent"), "profile");
  const r = await seed.copySeed(src, dst);
  assert.deepStrictEqual(listTree(dst), (await seed.planSeed(src)).files.map((f) => f.rel).sort());
  assert.strictEqual(fs.readFileSync(path.join(dst, "Default", "Network", "Cookies"), "utf8"), "cookies-copy");
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dst, "Local State"), "utf8")).os_crypt.encrypted_key, "key-copy");
  assert.strictEqual(r.files, 5);
  assert.ok(r.bytes > 0);
  assert.deepStrictEqual(snapshot(src), before, "source untouched");
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dst)), ["profile"], "no temp dir left behind");
});

test("copySeed: refuses an existing target; a failed copy leaves neither target nor temp dir", async () => {
  const src = fakeSlot("fail");
  const existing = tmp("exists");
  fs.mkdirSync(existing);
  await assert.rejects(seed.copySeed(src, existing), /already exists/);

  const parent = tmp("fail-parent");
  const dst = path.join(parent, "profile");
  let calls = 0;
  const copyFile = async (a, b) => {
    if (++calls === 3) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    return fs.promises.copyFile(a, b);
  };
  await assert.rejects(seed.copySeed(src, dst, { copyFile }), /EBUSY/);
  assert.deepStrictEqual(fs.existsSync(parent) ? fs.readdirSync(parent) : [], []);
});

// ───────────────────────────── on the broker's first start ─────────────────────────────

function fakePool(poolDirs, { standalone = false } = {}) {
  return { CONFIG: { poolDirs, standalone }, userDataDirMatcher: require("../src/pool-shared.js").userDataDirMatcher };
}

test("seedOnFirstStart: an existing profile is left alone (nothing listed, nothing read)", async () => {
  const profileDir = tmp("existing-profile");
  fs.mkdirSync(profileDir);
  const logs = [];
  const r = await seed.seedOnFirstStart({
    profileDir,
    log: (m) => logs.push(m),
    pool: fakePool([fakeSlot("ignored")]),
    listBraveCommands: () => { throw new Error("must not list processes"); },
  });
  assert.strictEqual(r, null);
  assert.deepStrictEqual(logs, []);
});

test("seedOnFirstStart: standalone (no pool) → a fresh profile, said once in the log", async () => {
  const logs = [];
  const r = await seed.seedOnFirstStart({
    profileDir: path.join(tmp("p"), "profile"),
    log: (m) => logs.push(m),
    pool: fakePool([tmp("repo-browser-data")], { standalone: true }),
    listBraveCommands: () => { throw new Error("must not list processes"); },
  });
  assert.strictEqual(r, null);
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /fresh profile/i);
});

test("seedOnFirstStart: a pool → seeded once from the freshest idle slot, source logged", async () => {
  const a = fakeSlot("pa", { ageMs: 10e3 });
  const b = fakeSlot("pb", { ageMs: 1e3 }); // freshest, but Brave runs on it
  const profileDir = path.join(tmp("p"), "profile");
  const logs = [];
  const r = await seed.seedOnFirstStart({
    profileDir,
    log: (m) => logs.push(m),
    pool: fakePool([a, b]),
    listBraveCommands: () => [`brave.exe --user-data-dir="${b}"`],
    isSlotClaimed: () => false,
  });
  assert.strictEqual(r.from, a);
  assert.strictEqual(fs.readFileSync(path.join(profileDir, "Default", "Network", "Cookies"), "utf8"), "cookies-pa");
  assert.ok(logs.some((l) => l.includes(a) && /seed/i.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes(b) && /running/i.test(l)), "why the fresher slot was skipped");
  // second start: the profile exists now
  assert.strictEqual(await seed.seedOnFirstStart({ profileDir, log: () => {}, pool: fakePool([a]), listBraveCommands: () => [] }), null);
});

test("seedOnFirstStart: a failed copy is logged and the broker starts with a fresh profile", async () => {
  const a = fakeSlot("pf");
  const profileDir = path.join(tmp("p"), "profile");
  const logs = [];
  const r = await seed.seedOnFirstStart({
    profileDir,
    log: (m) => logs.push(m),
    pool: fakePool([a]),
    listBraveCommands: () => [],
    isSlotClaimed: () => false,
    copyFile: async () => { throw new Error("EACCES: permission denied"); },
  });
  assert.strictEqual(r, null);
  assert.strictEqual(fs.existsSync(profileDir), false);
  assert.ok(logs.some((l) => /EACCES/.test(l) && /fresh/i.test(l)), logs.join("\n"));
});
