"use strict";

// result-limit.js — keeps a forwarded tool result small enough to read.
//
// Claude Code shows an MCP result only up to 25,000 tokens (and any text only
// up to 50,000 characters); a larger one is saved to a file that holds the
// JSON result on ONE line, so it cannot be read by line range. Page results
// pass that easily (measured: navigation_go-to on a 500-row table page
// returned 947,174 characters).
//
// limitResult() cuts each text part over MAX_RESULT_CHARS, saves the full text
// to a file with real line breaks, and adds a note saying where the file is,
// where the cut text continues in it, and how to ask the tool for less.

const fs = require("node:fs");
const path = require("node:path");

/** Longest text part returned whole (about 8,000-10,000 tokens of page tree). */
const MAX_RESULT_CHARS = 30_000;
/** A string field longer than this is cut on its own, keeping the JSON around it whole. */
const LONG_FIELD_CHARS = 2_000;
/** With less room than this per long field, the text is cut as a whole instead. */
const MIN_FIELD_CHARS = 1_000;
/** Room kept for the marker that ends a cut field. */
const MARKER_ROOM = 160;
/** A line longer than this is not worth reading by line number. */
const LONG_LINE_CHARS = 2_000;
/** The most of a field's path the note repeats: a key can be as long as the page makes it. */
const PATH_CHARS = 120;
const KEEP_FILES_MS = 24 * 60 * 60 * 1000;

const SNAPSHOT_HINT = "pass includeSnapshot:false or snapshotOptions:{interactiveOnly:true}, then a11y_take-aria-snapshot with a `selector` for the part you need";
/** Per tool: how to get a smaller result (test/upstream-contract.test.js checks every tool and argument named here against upstream). */
const LESS_NEXT_TIME = {
  "navigation_go-to": SNAPSHOT_HINT,
  "navigation_reload": SNAPSHOT_HINT,
  "navigation_go-back-or-forward": SNAPSHOT_HINT,
  "a11y_take-aria-snapshot": "pass a `selector`, interactiveOnly:true or a small maxDepth",
  "content_get-as-html": "pass a `selector` or a smaller maxLength",
  "content_get-as-text": "pass a `selector` or a smaller maxLength",
  "o11y_get-console-messages": "pass limit:{count:N}, a `type` or a `search`",
  "o11y_get-http-requests": "pass limit:{count:N}, a `resourceType` or a `status` range",
  execute: "return less from the script, or leave out callTool's third argument so nested outputs are not returned",
};

const tooLong = (part) => Boolean(part) && part.type === "text" && typeof part.text === "string" && part.text.length > MAX_RESULT_CHARS;
/** Length of `s` inside a JSON string. */
const enc = (s) => JSON.stringify(s).length - 2;
const lineCount = (s) => s.split("\n").length;
/** A field's path as the note and the saved file give it: at most PATH_CHARS of it, never half of a character pair. */
const label = (p) => (p.length > PATH_CHARS ? `${p.slice(0, PATH_CHARS).replace(/[\ud800-\udbff]$/, "")}…` : p);

/** Every string longer than LONG_FIELD_CHARS in a parsed result, with where it sits. */
function longFields(value, at = "", found = []) {
  for (const key of Object.keys(value)) {
    const v = value[key];
    // kept on one line: it heads a section of the saved file, whose lines the note counts
    const here = (Array.isArray(value) ? `${at}[${key}]` : at ? `${at}.${key}` : key).replace(/\s+/g, " ");
    if (typeof v === "string") {
      if (v.length > LONG_FIELD_CHARS) found.push({ holder: value, key, path: here, value: v, enc: enc(v) });
    } else if (v && typeof v === "object") {
      longFields(v, here, found);
    }
  }
  return found;
}

/** The start of `value` that fits `room` encoded characters: whole lines when they use at least half the room, else a cut by characters. */
function cutField(value, room) {
  const lines = value.split("\n");
  let used = 0;
  let n = 0;
  for (; n < lines.length; n++) {
    const cost = enc(lines[n]) + (n ? 2 : 0); // a line break is two characters once encoded
    if (used + cost > room) break;
    used += cost;
  }
  if (n && used >= room / 2) return { head: lines.slice(0, n).join("\n"), lines: n, totalLines: lines.length };
  let k = Math.min(value.length, room);
  for (let e = enc(value.slice(0, k)); e > room; e = enc(value.slice(0, k))) k = Math.min(k - 1, Math.floor((k * room) / e));
  const last = value.charCodeAt(k - 1);
  if (last >= 0xd800 && last <= 0xdbff) k--; // never half of a character pair
  return { head: value.slice(0, k), chars: k, totalLines: lines.length };
}

/**
 * Cut a JSON result inside its long string fields, so the text stays valid
 * JSON and every small field survives. null when the text is not JSON, has no
 * long field, its structure alone leaves too little room, or every field fits
 * (the text was only spaced wider than this writes it).
 */
function cutJson(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const fields = longFields(parsed);
  if (!fields.length) return null;
  for (const f of fields) f.holder[f.key] = "";
  let room = MAX_RESULT_CHARS - JSON.stringify(parsed, null, 2).length - fields.length * MARKER_ROOM;
  if (room < fields.length * MIN_FIELD_CHARS) return null;

  // Smallest first: a field under its even share stays whole and leaves its room to the rest.
  const cut = [];
  [...fields].sort((a, b) => a.enc - b.enc).forEach((f, i, all) => {
    const share = Math.min(f.enc, Math.floor(room / (all.length - i)));
    room -= share;
    if (share < f.enc) Object.assign(f, cutField(f.value, share), { isCut: true });
  });
  let line = 1;
  const sections = [];
  for (const f of fields) {
    if (!f.isCut) { f.holder[f.key] = f.value; continue; }
    cut.push(f);
  }
  if (!cut.length) return null;
  for (const f of cut) {
    const what = f.lines !== undefined ? `lines 1-${f.lines} of ${f.totalLines}` : `the first ${f.chars} of ${f.value.length} characters`;
    f.holder[f.key] = `${f.head}\n[cut by the relay: ${what} shown; the note after this result says where the full text is]`;
    if (cut.length > 1) { sections.push(`### ${label(f.path)}`); line++; }
    f.fileLine = line;
    sections.push(f.value);
    line += f.totalLines;
    if (cut.length > 1) { sections.push(""); line++; }
  }
  const shown = JSON.stringify(parsed, null, 2);
  if (shown.length > MAX_RESULT_CHARS) return null;
  return { shown, full: sections.join("\n"), fields: cut };
}

/** Cut any text at the last line break that keeps more than half the limit, else at the limit. */
function cutPlain(text) {
  const at = text.lastIndexOf("\n", MAX_RESULT_CHARS);
  if (at > MAX_RESULT_CHARS / 2) {
    const shown = text.slice(0, at);
    return { shown, full: text, fields: [], lines: lineCount(shown) };
  }
  let k = MAX_RESULT_CHARS;
  const last = text.charCodeAt(k - 1);
  if (last >= 0xd800 && last <= 0xdbff) k--;
  return { shown: text.slice(0, k), full: text, fields: [] };
}

/** Write the full text; drop saved results older than KEEP_FILES_MS. Returns {file} or {error}. */
function saveFull(dir, name, text, now, log) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // page content: for this user only
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".txt")) continue;
      const p = path.join(dir, f);
      try { if (now - fs.statSync(p).mtimeMs > KEEP_FILES_MS) fs.unlinkSync(p); } catch { /* removed by another call */ }
    }
    const file = path.join(dir, name);
    fs.writeFileSync(file, text, { mode: 0o600 });
    return { file };
  } catch (e) {
    log(`result-limit: could not save the full result: ${e.message}`);
    return { error: e.code || "write failed" };
  }
}

function describe(cut, total, saved, tool) {
  const out = [`[browser relay] This result was cut to fit: ${cut.shown.length} of ${total} characters are shown.${cut.lines ? ` The text continues at line ${cut.lines + 1} of the file.` : ""}`];
  for (const f of cut.fields) {
    const at = label(f.path);
    out.push(f.lines !== undefined
      ? `  ${at}: lines 1-${f.lines} of ${f.totalLines}; the rest starts at line ${f.fileLine + f.lines} of the file.`
      : `  ${at}: the first ${f.chars} of ${f.value.length} characters; the whole field starts at line ${f.fileLine} of the file.`);
  }
  if (saved.file) {
    out.push(`Full text (kept at least ${KEEP_FILES_MS / 3_600_000} hours): ${saved.file}`);
    out.push(cut.full.split("\n").some((l) => l.length > LONG_LINE_CHARS)
      ? "Some of its lines are very long, and Read shows only the start of one: Grep those with -o and a pattern like `.{0,200}word.{0,200}`, and Read the other lines with offset/limit."
      : "Read it with offset/limit, or Grep it.");
  } else {
    out.push(`The full text could not be saved (${saved.error}).`);
  }
  if (Object.hasOwn(LESS_NEXT_TIME, tool)) out.push(`To get less next time: ${LESS_NEXT_TIME[tool]}.`);
  return out.join("\n");
}

/**
 * @param {object} result — a CallToolResult
 * @param {object} opts
 * @param {string} opts.dir — where full texts are saved (created on first use)
 * @param {string} opts.tool — the tool's name: names the file and picks the advice
 * @param {string} opts.tag — makes the file name unique among calls in the same millisecond
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.now]
 * @returns {object} `result` itself when nothing is over the limit, else a copy with the long text parts cut and one note part added per cut part
 */
function limitResult(result, { dir, tool, tag, log = () => {}, now = Date.now() }) {
  const content = result && Array.isArray(result.content) ? result.content : [];
  if (!content.some(tooLong)) return result;
  const shown = [];
  const notes = [];
  for (const part of content) {
    if (!tooLong(part)) { shown.push(part); continue; }
    const cut = cutJson(part.text) || cutPlain(part.text);
    const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
    const name = `${tool}-${stamp}-${tag}${notes.length ? `-${notes.length + 1}` : ""}`.replace(/[^\w.-]/g, "_") + ".txt";
    shown.push({ ...part, text: cut.shown });
    notes.push({ type: "text", text: describe(cut, part.text.length, saveFull(dir, name, cut.full, now, log), tool) });
  }
  return { ...result, content: [...shown, ...notes] };
}

module.exports = { limitResult, MAX_RESULT_CHARS, KEEP_FILES_MS, LESS_NEXT_TIME };
