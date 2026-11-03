// Tests for src/own-tools/_tool-args.js — shared argument / output helpers.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fitJson, absolutePathArg, outputPathArg, writeOutputFile, writeExclusive } = require("../../src/own-tools/_tool-args.js");

const CTRL = String.fromCharCode(1); // JSON-escapes to 6 chars (\u0001)
const escaped = (s) => JSON.stringify(s).length;

test("fitJson: text that fits is returned untouched with its escaped cost", () => {
  assert.deepStrictEqual(fitJson("hello", 100), { text: "hello", cost: 7, cut: false });
});

test("fitJson: front-loaded escapes still end within the cap (V2-1)", () => {
  // Proportional scaling by the average escape ratio underestimates a prefix
  // that is mostly control characters.
  for (const text of [
    CTRL.repeat(500) + "a".repeat(1500),
    CTRL.repeat(3000) + "a".repeat(30000),
    '"'.repeat(4000) + "b".repeat(100),
  ]) {
    const r = fitJson(text, 2000);
    assert.strictEqual(r.cut, true);
    assert.ok(r.cost <= 2000, `cost ${r.cost} > cap`);
    assert.strictEqual(r.cost, escaped(r.text), "cost is the real escaped size");
    assert.match(r.text, /\.\.\.\[truncated\]$/, "the truncation marker is included in the cost");
    assert.ok(r.cost > 1900, `should use most of the cap (got ${r.cost})`);
  }
});

test("fitJson: plain text keeps close to the cap", () => {
  const r = fitJson("x".repeat(10_000), 1000);
  assert.ok(r.cost <= 1000 && r.cost >= 990, String(r.cost));
});

// V2-2: a UNC / device path would let a prompt-injected agent write cookies
// to (or read them from) a remote share — and Windows authenticates to the
// share with the user's NTLM credentials.
const BS = String.fromCharCode(92); // backslash, spelled out so no tool can collapse it
const UNC_AND_DEVICE_PATHS = [
  `${BS}${BS}attacker.example${BS}share${BS}cookies.json`,
  "//attacker.example/share/cookies.json",
  `${BS}${BS}.${BS}pipe${BS}relay`,
  `${BS}${BS}?${BS}C:${BS}tmp${BS}cookies.json`,
  `/${BS}attacker.example${BS}share${BS}c.json`,
];

test("absolutePathArg rejects UNC and device paths (V2-2)", () => {
  for (const p of UNC_AND_DEVICE_PATHS) {
    const r = absolutePathArg("t", "outputPath", p);
    assert.ok(r.error, `expected an error for ${p}`);
    assert.match(r.error, /UNC|device|network/i, p);
    assert.strictEqual(r.path, undefined);
    assert.ok(outputPathArg("t", "outputPath", p, true).error, `outputPathArg must reject ${p} too`);
  }
});

// V2-3: a file that appears after the up-front check (e.g. during a long
// capture) must not turn finished work into an error — write beside it.
test("writeOutputFile writes to the first free name-N sibling when the path appeared (V2-3)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-tool-args-"));
  try {
    const p = path.join(dir, "cap.json");
    fs.writeFileSync(p, "theirs");
    fs.writeFileSync(path.join(dir, "cap-1.json"), "theirs too");
    const r = await writeOutputFile(p, "mine", false);
    assert.deepStrictEqual(r, { path: path.join(dir, "cap-2.json"), bytes: 4 });
    assert.strictEqual(fs.readFileSync(p, "utf8"), "theirs");
    assert.strictEqual(fs.readFileSync(path.join(dir, "cap-1.json"), "utf8"), "theirs too");
    assert.strictEqual(fs.readFileSync(r.path, "utf8"), "mine");
    const o = await writeOutputFile(p, "replaced", true);
    assert.strictEqual(o.path, p, "overwrite: true replaces in place");
    assert.strictEqual(fs.readFileSync(p, "utf8"), "replaced");
    const fresh = await writeOutputFile(path.join(dir, "sub", "new.json"), "x", false);
    assert.strictEqual(fresh.path, path.join(dir, "sub", "new.json"), "a free path is used as-is (parent created)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeExclusive never reuses a name — not even a dangling symlink's", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-tool-args-"));
  try {
    const p = path.join(dir, "out.bin");
    try {
      fs.symlinkSync(path.join(dir, "missing-target"), p);
    } catch {
      t.skip("symlinks not permitted here");
      return;
    }
    const got = await writeExclusive(p, "");
    assert.strictEqual(got, path.join(dir, "out-1.bin"));
    assert.strictEqual(fs.existsSync(path.join(dir, "missing-target")), false, "must not write through the symlink");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("absolutePathArg still accepts a plain local absolute path", () => {
  const p = path.join(os.tmpdir(), "bmr-tool-args", "out.json");
  assert.deepStrictEqual(absolutePathArg("t", "outputPath", p), { path: path.resolve(p) });
});
