// relay-server.js — the MCP server that Cursor talks to. Forwards tools/call
// to upstream OR to our own-tool handlers based on the tool name. Merges
// upstream's tools/list with our own tool list.
//
// Two async dependencies (both injected by the entrypoint):
//   - getUpstream(): returns the upstream MCP client. Called by tools/list
//     AND tools/call. Cheap once cached. Spawning upstream is fast (~50MB
//     node process); upstream's tools/list returns its static catalog
//     without needing a browser.
//   - ensureBrave(): launches our Brave instance via Playwright. Slow
//     (~3-5s, ~250MB). Called ONLY by tools/call (own-tools need the
//     globalThis.__relayBridge handle; forwarded tools need Brave running
//     so upstream's lazy `chromium.connectOverCDP` succeeds when its tool
//     handler runs).
//
// Splitting these means tools/list (Cursor's first call at MCP connect)
// does NOT trigger Brave launch. Brave only spins up when something
// actually needs to drive a browser.

class RelayServer {
  constructor({ getUpstream, ensureBrave } = {}) {
    if (typeof getUpstream !== "function") {
      throw new Error("RelayServer: constructor expects { getUpstream } async function");
    }
    if (ensureBrave != null && typeof ensureBrave !== "function") {
      throw new Error("RelayServer: ensureBrave, if provided, must be an async function");
    }
    this.getUpstream = getUpstream;
    this.ensureBrave = ensureBrave || null;
    this.ownTools = new Map(); // name → { name, description, inputSchema, handler }
  }

  registerOwnTool({ name, description, inputSchema, handler }) {
    if (this.ownTools.has(name)) {
      throw new Error(`relay: tool "${name}" already registered`);
    }
    if (typeof handler !== "function") {
      throw new Error(`relay: tool "${name}" handler must be a function`);
    }
    this.ownTools.set(name, { name, description, inputSchema, handler });
  }

  async handleToolsList() {
    // tools/list does NOT need Brave. Upstream's catalog is static (registered
    // at upstream startup), and own-tool definitions are static. We only need
    // upstream spawned to ask it for its catalog — that's it.
    const upstream = await this.getUpstream();
    const upstreamResponse = await upstream.request("tools/list", {});
    const upstreamTools = upstreamResponse.tools || [];
    const ownTools = Array.from(this.ownTools.values()).map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    }));
    for (const ours of ownTools) {
      if (upstreamTools.some((u) => u.name === ours.name)) {
        throw new Error(
          `relay: tool name collision — upstream and relay both expose "${ours.name}". Rename the relay tool or remove the upstream one.`,
        );
      }
    }
    return { tools: [...upstreamTools, ...ownTools] };
  }

  async handleToolsCall({ name, arguments: args }) {
    const own = this.ownTools.get(name);
    if (own) {
      // Own-tool handlers read globalThis.__relayBridge. ensureBrave populates
      // that. Always call it before invoking the own-tool handler.
      if (this.ensureBrave) await this.ensureBrave();
      try {
        return await own.handler(args || {});
      } catch (e) {
        return {
          content: [{ type: "text", text: `[mcp-relay] tool "${name}" failed: ${e.message}` }],
          isError: true,
        };
      }
    }
    // Forwarded tool — upstream's tool handler will lazily try to attach to
    // our Brave via CDP. Brave must be running first.
    if (this.ensureBrave) await this.ensureBrave();
    const upstream = await this.getUpstream();
    return await upstream.request("tools/call", { name, arguments: args });
  }
}

module.exports = { RelayServer };
