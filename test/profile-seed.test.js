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
const dirsOf = (r) => r.candidates.map((c) => c.dir);

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

test("findSeedSource: candidates freshest Default/Network/Cookies first", async () => {
  const old = fakeSlot("old", { ageMs: 3 * 86400e3 });
  const fresh = fakeSlot("fresh", { ageMs: 60e3 });
  const none = fakeSlot("nocookies", { cookies: false });
  const r = await seed.findSeedSource({ pool: fakePool([]), dirs: [old, none, fresh], probes: probes() });
  assert.deepStrictEqual(dirsOf(r), [fresh, old]);
  assert.ok(Math.abs(r.candidates[0].cookiesMtimeMs - (Date.now() - 60e3)) < 5000);
  assert.deepStrictEqual(r.skipped.map((s) => [s.dir, s.why]), [[none, "no Default/Network/Cookies"]]);
});

test("findSeedSource: no slot left after the cookie + lockfile checks → no process probes at all", async () => {
  const running = fakeSlot("lockfile");
  write(path.join(running, "lockfile"), "");
  const r = await seed.findSeedSource({ pool: fakePool([]), dirs: [fakeSlot("nc", { cookies: false }), tmp("missing"), running], probes: noProbes });
  assert.deepStrictEqual(r.candidates, []);
  assert.deepStrictEqual(r.skipped.map((s) => s.why), ["no Default/Network/Cookies", "no Default/Network/Cookies", "Brave is running on it (its lockfile is present)"]);
});

test("findSeedSource: a running Brave (exact --user-data-dir) or a live relay's lock is skipped", async () => {
  const busy = fakeSlot("busy", { ageMs: 1e3 });
  const claimed = fakeSlot("claimed", { ageMs: 2e3 });
  const idle = fakeSlot("idle", { ageMs: 86400e3 });
  lockSlot(claimed, { pid: process.pid, startedAt: new Date().toISOString() });
  const commands = [
    `"C:\\brave.exe" --type=renderer --user-data-dir="${busy}" --foo`,
    `"C:\\brave.exe" --user-data-dir=${idle}-other`, // a different dir that merely starts the same
  ];
  const r = await seed.findSeedSource({ pool: fakePool([]), dirs: [busy, claimed, idle], probes: probes(commands, new Map([[process.pid, Date.now() - 60e3]])) });
  assert.deepStrictEqual(dirsOf(r), [idle]);
  assert.deepStrictEqual(r.skipped.map((s) => s.why), ["Brave is running on it", "a legacy relay holds it"]);
});

test("findSeedSource: pool-shared's lock rules — a dead or recycled PID's lock doesn't block the slot (handed over to be cleared)", async () => {
  const dead = fakeSlot("deadlock", { ageMs: 1e3 });
  lockSlot(dead, { pid: 999999999, startedAt: new Date().toISOString() });
  const r1 = await seed.findSeedSource({ pool: fakePool([]), dirs: [dead], probes: probes() });
  assert.deepStrictEqual(dirsOf(r1), [dead]);
  assert.match(r1.candidates[0].staleLockRaw, /999999999/);
  const recycled = fakeSlot("recycled", { ageMs: 1e3 });
  // the lock was written a year ago; this PID's process started now: a recycled PID
  lockSlot(recycled, { pid: process.pid, startedAt: new Date(Date.now() - 365 * 86400e3).toISOString() });
  const r2 = await seed.findSeedSource({ pool: fakePool([]), dirs: [recycled], probes: probes([], new Map([[process.pid, Date.now()]])) });
  assert.deepStrictEqual(dirsOf(r2), [recycled]);
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

test("copySeed: the final rename is retried on EPERM (AV / indexer), then given up", async () => {
  const src = fakeSlot("eperm");
  let tries = 0;
  const flaky = async (a, b) => {
    if (++tries < 3) throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
    return fs.promises.rename(a, b);
  };
  const dst = path.join(tmp("eperm-ok"), "profile");
  assert.deepStrictEqual(await seed.copySeed(src, dst, { rename: flaky }), { files: 5 });
  assert.strictEqual(tries, 3);
  const parent = tmp("eperm-never");
  await assert.rejects(seed.copySeed(src, path.join(parent, "profile"), { rename: async () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); } }), /EPERM/);
  assert.deepStrictEqual(fs.readdirSync(parent), [], "temp dir removed");
});

test("V2-b: a source whose Default or Local State is a symlink / junction is refused (it could point anywhere)", async () => {
  const outside = tmp("outside");
  write(path.join(outside, "Network", "Cookies"), "x");
  write(path.join(outside, "secret.txt"), "TOP SECRET");
  const linked = tmp("linked-default");
  fs.mkdirSync(linked);
  fs.symlinkSync(outside, path.join(linked, "Default"), "junction");
  await assert.rejects(seed.copySeed(linked, path.join(tmp("dst-link"), "profile")), /refusing .*Default.*symlink or junction/);
  await assert.rejects(seed.planSeed(linked), /symlink or junction/);

  const linkedState = fakeSlot("linked-state");
  fs.rmSync(path.join(linkedState, "Local State"));
  write(path.join(outside, "state.json"), "{}");
  try {
    fs.symlinkSync(path.join(outside, "state.json"), path.join(linkedState, "Local State"), "file");
  } catch (e) {
    if (e.code !== "EPERM") throw e; // file symlinks need a privilege on Windows: Default covers the rule
    return;
  }
  await assert.rejects(seed.copySeed(linkedState, path.join(tmp("dst-link2"), "profile")), /Local State.*symlink or junction/);
});

test("V2-a: the slot's relay lock is held (by this process, no reap) for the whole copy, then released; a stale lock is cleared first", async () => {
  const slot = fakeSlot("locked");
  lockSlot(slot, { pid: 999999999, startedAt: new Date().toISOString() }); // a dead relay's
  const { candidates } = await seed.findSeedSource({ pool: fakePool([]), dirs: [slot], probes: probes() });
  const seen = [];
  const copyFile = async (a, b) => {
    seen.push(JSON.parse(fs.readFileSync(path.join(slot, pool.WRAPPER_LOCK), "utf8")).pid);
    return fs.promises.copyFile(a, b);
  };
  const dst = path.join(tmp("dst-locked"), "profile");
  await seed.copyFromSlot(fakePool([slot]), candidates[0], dst, { copyFile });
  assert.ok(seen.length === 5 && seen.every((pid) => pid === process.pid), `lock held by us during every copy: ${seen}`);
  assert.strictEqual(fs.existsSync(path.join(slot, pool.WRAPPER_LOCK)), false, "released after");
});

test("V2-a: a slot a relay claimed after it was picked is not copied", async () => {
  const slot = fakeSlot("raced");
  const { candidates } = await seed.findSeedSource({ pool: fakePool([]), dirs: [slot], probes: probes() });
  lockSlot(slot, { pid: process.pid, startedAt: new Date().toISOString() }); // a relay claims it now
  const dst = path.join(tmp("dst-raced"), "profile");
  await assert.rejects(seed.copyFromSlot(fakePool([slot]), candidates[0], dst), /claimed it meanwhile/);
  assert.strictEqual(fs.existsSync(dst), false);
});

test("V1-3: a source that changes during the copy (cookies written, Brave started) is discarded for the next slot", async () => {
  const fresh = fakeSlot("changes", { ageMs: 1e3 });
  const older = fakeSlot("steady", { ageMs: 60e3 });
  let calls = 0;
  const copyFile = async (a, b) => {
    if (++calls === 2 && a.startsWith(fresh)) write(path.join(fresh, "lockfile"), ""); // a Brave starts on it mid-copy
    return fs.promises.copyFile(a, b);
  };
  const profileDir = path.join(tmp("p-change"), "profile");
  const logs = [];
  const r = await seed.seedOnFirstStart({ profileDir, log: (m) => logs.push(m), pool: fakePool([fresh, older]), probes: probes(), copyFile });
  assert.strictEqual(r.from, older);
  assert.strictEqual(fs.readFileSync(path.join(profileDir, "Default", "Network", "Cookies"), "utf8"), "cookies-steady");
  assert.ok(logs.some((l) => l.includes(fresh) && /changed during the copy/.test(l)), logs.join("\n"));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(profileDir)), ["profile"], "the discarded copy left nothing");
  assert.strictEqual(fs.existsSync(path.join(fresh, pool.WRAPPER_LOCK)), false, "its lock was released too");
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

test("seedOnFirstStart: an unfinished seed by a dead process is removed; a live one's is left", async () => {
  const parent = tmp("orphans");
  fs.mkdirSync(path.join(parent, "profile"), { recursive: true });
  write(path.join(parent, "profile.seeding-999999999", "Default", "x"), "half");
  write(path.join(parent, `profile.seeding-${process.pid}`, "Default", "x"), "in progress");
  const logs = [];
  await seed.seedOnFirstStart({ profileDir: path.join(parent, "profile"), log: (m) => logs.push(m), pool: fakePool([]), probes: noProbes });
  assert.deepStrictEqual(fs.readdirSync(parent).sort(), ["profile", `profile.seeding-${process.pid}`]);
  assert.ok(logs.some((l) => /profile\.seeding-999999999/.test(l)), logs.join("\n"));
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
    assert.ok(logs.some((l) => /EACCES|powershell failed/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /fresh profile/i.test(l)), logs.join("\n"));
  }
});
