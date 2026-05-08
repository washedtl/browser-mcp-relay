// emulate_device — applies CDP Emulation overrides to the active page.
// User-agent, viewport, device scale factor, mobile/touch flags, network throttle.
//
// V0-3: CDP `Emulation.*` overrides are session-scoped — they revert when
// the CDP session detaches. The previous implementation called `cdp.detach()`
// in a finally block immediately after `setUserAgentOverride` etc., so the
// overrides reverted ~milliseconds after the tool returned (silently doing
// nothing). Fix: keep the CDP session alive for the lifetime of the page,
// keyed in a per-page WeakMap so callers don't accidentally double-attach.
// Auto-cleanup on page close.

const { getOrCreatePageCdp } = require("./_page-cdp-session.js");

module.exports = {
  name: "emulate_device",
  description:
    "Apply device emulation to the active page via CDP Emulation. " +
    "Useful for testing mobile layouts, slow networks, or specific user-agent behavior. " +
    "Persists until the page navigates or the page is closed.",
  inputSchema: {
    type: "object",
    properties: {
      userAgent: { type: "string", description: "User-Agent header override" },
      viewport: {
        type: "object",
        properties: {
          width: { type: "integer", minimum: 100, maximum: 4096 },
          height: { type: "integer", minimum: 100, maximum: 4096 },
          deviceScaleFactor: { type: "number", default: 1 },
          mobile: { type: "boolean", default: false },
          hasTouch: { type: "boolean", default: false },
        },
        required: ["width", "height"],
      },
      network: {
        type: "object",
        description: "Network conditions (offline / throttled). All fields optional.",
        properties: {
          offline: { type: "boolean", default: false },
          downloadKbps: { type: "integer", description: "Download throughput in kbps; -1 = no throttle" },
          uploadKbps: { type: "integer", description: "Upload throughput in kbps; -1 = no throttle" },
          latencyMs: { type: "integer", description: "Round-trip latency in ms" },
        },
      },
    },
  },
  handler: async ({ userAgent, viewport, network }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) {
      return { content: [{ type: "text", text: "emulate_device unavailable: bridge missing" }], isError: true };
    }
    const pages = bridge.context.pages();
    if (pages.length === 0) {
      return { content: [{ type: "text", text: "no pages open" }], isError: true };
    }
    const page = pages[0];
    // V0-3: do NOT detach after applying — Emulation overrides revert on
    // detach. The session stays alive for the page's lifetime.
    const cdp = await getOrCreatePageCdp(page, bridge.context);
    const applied = {};
    if (userAgent) {
      await cdp.send("Network.setUserAgentOverride", { userAgent });
      applied.userAgent = userAgent;
    }
    if (viewport) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
        mobile: !!viewport.mobile,
      });
      if (viewport.hasTouch) {
        await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      }
      applied.viewport = viewport;
    }
    if (network) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: !!network.offline,
        downloadThroughput: network.downloadKbps != null ? (network.downloadKbps * 1024 / 8) : -1,
        uploadThroughput: network.uploadKbps != null ? (network.uploadKbps * 1024 / 8) : -1,
        latency: network.latencyMs ?? 0,
      });
      applied.network = network;
    }
    return { content: [{ type: "text", text: JSON.stringify({ applied }, null, 2) }] };
  },
};
