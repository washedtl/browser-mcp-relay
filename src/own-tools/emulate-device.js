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
// T2-A (v0.3.5) → W1D: CDP's `Network.setUserAgentOverride` takes a
// `userAgentMetadata` arg that Chromium uses for BOTH the HTTP Sec-CH-UA-*
// headers and the page's navigator.userAgentData. Overriding the UA without
// it blanks the client hints (an obvious tell). The metadata now comes from
// the one generator stealth_apply also uses, so header + JS values agree.
const { clientHintsFromUA } = require("./_client-hints.js");

module.exports = {
  name: "emulate_device",
  description:
    "Apply device emulation to the active page via CDP Emulation. " +
    "Useful for testing mobile layouts, slow networks, or specific user-agent behavior. " +
    "Overrides stay on that tab across navigations until the tab closes or you call reset:true.",
  inputSchema: {
    type: "object",
    properties: {
      reset: {
        type: "boolean",
        description: "Clear every override this tool set on the active page (user agent, viewport, touch, network). Use alone.",
      },
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
  handler: async ({ reset, userAgent, viewport, network }, { page, context }) => {
    // W1D-4: reset is all-or-nothing. Mixing it with overrides would race
    // "clear" against "set" across CDP domains, so reject the combination.
    if (reset && (userAgent || viewport || network)) {
      return {
        content: [{ type: "text", text: "emulate_device: reset:true can't be combined with userAgent / viewport / network. Call reset alone, then apply new overrides." }],
        isError: true,
      };
    }
    // T1-9: validate viewport.{width, height} when a viewport block is provided.
    // The schema declares them required, but JSON-RPC + the MCP SDK don't
    // enforce nested-required. CDP throws an opaque ParameterError on
    // missing dimensions; this guard surfaces the issue at handler entry.
    if (viewport && (typeof viewport !== "object" || viewport.width == null || viewport.height == null)) {
      return {
        content: [{ type: "text", text: "emulate_device: viewport requires both width and height (got " + JSON.stringify(viewport) + ")" }],
        isError: true,
      };
    }

    // V0-3: do NOT detach after applying — Emulation overrides revert on
    // detach. The session stays alive for the page's lifetime.
    const cdp = await getOrCreatePageCdp(page, context);
    const applied = {};

    // T1-2: build the list of CDP commands and dispatch in parallel.
    // Each Emulation.* / Network.* override is independent, so parallel
    // dispatch saves ~30-80ms vs the previous sequential round-trips.
    //
    // Reviewer V1 (2026-05-09): use Promise.allSettled so a partial failure
    // (e.g. CDP rejects setDeviceMetricsOverride mid-flight) returns a
    // structured per-command result instead of short-circuiting and leaving
    // the page in a half-applied state with no diagnostics.
    const sends = [];
    if (reset) {
      // W1D-4: undo everything this tool can set. An empty userAgent is
      // CDP's "no override" (metadata must not accompany it); -1 throughput
      // = no throttling.
      sends.push(
        { name: "userAgent", p: cdp.send("Network.setUserAgentOverride", { userAgent: "" }) },
        { name: "viewport", p: cdp.send("Emulation.clearDeviceMetricsOverride") },
        { name: "touch", p: cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }) },
        {
          name: "network",
          p: cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }),
        },
      );
    }
    if (userAgent) {
      // T2-A: pass userAgentMetadata so Sec-CH-UA-* headers and
      // navigator.userAgentData describe the override UA, not Brave.
      const uaMetadata = clientHintsFromUA(userAgent);
      sends.push({
        name: "userAgent",
        p: cdp.send("Network.setUserAgentOverride", {
          userAgent,
          userAgentMetadata: uaMetadata,
        }),
      });
      applied.userAgent = userAgent;
      applied.userAgentMetadata = uaMetadata;
    }
    if (viewport) {
      sends.push({
        name: "viewport",
        p: cdp.send("Emulation.setDeviceMetricsOverride", {
          width: viewport.width,
          height: viewport.height,
          deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
          mobile: !!viewport.mobile,
        }),
      });
      // T1-8: always send setTouchEmulationEnabled with the requested state.
      // Previously it was only sent when hasTouch was truthy — calling
      // emulate_device twice (once with hasTouch:true, once with false)
      // would leave touch enabled because the second call never sent the
      // "disable" command. Always sending makes the touch state idempotent.
      sends.push({
        name: "touch",
        p: cdp.send("Emulation.setTouchEmulationEnabled", { enabled: !!viewport.hasTouch }),
      });
      applied.viewport = viewport;
    }
    if (network) {
      // F0-9 (2026-05-10): coerce numeric fields with Number.isFinite guard.
      // Pre-fix, NaN/Infinity from the wire would silently propagate to CDP
      // which rejects with an opaque error.
      const finiteOrSentinel = (v) => Number.isFinite(v) ? v : -1;
      sends.push({
        name: "network",
        p: cdp.send("Network.emulateNetworkConditions", {
          offline: !!network.offline,
          downloadThroughput: network.downloadKbps != null ? (finiteOrSentinel(Number(network.downloadKbps)) * 1024 / 8) : -1,
          uploadThroughput: network.uploadKbps != null ? (finiteOrSentinel(Number(network.uploadKbps)) * 1024 / 8) : -1,
          latency: Number.isFinite(network.latencyMs) ? network.latencyMs : 0,
        }),
      });
      applied.network = network;
    }
    const results = await Promise.allSettled(sends.map((s) => s.p));
    const failed = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        failed.push({ name: sends[i].name, error: r.reason && (r.reason.message || String(r.reason)) });
      }
    });
    const summary = reset ? { reset: sends.map((s) => s.name) } : { applied };
    const result = {
      content: [{
        type: "text",
        text: JSON.stringify({ ...summary, failed: failed.length ? failed : undefined }, null, 2),
      }],
    };
    if (failed.length) result.isError = true;
    return result;
  },
  // T2-A: test seam, kept under its old name (docs/BACKLOG.md cites it).
  // Same function stealth_apply runs in-page.
  synthesizeUserAgentMetadata: clientHintsFromUA,
};
