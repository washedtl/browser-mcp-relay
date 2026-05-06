// Tiny stand-in for upstream browser-devtools-mcp. Reads JSON-RPC requests on stdin,
// replies on stdout. If launched with --no-reply, ignores everything (for timeout tests).
const noReply = process.argv.includes("--no-reply");

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim() || noReply) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "tools/list") {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { tools: [{ name: "echo", description: "mock", inputSchema: {} }] },
      }) + "\n");
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: {},
      }) + "\n");
    }
  }
});

process.stdin.on("end", () => process.exit(0));
