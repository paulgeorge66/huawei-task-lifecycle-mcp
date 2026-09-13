---
name: huawei-task-lifecycle
description: Report a substantive agent task from start through waiting, progress, renaming, and exactly one terminal state to one Huawei Today card through an operator-configured Huawei Task Lifecycle MCP. Use for work that produces a result, changes state, runs tools, pauses for input, or continues asynchronously; do not invoke for casual conversation or clarification-only replies.
---

# Huawei Task Lifecycle

Use the connected Huawei Task Lifecycle MCP as part of the task, not as a replacement for the user's requested work.

## Lifecycle contract

1. Before substantive work or the first tool call, invoke `huawei_task_start`.
2. Create one stable `task_id` of at most 128 characters using only letters, digits, `.`, `_`, `:`, and `-`. Prefer a namespaced host task, thread, or conversation ID such as `codex:<thread-id>`. Create one `run_id` for the current execution. Reuse both IDs for this run; reuse `task_id` with a new `run_id` only when intentionally reopening a terminal task. When a host completion Hook is enabled, use its exact task ID so both channels update one card.
3. Generate a unique `event_id` before every lifecycle call and retain it for status or retry. Never repeat a start, progress, waiting, rename, or terminal call merely to discover an event ID.
4. Derive a concise, stable title from the user's requested outcome. Do not use a transient progress message as the title.
5. Invoke `huawei_task_progress` only at meaningful milestones or when a long-running task changes phase. Include an integer `progress` from 0 to 100 and concise user-visible status.
6. When required user input or an external dependency pauses the task, call `huawei_task_wait`; keep the run open. Call `huawei_task_rename` only when the task title genuinely changes.
7. Before returning the final response, invoke exactly one terminal tool:
   - `huawei_task_complete` when the requested outcome is delivered;
   - `huawei_task_fail` when the task ends without the requested outcome because of an error or unrecoverable blocker;
   - `huawei_task_cancel` when the user cancels or replaces the task.
8. Put the useful user-visible result in terminal `content`, up to 5000 characters. Keep the same title, `task_id`, and `run_id` so the lifecycle updates one card.

Do not emit a terminal event until the task actually ends.

## Delivery handling

- Treat a successful recorded/queued/delivering/delivered response as accepted by the service. It does not prove device display. A policy-suppressed event is still recorded and does not justify a retry.
- If a lifecycle call fails, continue the user's work when safe and mention the notification failure briefly. Query `huawei_get_delivery_status` before retrying an event; retry only failed deliveries with `huawei_retry_delivery`.
- Do not create a second task ID merely because an event delivery failed.

## Information boundary

Send only content the user would reasonably expect on their notification card. Prefer a minimal status summary when the task involves personal, confidential, medical, financial, authentication, or third-party data. Never include hidden reasoning, credentials, OAuth codes, tokens, private environment values, local paths, or unrelated sensitive data. If a useful safe summary is impossible, report only the state and a generic title.
