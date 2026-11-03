// profile-seed.js — the broker profile's one-time seed (v0.4, owner decision).
//
// The broker keeps ONE persistent Brave profile. On its first start (the
// profile dir doesn't exist yet) it is seeded once from the legacy pool slot
// whose cookies were written most recently, so existing logins carry over;
// from then on Brave itself keeps that profile current. Standalone installs
// (no pool) start with a fresh profile.
//
// Copied: `Default/` minus caches and the last session's tabs, plus `Local
// State` (it holds the cookie key, DPAPI-wrapped for this same user). Nothing
// else at the top level (shader caches, crash dumps, locks). The source is
// only read. Skipped sources: a slot without cookies, one Brave runs on (a
// live profile copies inconsistently), one a live legacy relay holds (its
// Brave may start any moment; and a de-elevated broker can't read an
// elevated Brave's command line, so the lock is the reliable sign). The copy
// lands in a temp dir next to the target and is renamed into place: a crash
// mid-copy never leaves a half profile that counts as "exists".
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
const COPY_PARALLEL = 12;

const toPath = (root, rel) => path.join(root, ...rel.split("/"));

/** The legacy pool slots (pool-shared's config); none in standalone mode. */
function poolCandidates(pool = require("../pool-shared.js")) {
  return pool.CONFIG.standalone ? [] : pool.CONFIG.poolDirs.slice();
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
 * The slot to seed from: the freshest Default/Network/Cookies among `dirs`
 * that no Brave runs on and no live legacy relay holds (pool-shared's lock
 * rules: a recycled PID's lock is stale). Cookies are stat'ed first; the
 * process probes run only if some slot has cookies.
 * @returns {Promise<{dir: string|null, cookiesMtimeMs?: number, skipped: Array<{dir: string, why: string}>}>}
 */
async function findSeedSource({ pool = require("../pool-shared.js"), dirs = poolCandidates(pool), probes = defaultProbes(pool) } = {}) {
  const stats = await Promise.all(dirs.map((dir) => fsp.stat(path.join(dir, ...COOKIES)).then((s) => s.mtimeMs, () => null)));
  const skipped = [];
  const withCookies = [];
  dirs.forEach((dir, i) => {
    if (stats[i] === null) skipped.push({ dir, why: "no Default/Network/Cookies" });
    else withCookies.push({ dir, cookiesMtimeMs: stats[i] });
  });
  if (!withCookies.length) return { dir: null, skipped };
  withCookies.sort((a, b) => b.cookiesMtimeMs - a.cookiesMtimeMs);

  const commands = await probes.braveCommands();
  const locks = new Map(withCookies.map(({ dir }) => [dir, pool.readLockState(path.join(dir, pool.WRAPPER_LOCK))]));
  const livePids = [...locks.values()].filter((l) => l && l.state === "alive").map((l) => l.meta.pid);
  const startTimes = livePids.length ? await probes.startTimes(livePids) : new Map();
  for (const { dir, cookiesMtimeMs } of withCookies) {
    const lock = locks.get(dir);
    if (commands.some(pool.userDataDirMatcher(dir))) skipped.push({ dir, why: "Brave is running on it" });
    else if (lock && (lock.state === "young" || (lock.state === "alive" && pool.isLockOwnerAlive(lock.meta, { startTimes })))) {
      skipped.push({ dir, why: "a legacy relay holds it" });
    } else return { dir, cookiesMtimeMs, skipped };
  }
  return { dir: null, skipped };
}

/**
 * What a seed from `src` copies, without stat'ing every file: files and the
 * dirs that hold them (rel, "/"-separated), and the excluded dirs present.
 */
async function listSeed(src) {
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
      }
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
 * mkdir per dir, then COPY_PARALLEL files at a time.
 * @param {{copyFile?: (from: string, to: string) => Promise<void>}} [opts] — test seam
 * @returns {Promise<{files: number}>}
 */
async function copySeed(src, dst, { copyFile = fsp.copyFile } = {}) {
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
    await fsp.rename(tmp, dst);
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { files: files.length };
}

/**
 * The broker's first start: seed `profileDir` if it doesn't exist and a pool
 * slot qualifies. Never throws; logs the source used (or why none was).
 * @returns {Promise<{from: string, files: number}|null>}
 */
async function seedOnFirstStart({ profileDir, log, pool = require("../pool-shared.js"), probes, copyFile }) {
  if (fs.existsSync(profileDir)) return null;
  const dirs = poolCandidates(pool);
  if (!dirs.length) {
    log(`broker profile ${profileDir}: fresh profile (no legacy pool to seed it from)`);
    return null;
  }
  let from = null;
  try {
    const pick = await findSeedSource({ pool, dirs, probes: probes || defaultProbes(pool) });
    for (const s of pick.skipped) log(`broker profile seed: not using ${s.dir} (${s.why})`);
    if (!pick.dir) {
      log(`broker profile ${profileDir}: fresh profile (no idle pool slot with cookies)`);
      return null;
    }
    from = pick.dir;
    log(`broker profile: seeding ${profileDir} once from ${from} (cookies written ${new Date(pick.cookiesMtimeMs).toISOString()})`);
    const t0 = Date.now();
    const r = await copySeed(from, profileDir, { copyFile });
    log(`broker profile: seeded ${r.files} files from ${from} in ${Date.now() - t0} ms`);
    return { from, ...r };
  } catch (e) {
    log(`broker profile: seeding${from ? ` from ${from}` : ""} failed (${e.message}); starting with a fresh profile ` +
      `(to retry: npm run broker:stop, delete ${profileDir}, npm run migrate-profile)`);
    return null;
  }
}

module.exports = { poolCandidates, findSeedSource, listSeed, planSeed, copySeed, seedOnFirstStart, EXCLUDED };
