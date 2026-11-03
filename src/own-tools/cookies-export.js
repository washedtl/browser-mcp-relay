// cookies_export — return cookies in the active context as JSON.
// Useful for saving authenticated session state, debugging cookie issues.
//
// W1C1 (2026-11-03): cookie values are secrets and a full jar can be
// hundreds of KB, so inline output is compact + capped (maxBytes) and
// narrowable (domains / names); outputPath keeps values out of the model's
// context entirely — pair it with cookies_import inputPath.

const { errorResult, intArg, outputPathArg, writeOutputFile } = require("./_tool-args.js");

const DEFAULT_MAX_BYTES = 50_000;

// F1-1: an optional filter must be an array of non-empty strings.
// Returns an error message or null.
function stringArrayError(name, v) {
  if (v == null) return null;
  if (!Array.isArray(v)) return `cookies_export: ${name} must be an array of strings (or omit it)`;
  const i = v.findIndex((s) => typeof s !== "string" || s.length === 0);
  return i >= 0 ? `cookies_export: ${name}[${i}] must be a non-empty string` : null;
}

// "amazon.com" matches cookies for .amazon.com, amazon.com, www.amazon.com —
// not evilamazon.com.
const bareDomain = (d) => String(d).toLowerCase().replace(/^\./, "");
function domainMatches(cookieDomain, wanted) {
  const cd = bareDomain(cookieDomain);
  return wanted.some((d) => cd === d || cd.endsWith("." + d));
}

module.exports = {
  name: "cookies_export",
  description:
    "Export browser cookies as JSON. Narrow with urls, domains or names; inline output is capped at maxBytes. " +
    "To save and restore a session, use outputPath here and cookies_import inputPath so values stay out of the conversation.",
  inputSchema: {
    type: "object",
    properties: {
      urls: { type: "array", items: { type: "string" }, description: "Only cookies that would be sent to these URLs." },
      domains: { type: "array", items: { type: "string" }, description: "Only cookies for these domains or their subdomains." },
      names: { type: "array", items: { type: "string" }, description: "Only cookies with these exact names." },
      maxBytes: { type: "integer", default: DEFAULT_MAX_BYTES, minimum: 1024, description: "Inline output cap." },
      outputPath: { type: "string", description: "Absolute path; write all matching cookies there and return only counts." },
      overwrite: { type: "boolean", default: false, description: "Allow replacing an existing outputPath." },
    },
  },
  handler: async (_args) => {
    // F0-9: null means "omitted" for every optional argument.
    const args = _args || {};
    const { urls, domains, names } = args;
    const bridge = globalThis.__relayBridge;
    if (!bridge) return errorResult("bridge missing");
    for (const [name, v] of [["urls", urls], ["domains", domains], ["names", names]]) {
      const err = stringArrayError(name, v);
      if (err) return errorResult(err);
    }
    const max = intArg("cookies_export", "maxBytes", args.maxBytes, DEFAULT_MAX_BYTES, 1024);
    if (max.error) return errorResult(max.error);
    const maxBytes = max.value;
    const overwrite = !!args.overwrite;
    const out = outputPathArg("cookies_export", "outputPath", args.outputPath, overwrite);
    if (out.error) return errorResult(out.error);

    let cookies;
    // V1-4: Playwright's `context.cookies([])` returns ALL cookies (empty
    // array = no filter). An empty filter list means "match nothing" here,
    // so the full vault is never returned for `urls: []` (same for
    // domains / names).
    if ([urls, domains, names].some((f) => Array.isArray(f) && f.length === 0)) {
      cookies = [];
    } else {
      try {
        cookies = await bridge.context.cookies(urls ?? undefined);
      } catch (e) {
        return errorResult(`cookies_export: ${e.message || e}`);
      }
      if (domains) {
        const wanted = domains.map(bareDomain);
        cookies = cookies.filter((c) => domainMatches(c.domain, wanted));
      }
      if (names) {
        const wanted = new Set(names);
        cookies = cookies.filter((c) => wanted.has(c.name));
      }
    }

    if (out.path) {
      let written;
      try {
        written = await writeOutputFile(out.path, JSON.stringify({ count: cookies.length, cookies }, null, 2), overwrite);
      } catch (e) {
        return errorResult(`cookies_export: writing outputPath failed: ${e.message}`);
      }
      return { content: [{ type: "text", text: JSON.stringify({ count: cookies.length, savedTo: written.path, fileBytes: written.bytes }) }] };
    }

    let text = JSON.stringify({ count: cookies.length, cookies });
    if (text.length > maxBytes) {
      // Keep whole cookies in order while they fit; reserve room for the
      // envelope so the final text stays within maxBytes.
      const hint = "narrow with domains/names/urls or use outputPath";
      const envelope = JSON.stringify({ count: cookies.length, returned: cookies.length, truncated: true, hint, cookies: [] }).length;
      const kept = [];
      let used = envelope;
      for (const c of cookies) {
        const size = JSON.stringify(c).length + 1;
        if (used + size > maxBytes) break;
        kept.push(c);
        used += size;
      }
      text = JSON.stringify({ count: cookies.length, returned: kept.length, truncated: true, hint, cookies: kept });
    }
    return { content: [{ type: "text", text }] };
  },
};
