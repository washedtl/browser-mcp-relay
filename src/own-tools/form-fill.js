// form_fill — fills multiple form fields in one call (selector + value pairs).
// Each field calls page.fill(selector, value) sequentially. Stops on first failure
// (returning the partial-fill state for diagnosis).

const { withActivePage } = require("./_active-page.js");

// T1-11: page.fill default timeout is 30s. With N fields, a flaky page that
// blocks element-resolution can hang the tool for 30s × N. Shorter per-field
// default + tunable knob + opt-in continueOnError makes form_fill resilient
// without breaking the existing fail-fast semantics.

module.exports = {
  name: "form_fill",
  description:
    "Fill multiple form fields on the active page in one call. Each field is " +
    "{ selector, value }. By default fills sequentially and stops on first " +
    "failure (returning partial state). Set `continueOnError: true` to attempt " +
    "every field regardless of failures. `timeoutMs` caps each field's wait " +
    "(default 5000ms — Playwright's default 30000ms is too long when stacking " +
    "many fields against a slow page). Useful when you have many text inputs " +
    "and want one round-trip.",
  inputSchema: {
    type: "object",
    properties: {
      fields: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            selector: { type: "string" },
            value: { type: "string" },
          },
          required: ["selector", "value"],
        },
      },
      timeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 60000,
        default: 5000,
        description: "Per-field timeout for the fill operation in ms (default 5000). Total time is roughly fields.length × timeoutMs in the worst case.",
      },
      continueOnError: {
        type: "boolean",
        default: false,
        description: "If true, attempt every field even after a failure. Result includes per-field ok/error. Default false (fail-fast).",
      },
    },
    required: ["fields"],
  },
  handler: async (_args = {}) => withActivePage(async ({ page }) => {
    // F0-9 reviewer V1 (2026-05-10): treat null/undefined as missing for
    // every defaulted parameter. JSON-RPC clients sending {"timeoutMs":null}
    // would otherwise propagate `null` to page.fill which throws cryptically.
    const fields = _args.fields;
    const timeoutMs = (_args.timeoutMs == null) ? 5000 : _args.timeoutMs;
    const continueOnError = !!_args.continueOnError;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) {
      return {
        content: [{ type: "text", text: `form_fill: timeoutMs must be a finite integer in [100, 60000] (got ${JSON.stringify(_args.timeoutMs)})` }],
        isError: true,
      };
    }
    // F0-3 (2026-05-10): validate fields is an array of objects upfront.
    // JSON-RPC clients can send anything; without this guard, `for...of`
    // crashes with `TypeError: fields is not iterable` on null/object,
    // and per-field `f.selector` access throws cryptically on null entries.
    if (!Array.isArray(fields)) {
      return {
        content: [{ type: "text", text: "form_fill: fields must be an array of {selector, value}" }],
        isError: true,
      };
    }
    if (fields.length === 0) {
      return {
        content: [{ type: "text", text: "form_fill: fields array is empty (no-op)" }],
        isError: true,
      };
    }
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (!f || typeof f !== "object" || typeof f.selector !== "string" || typeof f.value !== "string") {
        return {
          content: [{ type: "text", text: `form_fill: fields[${i}] must be an object with string selector + value` }],
          isError: true,
        };
      }
    }

    const filled = [];
    for (const f of fields) {
      try {
        // T1-11: pass through the per-field timeout to Playwright.
        await page.fill(f.selector, f.value, { timeout: timeoutMs });
        filled.push({ selector: f.selector, ok: true });
      } catch (e) {
        filled.push({ selector: f.selector, ok: false, error: e.message });
        if (!continueOnError) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                filledCount: filled.filter((x) => x.ok).length,
                total: fields.length,
                failed: f,
                partial: filled,
              }, null, 2),
            }],
            isError: true,
          };
        }
      }
    }
    const okCount = filled.filter((x) => x.ok).length;
    const allOk = okCount === fields.length;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          filledCount: okCount,
          total: fields.length,
          all: filled,
        }, null, 2),
      }],
      ...(allOk ? {} : { isError: true }),
    };
  }),
};
