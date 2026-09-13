# Third-party notices

This repository depends on third-party packages distributed under their own licenses. Their package metadata and license files remain authoritative. This summary is provided for release review and is not legal advice.

## Direct dependencies

| Package | Declared license |
| --- | --- |
| `@cloudflare/workers-oauth-provider` | MIT |
| `@modelcontextprotocol/server` | MIT |
| `agents` | MIT |
| `zod` | MIT |
| `@cloudflare/vitest-plugin` | MIT |
| `@types/node` | MIT |
| `oxfmt` | MIT |
| `oxlint` | MIT |
| `typescript` | Apache-2.0 |
| `vitest` | MIT |
| `wrangler` | MIT OR Apache-2.0 |

The dependency tree used for the 3.0.0 release candidate also includes packages declaring other licenses, including MPL-2.0, LGPL-3.0-or-later, and CC-BY-4.0. Examples include optional platform or development dependencies used by Vite, Wrangler, Miniflare, or Sharp; they are not a claim that every such package is shipped in the Worker bundle or Skill archives.

Before publishing a release, regenerate the dependency tree from `package-lock.json`, inspect package license files and the actual distributed artifacts, and decide what attributions or source-offer obligations apply. Choosing a license for this repository does not replace those third-party obligations.
