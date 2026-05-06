# Third-Party Notices

`browser-mcp-relay` is distributed under the MIT license (see `LICENSE`). It depends on the
packages listed below at runtime. Each retains its own license — this document records the
licenses of the direct dependencies pinned by `package.json` and gives a short note on why
each one is used.

## License compatibility

**Read this before redistributing this project as part of a closed-source product.**

Three of the four direct deps (`@modelcontextprotocol/sdk`, `lighthouse`, `playwright-core`)
are under standard OSI-approved permissive licenses (MIT or Apache-2.0). They are compatible
with closed-source redistribution.

The fourth, **`browser-devtools-mcp`**, is licensed under **Elastic License 2.0 (ELv2)**.
ELv2 is a *source-available* license. It allows free use, modification, and redistribution
*except* in three cases:

1. You may not provide the software to third parties as a hosted or managed service where
   the service offers users substantially the same functionality as the software itself.
2. You may not circumvent the license-key functionality.
3. You may not remove or obscure licensing, copyright, or trademark notices.

ELv2 is **not OSI-approved-open-source**. It is permissive enough for normal use as a
library inside another project — including this relay — but if you intend to redistribute
this relay as part of a SaaS product, you should read the upstream's full license text at
https://github.com/serkan-ozal/browser-devtools-mcp/blob/main/LICENSE first.

For most users (running the relay locally, contributing PRs, embedding in personal tooling)
this is a non-issue.

## Direct dependencies

### `@modelcontextprotocol/sdk@^1.23.0`

- **License:** MIT
- **Author:** Anthropic, PBC
- **Repository:** https://github.com/modelcontextprotocol/typescript-sdk
- **Used for:** the official Model Context Protocol SDK. The relay registers itself as an
  MCP server using `Server` + `StdioServerTransport` from this package.

### `lighthouse@^11.0.0`

- **License:** Apache-2.0
- **Author:** Google LLC
- **Repository:** https://github.com/GoogleChrome/lighthouse
- **Used for:** powering the `lighthouse_audit` own-tool. The relay invokes Lighthouse
  programmatically against its existing Brave instance over CDP.

### `playwright-core@^1.58.0`

- **License:** Apache-2.0
- **Author:** Microsoft Corporation
- **Repository:** https://github.com/microsoft/playwright
- **Used for:** browser automation. The relay uses `chromium.connectOverCDP` to attach to
  the same Brave instance that the upstream child also drives, so own-tools and forwarded
  tools see one shared browser.

### `browser-devtools-mcp@^0.6.4`

- **License:** Elastic-2.0 (see [License compatibility](#license-compatibility) above)
- **Author:** Serkan Ozal
- **Repository:** https://github.com/serkan-ozal/browser-devtools-mcp
- **Used for:** the upstream MCP this relay forwards to. The relay spawns this package
  as a child process and proxies most tool calls to it; the relay's own-tools live
  alongside the forwarded ones in the merged tools/list response.

## Supply-chain audit notes

The audit below records what was checked at the time these notices were written. Re-run
`npm audit` and re-check maintainer signals if any of the upstreams change owners.

| Package | Maintainer signal | Concern level |
| --- | --- | --- |
| `@modelcontextprotocol/sdk` | Anthropic — corporate sponsor, active releases, broad LLM-tooling adoption. | Low |
| `lighthouse` | Google Chrome team — long-running, multi-maintainer, OSS process well-established. | Low |
| `playwright-core` | Microsoft — first-party browser-automation team, near-weekly releases. | Low |
| `browser-devtools-mcp` | Single maintainer (`serkan-ozal`). Active release cadence (0.6.4 → 0.6.12 in two months). Permissive but non-OSI license. **Single-maintainer risk** — if this package is abandoned, the relay's forwarded toolset breaks; the relay can be unblocked by pinning the last working version or by replacing the upstream resolution path with a fork. | Medium |

Transitive deps were not enumerated in this document; run `npm ls` for the full tree, or
`npm audit --omit=dev` for vulnerability signals.
