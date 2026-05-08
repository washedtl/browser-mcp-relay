// form_fill — fills multiple form fields in one call (selector + value pairs).
// Each field calls page.fill(selector, value) sequentially. Stops on first failure
// (returning the partial-fill state for diagnosis).

const { getActivePage } = require("./_active-page.js");

module.exports = {
  name: "form_fill",
  description:
    "Fill multiple form fields on the active page in one call. Each field is " +
    "{ selector, value }. Fills sequentially; on first failure returns partial-fill state " +
    "with the failing field. Useful when you have many text inputs and want one round-trip.",
  inputSchema: {
    type: "object",
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            selector: { type: "string" },
            value: { type: "string" },
          },
          required: ["selector", "value"],
        },
      },
    },
    required: ["fields"],
  },
  handler: async ({ fields }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    // Use the tracked active page (set by tabs_new / tabs_select) — not
    // pages[0] which is Brave's auto-opened about:blank. See _active-page.js.
    const page = getActivePage(bridge.context);
    if (!page) return { content: [{ type: "text", text: "no pages open" }], isError: true };
    const filled = [];
    for (const f of fields) {
      try {
        await page.fill(f.selector, f.value);
        filled.push({ selector: f.selector, ok: true });
      } catch (e) {
        filled.push({ selector: f.selector, ok: false, error: e.message });
        return {
          content: [{ type: "text", text: JSON.stringify({ filledCount: filled.filter(x => x.ok).length, total: fields.length, failed: f, partial: filled }, null, 2) }],
          isError: true,
        };
      }
    }
    return { content: [{ type: "text", text: JSON.stringify({ filledCount: filled.length, total: fields.length, all: filled }, null, 2) }] };
  },
};
