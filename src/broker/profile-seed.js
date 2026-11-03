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
// live profile copies inconsistently), one a legacy relay holds (its Brave
// may start any moment; and a de-elevated broker can't read an elevated
// Brave's command line, so the lock is the reliable sign). The copy lands in
// a temp dir next to the target and is renamed into place: a crash mid-copy
// never leaves a half profile that counts as "exists".
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

const toPath = (root, rel) => path.join(root, ...rel.split("/"));
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/**
 * The pool slot to seed from: the freshest Default/Network/Cookies among the
 * slots nothing is using.
 * @param {{poolDirs: string[], braveCommands: string[], isSlotClaimed: (dir: string) => boolean}} opts
 * @returns {{dir: string|null, cookiesMtimeMs?: number, skipped: Array<{dir: string, why: string}>}}
 */
function pickSeedSource({ poolDirs, braveCommands, isSlotClaimed }) {
  const { userDataDirMatcher } = require("../pool-shared.js");
  const skipped = [];
  let best = null;
  for (const dir of poolDirs) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(path.join(dir, ...COOKIES)).mtimeMs;
    } catch {
      skipped.push({ dir, why: "no Default/Network/Cookies" });
      continue;
    }
    const matches = userDataDirMatcher(dir);
    if (braveCommands.some(matches)) skipped.push({ dir, why: "Brave is running on it" });
    else if (isSlotClaimed(dir)) skipped.push({ dir, why: "a legacy relay holds it" });
    else if (!best || mtimeMs > best.cookiesMtimeMs) best = { dir, cookiesMtimeMs: mtimeMs };
  }
  return { dir: best ? best.dir : null, cookiesMtimeMs: best ? best.cookiesMtimeMs : undefined, skipped };
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
 * What a seed from `src` copies: files [{rel, size}] and their total, plus
 * the excluded dirs present [{rel, bytes?}] (bytes only with measureExcluded:
 * a cache can be many files). rel uses "/".
 */
async function planSeed(src, { measureExcluded = false } = {}) {
  const files = [];
  const excluded = [];
  async function walk(rel) {
    let entries;
    try {
      entries = await fsp.readdir(toPath(src, rel), { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") return;
      throw e;
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (EXCLUDED.includes(r.toLowerCase())) excluded.push(measureExcluded ? { rel: r, bytes: await dirBytes(toPath(src, r)) } : { rel: r });
        else await walk(r);
      } else if (e.isFile()) {
        files.push({ rel: r, size: (await fsp.stat(toPath(src, r))).size });
      }
    }
  }
  await walk("Default");
  try {
    files.push({ rel: "Local State", size: (await fsp.stat(path.join(src, "Local State"))).size });
  } catch { /* no Local State: cookies then can't be decrypted, but there's nothing to copy */ }
  return { files, bytes: files.reduce((a, f) => a + f.size, 0), excluded };
}

/**
 * Copy planSeed(src) into the new profile dir `dst` (must not exist).
 * @param {{copyFile?: (from: string, to: string) => Promise<void>}} [opts] — test seam
 * @returns {Promise<{files: number, bytes: number}>}
 */
async function copySeed(src, dst, { copyFile = fsp.copyFile } = {}) {
  if (fs.existsSync(dst)) throw new Error(`${dst} already exists`);
  const plan = await planSeed(src);
  const tmp = `${dst}.seeding-${process.pid}`;
  await fsp.rm(tmp, { recursive: true, force: true });
  try {
    await fsp.mkdir(tmp, { recursive: true, mode: 0o700 });
    for (const f of plan.files) {
      const to = toPath(tmp, f.rel);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await copyFile(toPath(src, f.rel), to);
    }
    await fsp.rename(tmp, dst);
  } catch (e) {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
  return { files: plan.files.length, bytes: plan.bytes };
}

function defaultListBraveCommands(pool) {
  const { listProcessesByCommand } = require("../process-shim.js");
  return listProcessesByCommand(pool.braveNeedle(process.platform)).map((p) => p.command);
}

function defaultIsSlotClaimed(pool) {
  return (dir) => {
    const lock = pool.readLockState(path.join(dir, ".mcp-wrapper-lock"));
    return Boolean(lock && lock.state !== "dead");
  };
}

/**
 * The broker's first start: seed `profileDir` if it doesn't exist and a pool
 * slot qualifies. Never throws; logs the source used (or why none was).
 * @returns {Promise<{from: string, files: number, bytes: number}|null>}
 */
async function seedOnFirstStart({ profileDir, log, pool = require("../pool-shared.js"), listBraveCommands, isSlotClaimed, copyFile }) {
  if (fs.existsSync(profileDir)) return null;
  const poolDirs = pool.CONFIG.standalone ? [] : pool.CONFIG.poolDirs;
  if (!poolDirs.length) {
    log(`broker profile ${profileDir}: fresh profile (no legacy pool to seed it from)`);
    return null;
  }
  try {
    const braveCommands = listBraveCommands ? listBraveCommands() : defaultListBraveCommands(pool);
    const pick = pickSeedSource({ poolDirs, braveCommands, isSlotClaimed: isSlotClaimed || defaultIsSlotClaimed(pool) });
    for (const s of pick.skipped) log(`broker profile seed: not using ${s.dir} (${s.why})`);
    if (!pick.dir) {
      log(`broker profile ${profileDir}: fresh profile (no idle pool slot with cookies)`);
      return null;
    }
    log(`broker profile: seeding ${profileDir} once from ${pick.dir} (cookies written ${new Date(pick.cookiesMtimeMs).toISOString()})`);
    const t0 = Date.now();
    try {
      const r = await copySeed(pick.dir, profileDir, { copyFile });
      log(`broker profile: seeded ${r.files} files (${mb(r.bytes)} MB) from ${pick.dir} in ${Date.now() - t0} ms`);
      return { from: pick.dir, ...r };
    } catch (e) {
      log(`broker profile: seeding from ${pick.dir} failed (${e.message}); starting with a fresh profile ` +
        `(to retry: npm run broker:stop, delete ${profileDir}, npm run migrate-profile)`);
      return null;
    }
  } catch (e) {
    log(`broker profile: could not look for a pool slot to seed from (${e.message}); fresh profile`);
    return null;
  }
}

module.exports = { pickSeedSource, planSeed, copySeed, seedOnFirstStart, EXCLUDED };
