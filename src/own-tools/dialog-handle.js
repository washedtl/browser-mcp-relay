// dialog_handle — registers a one-shot listener for the next dialog
// (alert/confirm/prompt) on the active page. Use this BEFORE triggering an
// action that opens a dialog.
//
// T0-9 / T0-10 / T1-12 fixes (2026-05-09):
//   • short-circuit on page close — without it, waiting for a dialog on a page
//     that gets closed mid-wait hangs until timeoutMs (default 30s)
//   • dialog.defaultValue() is a method, not a getter — drop the `?.` to
//     surface API breakage if the Playwright contract ever changes
//   • description corrected: "auto-dismissed" was wrong (default is `accept`,
//     and the action parameter controls accept-vs-dismiss)

const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "dialog_handle",
  description:
    "Register a one-shot handler for the NEXT JavaScript dialog (alert/confirm/prompt) " +
    "on the active page. Call this BEFORE the action that triggers the dialog. " +
    "The handler resolves when the dialog appears and is auto-handled per the " +
    "`action` parameter (accept by default, or dismiss). For prompts, set " +
    "`promptText` to inject a value. If the page closes during the wait, the " +
    "handler resolves immediately with isError + a `pageClosed: true` flag.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["accept", "dismiss"], default: "accept" },
      promptText: { type: "string", description: "Text to type into a prompt dialog (only for action=accept)" },
      timeoutMs: { type: "integer", default: 30000, description: "Max wait for the dialog to appear" },
    },
  },
  handler: async ({ action = "accept", promptText, timeoutMs = 30000 }) => withActivePage(async ({ page }) => {
    return await new Promise((resolve) => {
      // V1-3: if the timeout fires AND the dialog arrives in the same tick,
      // both branches would resolve the promise (only the first take effect)
      // and the dialog would still be auto-accepted by Playwright after the
      // caller already saw a timeout. The `settled` guard prevents the
      // second branch from firing at all — exactly one outcome.
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        page.off("dialog", onDialog);
        page.off("close", onClose);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ content: [{ type: "text", text: `timeout: no dialog appeared within ${timeoutMs}ms` }], isError: true });
      }, timeoutMs);

      // T0-9: short-circuit if the page closes before a dialog fires.
      // Without this, waitForEvent("dialog") on a closed page would hang
      // until the timeoutMs (default 30s).
      const onClose = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          content: [{ type: "text", text: JSON.stringify({ pageClosed: true, error: "page was closed before any dialog appeared" }, null, 2) }],
          isError: true,
        });
      };

      const onDialog = async (dialog) => {
        if (settled) return;
        settled = true;
        cleanup();
        // T0-10: defaultValue is a method on Playwright's Dialog, not a
        // property. Calling it directly (no `?.`) returns the prompt's
        // default value as a string — empty string for non-prompt dialogs.
        // The previous `dialog.defaultValue?.()` always returned undefined
        // because the optional-chaining call only fires when defaultValue
        // is callable AND truthy, but the dead-code path was never noticed.
        let defaultValue = "";
        try { defaultValue = dialog.defaultValue(); } catch { /* not a prompt */ }
        const info = { type: dialog.type(), message: dialog.message(), defaultValue };
        try {
          if (action === "accept") await dialog.accept(promptText);
          else await dialog.dismiss();
          resolve({ content: [{ type: "text", text: JSON.stringify({ handled: action, ...info }, null, 2) }] });
        } catch (e) {
          resolve({ content: [{ type: "text", text: `dialog handle failed: ${e.message}` }], isError: true });
        }
      };

      page.once("dialog", onDialog);
      page.once("close", onClose);
    });
  }),
};
