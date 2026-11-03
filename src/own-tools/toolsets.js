// own-tools/toolsets.js — hidden-by-default tool groups + the `toolsets` tool.
//
// Specialist upstream tools nobody needs for everyday browsing are hidden
// from tools/list to save the client's context. Owner rule: the agent must
// ASK THE USER before turning a group on; that wording lives in the tool
// description and in the error a hidden-tool call returns. Groups can be
// pre-enabled with BROWSER_RELAY_TOOLSETS=debug,react (or "all").
//
// State lives on the RelayServer (enabledToolsets / setToolsetsEnabled);
// the handler reads it from ctx.relay.

const TRACE_TOOLS = new Set(["o11y_get-trace-context", "o11y_new-trace-id", "o11y_set-trace-context"]);

const TOOLSETS = {
  debug: { about: "JS debugger probes: tracepoints, logpoints, watches", match: (n) => n.startsWith("debug_") },
  react: { about: "React component <-> DOM lookup", match: (n) => n.startsWith("react_") },
  scenario: { about: "saved multi-step tool scripts", match: (n) => n.startsWith("scenario-") },
  trace: { about: "OpenTelemetry trace-id context", match: (n) => TRACE_TOOLS.has(n) },
};
const TOOLSET_NAMES = Object.keys(TOOLSETS);

function toolsetOf(toolName) {
  return TOOLSET_NAMES.find((set) => TOOLSETS[set].match(toolName)) || null;
}

/** "debug, react" | ["debug"] | "all" → { sets, unknown } */
function parseToolsets(input) {
  const items = Array.isArray(input) ? input : String(input || "").split(",");
  const sets = new Set();
  const unknown = [];
  for (const raw of items) {
    const name = String(raw).trim().toLowerCase();
    if (!name) continue;
    if (name === "all") TOOLSET_NAMES.forEach((s) => sets.add(s));
    else if (TOOLSETS[name]) sets.add(name);
    else unknown.push(name);
  }
  return { sets: TOOLSET_NAMES.filter((s) => sets.has(s)), unknown };
}

function hiddenToolMessage(toolName, set) {
  return (
    `Tool "${toolName}" belongs to the "${set}" toolset, which is hidden by default to save context. ` +
    `Do not enable it yourself: ask the user whether to turn on the "${set}" toolset for this task. ` +
    `Only if they agree, call toolsets {"action":"enable","sets":["${set}"]} and retry.`
  );
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

const tool = {
  name: "toolsets",
  description:
    "List or change optional tool groups. These exist but are hidden by default to save context: " +
    TOOLSET_NAMES.map((s) => `${s} (${TOOLSETS[s].about})`).join(", ") + ". " +
    "If a task would clearly benefit from one, ASK THE USER first and enable it only after they agree; " +
    "never enable a group on your own. action=list (default) shows each group and its tools; " +
    "enable/disable take sets[]. Where the client supports it, enable also shows the user an approve/decline " +
    "prompt; if they decline, do not retry.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "enable", "disable"], default: "list" },
      sets: { type: "array", items: { type: "string", enum: [...TOOLSET_NAMES, "all"] } },
    },
    additionalProperties: false,
  },
  // Relay-local: toggling visibility never needs a browser.
  needsBrave: false,
  async handler(args, { relay }) {
    const action = args.action || "list";
    const toolsIn = async (sets) =>
      (await relay.upstreamCatalog()).map((t) => t.name).filter((n) => sets.includes(toolsetOf(n)));

    if (action === "list") {
      const members = Object.fromEntries(TOOLSET_NAMES.map((s) => [s, []]));
      for (const name of await toolsIn(TOOLSET_NAMES)) members[toolsetOf(name)].push(name);
      const toolsets = TOOLSET_NAMES.map((name) => ({
        name, enabled: relay.enabledToolsets.has(name), about: TOOLSETS[name].about, tools: members[name],
      }));
      return ok({ toolsets, note: "Ask the user before enabling a group." });
    }
    if (action !== "enable" && action !== "disable") {
      return fail(`[toolsets] unknown action "${action}". Use list, enable or disable.`);
    }
    const { sets, unknown } = parseToolsets(args.sets);
    if (unknown.length || sets.length === 0) {
      const problem = unknown.length ? `unknown toolset(s): ${unknown.join(", ")}` : "sets is required";
      return fail(`[toolsets] ${problem}. Valid: ${TOOLSET_NAMES.join(", ")} (or all).`);
    }

    // Owner rule: the user decides. When the client supports MCP elicitation
    // the user gets a real approve/decline prompt; otherwise (null) the agent
    // must already have asked in chat, per the description.
    let userApproved;
    const toEnable = action === "enable" ? sets.filter((s) => !relay.enabledToolsets.has(s)) : [];
    if (toEnable.length) {
      const counts = Object.fromEntries(toEnable.map((s) => [s, 0]));
      for (const name of await toolsIn(toEnable)) counts[toolsetOf(name)]++;
      const answer = await relay.askUser({
        message:
          `Your AI wants to turn on hidden tool group${toEnable.length > 1 ? "s" : ""}: ` +
          toEnable.map((s) => `"${s}" (${counts[s]} tools: ${TOOLSETS[s].about})`).join("; ") +
          ". They stay available until the MCP server restarts. Allow?",
        requestedSchema: { type: "object", properties: {} },
      });
      if (answer && answer.action !== "accept") {
        const noAnswer = answer.action === "timeout";
        return ok({
          action,
          changed: [],
          declined: true,
          note: noAnswer
            ? `No answer from the user to the approval prompt; ${toEnable.join(", ")} stays hidden. Ask the user in chat before trying again.`
            : `The user declined enabling ${toEnable.join(", ")}. Do not enable it or retry; continue without these tools.`,
        });
      }
      if (answer) userApproved = true;
    }

    const changed = relay.setToolsetsEnabled(sets, action === "enable");
    const enabled = TOOLSET_NAMES.filter((s) => relay.enabledToolsets.has(s));
    const restartHint = `set BROWSER_RELAY_TOOLSETS=${enabled.join(",") || "\"\""} in the relay's env (or local-config.json) and restart the MCP server`;
    let note;
    if (changed.length === 0) note = "No change.";
    else if (relay.canNotify) {
      note = "Sent notifications/tools/list_changed so the client refreshes its tool list. If the change does not " +
        `show up, the client ignores that notification: ${restartHint}.`;
    } else {
      note = "This relay cannot notify the client of tool-list changes, so the client's tool list only updates when " +
        `it re-fetches tools/list. To be sure the change shows up, ${restartHint}.`;
    }
    return ok({ action, changed, enabled, tools: await toolsIn(changed), userApproved, note });
  },
};

module.exports = { tool, TOOLSET_NAMES, toolsetOf, parseToolsets, hiddenToolMessage };
