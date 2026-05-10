// file_upload — sets file input via Playwright's setInputFiles.
// Bypasses the OS file picker dialog entirely.

const { withActivePage } = require("./_active-page.js");

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
  handler: async ({ selector, files }) => withActivePage(async ({ page }) => {
    // V0-6: wrap setInputFiles so a bad selector / missing file / permission
    // error returns a structured `{ ok: false, error }` shape instead of
    // throwing into relay-server's generic catch.
    const locator = page.locator(selector);
    try {
      await locator.setInputFiles(files);
    } catch (e) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, selector, files, error: e.message || String(e) }, null, 2),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [
        { type: "text", text: JSON.stringify({ ok: true, selector, uploaded: files }, null, 2) },
      ],
    };
  }),
};
