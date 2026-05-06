// lighthouse_audit — runs Lighthouse against a URL using the slot's CDP port.
// Returns category scores (performance, accessibility, best-practices, seo).

module.exports = {
  name: "lighthouse_audit",
  description:
    "Run a Lighthouse audit against a URL using the relay's Brave instance. " +
    "Returns category scores (performance, accessibility, best-practices, seo). " +
    "The audit runs against a fresh page in the relay's browser; cookies and " +
    "extensions are inherited from the slot's profile.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to audit (must include scheme)" },
      formFactor: {
        type: "string",
        enum: ["desktop", "mobile"],
        default: "desktop",
        description: "Lighthouse form factor",
      },
      onlyCategories: {
        type: "array",
        items: { type: "string", enum: ["performance", "accessibility", "best-practices", "seo", "pwa"] },
        description: "Optional subset of categories to run (defaults to performance + accessibility + best-practices + seo)",
      },
    },
    required: ["url"],
  },
  handler: async ({ url, formFactor = "desktop", onlyCategories }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) {
      return {
        content: [{ type: "text", text: "lighthouse_audit unavailable: relay bridge not initialized (Phase B not active)" }],
        isError: true,
      };
    }
    const lighthouse = (await import("lighthouse")).default;
    const cats = onlyCategories || ["performance", "accessibility", "best-practices", "seo"];
    const result = await lighthouse(url, {
      port: bridge.port,
      output: "json",
      logLevel: "error",
      onlyCategories: cats,
      formFactor,
      screenEmulation: formFactor === "mobile"
        ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
        : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    });
    if (!result || !result.lhr) {
      return {
        content: [{ type: "text", text: "lighthouse returned no result" }],
        isError: true,
      };
    }
    const summary = {};
    for (const [key, cat] of Object.entries(result.lhr.categories || {})) {
      summary[key] = {
        score: cat.score === null ? null : Math.round(cat.score * 100),
        title: cat.title,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ url, formFactor, categories: summary, finalUrl: result.lhr.finalUrl, fetchTime: result.lhr.fetchTime }, null, 2) }],
    };
  },
};
