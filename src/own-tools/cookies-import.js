// cookies_import — load cookies into the active context.
// Inverse of cookies_export. For restoring saved sessions or testing flows.
//
// W1C1 (2026-11-03): `inputPath` reads a file written by cookies_export
// outputPath, so cookie values never round-trip through the model.

const fsp = require("node:fs/promises");
const { errorResult, absolutePathArg } = require("./_tool-args.js");

// Read a cookies_export file: { cookies: [...] } or a bare array.
// Returns { cookies } or { error }.
async function readCookieFile(p) {
  let raw;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch (e) {
    return { error: `cookies_import: cannot read inputPath: ${e.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (e) {
    return { error: `cookies_import: inputPath is not valid JSON: ${e.message}` };
  }
  const cookies = Array.isArray(parsed) ? parsed : parsed && parsed.cookies;
  if (!Array.isArray(cookies)) {
    return { error: "cookies_import: inputPath must hold a cookies array (cookies_export's { cookies: [...] } or a bare array)" };
  }
  return { cookies };
}

module.exports = {
  name: "cookies_import",
  description:
    "Import cookies into the browser context; same name/domain/path cookies are replaced. " +
    "Pass cookies (Playwright format, as cookies_export returns) or inputPath (a file from cookies_export outputPath).",
  inputSchema: {
    type: "object",
    properties: {
      cookies: {
        type: "array",
        description: "Cookie objects: { name, value, domain + path or url, expires?, httpOnly?, secure?, sameSite? }.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            domain: { type: "string" },
            path: { type: "string" },
          },
          required: ["name", "value"],
        },
      },
      inputPath: { type: "string", description: "Absolute path to a cookies_export outputPath file." },
    },
  },
  handler: async (_args) => {
    // F0-9: null means "omitted".
    const args = _args || {};
    const bridge = globalThis.__relayBridge;
    if (!bridge) return errorResult("bridge missing");
    const input = absolutePathArg("cookies_import", "inputPath", args.inputPath);
    if (input.error) return errorResult(input.error);
    if (args.cookies != null && input.path) return errorResult("cookies_import: pass cookies or inputPath, not both");
    if (args.cookies == null && !input.path) return errorResult("cookies_import: pass cookies or inputPath");

    let cookies = args.cookies;
    if (input.path) {
      const read = await readCookieFile(input.path);
      if (read.error) return errorResult(read.error);
      cookies = read.cookies;
    }
    if (!Array.isArray(cookies)) {
      return errorResult("cookies must be an array");
    }
    // F0-5 (2026-05-10): filter null/non-object entries upfront. Without
    // this, `[null, validCookie]` propagates to addCookies which throws
    // on the null with no per-index context. We surface the index of the
    // first bad entry.
    //
    // Reviewer V1 (2026-05-10): also validate the OPTIONAL fields Playwright
    // actually consumes — domain/path/expires/url/sameSite/httpOnly/secure.
    // Pre-fix this was half-applied: name/value were checked but a malformed
    // domain (number) or sameSite (random string) reached Playwright's
    // ParameterError with a cryptic stack trace. Match the rigor of F0-5's
    // top-level guards.
    const VALID_SAMESITE = new Set(["Strict", "Lax", "None"]);
    for (let i = 0; i < cookies.length; i++) {
      const c = cookies[i];
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        return errorResult(`cookies_import: cookies[${i}] must be a non-null object (got ${c === null ? "null" : typeof c})`);
      }
      if (typeof c.name !== "string" || typeof c.value !== "string") {
        return errorResult(`cookies_import: cookies[${i}] must have string name + value`);
      }
      // Either url OR (domain + path) must be present per Playwright's
      // contract. We don't enforce the OR here (Playwright surfaces it
      // with a clear message) but we do reject *malformed* values.
      if (c.url !== undefined && (typeof c.url !== "string" || c.url.length === 0)) {
        return errorResult(`cookies_import: cookies[${i}].url must be a non-empty string when provided`);
      }
      if (c.domain !== undefined && typeof c.domain !== "string") {
        return errorResult(`cookies_import: cookies[${i}].domain must be a string when provided`);
      }
      if (c.path !== undefined && typeof c.path !== "string") {
        return errorResult(`cookies_import: cookies[${i}].path must be a string when provided`);
      }
      if (c.expires !== undefined && (!Number.isFinite(c.expires))) {
        return errorResult(`cookies_import: cookies[${i}].expires must be a finite number (Unix seconds) when provided`);
      }
      if (c.httpOnly !== undefined && typeof c.httpOnly !== "boolean") {
        return errorResult(`cookies_import: cookies[${i}].httpOnly must be boolean when provided`);
      }
      if (c.secure !== undefined && typeof c.secure !== "boolean") {
        return errorResult(`cookies_import: cookies[${i}].secure must be boolean when provided`);
      }
      if (c.sameSite !== undefined && (typeof c.sameSite !== "string" || !VALID_SAMESITE.has(c.sameSite))) {
        return errorResult(`cookies_import: cookies[${i}].sameSite must be 'Strict' | 'Lax' | 'None' (got ${JSON.stringify(c.sameSite)})`);
      }
    }
    try {
      await bridge.context.addCookies(cookies);
    } catch (e) {
      // Playwright throws on malformed cookies (missing domain+path or url,
      // invalid sameSite, etc.). Return structured error instead of letting
      // it propagate as an uncaught exception.
      return errorResult(`addCookies failed: ${e.message}`);
    }
    return { content: [{ type: "text", text: JSON.stringify({ imported: cookies.length }) }] };
  },
};
