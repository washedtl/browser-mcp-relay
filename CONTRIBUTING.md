# Contributing

Thanks for taking a look. This project stays small on purpose; PRs that keep the surface tight and the tests honest land fastest.

## Quick orientation

```
src/
├── index.js              # entrypoint — claims a slot, lazy-launches Brave,
│                         #   spawns the upstream child, runs the relay server
├── relay-server.js       # tools/list merge + tools/call routing
├── upstream-client.js    # JSON-RPC over stdio to browser-devtools-mcp
├── cdp-bridge.js         # launchBrave / closeBrave (Playwright-over-CDP)
├── detect-browser.js     # cross-platform Brave + profile-dir detection
├── process-shim.js       # cross-platform "is process alive?" + kill
├── pool-shared.js        # opt-in pool / standalone slot management
├── local-config.js       # local-config.json loader + env merge
└── own-tools/            # the 16 first-party tools live here
    ├── index.js          # registry — add new tools here
    └── <tool>.js         # one file per tool (name + schema + handler)
test/                     # node --test runner; mirrors src/ layout
└── own-tools/            # tests for each own-tool (shape + bridge-missing)
scripts/
├── setup.js              # interactive `npm run setup` wizard
└── smoke.js              # `npm run smoke` — spawn relay + tools/list check
```

## Add an own-tool in 5 minutes

1. **Create the tool file.** `src/own-tools/my-tool.js`:

   ```js
   // my-tool — short purpose summary, then the doc that surfaces in MCP.
   module.exports = {
     name: "my_tool",
     description: "What this tool does, in two or three sentences.",
     inputSchema: {
       type: "object",
       properties: {
         someArg: { type: "string", description: "..." },
       },
       required: ["someArg"],
     },
     async handler(args) {
       const bridge = globalThis.__relayBridge;
       if (!bridge) {
         return {
           isError: true,
           content: [{ type: "text", text: "Relay bridge not initialized." }],
         };
       }
       // bridge.context is a Playwright BrowserContext attached to the same
       // Brave instance the upstream uses.
       const page = (await bridge.context.pages())[0] || await bridge.context.newPage();
       // ... do the thing ...
       return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
     },
   };
   ```

2. **Register it.** Add the require to `src/own-tools/index.js`:

   ```js
   const tools = [
     // ...existing tools...
     require("./my-tool.js"),
   ];
   ```

3. **Write tests.** `test/own-tools/my-tool.test.js`:

   ```js
   const test = require("node:test");
   const assert = require("node:assert");
   const tool = require("../../src/own-tools/my-tool.js");

   test("my_tool has required tool shape", () => {
     assert.strictEqual(tool.name, "my_tool");
     assert.strictEqual(typeof tool.description, "string");
     assert.strictEqual(typeof tool.inputSchema, "object");
     assert.strictEqual(typeof tool.handler, "function");
   });

   test("my_tool returns isError when bridge missing", async () => {
     const prev = globalThis.__relayBridge;
     globalThis.__relayBridge = undefined;
     try {
       const result = await tool.handler({ someArg: "x" });
       assert.strictEqual(result.isError, true);
     } finally {
       globalThis.__relayBridge = prev;
     }
   });
   ```

4. **Run the suite.** `npm test`. The count should be N+2.

5. **Restart your MCP client.** It will see the new tool in `tools/list` after the next relay launch.

`src/own-tools/lighthouse-audit.js` + `test/own-tools/lighthouse-audit.test.js` are the canonical reference — copy that pattern.

## Code style

- CommonJS, no TypeScript. The relay runs on `node >= 20` with no build step.
- Use JSDoc on exported functions; skip prose comments where the code is self-evident.
- Comments explain **why**, not **what**. If a comment is restating the next line, delete it.
- Two-space indent, double quotes, semicolons.
- One file per own-tool. Don't bundle.

## Tests

- `node --test` is the runner. No mocha, no jest, no babel.
- Prefer **test seams** over real side-effects. `src/detect-browser.js` + `test/detect-browser.test.js` show the pattern: detection takes injected `platform` + `env` + `existsSync` so the tests don't need a real Brave install.
- Don't reach for the network in tests.
- Don't launch Brave in tests. Bridge-missing assertions cover the unhappy path; manual `npm run smoke` covers the happy path.

## Sending PRs

- Branch off `main`.
- Run `npm test` — all tests must pass.
- Write a focused commit message — what changed and why.
- Open a PR. The review loop is small; expect a response in a day or two.
