// form_fill — fills multiple form fields in one call (selector + value pairs).
// Each field calls page.fill(selector, value) sequentially. Stops on first failure
// (returning the partial-fill state for diagnosis).

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
    const pages = bridge.context.pages();
    if (pages.length === 0) return { content: [{ type: "text", text: "no pages open" }], isError: true };
    const page = pages[0];
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
