// result-limit.test.js — the broker's size limit on forwarded tool results:
// what is cut, what stays valid, what the saved file holds, and what the note
// tells the caller. No browser.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { limitResult, MAX_RESULT_CHARS, KEEP_FILES_MS, LESS_NEXT_TIME } = require("../src/broker/result-limit.js");

function tmpDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-limit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "results"); // does not exist yet: the limit creates it on first use
}
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 6);
const opts = (dir, over = {}) => ({ dir, tool: "navigation_go-to", tag: "c1-1", now: NOW, ...over });
const jsonResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }], isError: false });
const tree = (n, tag = "row") => Array.from({ length: n }, (_, i) => `- ${tag} "${i + 1}" [ref=e${i + 1}]`).join("\n");
const fileOf = (note) => (/Full text \(kept[^)]*\): (.+)/.exec(note) || [])[1];
const readLines = (file) => fs.readFileSync(file, "utf8").split("\n");
const LONG_LINES_ADVICE = /\nSome of its lines are very long, and Read shows only the start of one: Grep those with -o and a pattern like `\.\{0,200\}word\.\{0,200\}`, and Read the other lines with offset\/limit\.\n/;

test("a result within the limit is returned as it is, and nothing is written", (t) => {
  const dir = tmpDir(t);
  const result = jsonResult({ url: "http://x/", output: tree(100) });
  assert.strictEqual(limitResult(result, opts(dir)), result);
  assert.strictEqual(fs.existsSync(dir), false);
  const noContent = { isError: true };
  assert.strictEqual(limitResult(noContent, opts(dir)), noContent);
});

test("a big snapshot: cut on whole lines, still valid JSON, full tree saved with real line breaks", (t) => {
  const dir = tmpDir(t);
  const output = tree(5000);
  const result = jsonResult({ url: "http://x/orders", status: 200, output });
  const out = limitResult(result, opts(dir));

  assert.strictEqual(out.isError, false);
  assert.strictEqual(out.content.length, 2, "the cut result, then one note");
  const shown = out.content[0].text;
  assert.ok(shown.length <= MAX_RESULT_CHARS, `shown ${shown.length}`);
  assert.ok(shown.length > MAX_RESULT_CHARS * 0.9, `the room is used (${shown.length})`);
  const parsed = JSON.parse(shown);
  assert.strictEqual(parsed.url, "http://x/orders");
  assert.strictEqual(parsed.status, 200);

  const m = /\n\[cut by the relay: lines 1-(\d+) of 5000 shown; the note after this result says where the full text is\]$/.exec(parsed.output);
  assert.ok(m, parsed.output.slice(-200));
  const kept = Number(m[1]);
  assert.strictEqual(parsed.output.slice(0, m.index), output.split("\n").slice(0, kept).join("\n"), "whole lines only");

  const note = out.content[1].text;
  assert.strictEqual(out.content[1].type, "text");
  assert.match(note, new RegExp(`${shown.length} of ${result.content[0].text.length} characters are shown`));
  assert.match(note, new RegExp(`output: lines 1-${kept} of 5000; the rest starts at line ${kept + 1} of the file`));
  assert.match(note, /Read it with offset\/limit, or Grep it/);
  assert.ok(note.includes(`Full text (kept at least ${KEEP_FILES_MS / 3_600_000} hours): `), "the note's hours are the ones files are kept for");
  const file = fileOf(note);
  assert.strictEqual(path.dirname(file), dir);
  assert.strictEqual(path.basename(file), "navigation_go-to-2026-01-02T03-04-05-006Z-c1-1.txt");
  const lines = readLines(file);
  assert.strictEqual(lines.length, 5000);
  assert.strictEqual(lines[kept], `- row "${kept + 1}" [ref=e${kept + 1}]`, "the line the note points at is the first one not shown");
  assert.strictEqual(result.content[0].text, JSON.stringify({ url: "http://x/orders", status: 200, output }, null, 2), "the caller's result object is not changed");
});

test("two long fields (an execute result): each gets a share, the file has one section per field", (t) => {
  const dir = tmpDir(t);
  const a = tree(3000, "alpha");
  const b = tree(4000, "beta");
  const result = jsonResult({ toolOutputs: [{ name: "navigation_go-to", output: { url: "u1", output: a } }, { name: "a11y_take-aria-snapshot", output: { output: b } }], logs: [], result: "ok" });
  const out = limitResult(result, opts(dir, { tool: "execute" }));
  const shown = out.content[0].text;
  assert.ok(shown.length <= MAX_RESULT_CHARS);
  const parsed = JSON.parse(shown);
  assert.strictEqual(parsed.result, "ok");
  const keptA = Number(/lines 1-(\d+) of 3000 shown/.exec(parsed.toolOutputs[0].output.output)[1]);
  const keptB = Number(/lines 1-(\d+) of 4000 shown/.exec(parsed.toolOutputs[1].output.output)[1]);
  assert.ok(Math.abs(keptA - keptB) < 60, `even shares: ${keptA} vs ${keptB}`);

  const note = out.content[1].text;
  const at = (field) => Number(new RegExp(`${field.replace(/[[\].]/g, "\\$&")}: lines 1-\\d+ of \\d+; the rest starts at line (\\d+) of the file`).exec(note)[1]);
  const lines = readLines(fileOf(note));
  assert.strictEqual(lines[0], "### toolOutputs[0].output.output");
  assert.strictEqual(lines[at("toolOutputs[0].output.output") - 1], `- alpha "${keptA + 1}" [ref=e${keptA + 1}]`);
  assert.strictEqual(lines[at("toolOutputs[1].output.output") - 1], `- beta "${keptB + 1}" [ref=e${keptB + 1}]`);
  assert.ok(lines.includes("### toolOutputs[1].output.output"));
  assert.match(note, /To get less next time: return less from the script/);
});

test("a key with a line break in it does not shift the line numbers the note gives", (t) => {
  const dir = tmpDir(t);
  const out = limitResult(jsonResult({ "first\nkey": tree(3000, "alpha"), second: tree(4000, "beta") }), opts(dir));
  const parsed = JSON.parse(out.content[0].text);
  const keptA = Number(/lines 1-(\d+) of 3000 shown/.exec(parsed["first\nkey"])[1]);
  const keptB = Number(/lines 1-(\d+) of 4000 shown/.exec(parsed.second)[1]);
  const note = out.content[1].text;
  const rest = [...note.matchAll(/the rest starts at line (\d+) of the file/g)].map((m) => Number(m[1]));
  const lines = readLines(fileOf(note));
  assert.strictEqual(lines[0], "### first key", "the section header is one line");
  assert.strictEqual(lines[rest[0] - 1], `- alpha "${keptA + 1}" [ref=e${keptA + 1}]`);
  assert.strictEqual(lines[rest[1] - 1], `- beta "${keptB + 1}" [ref=e${keptB + 1}]`);
});

test("a very long key is shortened in the note and in the file's section header, never inside a character pair; the result keeps it whole", (t) => {
  const dir = tmpDir(t);
  const pair = "k".repeat(119) + "😀" + "k".repeat(4000); // the pair sits across the 120th character
  const plain = "j".repeat(4000);
  const out = limitResult(jsonResult({ [pair]: tree(5000), [plain]: tree(5000) }), opts(dir));
  const parsed = JSON.parse(out.content[0].text);
  assert.ok(Object.hasOwn(parsed, pair) && Object.hasOwn(parsed, plain));
  const note = out.content[1].text;
  assert.match(note.split("\n")[1], /^ {2}k{119}…: lines 1-\d+ of 5000; the rest starts at line \d+ of the file\.$/);
  assert.match(note.split("\n")[2], /^ {2}j{120}…: lines 1-\d+ of 5000; the rest starts at line \d+ of the file\.$/);
  const lines = readLines(fileOf(note));
  assert.strictEqual(lines[0], `### ${"k".repeat(119)}…`);
  assert.ok(lines.includes(`### ${"j".repeat(120)}…`));
  assert.match(note, /\nRead it with offset\/limit, or Grep it\./, "a long key does not make the file's lines long");
});

test("a long field that fits its share stays whole beside a huge one", (t) => {
  const dir = tmpDir(t);
  const small = tree(120, "small"); // over the long-field size, far under an even share
  const result = jsonResult({ first: small, second: tree(6000, "big") });
  const out = limitResult(result, opts(dir));
  const parsed = JSON.parse(out.content[0].text);
  assert.strictEqual(parsed.first, small);
  assert.match(parsed.second, /\[cut by the relay: lines 1-\d+ of 6000 shown/);
  const lines = readLines(fileOf(out.content[1].text));
  assert.strictEqual(lines[0], `- big "1" [ref=e1]`, "one cut field: the file is that field, no section header");
  assert.doesNotMatch(out.content[1].text, /first:/);
});

test("a field with no line breaks is cut by characters, and the note says how to search long lines", (t) => {
  const dir = tmpDir(t);
  const html = "<div>" + "x".repeat(200_000) + "</div>";
  const result = jsonResult({ output: html });
  const out = limitResult(result, opts(dir, { tool: "content_get-as-html" }));
  const shown = out.content[0].text;
  assert.ok(shown.length <= MAX_RESULT_CHARS && shown.length > MAX_RESULT_CHARS * 0.9, `shown ${shown.length}`);
  const parsed = JSON.parse(shown);
  const m = /\n\[cut by the relay: the first (\d+) of 200011 characters shown; the note after this result says where the full text is\]$/.exec(parsed.output);
  assert.ok(m, parsed.output.slice(-200));
  assert.strictEqual(parsed.output.slice(0, m.index), html.slice(0, Number(m[1])));
  const note = out.content[1].text;
  assert.match(note, new RegExp(`output: the first ${m[1]} of 200011 characters; the whole field starts at line 1 of the file`));
  assert.match(note, LONG_LINES_ADVICE);
  assert.match(note, /To get less next time: pass a `selector` or a smaller maxLength/);
  assert.strictEqual(fs.readFileSync(fileOf(note), "utf8"), html);
});

test("one long line among short ones is enough for the long-lines advice, which still says to Read the others", (t) => {
  const dir = tmpDir(t);
  const out = limitResult(jsonResult({ snapshot: tree(5000), html: "<div>" + "x".repeat(200_000) + "</div>" }), opts(dir));
  const note = out.content[1].text;
  assert.match(note, / {2}snapshot: lines 1-\d+ of 5000; /);
  assert.match(note, / {2}html: the first \d+ of 200011 characters; /);
  assert.match(note, LONG_LINES_ADVICE);
  assert.doesNotMatch(note, /\nRead it with offset\/limit, or Grep it\./);
});

test("text full of escapes still fits the limit, and a character pair is never split", (t) => {
  const dir = tmpDir(t);
  const quotes = "\"\\\t".repeat(40_000); // every character doubles once encoded
  const out1 = limitResult(jsonResult({ output: quotes }), opts(dir));
  assert.ok(out1.content[0].text.length <= MAX_RESULT_CHARS, `shown ${out1.content[0].text.length}`);
  assert.ok(out1.content[0].text.length > MAX_RESULT_CHARS * 0.9, "and the room is still used");
  JSON.parse(out1.content[0].text);

  const emoji = "😀".repeat(60_000);
  const out2 = limitResult(jsonResult({ output: emoji }), opts(dir, { tag: "c1-2" }));
  const cut = JSON.parse(out2.content[0].text).output;
  const head = cut.slice(0, cut.indexOf("\n[cut by the relay"));
  assert.strictEqual(head.length % 2, 0, "ends on a whole character");
  assert.strictEqual(head, "😀".repeat(head.length / 2));
});

test("an error text (not JSON) is cut at a line break and stays an error", (t) => {
  const dir = tmpDir(t);
  const text = "Error: it broke\n" + Array.from({ length: 4000 }, (_, i) => `  at frame ${i} (file.js:${i})`).join("\n");
  const out = limitResult({ content: [{ type: "text", text }], isError: true }, opts(dir, { tool: "interaction_click" }));
  assert.strictEqual(out.isError, true);
  const shown = out.content[0].text;
  assert.ok(shown.length <= MAX_RESULT_CHARS && shown.length > MAX_RESULT_CHARS - 100);
  assert.ok(text.startsWith(shown) && text[shown.length] === "\n", "cut exactly at a line break");
  const shownLines = shown.split("\n").length;
  const note = out.content[1].text;
  assert.match(note, new RegExp(`${shown.length} of ${text.length} characters are shown\\. The text continues at line ${shownLines + 1} of the file`));
  assert.strictEqual(readLines(fileOf(note))[shownLines], text.split("\n")[shownLines]);
  assert.doesNotMatch(note, /To get less next time/, "no advice for a tool the table does not know");
});

test("text with no line break to cut at is cut at the limit, never inside a character pair, and the note names no line", (t) => {
  const dir = tmpDir(t);
  const flat = "x".repeat(MAX_RESULT_CHARS * 2);
  const out1 = limitResult({ content: [{ type: "text", text: flat }], isError: true }, opts(dir));
  assert.strictEqual(out1.content[0].text, flat.slice(0, MAX_RESULT_CHARS));
  assert.match(out1.content[1].text, new RegExp(`^\\[browser relay\\] This result was cut to fit: ${MAX_RESULT_CHARS} of ${flat.length} characters are shown\\.\\n`));
  assert.strictEqual(fs.readFileSync(fileOf(out1.content[1].text), "utf8"), flat);

  const pair = "x".repeat(MAX_RESULT_CHARS - 1) + "😀" + "y".repeat(10); // the pair sits across the limit
  const out2 = limitResult({ content: [{ type: "text", text: pair }], isError: true }, opts(dir, { tag: "c1-2" }));
  assert.strictEqual(out2.content[0].text, "x".repeat(MAX_RESULT_CHARS - 1));
});

test("a line break is used only past half the limit: one at exactly half leaves the cut at the limit", (t) => {
  const dir = tmpDir(t);
  const half = MAX_RESULT_CHARS / 2;
  const breakAt = (n) => "a".repeat(n) + "\n" + "b".repeat(MAX_RESULT_CHARS);
  const exact = limitResult({ content: [{ type: "text", text: breakAt(half) }], isError: true }, opts(dir));
  assert.strictEqual(exact.content[0].text.length, MAX_RESULT_CHARS);
  assert.doesNotMatch(exact.content[1].text, /The text continues at line/);
  const past = limitResult({ content: [{ type: "text", text: breakAt(half + 1) }], isError: true }, opts(dir, { tag: "c1-2" }));
  assert.strictEqual(past.content[0].text, "a".repeat(half + 1));
  assert.match(past.content[1].text, /The text continues at line 2 of the file\./);
});

test("JSON with no long field (a long list) is cut at a line break; the file is the whole text", (t) => {
  const dir = tmpDir(t);
  const result = jsonResult({ messages: Array.from({ length: 2000 }, (_, i) => ({ type: "log", text: `message number ${i}` })) });
  const out = limitResult(result, opts(dir, { tool: "o11y_get-console-messages" }));
  const shown = out.content[0].text;
  assert.ok(shown.length <= MAX_RESULT_CHARS);
  assert.ok(result.content[0].text.startsWith(shown) && result.content[0].text[shown.length] === "\n");
  const note = out.content[1].text;
  assert.strictEqual(fs.readFileSync(fileOf(note), "utf8"), result.content[0].text);
  assert.match(note, /To get less next time: pass limit:\{count:N\}, a `type` or a `search`/);
});

test("JSON over the limit only by its spacing, every field fitting, is cut as plain text: never called cut with nothing in the file", (t) => {
  const dir = tmpDir(t);
  const text = JSON.stringify({ output: tree(150), list: Array.from({ length: 2000 }, (_, i) => i) }, null, 10);
  assert.ok(text.length > MAX_RESULT_CHARS);
  const out = limitResult({ content: [{ type: "text", text }], isError: false }, opts(dir));
  const shown = out.content[0].text;
  assert.ok(text.startsWith(shown) && text[shown.length] === "\n", "what is shown is the start of the text as it came");
  assert.strictEqual(fs.readFileSync(fileOf(out.content[1].text), "utf8"), text);
});

test("only text parts over the limit are touched; several cut parts get separate files", (t) => {
  const dir = tmpDir(t);
  const image = { type: "image", data: "A".repeat(MAX_RESULT_CHARS * 2), mimeType: "image/png" };
  const small = { type: "text", text: "small" };
  const big1 = { type: "text", text: tree(3000, "one") };
  const big2 = { type: "text", text: tree(3000, "two"), mimeType: "image/svg+xml" };
  const out = limitResult({ content: [small, big1, image, big2], isError: false }, opts(dir));
  assert.strictEqual(out.content.length, 6);
  assert.strictEqual(out.content[0], small);
  assert.strictEqual(out.content[2], image);
  assert.strictEqual(out.content[3].mimeType, "image/svg+xml");
  const [f1, f2] = [fileOf(out.content[4].text), fileOf(out.content[5].text)];
  assert.notStrictEqual(f1, f2);
  assert.match(path.basename(f2), /-c1-1-2\.txt$/);
  assert.strictEqual(fs.readFileSync(f1, "utf8"), big1.text);
  assert.strictEqual(fs.readFileSync(f2, "utf8"), big2.text);
});

test("saved results older than a day are removed when a new one is saved; other files are left alone", (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(dir, { recursive: true });
  const age = (name, ms) => { const p = path.join(dir, name); fs.writeFileSync(p, "x"); fs.utimesSync(p, new Date(NOW - ms), new Date(NOW - ms)); return p; };
  const old = age("old.txt", KEEP_FILES_MS + 60_000);
  const recent = age("recent.txt", KEEP_FILES_MS - 60_000);
  const other = age("old.log", KEEP_FILES_MS * 3);
  limitResult(jsonResult({ output: tree(5000) }), opts(dir));
  assert.strictEqual(fs.existsSync(old), false);
  assert.strictEqual(fs.existsSync(recent), true);
  assert.strictEqual(fs.existsSync(other), true);
});

test("when the file cannot be written the result is still cut, and the note says so", (t) => {
  const dir = tmpDir(t);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, "a file where the directory should be");
  const logged = [];
  const out = limitResult(jsonResult({ output: tree(5000) }), opts(dir, { log: (m) => logged.push(m) }));
  assert.ok(out.content[0].text.length <= MAX_RESULT_CHARS);
  assert.match(out.content[1].text, /The full text could not be saved/);
  assert.doesNotMatch(out.content[1].text, /Full text \(kept/);
  assert.strictEqual(logged.length, 1);
});

test("a tool name or tag that is not a safe file name is cleaned", (t) => {
  const dir = tmpDir(t);
  const out = limitResult(jsonResult({ output: tree(5000) }), opts(dir, { tool: "weird/..\\name:x", tag: "c1/../../escape" }));
  const file = fileOf(out.content[1].text);
  assert.strictEqual(path.dirname(file), dir);
  assert.strictEqual(path.basename(file), "weird_.._name_x-2026-01-02T03-04-05-006Z-c1_.._.._escape.txt");
});

test("the saved file and its directory are for this user only", { skip: process.platform === "win32" && "POSIX file modes only" }, (t) => {
  const dir = tmpDir(t);
  const out = limitResult(jsonResult({ output: tree(5000) }), opts(dir));
  assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(fileOf(out.content[1].text)).mode & 0o777, 0o600);
});

test("LESS_NEXT_TIME: advice for the tools that return page-sized text", () => {
  assert.deepStrictEqual(Object.keys(LESS_NEXT_TIME).sort(), [
    "a11y_take-aria-snapshot", "content_get-as-html", "content_get-as-text", "execute",
    "navigation_go-back-or-forward", "navigation_go-to", "navigation_reload",
    "o11y_get-console-messages", "o11y_get-http-requests",
  ]);
});
