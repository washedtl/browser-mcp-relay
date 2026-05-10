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
    // F0-4 (2026-05-10): validate selector + files upfront. Without this,
    // `files: null` crashes Playwright with "Cannot read properties of null",
    // `files: "string"` produces a confusing "expected array" error,
    // `files: []` silently CLEARS the input (likely surprising — schema
    // requires non-empty), and `files: ["", "real.png"]` produces an
    // ENOENT for the empty path.
    if (typeof selector !== "string" || selector.length === 0) {
      return {
        content: [{ type: "text", text: "file_upload: selector must be a non-empty string" }],
        isError: true,
      };
    }
    if (!Array.isArray(files)) {
      return {
        content: [{ type: "text", text: "file_upload: files must be an array of absolute paths" }],
        isError: true,
      };
    }
    if (files.length === 0) {
      return {
        content: [{ type: "text", text: "file_upload: files array is empty. To clear an input, the caller must explicitly opt in (this tool requires at least one path)" }],
        isError: true,
      };
    }
    for (let i = 0; i < files.length; i++) {
      if (typeof files[i] !== "string" || files[i].length === 0) {
        return {
          content: [{ type: "text", text: `file_upload: files[${i}] must be a non-empty string (absolute path)` }],
          isError: true,
        };
      }
    }
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
