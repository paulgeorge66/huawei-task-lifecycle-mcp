# Huawei Task Lifecycle MCP

[中文](README.md) · English

An unofficial, self-hosted bridge that turns AI-agent task lifecycles into one continuously updated Huawei Today card per task. It supports Codex, Gemini Spark, GPT Work, and other agents through MCP, host hooks, or a bundled HTTPS Skill.

This project is not affiliated with or endorsed by Huawei, OpenAI, or Google. Product names and trademarks belong to their respective owners. The project is licensed under the [Apache License 2.0](LICENSE).

## Choose an integration

| Client capability | Recommended mode | Guide |
| --- | --- | --- |
| Remote MCP and a completion hook | MCP + Hook | [Codex guide](docs/mcp-hook.md) |
| Remote MCP without a hook | MCP + Skill | [MCP and Gemini Spark](docs/mcp-skill.md) |
| No MCP, but Python execution | Skill + Webhook | [Webhook Skill](docs/skill-webhook.md) |

All modes share the same identity model: one stable `task_id` maps to one card within an Agent, `run_id` identifies one execution, and every lifecycle event has a unique `event_id`. The service supports start, progress, waiting, rename, completion, failure, and cancellation.

## Architecture

- Cloudflare Worker: OAuth, MCP, webhooks, policy, and administration.
- D1: events, runs, monotonic revisions, card projections, delivery state, and audit records.
- Cloudflare Queues and Cron: retryable delivery and recovery.
- KV: OAuth provider state.
- Huawei dynamic-message endpoint: the final one-way notification channel.

The repository contains source code for a service you deploy in your own accounts; it does not provide a public hosted endpoint. Start with the [Chinese deployment quickstart](docs/getting-started.md), use the [documentation index](docs/README.md) for all guides, then review [privacy and data flow](docs/privacy.md) and [third-party notices](THIRD_PARTY_NOTICES.md).

## Development

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npm run cf-typegen
npm run check
npm run release:verify
```

Production `wrangler.jsonc`, `.dev.vars`, Skill `.env` files, and generated archives are intentionally ignored by Git.

## Important boundaries

- HTTP 202 means the event was durably recorded, not that a phone displayed it.
- MCP and Skill instructions improve reporting behavior; only a host-level hook can provide a host completion signal.
- The Huawei card is a one-way notification surface. This project receives no phone reply, read receipt, or device-delivery receipt.
- Task titles and content leave the agent environment and are stored in the deployer's Cloudflare resources before being sent to Huawei. Never send credentials, hidden reasoning, or content unsuitable for a notification surface.
