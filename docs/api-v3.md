# v3 HTTP API

The v3 API is intended for the bundled pure-Skill client and other script-capable agents. Send an Agent Token as `Authorization: Bearer …`. One Agent can use multiple clients, but `(agent_id, task_id)` always identifies one Huawei card.

## Submit an event

`POST /api/v3/events`

```json
{
  "task_id": "gpt-work:conversation-123",
  "run_id": "run:2026-09-13T15:30",
  "event_id": "evt:018f...",
  "type": "task.progress",
  "title": "Review the lifecycle service",
  "summary": "Tests are running",
  "content": "Completed the protocol and identity checks.",
  "progress": 70,
  "project": "huawei-task-lifecycle"
}
```

Event types are `task.started`, `task.progress`, `task.waiting`, `task.completed`, `task.failed`, `task.canceled`, `task.renamed`, and `turn.completed`. `progress` is required only for `task.progress`. Identifiers are 1–128 characters using letters, digits, `.`, `_`, `:`, and `-`; title is 1–120 characters; summary is at most 300; content is at most 5000.

A successful response is HTTP 202 with `acceptance=recorded`, `revision`, `disposition`, `delivery`, and `trace_id`. Generate the `event_id` before the call and retain it for status/retry; do not repeat a lifecycle event merely to learn its ID. Repeating the exact `event_id` and body is idempotent. Reusing an event ID with different content returns HTTP 409.

## Delivery status

`GET /api/v3/events/:event_id` returns the legacy compatibility status and, when available, the v3 revision, outbox state, failure count, provider code, and revision lag. It only exposes events owned by the authenticated Agent.

## Retry

`POST /api/v3/events/:event_id/retry` retries a failed delivery. Query status first; policy-suppressed and already accepted events do not need retrying.

## Diagnostics

`GET /api/v3/doctor` verifies the Token, Agent identity, service version, global v3 switch, and per-Agent mode without submitting an event or creating a phone notification.

## Meaning of delivery states

- `recorded`: D1 accepted the immutable event.
- `pending`, `enqueuing`, or `enqueued`: asynchronous delivery has not converged yet.
- `provider_accepted` or `accepted_revision == desired_revision`: the Huawei gateway accepted the latest card projection.
- `failed`: delivery stopped and may be retried after fixing the cause.
- Device display or user interaction is not observable through the available Huawei endpoint.
