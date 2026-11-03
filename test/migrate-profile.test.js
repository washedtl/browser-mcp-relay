// migrate-profile.test.js — W2E: `npm run migrate-profile` seeds the broker
// profile from a legacy pool profile, once, by hand.
//
// Fake pool dirs and a temp target only: nothing reads a real profile.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { run } = require("../scripts/migrate-profile.js");

const SCRIPT = path.resolve(__dirname, "..", "scripts", "migrate-profile.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-migrate-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const tmp = (label) => path.join(root, `${label}-${++n}`);

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function fakeSlot(label, ageMs = 0) {
  const dir = tmp(label);
  write(path.join(dir, "Local State"), "{}");
  write(path.join(dir, "Default", "Preferences"), "{}");
  write(path.join(dir, "Default", "Cache", "data_0"), "c".repeat(2 * 1024 * 1024));
  const c = path.join(dir, "Default", "Network", "Cookies");
  write(c, `cookies-${label}`);
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(c, t, t);
  return dir;
}

const pool = (poolDirs) => ({ CONFIG: { poolDirs, standalone: false }, braveNeedle: () => "brave.exe", readLockState: () => null });

async function runWith(argv, { target = path.join(tmp("t"), "profile"), poolDirs = [], braveCommands = [], claimed = [] } = {}) {
  const lines = [];
  const code = await run({
    argv,
    env: { BROWSER_RELAY_BROKER_PROFILE_DIR: target },
    pool: pool(poolDirs),
    listBraveCommands: () => braveCommands,
    isSlotClaimed: (d) => claimed.includes(d),
    out: (l) => lines.push(l),
  });
  return { code, text: lines.join("\n"), target };
}

test("--dry-run --from: prints source, target, what and how much it would copy; copies nothing", async () => {
  const slot = fakeSlot("dry");
  const r = await runWith(["--dry-run", "--from", slot]);
  assert.strictEqual(r.code, 0, r.text);
  assert.ok(r.text.includes(slot) && r.text.includes(r.target), r.text);
  assert.match(r.text, /3 files/);
  assert.match(r.text, /Default\/Cache \(2\.0 MB\)/, "excluded caches are listed with their size");
  assert.match(r.text, /dry run/i);
  assert.strictEqual(fs.existsSync(r.target), false);
});

test("--from: seeds the broker profile from that dir", async () => {
  const slot = fakeSlot("real");
  const r = await runWith(["--from", slot]);
  assert.strictEqual(r.code, 0, r.text);
  assert.strictEqual(fs.readFileSync(path.join(r.target, "Default", "Network", "Cookies"), "utf8"), "cookies-real");
  assert.strictEqual(fs.existsSync(path.join(r.target, "Default", "Cache")), false);
  assert.match(r.text, /seeded 3 files/i);
});

test("without --from: the freshest idle pool slot, as the broker picks it", async () => {
  const older = fakeSlot("older", 60_000);
  const newest = fakeSlot("newest", 1_000);
  const busy = fakeSlot("busy", 0);
  const r = await runWith(["--dry-run"], { poolDirs: [older, newest, busy], braveCommands: [`brave.exe --user-data-dir=${busy}`] });
  assert.strictEqual(r.code, 0, r.text);
  assert.match(r.text, new RegExp(`source: +${newest.replace(/[\\.]/g, "\\$&")}`));
  assert.ok(r.text.includes(busy) && /running/.test(r.text), "says why the busy slot was skipped");
});

test("refuses: an existing broker profile, a source Brave runs on or a relay holds, a missing source, no pool slot", async () => {
  const slot = fakeSlot("src");
  const existing = tmp("existing");
  fs.mkdirSync(existing);
  const exists = await runWith(["--from", slot], { target: existing });
  assert.strictEqual(exists.code, 1);
  assert.match(exists.text, /already exists/);
  assert.match(exists.text, /broker:stop/);

  const running = await runWith(["--from", slot], { braveCommands: [`brave.exe --user-data-dir="${slot}"`] });
  assert.strictEqual(running.code, 1);
  assert.match(running.text, /Brave is running/);

  const held = await runWith(["--from", slot], { claimed: [slot] });
  assert.strictEqual(held.code, 1);
  assert.match(held.text, /legacy relay holds/);

  const missing = await runWith(["--from", tmp("nope")]);
  assert.strictEqual(missing.code, 1);
  assert.match(missing.text, /not a Brave profile/);

  const none = await runWith([], { poolDirs: [] });
  assert.strictEqual(none.code, 1);
  assert.match(none.text, /--from/);
});

test("rejects unknown arguments with usage", async () => {
  const r = await runWith(["--force"]);
  assert.strictEqual(r.code, 2);
  assert.match(r.text, /usage/i);
});

test("CLI: `node scripts/migrate-profile.js --dry-run --from <dir>` (target from BROWSER_RELAY_BROKER_PROFILE_DIR)", () => {
  const slot = fakeSlot("cli");
  const target = path.join(tmp("cli-target"), "profile");
  const r = spawnSync(process.execPath, [SCRIPT, "--dry-run", "--from", slot], {
    env: { ...process.env, BROWSER_RELAY_BROKER_PROFILE_DIR: target },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes(slot) && r.stdout.includes(target), r.stdout);
  assert.strictEqual(fs.existsSync(target), false);
});
