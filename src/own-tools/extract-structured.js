// extract_structured — schema-driven data extraction from the active page.
// Schema is { fieldName: { selector, attribute?, multiple? }, ... }.
// Uses the authed session — sees logged-in content unlike unauthenticated scrapers.

const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "extract_structured",
  description:
    "Extract structured data from the active page using a CSS-selector schema. " +
    "Schema shape: { fieldName: { selector: 'css', attribute?: 'textContent'|'innerText'|'innerHTML'|'href'|'src'|'value'|attr-name, multiple?: boolean } }. " +
    "Default attribute is 'textContent' (fast, includes hidden content). Use 'innerText' explicitly when you need rendered text only (forces page layout — slow on large lists). " +
    "Returns object with fields populated from the page. Use for authenticated/logged-in content.",
  inputSchema: {
    type: "object",
    properties: {
      navigateToUrl: {
        type: "string",
        description: "Optional URL to navigate to before extracting.",
      },
      waitForSelector: {
        type: "string",
        description: "Optional CSS selector to wait for before extracting (ensures page is ready).",
      },
      schema: {
        type: "object",
        minProperties: 1,
        description: "Field schema. Each value is { selector, attribute?, multiple? }. Must have at least one field.",
        additionalProperties: {
          type: "object",
          properties: {
            selector: { type: "string" },
            attribute: {
              type: "string",
              examples: ["textContent", "innerText", "innerHTML", "href", "src", "value"],
              description: "textContent (default — fast, includes hidden content), innerText (rendered-only, forces layout), innerHTML, href, src, value, or any HTML attribute name.",
            },
            multiple: { type: "boolean", default: false, description: "If true, return array of all matches." },
          },
          required: ["selector"],
        },
      },
    },
    required: ["schema"],
  },
  handler: async ({ navigateToUrl, waitForSelector, schema }) => withActivePage(async ({ page }) => {
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
    if (navigateToUrl) {
      try { await page.goto(navigateToUrl, { waitUntil: "domcontentloaded" }); }
      catch (e) { return { content: [{ type: "text", text: `nav failed: ${e.message}` }], isError: true }; }
    }
    if (waitForSelector) {
      try { await page.waitForSelector(waitForSelector, { timeout: 30000 }); }
      catch (e) { return { content: [{ type: "text", text: `waitForSelector "${waitForSelector}" failed: ${e.message}` }], isError: true }; }
    }

    // Run extraction in page context. Each field is wrapped in try/catch so a
    // bad selector for one field doesn't kill the whole extraction — the
    // failing field gets { __error: "..." } and other fields proceed.
    let result;
    try {
      result = await page.evaluate((schema) => {
        const out = {};
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
        for (const [field, spec] of Object.entries(schema)) {
          try {
            const attr = spec.attribute || "textContent";
            if (spec.multiple) {
              const els = Array.from(document.querySelectorAll(spec.selector));
              out[field] = els.map((el) => readAttr(el, attr));
            } else {
              const el = document.querySelector(spec.selector);
              out[field] = readAttr(el, attr);
            }
          } catch (e) {
            out[field] = { __error: e.message };
          }
        }
        return out;
      }, schema);
    } catch (e) {
      return {
        content: [{ type: "text", text: `page.evaluate failed: ${e.message}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ url: page.url(), data: result }, null, 2),
      }],
    };
  }),
};
