// file_upload — sets file input via Playwright's setInputFiles.
// Bypasses the OS file picker dialog entirely.

const { getActivePage } = require("./_active-page.js");

module.exports = {
  name: "file_upload",
  description:
    "Set files on a file input element by selector. Bypasses the OS file picker. " +
    "Files must already exist on disk; provide absolute paths.",
  inputSchema: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS or Playwright selector for the file input" },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Absolute paths to files to upload",
      },
    },
    required: ["selector", "files"],
  },
  handler: async ({ selector, files }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    // Use the tracked active page (set by tabs_new / tabs_select) — not
    // pages[0] which is Brave's auto-opened about:blank. See _active-page.js.
    const page = getActivePage(bridge.context);
    if (!page) return { content: [{ type: "text", text: "no pages open" }], isError: true };
    const locator = page.locator(selector);
    await locator.setInputFiles(files);
    return { content: [{ type: "text", text: JSON.stringify({ selector, uploaded: files }, null, 2) }] };
  },
};
