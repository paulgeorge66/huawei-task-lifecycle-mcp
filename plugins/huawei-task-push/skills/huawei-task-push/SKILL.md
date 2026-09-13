---
name: huawei-task-push
description: Reliably report a task's lifecycle and safe user-visible output to one Huawei Today card through an operator-configured HTTPS service when MCP is unavailable. Includes a local retry outbox, status, retry, flush, and diagnostics. Use for GPT Work and other script-capable agents; do not use for unrelated notifications.
---

# Huawei Task Push

Use the bundled `scripts/push_event.py`; this skill has no MCP dependency.

## Workflow

1. Define one stable task ID for the task/card and one stable run ID for this execution. Prefer host-provided conversation/task and run/turn IDs. Otherwise omit both on the first call, capture the returned `task_id` and `run_id`, and reuse both for later events. A later execution of the same task reuses `task_id` but creates a new `run_id`.
2. Define the title from the task itself, not from the current progress message. Keep it stable unless the user explicitly renames the task.
3. Before substantive work, submit `started`. Submit `progress` only at meaningful milestones. Use `waiting` when required user input pauses the task. Submit exactly one terminal state: `completed`, `failed`, or `canceled`. Use `renamed` only when the task title genuinely changes.
4. Put a safe user-visible status or result in `content`. Prefer a minimal summary for personal, confidential, medical, financial, authentication, or third-party data. Never include hidden reasoning, credentials, authentication codes, local paths, or unrelated private data. If necessary, send only a generic state update.
5. Reuse the same task ID so all lifecycle events update one Huawei card. Each script invocation creates a unique event ID automatically; retain the returned ID for status or retry and never repeat a lifecycle event merely to obtain it.

Run from this skill directory:

```bash
python3 scripts/push_event.py started --title "任务标题"
python3 scripts/push_event.py progress --task-id "returned-task-id" --run-id "returned-run-id" --title "任务标题" --progress 50 --content "当前可见进展"
python3 scripts/push_event.py completed --task-id "returned-task-id" --run-id "returned-run-id" --title "任务标题" --content-file "/path/to/final.txt"
```

Use `--content-stdin` when the visible output is already available on standard input. Parse the JSON and retain both IDs. `acceptance=recorded` means the durable gateway recorded the event; it does not prove device display. Use `status EVENT_ID` to inspect accepted revision/provider state and `retry EVENT_ID` only for a failed delivery.

The client writes an event to a mode-0600 local outbox before sending it. A retryable network/server failure leaves the exact same event ID pending. Run `flush` after connectivity returns; run `doctor` to verify endpoint, Agent identity, and v3 delivery mode without sending a phone card.

## Credential boundary

The script loads the private long-lived credential from `.env` beside this file. Never read, print, summarize, attach, or copy `.env` into a prompt or response. If `.env` is missing, stop and tell the operator to run `scripts/provision_agent.py`; do not ask them to paste a token into the conversation.

The backend controls the displayed source name. Client input cannot override it.
