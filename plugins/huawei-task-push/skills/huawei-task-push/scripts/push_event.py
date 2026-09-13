#!/usr/bin/env python3
"""Reliable Huawei Task Lifecycle v3 client for script-capable agents."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid


SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = SKILL_DIR / ".env"
EVENT_COMMANDS = ("started", "progress", "waiting", "completed", "failed", "canceled", "renamed")
TYPE_BY_COMMAND = {command: f"task.{command}" for command in EVENT_COMMANDS}
USER_AGENT = "huawei-task-lifecycle-client/3.0"
MAX_RESPONSE_BYTES = 128 * 1024


def load_env(path: Path) -> dict[str, str]:
    if not path.is_file():
        raise RuntimeError(
            f"Credential file is missing: {path}. Run scripts/provision_agent.py first."
        )
    values: dict[str, str] = {}
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise RuntimeError(f"Invalid .env line {number}")
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key] = value
    return values


def identifier(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._:-]+", "_", value.strip())[:128]
    if not cleaned:
        raise ValueError("identifier is empty after normalization")
    return cleaned


def new_event_id() -> str:
    return f"evt:{uuid.uuid4()}"


def api_url(config: dict[str, str]) -> str:
    explicit = config.get("HUAWEI_PUSH_API_URL", "").strip()
    if explicit:
        return explicit.rstrip("/")
    legacy = config.get("HUAWEI_PUSH_AGENT_URL", "").strip()
    if legacy.endswith("/hooks/agent"):
        return f"{legacy[:-len('/hooks/agent')]}/api/v3/events"
    raise RuntimeError(".env must define HUAWEI_PUSH_API_URL")


def outbox_dir(env_file: Path, config: dict[str, str]) -> Path:
    configured = config.get("HUAWEI_PUSH_OUTBOX_DIR", "").strip()
    return Path(configured).expanduser() if configured else env_file.parent / ".outbox"


def atomic_write(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".pending.", dir=path.parent, text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def pending_path(directory: Path, event_id: str) -> Path:
    digest = hashlib.sha256(event_id.encode("utf-8")).hexdigest()
    return directory / f"{digest}.json"


def request_json(
    url: str,
    token: str,
    *,
    method: str = "GET",
    payload: dict[str, object] | None = None,
) -> dict[str, object]:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers = {"Authorization": f"Bearer {token}", "User-Agent": USER_AGENT}
    if body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.loads(response.read(MAX_RESPONSE_BYTES).decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(64 * 1024).decode("utf-8", errors="replace")
        failure = RuntimeError(f"request failed with HTTP {error.code}: {detail}")
        failure.retryable = error.code == 429 or error.code >= 500  # type: ignore[attr-defined]
        raise failure from error
    except urllib.error.URLError as error:
        failure = RuntimeError(f"network error: {error.reason}")
        failure.retryable = True  # type: ignore[attr-defined]
        raise failure from error
    except (TimeoutError, json.JSONDecodeError) as error:
        failure = RuntimeError(f"invalid or incomplete server response: {error}")
        failure.retryable = True  # type: ignore[attr-defined]
        raise failure from error
    if not isinstance(result, dict) or result.get("success") is not True:
        raise RuntimeError(f"server did not accept the request: {result!r}")
    return result


def event_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser], command: str) -> None:
    parser = subparsers.add_parser(command)
    parser.add_argument("--task-id", help="Stable ID reused by every run of this task")
    parser.add_argument("--run-id", help="Stable run ID; use a new value to reopen a terminal task")
    parser.add_argument("--event-id", help="Stable idempotency ID for this event")
    parser.add_argument("--title", required=True, help="Task/card title, at most 120 characters")
    parser.add_argument("--summary", help="Short card status, at most 300 characters")
    content = parser.add_mutually_exclusive_group()
    content.add_argument("--content")
    content.add_argument("--content-file", type=Path)
    content.add_argument("--content-stdin", action="store_true")
    parser.add_argument("--progress", type=int)
    parser.add_argument("--project")
    parser.add_argument("--result")
    parser.add_argument("--observed-at", type=int)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in EVENT_COMMANDS:
        event_parser(subparsers, command)
    for command in ("status", "retry"):
        operation = subparsers.add_parser(command)
        operation.add_argument("event_id")
    subparsers.add_parser("flush")
    subparsers.add_parser("doctor")
    return parser.parse_args()


def content_for(args: argparse.Namespace) -> str:
    if args.content_file:
        value = args.content_file.read_text(encoding="utf-8")
    elif args.content_stdin:
        value = sys.stdin.read()
    else:
        value = args.content or ""
    if len(value) > 5_000:
        raise RuntimeError("content exceeds the 5000-character service limit")
    return value


def event_payload(args: argparse.Namespace) -> dict[str, object]:
    if args.command == "progress" and args.progress is None:
        raise RuntimeError("--progress is required for progress events")
    if args.progress is not None and not 0 <= args.progress <= 100:
        raise RuntimeError("--progress must be between 0 and 100")
    title = args.title.strip()
    if not title or len(title) > 120:
        raise RuntimeError("--title must contain 1 to 120 characters")
    task_id = identifier(args.task_id or f"task:{uuid.uuid4()}")
    run_id = identifier(args.run_id or f"run:{uuid.uuid4()}")
    payload: dict[str, object] = {
        "task_id": task_id,
        "run_id": run_id,
        "event_id": identifier(args.event_id) if args.event_id else new_event_id(),
        "type": TYPE_BY_COMMAND[args.command],
        "title": title,
        "content": content_for(args),
    }
    for value, key in (
        (args.summary, "summary"),
        (args.progress, "progress"),
        (args.project, "project"),
        (args.result, "result"),
        (args.observed_at, "observed_at"),
    ):
        if value is not None:
            payload[key] = value
    return payload


def send_with_outbox(
    endpoint: str,
    token: str,
    directory: Path,
    payload: dict[str, object],
) -> dict[str, object]:
    path = pending_path(directory, str(payload["event_id"]))
    atomic_write(path, payload)
    try:
        result = request_json(endpoint, token, method="POST", payload=payload)
    except RuntimeError as error:
        if not getattr(error, "retryable", False):
            path.unlink(missing_ok=True)
        raise
    path.unlink(missing_ok=True)
    result.setdefault("run_id", payload["run_id"])
    return result


def flush(endpoint: str, token: str, directory: Path) -> dict[str, object]:
    sent = 0
    failed = 0
    if not directory.is_dir():
        return {"success": True, "sent": 0, "failed": 0, "remaining": 0}
    for path in sorted(directory.glob("*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise RuntimeError("pending event is not an object")
            request_json(endpoint, token, method="POST", payload=payload)
            path.unlink()
            sent += 1
        except (OSError, RuntimeError, ValueError, json.JSONDecodeError):
            failed += 1
    remaining = len(list(directory.glob("*.json")))
    return {"success": failed == 0, "sent": sent, "failed": failed, "remaining": remaining}


def main() -> int:
    args = parse_args()
    env_file = args.env_file.expanduser().resolve()
    config = load_env(env_file)
    endpoint = api_url(config)
    token = config.get("HUAWEI_PUSH_AGENT_TOKEN", "").strip()
    if not token:
        raise RuntimeError(".env must define HUAWEI_PUSH_AGENT_TOKEN")
    if args.command in EVENT_COMMANDS:
        result = send_with_outbox(endpoint, token, outbox_dir(env_file, config), event_payload(args))
    elif args.command == "flush":
        result = flush(endpoint, token, outbox_dir(env_file, config))
    elif args.command == "doctor":
        base = endpoint[: -len("/events")] if endpoint.endswith("/events") else endpoint
        result = request_json(f"{base}/doctor", token)
    else:
        event_id = identifier(args.event_id)
        event_url = f"{endpoint}/{urllib.parse.quote(event_id, safe='')}"
        result = request_json(event_url + ("/retry" if args.command == "retry" else ""), token, method="POST" if args.command == "retry" else "GET")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("success") is True else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"success": False, "message": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
