// extract_structured — schema-driven data extraction from the active page.
// Schema is { fieldName: { selector, attribute?, multiple? }, ... }.
// Uses the authed session — sees logged-in content unlike unauthenticated scrapers.

const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "extract_structured",
  description:
    "Extract structured data from the active page using a CSS-selector schema. " +
    "Schema shape: { fieldName: { selector: 'css', attribute?: 'innerText'|'href'|'src'|attr-name, multiple?: boolean } }. " +
    "Default attribute is 'innerText'. Returns object with fields populated from " +
    "the page. Use this instead of firecrawl-agent when you need authenticated/logged-in content.",
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
        description: "Field schema. Each value is { selector, attribute?, multiple? }.",
        additionalProperties: {
          type: "object",
          properties: {
            selector: { type: "string" },
            attribute: { type: "string", description: "innerText, textContent, innerHTML, href, src, value, or any HTML attribute. Default: innerText." },
            multiple: { type: "boolean", default: false, description: "If true, return array of all matches." },
          },
          required: ["selector"],
        },
      },
    },
    required: ["schema"],
  },
  handler: async ({ navigateToUrl, waitForSelector, schema }) => withActivePage(async ({ page }) => {
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
          if (attr === "innerText") return el.innerText;
          if (attr === "textContent") return el.textContent;
          if (attr === "innerHTML") return el.innerHTML;
          return el.getAttribute(attr);
        };
        for (const [field, spec] of Object.entries(schema)) {
          try {
            const attr = spec.attribute || "innerText";
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
