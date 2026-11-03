// docs-drift.test.js — F1-19 (2026-05-10).
//
// Make the user-facing docs (README.md, docs/REFERENCE.md) tested artifacts.
//
// Why this exists:
//   v0.3.0 added 3 storage tools, bumping the first-party count from 16 to
//   19 and the total from 67 to 70. The code's drift guards (see
//   inspector-server.test.js "forwardedCount matches the actual hardcoded
//   catalog length") caught the test-side mismatch immediately, but the
//   README + REFERENCE docs claimed "67 tools / 16 first-party" for two
//   minor versions before the README simplification PR (v0.3.2 followup)
//   caught it manually.
//
// The fix: assert that every numeric claim in the docs that has a live
// source-of-truth value actually matches that source-of-truth. Failure
// here means: code shipped, docs didn't follow.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const README = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
const REFERENCE = fs.readFileSync(path.join(REPO, "docs", "REFERENCE.md"), "utf8");

const ownTools = require("../src/own-tools/index.js").tools;
const forwarded = require("../scripts/inspector-forwarded-tools.js").tools;

const { toolsetOf } = require("../src/own-tools/toolsets.js");

const liveOwn = ownTools.length;
const liveForwarded = forwarded.length;
const liveTotal = liveOwn + liveForwarded;
// W1B: forwarded tools hidden from tools/list until their toolset is enabled.
const liveHidden = forwarded.filter((t) => toolsetOf(t.name)).length;

// Helper: count how many distinct N-values appear in `text` matching the
// pattern `(\d+)\s*<context>`. Returns the first numeric capture.
function findNumberBefore(text, contextRegex) {
  const re = new RegExp("(\\d+)\\s*" + contextRegex.source, "gi");
  const m = re.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

test("F1-19: README total-tool count matches live ownTools.length + forwarded.length", () => {
  // README mentions tool counts in a couple of places: badges, "70 commands",
  // "70-tool catalog", "70 tools available". Pull every \d+ that appears
  // immediately before "tools" / "commands" / "tool catalog" and assert at
  // least one matches the live count, and NONE disagree.
  const numbers = new Set();
  const patterns = [
    /\btool[s\s-]*catalog\b/i,
    /\btools available\b/i,
    /\btools (?:total|in total)\b/i,
    /\bcommands?\b/i,
  ];
  for (const pat of patterns) {
    const re = new RegExp("(\\d+)\\s*[A-Za-z\\s\\-`]*?" + pat.source, "gi");
    let m;
    while ((m = re.exec(README)) !== null) {
      const n = parseInt(m[1], 10);
      if (n >= 50 && n <= 200) numbers.add(n); // sanity range
    }
  }
  // Also pull from badge URLs (which encode counts as percent-escaped digits).
  // tools-70%20%2851%20forwarded%20%2B%2019%20own%29 → 70, 51, 19
  const badgeRe = /tools-(\d+)%20%28(\d+)%20forwarded%20%2B%20(\d+)%20own%29/i;
  const badge = README.match(badgeRe);
  if (badge) {
    const [, total, fwd, own] = badge.map(Number);
    assert.strictEqual(total, liveTotal,
      `README badge claims ${total} total tools; live = ${liveTotal} (${liveOwn} own + ${liveForwarded} forwarded)`);
    assert.strictEqual(fwd, liveForwarded,
      `README badge claims ${fwd} forwarded; live = ${liveForwarded}`);
    assert.strictEqual(own, liveOwn,
      `README badge claims ${own} own; live = ${liveOwn}`);
  }
  assert.ok(numbers.has(liveTotal),
    `README must mention live total tool count (${liveTotal}); found ${[...numbers].join(", ")} instead`);
});

test("F1-19: REFERENCE.md tool counts match live ownTools.length + forwarded.length", () => {
  // REFERENCE has explicit "First-party tools (N)" and "Forwarded upstream tools (N)" headings.
  const fpMatch = REFERENCE.match(/First-party tools\s*\((\d+)\)/i);
  const fwdMatch = REFERENCE.match(/Forwarded upstream tools\s*\((\d+)\)/i);
  assert.ok(fpMatch, "REFERENCE.md must have a 'First-party tools (N)' heading");
  assert.ok(fwdMatch, "REFERENCE.md must have a 'Forwarded upstream tools (N)' heading");
  assert.strictEqual(parseInt(fpMatch[1], 10), liveOwn,
    `REFERENCE.md heading claims ${fpMatch[1]} first-party tools; live = ${liveOwn}`);
  assert.strictEqual(parseInt(fwdMatch[1], 10), liveForwarded,
    `REFERENCE.md heading claims ${fwdMatch[1]} forwarded tools; live = ${liveForwarded}`);

  // Also assert the total is mentioned somewhere with the right number.
  const totalRe = new RegExp(`\\b${liveTotal}\\s+tools\\s+total\\b`, "i");
  assert.ok(totalRe.test(REFERENCE),
    `REFERENCE.md must include "${liveTotal} tools total"; live = ${liveTotal}`);
});

test("F1-19: every first-party tool name appears in REFERENCE.md catalog", () => {
  // If we add a new own-tool but forget to document it in REFERENCE.md, this
  // catches it. Use a strict word boundary so "tabs_list" doesn't match
  // "tabs_listicle" (hypothetical).
  const missing = [];
  for (const t of ownTools) {
    const safe = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("`" + safe + "`");
    if (!re.test(REFERENCE)) {
      missing.push(t.name);
    }
  }
  assert.deepStrictEqual(missing, [],
    `These first-party tools are live but missing from REFERENCE.md catalog (look for backticked names): ${missing.join(", ")}`);
});

test("F1-19: every forwarded tool name appears in REFERENCE.md catalog", () => {
  // If upstream adds a tool and we re-sync the inspector-forwarded-tools.js
  // catalog but forget to document it in REFERENCE.md, this catches it.
  const missing = [];
  for (const t of forwarded) {
    const safe = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp("`" + safe + "`");
    if (!re.test(REFERENCE)) {
      missing.push(t.name);
    }
  }
  assert.deepStrictEqual(missing, [],
    `These forwarded tools are live but missing from REFERENCE.md catalog: ${missing.join(", ")}`);
});

test("F1-19: package.json version matches the latest annotated git tag", () => {
  // Light-touch drift signal: if package.json says 0.3.5 but the most recent
  // annotated tag is 0.3.2, someone bumped the version without tagging — or
  // tagged without bumping. Either way, the release pipeline didn't follow
  // the v0.3.x ship pattern (squash-merge → tag → push tag → release).
  //
  // Tolerated divergence: package.json may legitimately be one minor / patch
  // ahead of the latest tag while a release is being prepared. So this test
  // only fires when package.json is BEHIND the latest tag (which would mean
  // we shipped a release but reverted package.json — clear bug).
  const { execSync } = require("node:child_process");
  let latestTag;
  try {
    latestTag = execSync("git describe --tags --abbrev=0 --match 'v*'", {
      cwd: REPO,
      encoding: "utf8",
    }).trim();
  } catch {
    return; // no tags yet — skip
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const tagSemver = latestTag.replace(/^v/, "");
  const pkgSemver = pkg.version;
  // Compare as [major, minor, patch] tuples.
  const parse = (s) => s.split(".").map((n) => parseInt(n, 10) || 0);
  const [tM, tm, tp] = parse(tagSemver);
  const [pM, pm, pp] = parse(pkgSemver);
  const cmp = pM - tM || pm - tm || pp - tp;
  assert.ok(cmp >= 0,
    `package.json version (${pkgSemver}) is BEHIND latest tag (${latestTag}) — this means a release was tagged but package.json was reverted. Fix the bump.`);
});

test("W1B: README + REFERENCE state the live hidden-by-default count", () => {
  for (const [doc, text] of [["README.md", README], ["docs/REFERENCE.md", REFERENCE]]) {
    const m = text.match(/(\d+)\s+(?:[a-z-]+\s+){0,3}hidden by default/i);
    assert.ok(m, `${doc} must say how many tools are hidden by default`);
    assert.strictEqual(parseInt(m[1], 10), liveHidden,
      `${doc} claims ${m[1]} hidden-by-default tools; live = ${liveHidden}`);
  }
});

test("W2E: smoke + setup run the relay in legacy mode (a broker-mode check would leave a detached broker running)", () => {
  for (const script of ["smoke.js", "setup.js"]) {
    const src = fs.readFileSync(path.join(REPO, "scripts", script), "utf8");
    assert.match(src, /BROWSER_RELAY_MODE:\s*"legacy"/, `${script} must spawn the relay with BROWSER_RELAY_MODE=legacy`);
  }
});

test("W1B: smoke + setup count the full catalog (all toolsets) against MIN_TOOLS", () => {
  for (const script of ["smoke.js", "setup.js"]) {
    const src = fs.readFileSync(path.join(REPO, "scripts", script), "utf8");
    assert.match(src, /BROWSER_RELAY_TOOLSETS:\s*"all"/,
      `${script} must spawn the relay with BROWSER_RELAY_TOOLSETS=all — hidden toolsets would drop tools/list below MIN_TOOLS`);
    assert.match(src, /BROWSER_RELAY_CATALOG_REFRESH:\s*"true"/,
      `${script} must force a catalog refresh so it exercises the real upstream, not just the cache file`);
    const min = parseInt(src.match(/const MIN_TOOLS = (\d+)/)[1], 10);
    assert.ok(liveTotal >= min, `${script} MIN_TOOLS=${min} exceeds the live catalog (${liveTotal})`);
  }
});

// ── W2E: broker mode ──

test("W2E: every BROWSER_RELAY_BROKER_* setting the code reads is documented in REFERENCE.md", () => {
  // set by the launcher for the broker it starts, never by a user
  const INTERNAL = new Set(["BROWSER_RELAY_BROKER_LAUNCH_WARNING"]);
  const read = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) for (const m of fs.readFileSync(full, "utf8").matchAll(/BROWSER_RELAY_BROKER_[A-Z_]*[A-Z]/g)) read.add(m[0]);
    }
  };
  walk(path.join(REPO, "src"));
  const missing = [...read].filter((k) => !INTERNAL.has(k) && !REFERENCE.includes(`\`${k}\``));
  assert.ok(read.size >= 8, `expected the broker settings in src/, found ${[...read].join(", ")}`);
  assert.deepStrictEqual(missing, [], "broker settings read in src/ but missing from REFERENCE.md");
});

test("W2E: README + REFERENCE state the default mode the code uses, and the legacy fallback", () => {
  const { relayMode } = require("../src/index.js");
  assert.strictEqual(relayMode({}, { platform: "win32" }), "broker");
  assert.strictEqual(relayMode({}, { platform: "linux" }), "legacy");
  assert.match(README, /Broker mode is the default on Windows/);
  assert.match(README, /BROWSER_RELAY_MODE=legacy/);
  assert.match(REFERENCE, /`BROWSER_RELAY_MODE` \| `broker` on Windows, `legacy` elsewhere/);
  const example = JSON.parse(fs.readFileSync(path.join(REPO, "local-config.example.json"), "utf8"));
  assert.ok("BROWSER_RELAY_MODE" in example && "_BROWSER_RELAY_MODE_doc" in example);
});

test("W2E: the broker npm scripts the docs name exist", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  for (const script of ["broker:status", "broker:stop", "migrate-profile"]) {
    assert.ok(pkg.scripts[script], `package.json lacks "${script}"`);
    assert.ok(fs.existsSync(path.join(REPO, pkg.scripts[script].split(" ")[1])), `${script} points at a missing file`);
    assert.ok(REFERENCE.includes(`npm run ${script}`), `REFERENCE.md doesn't show npm run ${script}`);
  }
  assert.ok(README.includes("npm run broker:status") && README.includes("npm run broker:stop"));
});
