const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/download-capture.js");

test("download_capture has required tool shape", () => {
  assert.strictEqual(tool.name, "download_capture");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("download_capture returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-9: short-circuit on page close — without this, download wait on a
// closed page hangs until full timeoutMs (default 30s).
// ──────────────────────────────────────────────────────────────────

test("T0-9: download_capture short-circuits when page closes before download", async () => {
  const prev = globalThis.__relayBridge;
  let registeredCloseHandler = null;
  // Fake page where waitForEvent("download") never resolves; close fires.
  const fakePage = {
    waitForEvent: (event, opts) => new Promise(() => {
      // never resolves (simulates "no download forthcoming")
    }),
    once: (event, fn) => {
      if (event === "close") registeredCloseHandler = fn;
    },
    off: () => {},
  };
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  try {
    // Long timeoutMs to prove the close path is what triggers fast resolution.
    const promise = tool.handler({ timeoutMs: 30000 });
    setTimeout(() => {
      if (registeredCloseHandler) registeredCloseHandler();
    }, 10);
    const result = await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("hung > 1s after close")), 1000)),
    ]);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /page closed before download started/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ───── F1-14: sanitizeDownloadFilename ─────

test("F1-14: sanitizeDownloadFilename defangs Linux path traversal", () => {
  const out = tool.sanitizeDownloadFilename("../../etc/passwd");
  assert.ok(!out.includes("/"), `must not contain path separators (got ${out})`);
  assert.ok(!out.startsWith(".."), `must not start with .. (got ${out})`);
  assert.ok(!out.startsWith("."), `must not start with . (got ${out})`);
});

test("F1-14: sanitizeDownloadFilename defangs Windows path traversal", () => {
  const out = tool.sanitizeDownloadFilename("..\\..\\windows\\system32\\foo.exe");
  assert.ok(!out.includes("\\"), `must not contain backslashes (got ${out})`);
  assert.ok(!out.includes("/"), `must not contain forward slashes (got ${out})`);
  assert.ok(!out.startsWith("."), `must not start with . (got ${out})`);
});

test("F1-14: sanitizeDownloadFilename strips control chars", () => {
  // Build the test input from char codes so the source file stays plain
  // ASCII (literal U+0000 / U+001F bytes would tip git's binary heuristic).
  const NUL = String.fromCharCode(0x00);
  const US = String.fromCharCode(0x1f);
  const DEL = String.fromCharCode(0x7f);
  const out = tool.sanitizeDownloadFilename("foo" + NUL + "bar" + US + "baz" + DEL + "trailing");
  // eslint-disable-next-line no-control-regex
  assert.ok(!/[\x00-\x1f\x7f]/.test(out), `must not contain control chars (got ${JSON.stringify(out)})`);
});

test("F1-14: sanitizeDownloadFilename defangs colon (Windows ADS / drive letter)", () => {
  const out = tool.sanitizeDownloadFilename("C:\\evil.exe");
  assert.ok(!out.includes(":"), `must not contain colon (got ${out})`);
});

test("F1-14: sanitizeDownloadFilename caps length to 200 chars", () => {
  const out = tool.sanitizeDownloadFilename("x".repeat(500));
  assert.strictEqual(out.length, 200);
});

test("F1-14: sanitizeDownloadFilename returns 'file.bin' for empty / null / all-dots", () => {
  assert.strictEqual(tool.sanitizeDownloadFilename(""), "file.bin");
  assert.strictEqual(tool.sanitizeDownloadFilename(null), "file.bin");
  assert.strictEqual(tool.sanitizeDownloadFilename(undefined), "file.bin");
  assert.strictEqual(tool.sanitizeDownloadFilename("...."), "file.bin");
});

test("F1-14: sanitizeDownloadFilename leaves a normal filename mostly untouched", () => {
  assert.strictEqual(tool.sanitizeDownloadFilename("report.pdf"), "report.pdf");
  assert.strictEqual(tool.sanitizeDownloadFilename("invoice-2025-Q1.csv"), "invoice-2025-Q1.csv");
});

test("F1-14: sanitizeDownloadFilename coerces non-string input safely", () => {
  // Number coerces to its decimal string — safe.
  assert.strictEqual(tool.sanitizeDownloadFilename(123), "123");
  // Object coerces to "[object Object]" via Object.prototype.toString —
  // contains no path separators, control chars, or colons, so it survives
  // sanitization unchanged. Acceptable: caller passing an object is a bug
  // on their end, but we don't crash.
  const objOut = tool.sanitizeDownloadFilename({});
  assert.ok(!objOut.includes("/") && !objOut.includes("\\") && !objOut.includes(":"),
    `object coercion must not contain path separators (got ${objOut})`);
});

// ──────────────────────────────────────────────────────────────────
// W1C1 (2026-11-03): orphaned waits never surface as unhandled
// rejections; savePath must be absolute and never silently overwrite;
// description tells the truth about when the listener starts.
// ──────────────────────────────────────────────────────────────────

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Fake page. `download` resolves waitForEvent immediately; `waitRejectMs`
// models Playwright's waitForEvent timeout (rejects with TimeoutError).
function makeDownloadPage({ download, waitRejectMs, click } = {}) {
  const closeHandlers = [];
  const page = {
    waitCalls: [],
    waitForEvent: (event, opts) => {
      page.waitCalls.push(opts);
      if (download) return Promise.resolve(download);
      return new Promise((_, reject) => {
        if (waitRejectMs != null) {
          setTimeout(() => {
            const e = new Error(`Timeout ${opts.timeout}ms exceeded while waiting for event "download"`);
            e.name = "TimeoutError";
            reject(e);
          }, waitRejectMs);
        }
      });
    },
    once: (event, fn) => { if (event === "close") closeHandlers.push(fn); },
    off: (event, fn) => {
      const i = closeHandlers.indexOf(fn);
      if (i >= 0) closeHandlers.splice(i, 1);
    },
    _close: () => { for (const fn of closeHandlers.splice(0)) fn(); },
    click: click || (async () => undefined),
  };
  return page;
}

// saveAs writes like Playwright's does (copying over whatever is at the path).
function makeDownload(name = "report.csv") {
  const saved = [];
  return {
    saved,
    suggestedFilename: () => name,
    url: () => `https://files.example/${name}`,
    saveAs: async (p) => { saved.push(p); fs.writeFileSync(p, "downloaded"); },
  };
}

// Default-path downloads land in os.tmpdir(); remove what a test saved there.
function removeSaved(download) {
  for (const p of download.saved) fs.rmSync(p, { force: true });
}

async function onPage(page, fn) {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = { context: { pages: () => [page] } };
  try { return await fn(); } finally { globalThis.__relayBridge = prev; }
}

async function collectUnhandled(fn, settleMs) {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, settleMs));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

test("W1C1: a failed click does not leave the download wait as an unhandled rejection", async () => {
  const page = makeDownloadPage({
    waitRejectMs: 30,
    click: async () => { throw new Error("No node found for selector: #export"); },
  });
  const seen = await collectUnhandled(() => onPage(page, async () => {
    const r = await tool.handler({ clickSelector: "#export", timeoutMs: 30 });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /click failed/);
  }), 120);
  assert.deepStrictEqual(seen.map(String), [], "orphaned waitForEvent rejection must be handled");
});

test("W1C1: the page closing during the click is not an unhandled rejection", async () => {
  let page;
  page = makeDownloadPage({
    click: async () => { page._close(); throw new Error("Target page, context or browser has been closed"); },
  });
  const seen = await collectUnhandled(() => onPage(page, async () => {
    const r = await tool.handler({ clickSelector: "#export", timeoutMs: 1000 });
    assert.strictEqual(r.isError, true);
  }), 50);
  assert.deepStrictEqual(seen.map(String), [], "close-promise rejection must be handled");
});

test("W1C1: relative savePath is rejected before listening for a download", async () => {
  const download = makeDownload();
  const page = makeDownloadPage({ download });
  await onPage(page, async () => {
    const r = await tool.handler({ savePath: "exports/report.csv" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /absolute/);
    assert.strictEqual(page.waitCalls.length, 0, "must not start waiting");
    assert.deepStrictEqual(download.saved, [], "must not save relative to the relay cwd");
  });
});

test("W1C1: an existing savePath is not overwritten unless overwrite: true", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-download-"));
  try {
    const existing = path.join(dir, "report.csv");
    fs.writeFileSync(existing, "keep");
    const d1 = makeDownload();
    const p1 = makeDownloadPage({ download: d1 });
    await onPage(p1, async () => {
      const r = await tool.handler({ savePath: existing });
      assert.strictEqual(r.isError, true);
      assert.match(r.content[0].text, /exists/);
      assert.strictEqual(p1.waitCalls.length, 0, "checked before waiting");
      assert.deepStrictEqual(d1.saved, []);
    });
    const d2 = makeDownload();
    await onPage(makeDownloadPage({ download: d2 }), async () => {
      const r = await tool.handler({ savePath: existing, overwrite: true });
      assert.ok(!r.isError, r.content[0].text);
      assert.deepStrictEqual(d2.saved, [existing]);
      assert.strictEqual(JSON.parse(r.content[0].text).savedTo, existing);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1C1 V2-3: a savePath that appears while waiting is kept; the download goes to a free sibling", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-download-"));
  try {
    const target = path.join(dir, "report.csv");
    const download = makeDownload();
    const page = makeDownloadPage();
    page.waitForEvent = async () => { fs.writeFileSync(target, "someone else's file"); return download; };
    await onPage(page, async () => {
      const r = await tool.handler({ savePath: target });
      assert.ok(!r.isError, r.content[0].text);
      const sibling = path.join(dir, "report-1.csv");
      assert.strictEqual(JSON.parse(r.content[0].text).savedTo, sibling, "reports the path actually written");
      assert.deepStrictEqual(download.saved, [sibling]);
      assert.strictEqual(fs.readFileSync(target, "utf8"), "someone else's file", "the other file is untouched");
      assert.strictEqual(fs.readFileSync(sibling, "utf8"), "downloaded");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1C1 V2-3: a failed saveAs removes the placeholder it claimed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-download-"));
  try {
    const target = path.join(dir, "report.csv");
    const download = makeDownload();
    download.saveAs = async () => { throw new Error("disk full"); };
    await onPage(makeDownloadPage({ download }), async () => {
      const r = await tool.handler({ savePath: target });
      assert.strictEqual(r.isError, true);
      assert.match(r.content[0].text, /saveAs failed: disk full/);
      assert.deepStrictEqual(fs.readdirSync(dir), [], "no empty placeholder left behind");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1C1: default save path is under the OS temp dir with the sanitized name", async () => {
  const download = makeDownload("../../evil.csv");
  try {
    await onPage(makeDownloadPage({ download }), async () => {
      const r = await tool.handler({});
      assert.ok(!r.isError, r.content[0].text);
      const saved = download.saved[0];
      assert.strictEqual(path.dirname(saved), os.tmpdir(), "traversal in the suggested name must not escape tmpdir");
      assert.ok(path.basename(saved).endsWith("evil.csv"), saved);
    });
  } finally {
    removeSaved(download);
  }
});

test("W1C1: timeoutMs null → 30000 default; non-positive rejected (0 would wait forever)", async () => {
  const download = makeDownload();
  const page = makeDownloadPage({ download });
  try {
    await onPage(page, async () => {
      const ok = await tool.handler({ timeoutMs: null });
      assert.ok(!ok.isError, ok.content[0].text);
      assert.strictEqual(page.waitCalls[0].timeout, 30000);
      const zero = await tool.handler({ timeoutMs: 0 });
      assert.strictEqual(zero.isError, true);
      assert.match(zero.content[0].text, /timeoutMs/);
    });
  } finally {
    removeSaved(download);
  }
});

test("W1C1: description no longer says to call it AFTER triggering (the listener starts at call time)", () => {
  assert.ok(!/call after triggering/i.test(tool.description), tool.description);
  assert.match(tool.description, /clickSelector/);
});
