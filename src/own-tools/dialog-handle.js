// dialog_handle — registers a one-shot listener for the next dialog
// (alert/confirm/prompt) on the active page. Use this BEFORE triggering an
// action that opens a dialog.

module.exports = {
  name: "dialog_handle",
  description:
    "Register a one-shot handler for the NEXT JavaScript dialog (alert/confirm/prompt) " +
    "on the active page. Call this BEFORE the action that triggers the dialog. " +
    "The handler resolves when the dialog appears and is auto-dismissed.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["accept", "dismiss"], default: "accept" },
      promptText: { type: "string", description: "Text to type into a prompt dialog (only for action=accept)" },
      timeoutMs: { type: "integer", default: 30000, description: "Max wait for the dialog to appear" },
    },
  },
  handler: async ({ action = "accept", promptText, timeoutMs = 30000 }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const pages = bridge.context.pages();
    if (pages.length === 0) {
      return { content: [{ type: "text", text: "no pages open" }], isError: true };
    }
    const page = pages[0];
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        page.off("dialog", onDialog);
        resolve({ content: [{ type: "text", text: `timeout: no dialog appeared within ${timeoutMs}ms` }], isError: true });
      }, timeoutMs);
      const onDialog = async (dialog) => {
        clearTimeout(timer);
        const info = { type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue?.() };
        try {
          if (action === "accept") await dialog.accept(promptText);
          else await dialog.dismiss();
          resolve({ content: [{ type: "text", text: JSON.stringify({ handled: action, ...info }, null, 2) }] });
        } catch (e) {
          resolve({ content: [{ type: "text", text: `dialog handle failed: ${e.message}` }], isError: true });
        }
      };
      page.once("dialog", onDialog);
    });
  },
};
