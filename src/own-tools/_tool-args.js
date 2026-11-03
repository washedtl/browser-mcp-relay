// _tool-args.js — argument + result helpers shared by the data-out own-tools
// (capture_xhr, cookies_export/import, storage_get-local, extract_structured,
// download_capture).
//
// F0-9: null means "omitted" (JSON-RPC clients send unset optionals as null).
//
// File paths: relative paths are rejected — they would resolve against the
// relay process's cwd (wherever the MCP client spawned it), not the agent's
// project directory. Existing files are never replaced silently.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const LEADING_DOUBLE_SEPARATOR = /^[\\/]{2}/;

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * null/undefined → { value: def }. Otherwise the value must be an integer in
 * [min, max] → { value } or { error }.
 */
function intArg(tool, name, value, def, min, max = Infinity) {
  if (value == null) return { value: def };
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Infinity ? `>= ${min}` : `from ${min} to ${max}`;
    return { error: `${tool}: ${name} must be an integer ${range} (got ${JSON.stringify(value)})` };
  }
  return { value };
}

/**
 * Fit `text` within `cap` JSON-escaped characters (what reaches the model:
 * quotes double, control characters become \uXXXX). Returns
 * { text, cost, cut }: `cost` is the real escaped size of `text`; when cut,
 * `text` is the longest prefix that fits with the "...[truncated]" marker
 * (included in cost). Binary search, because escapes are not evenly spread —
 * scaling by the average ratio overshot on front-loaded escapes.
 *
 * Shipped into pages as source text (extract_structured), so it must stay
 * self-contained: no references outside its own body.
 */
function fitJson(text, cap) {
  const whole = JSON.stringify(text).length;
  if (whole <= cap) return { text, cost: whole, cut: false };
  const marker = "...[truncated]";
  const costAt = (n) => JSON.stringify(text.slice(0, n) + marker).length;
  let lo = 0;
  let hi = Math.min(text.length, cap);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (costAt(mid) <= cap) lo = mid;
    else hi = mid - 1;
  }
  const kept = text.slice(0, lo) + marker;
  return { text: kept, cost: JSON.stringify(kept).length, cut: true };
}

/**
 * null/undefined → { path: null } (argument omitted).
 * Otherwise the value must be a non-empty absolute path → { path } or { error }.
 */
function absolutePathArg(tool, name, value) {
  if (value == null) return { path: null };
  if (typeof value !== "string" || value.length === 0) {
    return { error: `${tool}: ${name} must be a non-empty string (got ${JSON.stringify(value)})` };
  }
  if (!path.isAbsolute(value)) {
    return { error: `${tool}: ${name} must be an absolute path (got ${JSON.stringify(value)}); a relative path would resolve against the relay's working directory, not yours` };
  }
  const resolved = path.resolve(value);
  // UNC (\\host\share) and device (\\.\pipe, \\?\) paths would read or write
  // cookies on another machine — and Windows sends the user's NTLM
  // credentials to that host. Only local paths are allowed.
  if (LEADING_DOUBLE_SEPARATOR.test(value) || LEADING_DOUBLE_SEPARATOR.test(resolved)) {
    return { error: `${tool}: ${name} must be a local path; UNC / device / network paths are not allowed (got ${JSON.stringify(value)})` };
  }
  return { path: resolved };
}

/**
 * absolutePathArg for a file the tool will write: also refuses an existing
 * file unless overwrite is set. Checked up front so the agent learns before
 * a capture / download, not after it → { path } or { error }.
 */
function outputPathArg(tool, name, value, overwrite) {
  const out = absolutePathArg(tool, name, value);
  if (out.path && !overwrite && fs.existsSync(out.path)) {
    return { error: `${tool}: ${name} ${out.path} already exists; pass overwrite: true to replace it` };
  }
  return out;
}

// These files can hold cookies and tokens, so NEW files get mode 0600 — on
// POSIX only: on Windows a file inherits its folder's ACL, and an
// overwritten file keeps its existing permissions (mode applies at creation).
const FILE_MODE = 0o600;

/**
 * Create `p` exclusively with `data`, or — if something is already there
 * (a file, or even a dangling symlink) — the first free `name-N.ext` beside
 * it. "wx" makes each attempt atomic, so a file that appeared after the
 * up-front outputPathArg check is never replaced. The lstat skip is for
 * Windows, where "wx" follows a dangling symlink and creates its target.
 * Returns the path written.
 */
async function writeExclusive(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const { dir, name, ext } = path.parse(p);
  for (let i = 0; ; i++) {
    const target = i === 0 ? p : path.join(dir, `${name}-${i}${ext}`);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
    try {
      await fsp.writeFile(target, data, { flag: "wx", mode: FILE_MODE });
      return target;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
}

/**
 * Write `text` to `p` (creating the parent directory) and return
 * { path, bytes } with the path actually written. With overwrite, `p` is
 * replaced in place; without it, a file that appeared mid-call (e.g. during
 * a long capture) is kept and the output goes to a free sibling instead of
 * failing after the work is done.
 */
async function writeOutputFile(p, text, overwrite) {
  let target = p;
  if (overwrite) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, text, { mode: FILE_MODE });
  } else {
    target = await writeExclusive(p, text);
  }
  return { path: target, bytes: Buffer.byteLength(text) };
}

module.exports = { errorResult, intArg, fitJson, absolutePathArg, outputPathArg, writeExclusive, writeOutputFile };
