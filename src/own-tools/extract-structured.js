// extract_structured — schema-driven data extraction from this tab.
// Schema is { fieldName: { selector, attribute?, multiple? }, ... }.
// Uses the authed session — sees logged-in content unlike unauthenticated scrapers.
//
// W1C1 (2026-11-03): `multiple` + innerHTML could return MBs straight into
// the model's context. Output is now capped: maxItems per multiple field and
// a maxBytes budget shared fairly across fields (cut fields are listed in
// `truncated`).

const { errorResult, intArg, fitJson } = require("./_tool-args.js");

const DEFAULT_MAX_ITEMS = 100;
const DEFAULT_MAX_BYTES = 100_000;

// Runs IN THE PAGE: page.evaluate ships a function's source text, so this
// may only use page globals plus fitJson, whose source EXTRACT_IN_PAGE
// embeds. Each field is wrapped in try/catch so a bad selector for one field
// doesn't kill the whole extraction — the failing field gets { __error } and
// other fields proceed. The output cap is applied here so oversized values
// never cross CDP. Each field may use an even split of the budget still
// left, so one huge field can't starve the fields after it, and whatever a
// small field doesn't use rolls over to later ones.
function extractFields({ schema, maxItems, maxBytes }) {
  const data = {};
  const truncated = {};
  const fields = Object.entries(schema);
  let room = maxBytes;
  const readAttr = (el, attr) => {
    if (!el) return null;
    // T1-4: textContent is the default — innerText forces a synchronous
    // layout pass which becomes O(N) slow on `multiple: true` queries
    // against big lists. textContent gives the same answer for 90%+ of
    // scraping cases without the layout penalty. Callers who explicitly
    // need rendered-text-only behavior (CSS-hidden content excluded)
    // can pass attribute: "innerText".
    if (attr === "textContent") return el.textContent;
    if (attr === "innerText") return el.innerText;
    if (attr === "innerHTML") return el.innerHTML;
    if (attr === "value") return el.value;
    return el.getAttribute(attr);
  };
  fields.forEach(([field, spec], i) => {
    let share = Math.floor(room / (fields.length - i));
    // Values are charged at their real JSON-escaped size (what reaches the
    // model); the one that doesn't fit is clipped.
    const take = (v) => {
      if (typeof v !== "string") return v;
      const fit = fitJson(v, share); // embedded by EXTRACT_IN_PAGE
      if (fit.cut) truncated[field] = "clipped";
      share -= fit.cost;
      room -= fit.cost;
      return fit.text;
    };
    try {
      const attr = spec.attribute || "textContent";
      if (spec.multiple) {
        const els = document.querySelectorAll(spec.selector);
        const vals = [];
        for (const el of els) {
          if (vals.length >= maxItems || share <= 0) break;
          vals.push(take(readAttr(el, attr)));
        }
        data[field] = vals;
        if (vals.length < els.length) truncated[field] = `kept ${vals.length} of ${els.length}`;
      } else {
        data[field] = take(readAttr(document.querySelector(spec.selector), attr));
      }
    } catch (e) {
      data[field] = { __error: e.message };
    }
  });
  return { data, truncated };
}
const EXTRACT_IN_PAGE = new Function("arg", `const fitJson = ${fitJson}; return (${extractFields})(arg);`);

module.exports = {
  name: "extract_structured",
  description:
    "Extract data from this tab with a CSS-selector schema: { field: { selector, attribute?, multiple? } }. " +
    "attribute defaults to textContent; also innerText (rendered text only, slow on big lists), innerHTML, value, or any attribute name. " +
    "Output is capped by maxItems (per multiple field) and maxBytes (all values); cut fields are listed in truncated.",
  inputSchema: {
    type: "object",
    properties: {
      navigateToUrl: { type: "string", description: "Navigate here first." },
      waitForSelector: { type: "string", description: "Wait for this selector (30s) before extracting." },
      schema: {
        type: "object",
        minProperties: 1,
        additionalProperties: {
          type: "object",
          properties: {
            selector: { type: "string" },
            attribute: { type: "string" },
            multiple: { type: "boolean", default: false, description: "Return an array of all matches." },
          },
          required: ["selector"],
        },
      },
      maxItems: { type: "integer", default: DEFAULT_MAX_ITEMS, minimum: 1, description: "Max matches per multiple field." },
      maxBytes: { type: "integer", default: DEFAULT_MAX_BYTES, minimum: 1024, description: "Budget for all extracted text." },
    },
    required: ["schema"],
  },
  handler: async (_args, { page }) => {
    const args = _args || {};
    const { navigateToUrl, waitForSelector, schema } = args;
    // T0-5: validate schema before passing to page.evaluate. Object.entries(null)
    // throws an opaque error inside the page context that surfaces as
    // "page.evaluate failed: Cannot convert undefined or null to object" — much
    // less actionable than this guard.
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return {
        content: [{ type: "text", text: "extract_structured: schema must be a non-null object with at least one field" }],
        isError: true,
      };
    }
    if (Object.keys(schema).length === 0) {
      return {
        content: [{ type: "text", text: "extract_structured: schema must have at least one field (got empty object)" }],
        isError: true,
      };
    }
    // F1-17 (2026-05-10): validate per-field shape upfront. The in-page
    // try/catch (line 103-105) catches selector errors per-field and records
    // them as { __error: ... } so OTHER fields proceed — that's the right
    // behavior for runtime failures (e.g. selector matches nothing). But a
    // STRUCTURAL error (`{ selector: null }`, `{ selector: 123 }`,
    // `{ selector: "" }`, missing `selector` entirely) is a caller bug, not
    // a runtime mismatch — surface it at handler entry with the field name
    // so the user knows EXACTLY which field they got wrong, instead of
    // getting `{ __error: "Failed to execute querySelector: ... is not a
    // valid selector" }` buried in the per-field result.
    for (const [field, spec] of Object.entries(schema)) {
      if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
        return {
          content: [{ type: "text", text: `extract_structured: schema.${field} must be an object with at least { selector }` }],
          isError: true,
        };
      }
      if (typeof spec.selector !== "string" || spec.selector.length === 0) {
        return {
          content: [{ type: "text", text: `extract_structured: schema.${field}.selector must be a non-empty string (got ${JSON.stringify(spec.selector)})` }],
          isError: true,
        };
      }
      if (spec.attribute !== undefined && typeof spec.attribute !== "string") {
        return {
          content: [{ type: "text", text: `extract_structured: schema.${field}.attribute must be a string when provided (got ${typeof spec.attribute})` }],
          isError: true,
        };
      }
      if (spec.multiple !== undefined && typeof spec.multiple !== "boolean") {
        return {
          content: [{ type: "text", text: `extract_structured: schema.${field}.multiple must be boolean when provided (got ${typeof spec.multiple})` }],
          isError: true,
        };
      }
    }
    // F0-9: null means "omitted".
    const maxItems = intArg("extract_structured", "maxItems", args.maxItems, DEFAULT_MAX_ITEMS, 1);
    if (maxItems.error) return errorResult(maxItems.error);
    const maxBytes = intArg("extract_structured", "maxBytes", args.maxBytes, DEFAULT_MAX_BYTES, 1024);
    if (maxBytes.error) return errorResult(maxBytes.error);
    if (navigateToUrl) {
      try { await page.goto(navigateToUrl, { waitUntil: "domcontentloaded" }); }
      catch (e) { return { content: [{ type: "text", text: `nav failed: ${e.message}` }], isError: true }; }
    }
    if (waitForSelector) {
      try { await page.waitForSelector(waitForSelector, { timeout: 30000 }); }
      catch (e) { return { content: [{ type: "text", text: `waitForSelector "${waitForSelector}" failed: ${e.message}` }], isError: true }; }
    }

    // Run extraction in page context (see extractFields).
    let result;
    try {
      result = await page.evaluate(EXTRACT_IN_PAGE, { schema, maxItems: maxItems.value, maxBytes: maxBytes.value });
    } catch (e) {
      return {
        content: [{ type: "text", text: `page.evaluate failed: ${e.message}` }],
        isError: true,
      };
    }

    const payload = { url: page.url(), data: result.data };
    if (Object.keys(result.truncated).length > 0) payload.truncated = result.truncated;
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  },
};
