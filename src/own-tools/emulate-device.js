// emulate_device — applies CDP Emulation overrides to this tab.
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
// STEALTH2-4: the same generator names the navigator.platform for the UA's
// OS, sent as setUserAgentOverride's `platform` (else a Mac UA on a Windows
// host still reports "Win32").
const { clientHintsFromUA, navigatorPlatformFromHints } = require("./_client-hints.js");

// ─── STEALTH2-5: the override on the tab's child targets ─────────────────
// A cross-origin iframe (OOPIF) and a dedicated worker are separate CDP
// targets. Chromium applies UA overrides per DevTools agent host
// (devtools_instrumentation.cc ApplyNetworkRequestOverrides /
// ApplyUserAgentMetadataOverrides → RenderFrameDevToolsAgentHost::GetFor),
// so the page session's override never reaches them: live in Brave 147 an
// OOPIF (e.g. a challenge iframe) reported the host's UA, brands and
// platform, and so did its subresource requests and its workers.
//
// So the page session auto-attaches to its child targets, paused
// (waitForDebuggerOnStart; an OOPIF is held before commit, a worker before
// its script runs), sets the same override on each, auto-attaches to ITS
// children, and resumes it. Non-flat (Target.sendMessageToTarget) because
// Playwright's CDPSession can't address flat child sessions; Chromium still
// supports non-flat auto-attach below browser level (target_handler.cc).
// reset turns auto-attach off: Chromium then detaches those sessions and
// their overrides go with them.
//
// Not covered (documented in the tool description + docs/REFERENCE.md):
//   • service / shared workers: shared by every tab of an origin (other
//     sessions' tabs included), and their navigator.userAgent ignores CDP
//     overrides anyway (live check), so they're filtered out and keep the
//     browser's real UA.
//   • navigator.platform inside ANY worker: WorkerNavigator has no override
//     hook (navigator_base.cc), so it always reports the host OS.
//   • popups the tab opens (new tabs, not children).
const CHILD_TARGETS = new WeakMap(); // page CDP session → { params, autoAttach (Promise | null), root }
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: false,
  filter: [
    { type: "service_worker", exclude: true },
    { type: "shared_worker", exclude: true },
    // Chromium's default filter excludes these two; a custom filter replaces it.
    { type: "browser", exclude: true },
    { type: "tab", exclude: true },
    {},
  ],
};
const OVERRIDDEN_TYPES = new Set(["iframe", "worker"]);

/** Fire-and-forget: a closed target must not surface as an unhandled rejection. */
function fire(node, method, params) {
  try { Promise.resolve(node.send(method, params)).catch(() => {}); } catch { /* target gone */ }
}

/** Per-session child-target state; installs the CDP event listeners once. */
function childTargetsOf(cdp) {
  let state = CHILD_TARGETS.get(cdp);
  if (state) return state;
  state = { params: null, autoAttach: null, root: { send: (m, p) => cdp.send(m, p), children: new Map() } };
  const childOf = (parent, sessionId, type) => {
    let id = 0;
    return {
      type,
      children: new Map(),
      send: (method, params) => parent.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({ id: ++id, method, params: params || {} }),
      }),
    };
  };
  const onEvent = (parent, method, p) => {
    if (method === "Target.attachedToTarget") {
      const type = p.targetInfo && p.targetInfo.type;
      const child = childOf(parent, p.sessionId, type);
      parent.children.set(p.sessionId, child);
      if (state.params && OVERRIDDEN_TYPES.has(type)) {
        fire(child, "Network.setUserAgentOverride", state.params);
        fire(child, "Target.setAutoAttach", AUTO_ATTACH);
      }
      // Always, and last on that session: the target stays paused until
      // every client that auto-attached with waitForDebuggerOnStart resumes it.
      fire(child, "Runtime.runIfWaitingForDebugger");
    } else if (method === "Target.receivedMessageFromTarget") {
      // A child's own events (its children attaching / detaching), wrapped.
      const child = parent.children.get(p.sessionId);
      let msg = null;
      try { msg = JSON.parse(p.message); } catch { /* not JSON */ }
      if (child && msg && msg.method) onEvent(child, msg.method, msg.params || {});
    } else if (method === "Target.detachedFromTarget") {
      parent.children.delete(p.sessionId);
    }
  };
  for (const m of ["Target.attachedToTarget", "Target.receivedMessageFromTarget", "Target.detachedFromTarget"]) {
    cdp.on(m, (p) => { try { onEvent(state.root, m, p || {}); } catch { /* never throw into the emitter */ } });
  }
  CHILD_TARGETS.set(cdp, state);
  return state;
}

/** Apply `params` (setUserAgentOverride args) to current and future child targets. */
async function overrideChildTargets(cdp, params) {
  const state = childTargetsOf(cdp);
  state.params = params;
  (function update(node) {
    for (const child of node.children.values()) {
      if (OVERRIDDEN_TYPES.has(child.type)) fire(child, "Network.setUserAgentOverride", params);
      update(child);
    }
  })(state.root);
  // One in-flight setAutoAttach per session: a concurrent call awaits the
  // same one, so it can't report success for an auto-attach that failed.
  if (!state.autoAttach) {
    state.autoAttach = cdp.send("Target.setAutoAttach", AUTO_ATTACH).catch((e) => {
      state.autoAttach = null; // the next call retries
      throw e;
    });
  }
  await state.autoAttach;
}

module.exports = {
  name: "emulate_device",
  description:
    "Apply device emulation to this tab via CDP Emulation. " +
    "Useful for testing mobile layouts, slow networks, or specific user-agent behavior. " +
    "Overrides stay on that tab across navigations until the tab closes or you call reset:true. " +
    "userAgent also sets matching client hints + navigator.platform and reaches the tab's cross-origin iframes " +
    "and dedicated workers; service/shared workers keep the real UA, and navigator.platform inside workers stays the host's.",
  inputSchema: {
    type: "object",
    properties: {
      reset: {
        type: "boolean",
        description: "Clear every override this tool set on this tab (user agent, viewport, touch, network). Use alone.",
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
      // STEALTH2-5: auto-attach off → Chromium detaches the child sessions,
      // which drops the overrides set through them. The child map is left to
      // their detachedFromTarget events: a child that reports a new target
      // before it is detached must still be able to resume it (params null →
      // resume only).
      const children = CHILD_TARGETS.get(cdp);
      if (children && children.autoAttach) {
        children.params = null;
        children.autoAttach = null;
        sends.push({
          name: "childTargets",
          p: cdp.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: false }),
        });
      }
    }
    if (userAgent) {
      // T2-A: pass userAgentMetadata so Sec-CH-UA-* headers and
      // navigator.userAgentData describe the override UA, not Brave.
      const uaMetadata = clientHintsFromUA(userAgent);
      const uaParams = {
        userAgent,
        userAgentMetadata: uaMetadata,
        platform: navigatorPlatformFromHints(uaMetadata, userAgent),
      };
      sends.push(
        { name: "userAgent", p: cdp.send("Network.setUserAgentOverride", uaParams) },
        { name: "childTargets", p: overrideChildTargets(cdp, uaParams) },
      );
      applied.userAgent = userAgent;
      applied.userAgentMetadata = uaMetadata;
      applied.platform = uaParams.platform;
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
