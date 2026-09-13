# Security Policy

## Reporting

Use GitHub's **Security → Report a vulnerability** flow when Private Vulnerability Reporting is enabled. Until then, contact the repository owner through a private channel. Do not open a public issue containing credentials, exploit details, deployment URLs, task content, or user data.

## Supported version

Only the latest release on the default branch receives security fixes.

## Secrets and data

- Store Cloudflare secrets with Wrangler secret bindings.
- Store long-lived Agent Tokens only in a mode-0600 local credential file or platform secret store.
- Treat OAuth client secrets, refresh tokens, Huawei authorization codes, admin cookies, and local outbox contents as private.
- Never send model hidden reasoning or credentials in task card content.

The service stores user-visible task status and delivery metadata. Huawei gateway acceptance is observable; device display and user interaction are not.

If a credential may have entered Git history, rotate or revoke it before discussing cleanup. Removing it from the latest commit is not sufficient because earlier commits and forks may retain it.
