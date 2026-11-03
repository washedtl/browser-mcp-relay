# Contributing

Thanks for taking a look. This project stays small on purpose; PRs that keep the surface tight and the tests honest land fastest.

## Quick orientation

```
src/
├── index.js              # entrypoint — runs the relay server; on the first
│                         #   tool call claims a slot, launches Brave, spawns
│                         #   the upstream child (and respawns both on death)
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
└── own-tools/            # tests for each own-tool (shape + acts on ctx.page only)
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
     // ctx.page is the caller's tab (args.tabId, default "main") and
     // ctx.context its BrowserContext, which every session shares: never
     // touch other pages. Tools that don't need a page set needsPage: false.
     async handler(args, { page }) {
       // ... do the thing ...
       return { content: [{ type: "text", text: JSON.stringify({ ok: true, url: page.url() }) }] };
     },
   };
   ```

   The full ctx contract is at the top of `src/own-tools/index.js`.

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

   test("my_tool acts on ctx.page", async () => {
     const page = { url: () => "https://example.com/" };
     const result = await tool.handler({ someArg: "x" }, { page, context: { pages: () => [page] } });
     assert.strictEqual(JSON.parse(result.content[0].text).url, "https://example.com/");
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
- Don't launch Brave in tests. Bridge-missing assertions cover the unhappy path; manual `npm run smoke` covers the happy path. (The one exception, `launchBrave + connectOverCDP roundtrip` in `test/cdp-bridge.test.js`, runs only when Brave is detected — set `BROWSER_RELAY_BRAVE_PATH` to a non-existent path to skip it.)
- Never hardcode a port a test binds or connects to — other relays, agents and real Brave instances use the 90xx/93xx ranges. Ask the OS for one (listen on `0`, read the port, close) or bind the server under test to `0`.

## Sending PRs

- Branch off `main`.
- Run `npm test` — all tests must pass.
- Write a focused commit message — what changed and why.
- Open a PR. The review loop is small; expect a response in a day or two.
