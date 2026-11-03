// profile-seed.js — the broker profile's one-time seed (v0.4, owner decision).
//
// The broker keeps ONE persistent Brave profile. On its first start (the
// profile dir doesn't exist yet) it is seeded once from the legacy pool slot
// whose cookies were written most recently, so existing logins carry over;
// from then on Brave itself keeps that profile current. A legacy standalone
// install (v0.3's default) has one slot: its `<repo>/.browser-data`.
//
// Copied: `Default/` minus caches and the last session's tabs, plus `Local
// State` (it holds the cookie key, DPAPI-wrapped for this same user). Nothing
// else at the top level (shader caches, crash dumps, locks). The source is
// only read, and refused when `Default` or `Local State` is a symlink or
// junction (it could point anywhere). Skipped sources: a slot without
// cookies, one Brave runs on (its `lockfile`, which a de-elevated broker
// sees even for an elevated Brave, or its command line), one a live legacy
// relay holds. The slot's relay lock is held for the whole copy, so no
// legacy relay claims and writes it meanwhile, and a source that changed
// anyway (cookies, Local State, a Brave starting) is discarded for the next
// slot. The copy lands in a temp dir next to the target and is renamed into
// place: a crash mid-copy never leaves a half profile that counts as "exists".
//
// Shared with scripts/migrate-profile.js.

"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const COOKIES = ["Default", "Network", "Cookies"];
// Under Default/, compared case-insensitively. Caches rebuild on their own;
// Sessions would reopen the slot's old tabs.
const EXCLUDED = [
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache", "GrShaderCache",
  "GraphiteDawnCache", "ShaderCache", "Service Worker/CacheStorage", "Service Worker/ScriptCache",
  "Shared Dictionary/cache", "component_crx_cache", "extensions_crx_cache", "Sessions",
].map((p) => `Default/${p}`.toLowerCase());
// Chromium's <user-data-dir>/lockfile exists exactly while a Brave runs on it
const LOCKFILE = "lockfile";
const COPY_PARALLEL = 12;
const RENAME_TRIES = 5; // the final rename can hit EPERM while AV / indexing scans the new dir

const toPath = (root, rel) => path.join(root, ...rel.split("/"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The legacy profiles to seed from: pool-shared's slots, or in standalone
 * mode its one dir (`<repo>/.browser-data`, or the per-user cache dir), which
 * a legacy relay claims and locks exactly like a pool slot.
 */
function poolCandidates(pool = require("../pool-shared.js")) {
  return pool.CONFIG.poolDirs.slice();
}

/** The process probes findSeedSource needs, off the event loop (they shell out). */
function defaultProbes(pool) {
  const shim = require("../process-shim.js");
  const opts = (spawn) => (spawn ? { _spawnSync: spawn } : {});
  return {
    braveCommands: async () => (await shim.runProbeAsync((spawn) => shim.listProcessesByCommand(pool.braveNeedle(process.platform), opts(spawn)))).map((p) => p.command),
    startTimes: (pids) => shim.runProbeAsync((spawn) => pool.getProcessStartTimes(pids, opts(spawn))),
  };
}

/**
 * The slots to seed from, freshest Default/Network/Cookies first: those no
 * Brave runs on (lockfile, command line) and no live legacy relay holds
 * (pool-shared's lock rules: a dead or recycled PID's lock is stale, and is
 * returned as staleLockRaw to be cleared before the copy claims the slot).
 * Cookies and lockfiles are stat'ed first; the process probes run only if
 * some slot is still a candidate.
 * @returns {Promise<{candidates: Array<{dir: string, cookiesMtimeMs: number, staleLockRaw: string|null}>, skipped: Array<{dir: string, why: string}>}>}
 */
async function findSeedSource({ pool = require("../pool-shared.js"), dirs = poolCandidates(pool), probes = defaultProbes(pool) } = {}) {
  const stats = await Promise.all(dirs.map((dir) => fsp.stat(path.join(dir, ...COOKIES)).then((s) => s.mtimeMs, () => null)));
  const skipped = [];
  const withCookies = [];
  dirs.forEach((dir, i) => {
    if (stats[i] === null) skipped.push({ dir, why: "no Default/Network/Cookies" });
    else if (fs.existsSync(path.join(dir, LOCKFILE))) skipped.push({ dir, why: "Brave is running on it (its lockfile is present)" });
    else withCookies.push({ dir, cookiesMtimeMs: stats[i] });
  });
  if (!withCookies.length) return { candidates: [], skipped };
  withCookies.sort((a, b) => b.cookiesMtimeMs - a.cookiesMtimeMs);

  const commands = await probes.braveCommands();
  const locks = new Map(withCookies.map(({ dir }) => [dir, pool.readLockState(path.join(dir, pool.WRAPPER_LOCK))]));
  const livePids = [...locks.values()].filter((l) => l && l.state === "alive").map((l) => l.meta.pid);
  const startTimes = livePids.length ? await probes.startTimes(livePids) : new Map();
  const candidates = [];
  for (const { dir, cookiesMtimeMs } of withCookies) {
    const lock = locks.get(dir);
    if (commands.some(pool.userDataDirMatcher(dir))) skipped.push({ dir, why: "Brave is running on it" });
    else if (lock && (lock.state === "young" || (lock.state === "alive" && pool.isLockOwnerAlive(lock.meta, { startTimes })))) {
      skipped.push({ dir, why: "a legacy relay holds it" });
    } else candidates.push({ dir, cookiesMtimeMs, staleLockRaw: lock ? lock.raw : null });
  }
  return { candidates, skipped };
}

const sameFsPath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Refuse a source whose Default or Local State is a symlink / junction: it could point anywhere. */
function refuseLinks(src) {
  const real = fs.realpathSync.native(src);
  for (const name of ["Default", "Local State"]) {
    const p = path.join(src, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    if (st.isSymbolicLink() || !sameFsPath(fs.realpathSync.native(p), path.join(real, name))) {
      throw new Error(`refusing ${p}: it is a symlink or junction`);
    }
  }
}

/**
 * What a seed from `src` copies, without stat'ing every file: files and the
 * dirs that hold them (rel, "/"-separated), and the excluded dirs present.
 */
async function listSeed(src) {
  refuseLinks(src);
  const files = [];
  const dirs = [];
  const excluded = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await fsp.readdir(toPath(src, rel), { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    dirs.push(rel);
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (EXCLUDED.includes(r.toLowerCase())) excluded.push(r);
        else await walk(r);
      } else if (e.isFile()) {
        files.push(r);
      } // links / junctions inside Default are never followed
    }
  }
  await walk("Default");
  if (fs.existsSync(path.join(src, "Local State"))) files.push("Local State");
  return { files, dirs, excluded };
}

async function dirBytes(dir) {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(full);
    else if (e.isFile()) total += (await fsp.stat(full)).size;
  }
  return total;
}

/**
 * listSeed with sizes, for people (migrate-profile): files [{rel, size}],
 * their total, and the excluded dirs [{rel, bytes?}] (bytes only with
 * measureExcluded: a cache can be many files).
 */
async function planSeed(src, { measureExcluded = false } = {}) {
  const list = await listSeed(src);
  const files = await Promise.all(list.files.map(async (rel) => ({ rel, size: (await fsp.stat(toPath(src, rel))).size })));
  const excluded = await Promise.all(list.excluded.map(async (rel) => (measureExcluded ? { rel, bytes: await dirBytes(toPath(src, rel)) } : { rel })));
  return { files, bytes: files.reduce((a, f) => a + f.size, 0), excluded };
}

/**
 * Copy listSeed(src) into the new profile dir `dst` (must not exist): one
 * mkdir per dir, then COPY_PARALLEL files at a time; `check()` runs before
 * the final rename (throw to discard the copy).
 * @param {{copyFile?: Function, rename?: Function, check?: () => void}} [opts] — copyFile / rename: test seams
 * @returns {Promise<{files: number}>}
 */
async function copySeed(src, dst, { copyFile = fsp.copyFile, rename = fsp.rename, check = () => {} } = {}) {
  if (fs.existsSync(dst)) throw new Error(`${dst} already exists`);
  const { files, dirs } = await listSeed(src);
  const tmp = `${dst}.seeding-${process.pid}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  try {
    await fsp.mkdir(tmp, { recursive: true, mode: 0o700 });
    for (const rel of dirs) await fsp.mkdir(toPath(tmp, rel), { recursive: true });
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const rel = files[next++];
        await copyFile(toPath(src, rel), toPath(tmp, rel));
      }
    };
    await Promise.all(Array.from({ length: Math.min(COPY_PARALLEL, files.length) }, worker));
    await check();
    for (let attempt = 1; ; attempt++) {
      try {
        await rename(tmp, dst);
        break;
      } catch (e) {
        if (e.code !== "EPERM" || attempt >= RENAME_TRIES) throw e;
        await sleep(100 * attempt);
      }
    }
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { files: files.length };
}

/** What the copy depends on: Cookies*, Local State and the lockfile (size + mtime, or absent). */
function sourceState(dir) {
  const network = path.join(dir, "Default", "Network");
  let cookieFiles = [];
  try { cookieFiles = fs.readdirSync(network).filter((n) => n.startsWith("Cookies")).map((n) => path.join("Default", "Network", n)); } catch { /* none */ }
  return JSON.stringify(["Local State", LOCKFILE, ...cookieFiles].sort().map((rel) => {
    try {
      const st = fs.statSync(path.join(dir, rel));
      return [rel, st.size, st.mtimeMs];
    } catch {
      return [rel, null];
    }
  }));
}

/**
 * Seed `dst` from one findSeedSource candidate, holding the slot's relay
 * lock for the whole copy; the copy is discarded (and this throws) if the
 * slot changed meanwhile.
 */
async function copyFromSlot(pool, { dir, staleLockRaw }, dst, opts = {}) {
  const lockPath = path.join(dir, pool.WRAPPER_LOCK);
  if (staleLockRaw) pool.clearStaleLock(lockPath, staleLockRaw, "stale; seeding the broker profile from this slot");
  const claim = pool.tryClaimDir(dir, lockPath, { reap: false });
  if (!claim) throw new Error("a legacy relay claimed it meanwhile");
  try {
    const before = sourceState(dir);
    if (fs.existsSync(path.join(dir, LOCKFILE))) throw new Error("a Brave started on it");
    return await copySeed(dir, dst, {
      ...opts,
      check: () => { if (sourceState(dir) !== before) throw new Error("it changed during the copy"); },
    });
  } finally {
    claim.release();
  }
}

/** Remove `<profileDir>.seeding-<pid>` dirs a dead process left behind. */
function removeOrphanSeedingDirs(profileDir, log, isAlive = require("../process-shim.js").isPidAlive) {
  const parent = path.dirname(profileDir);
  const prefix = `${path.basename(profileDir)}.seeding-`;
  let names = [];
  try { names = fs.readdirSync(parent); } catch { return; }
  for (const name of names) {
    const pid = name.startsWith(prefix) ? Number(name.slice(prefix.length)) : NaN;
    if (!Number.isInteger(pid) || isAlive(pid)) continue;
    fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    log(`broker profile: removed ${name}, an unfinished seed by a process that is gone`);
  }
}

/**
 * The broker's first start: seed `profileDir` if it doesn't exist and a pool
 * slot qualifies (the next one if a copy fails). Never throws; logs the
 * source used (or why none was).
 * @returns {Promise<{from: string, files: number}|null>}
 */
async function seedOnFirstStart({ profileDir, log, pool = require("../pool-shared.js"), probes, copyFile }) {
  try {
    removeOrphanSeedingDirs(profileDir, log);
    if (fs.existsSync(profileDir)) return null;
    const dirs = poolCandidates(pool);
    if (!dirs.length) {
      log(`broker profile ${profileDir}: fresh profile (no legacy pool to seed it from)`);
      return null;
    }
    const { candidates, skipped } = await findSeedSource({ pool, dirs, probes: probes || defaultProbes(pool) });
    for (const s of skipped) log(`broker profile seed: not using ${s.dir} (${s.why})`);
    for (const cand of candidates) {
      log(`broker profile: seeding ${profileDir} once from ${cand.dir} (cookies written ${new Date(cand.cookiesMtimeMs).toISOString()})`);
      const t0 = Date.now();
      try {
        const r = await copyFromSlot(pool, cand, profileDir, { copyFile });
        log(`broker profile: seeded ${r.files} files from ${cand.dir} in ${Date.now() - t0} ms`);
        return { from: cand.dir, ...r };
      } catch (e) {
        log(`broker profile seed: not using ${cand.dir} (${e.message})`);
      }
    }
    log(`broker profile ${profileDir}: fresh profile (no idle pool slot with cookies could be copied)`);
  } catch (e) {
    log(`broker profile: seeding failed (${e.message}); starting with a fresh profile ` +
      `(to retry: npm run broker:stop, delete ${profileDir}, npm run migrate-profile)`);
  }
  return null;
}

module.exports = { poolCandidates, findSeedSource, planSeed, copySeed, copyFromSlot, seedOnFirstStart };
