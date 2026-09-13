# Contributing

Discussion and patches are welcome. By contributing, you confirm that you have the right to submit the material and that it contains no private deployment data or credentials. Unless explicitly stated otherwise, contributions intentionally submitted for inclusion are licensed under Apache-2.0 as described in Section 5 of the license.

## Development

Use Node.js 24 and Python 3.10 or newer. Never use production credentials in tests.

```bash
npm ci
cp wrangler.example.jsonc wrangler.jsonc
npm run cf-typegen
npm run check
npm run release:verify
```

Keep migrations additive and contiguous. Preserve existing Agent IDs, OAuth grants, task IDs, card IDs, and event idempotency. Add a regression test for every behavior change, and update the changelog for user-visible changes.

Do not commit `.dev.vars`, `wrangler.jsonc`, any `.env`, generated ZIP files, phone screenshots containing private data, OAuth secrets, Agent Tokens, or Huawei authorization codes.

Use example domains and placeholder identifiers in documentation and tests. Do not include real task content, local usernames/paths, production Worker names, account IDs, database IDs, OAuth redirect URLs, or device screenshots in an issue or pull request.
