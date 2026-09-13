# Changelog

All notable changes are documented here. Versions follow semantic versioning.

## Unreleased

- Reorganized public documentation around deployment, integration choice, troubleshooting, privacy, and release safety.
- Clarified the project's unofficial, self-hosted status and third-party trademark boundary.
- Hardened Skill instructions to minimize sensitive notification content and removed official-sounding publisher metadata.
- Added privacy-safe issue forms, Dependabot configuration, and generic checks for private deployment URLs and local user paths.
- Adopted the Apache License 2.0 and documented third-party dependency licenses for release review.

## 3.0.0 - 2026-09-13

- Added the versioned v3 event API with explicit run identity, waiting, renaming, status, retry, and diagnostics.
- Added revision-based, per-card reliable delivery with D1 outbox, Queue recovery, leases, coalescing, canary rollout, and legacy fallback.
- Added local mode-0600 outboxes to the pure Skill client and Codex completion Hook.
- Preserved Agent, OAuth, task, and Huawei card identities across the migration; added credential audit records.
- Replaced personal deployment constants with environment bindings and added live/ready health probes.
- Added allowlist-only Skill packaging, checksums, secret scanning, CI, and release verification.

## 2.4.0 - 2026-09-13

- Introduced opt-in v3 delivery canaries and validated one-card revision convergence in production.

## 2.3.0 - 2026-09-13

- Added v3 shadow events, runs, projections, outbox records, and reconciliation without changing phone delivery.

## 2.2.0 - 2026-09-12

- Fixed Huawei card/message identity, strict provider responses, queue role handling, Codex title/state behavior, event conflicts, and in-place Token rotation.
