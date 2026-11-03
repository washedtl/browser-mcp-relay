// profile-seed.test.js — W2E: the broker profile is seeded once, from the
// legacy pool slot with the freshest cookies.
//
// Fake pool dirs only (mkdtemp): nothing here reads a real profile. The lock
// rules are pool-shared's own (real functions, fake dirs).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const seed = require("../src/broker/profile-seed.js");
const pool = require("../src/pool-shared.js");

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
  if (cookies) {
    const c = path.join(dir, "Default", "Network", "Cookies");
    write(c, `cookies-${label}`);
    const t = (Date.now() - ageMs) / 1000;
    fs.utimesSync(c, t, t);
  }
  return dir;
}

/** pool-shared's functions over fake slots. */
const fakePool = (poolDirs, { standalone = false } = {}) => ({ ...pool, CONFIG: { poolDirs, standalone } });
/** Probes that must not run, or fixed answers. */
const noProbes = { braveCommands: async () => { throw new Error("must not list processes"); }, startTimes: async () => { throw new Error("must not probe"); } };
const probes = (commands = [], startTimes = new Map()) => ({ braveCommands: async () => commands, startTimes: async () => startTimes });

function lockSlot(dir, meta) {
  fs.writeFileSync(path.join(dir, pool.WRAPPER_LOCK), JSON.stringify({ host: "h", relay: true, ...meta }));
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

test("findSeedSource: the slot whose Default/Network/Cookies was written most recently", async () => {
  const old = fakeSlot("old", { ageMs: 3 * 86400e3 });
  const fresh = fakeSlot("fresh", { ageMs: 60e3 });
  const none = fakeSlot("nocookies", { cookies: false });
  const r = await seed.findSeedSource({ pool: fakePool([]), dirs: [old, none, fresh], probes: probes() });
  assert.strictEqual(r.dir, fresh);
  assert.ok(Math.abs(r.cookiesMtimeMs - (Date.now() - 60e3)) < 5000);
  assert.deepStrictEqual(r.skipped.map((s) => [s.dir, s.why]), [[none, "no Default/Network/Cookies"]]);
});

test("findSeedSource: no slot with cookies → no process probes at all", async () => {
  const r = await seed.findSeedSource({ pool: fakePool([]), dirs: [fakeSlot("nc", { cookies: false }), tmp("missing")], probes: noProbes });
  assert.strictEqual(r.dir, null);
  assert.strictEqual(r.skipped.length, 2);
});

test("findSeedSource: a slot with a running Brave (exact --user-data-dir) or a live relay's lock is skipped", async () => {
  const busy = fakeSlot("busy", { ageMs: 1e3 });
  const claimed = fakeSlot("claimed", { ageMs: 2e3 });
  const idle = fakeSlot("idle", { ageMs: 86400e3 });
  lockSlot(claimed, { pid: process.pid, startedAt: new Date().toISOString() });
  const commands = [
    `"C:\\brave.exe" --type=renderer --user-data-dir="${busy}" --foo`,
    `"C:\\brave.exe" --user-data-dir=${idle}-other`, // a different dir that merely starts the same
  ];
  const r = await seed.findSeedSource({ pool: fakePool([]), dirs: [busy, claimed, idle], probes: probes(commands, new Map([[process.pid, Date.now() - 60e3]])) });
  assert.strictEqual(r.dir, idle);
  assert.deepStrictEqual(r.skipped.map((s) => s.why), ["Brave is running on it", "a legacy relay holds it"]);
});

test("findSeedSource: pool-shared's lock rules — a dead or recycled PID's lock doesn't block the slot", async () => {
  const dead = fakeSlot("deadlock", { ageMs: 1e3 });
  lockSlot(dead, { pid: 999999999, startedAt: new Date().toISOString() });
  assert.strictEqual((await seed.findSeedSource({ pool: fakePool([]), dirs: [dead], probes: probes() })).dir, dead);
  const recycled = fakeSlot("recycled", { ageMs: 1e3 });
  // the lock was written a year ago; this PID's process started now: a recycled PID
  lockSlot(recycled, { pid: process.pid, startedAt: new Date(Date.now() - 365 * 86400e3).toISOString() });
  const r = await seed.findSeedSource({ pool: fakePool([]), dirs: [recycled], probes: probes([], new Map([[process.pid, Date.now()]])) });
  assert.strictEqual(r.dir, recycled);
});

test("poolCandidates: pool-shared's slots; none in standalone mode", () => {
  assert.deepStrictEqual(seed.poolCandidates(fakePool(["/a", "/b"])), ["/a", "/b"]);
  assert.deepStrictEqual(seed.poolCandidates(fakePool(["/repo/.browser-data"], { standalone: true })), []);
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
  assert.deepStrictEqual(r, { files: 5 });
  assert.deepStrictEqual(snapshot(src), before, "source untouched");
  assert.deepStrictEqual(fs.readdirSync(path.dirname(dst)), ["profile"], "no temp dir left behind");
});

test("copySeed: copies in parallel, but bounded", async () => {
  const src = fakeSlot("many");
  for (let i = 0; i < 60; i++) write(path.join(src, "Default", "IndexedDB", `f${i}`), String(i));
  let active = 0;
  let max = 0;
  const copyFile = async (a, b) => {
    max = Math.max(max, ++active);
    await new Promise((r) => setTimeout(r, 2));
    await fs.promises.copyFile(a, b);
    active--;
  };
  const r = await seed.copySeed(src, path.join(tmp("par"), "profile"), { copyFile });
  assert.strictEqual(r.files, 65);
  assert.ok(max > 1 && max <= 16, `max parallel copies ${max}`);
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

test("seedOnFirstStart: an existing profile is left alone (nothing listed, nothing read)", async () => {
  const profileDir = tmp("existing-profile");
  fs.mkdirSync(profileDir);
  const logs = [];
  const r = await seed.seedOnFirstStart({ profileDir, log: (m) => logs.push(m), pool: fakePool([fakeSlot("ignored")]), probes: noProbes });
  assert.strictEqual(r, null);
  assert.deepStrictEqual(logs, []);
});

test("seedOnFirstStart: standalone (no pool) → a fresh profile, said once in the log", async () => {
  const logs = [];
  const r = await seed.seedOnFirstStart({
    profileDir: path.join(tmp("p"), "profile"),
    log: (m) => logs.push(m),
    pool: fakePool([tmp("repo-browser-data")], { standalone: true }),
    probes: noProbes,
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
  const r = await seed.seedOnFirstStart({ profileDir, log: (m) => logs.push(m), pool: fakePool([a, b]), probes: probes([`brave.exe --user-data-dir="${b}"`]) });
  assert.strictEqual(r.from, a);
  assert.strictEqual(fs.readFileSync(path.join(profileDir, "Default", "Network", "Cookies"), "utf8"), "cookies-pa");
  assert.ok(logs.some((l) => l.includes(a) && /seed/i.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => l.includes(b) && /running/i.test(l)), "why the fresher slot was skipped");
  // second start: the profile exists now
  assert.strictEqual(await seed.seedOnFirstStart({ profileDir, log: () => {}, pool: fakePool([a]), probes: noProbes }), null);
});

test("seedOnFirstStart: a failed copy or probe is logged and the broker starts with a fresh profile", async () => {
  const a = fakeSlot("pf");
  for (const [label, opts] of [
    ["copy", { probes: probes(), copyFile: async () => { throw new Error("EACCES: permission denied"); } }],
    ["probe", { probes: { braveCommands: async () => { throw new Error("powershell failed"); }, startTimes: async () => new Map() } }],
  ]) {
    const profileDir = path.join(tmp(`p-${label}`), "profile");
    const logs = [];
    const r = await seed.seedOnFirstStart({ profileDir, log: (m) => logs.push(m), pool: fakePool([a]), ...opts });
    assert.strictEqual(r, null);
    assert.strictEqual(fs.existsSync(profileDir), false);
    assert.ok(logs.some((l) => /EACCES|powershell failed/.test(l) && /fresh/i.test(l)), logs.join("\n"));
  }
});
