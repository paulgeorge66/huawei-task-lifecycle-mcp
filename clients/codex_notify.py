#!/usr/bin/env python3
"""Forward Codex agent-turn-complete notifications to the Worker webhook."""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import tempfile
import urllib.error
import urllib.request


AGENT_KEYCHAIN_SERVICE = "huawei-push-mcp-agent-token"
LEGACY_KEYCHAIN_SERVICE = "huawei-push-mcp-webhook-token"


def state_database_candidates() -> list[Path]:
    configured = os.environ.get("CODEX_STATE_DB")
    if configured:
        return [Path(configured).expanduser()]
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")).expanduser()
    return [codex_home / "state_5.sqlite", codex_home / "sqlite" / "state_5.sqlite"]


def read_thread_title(database: Path, thread_id: str) -> tuple[str | None, str | None]:
    if not database.is_file():
        return None, None
    connection = sqlite3.connect(database, timeout=1)
    try:
        connection.execute("PRAGMA query_only = ON")
        try:
            row = connection.execute(
                "SELECT NULLIF(TRIM(name), ''), NULLIF(TRIM(title), '') "
                "FROM threads WHERE id = ?",
                (thread_id,),
            ).fetchone()
        except sqlite3.OperationalError:
            # Older Codex state databases did not have the generated/custom `name` column.
            row = connection.execute(
                "SELECT NULL, NULLIF(TRIM(title), '') FROM threads WHERE id = ?",
                (thread_id,),
            ).fetchone()
        if not row:
            return None, None
        name, title = row
        return (
            name if isinstance(name, str) else None,
            title if isinstance(title, str) else None,
        )
    finally:
        connection.close()


def resolve_thread_title(
    thread_id: str,
    *,
    attempts: int = 7,
    retry_delay_seconds: float = 0.25,
) -> str | None:
    """Prefer Codex's generated/custom name; briefly wait for first-turn title generation."""
    fallback: str | None = None
    for attempt in range(attempts):
        for database in state_database_candidates():
            try:
                name, title = read_thread_title(database, thread_id)
            except sqlite3.Error:
                continue
            if name:
                return name
            fallback = fallback or title
        if attempt + 1 < attempts:
            time.sleep(retry_delay_seconds)
    return fallback


def credential_file() -> Path:
    configured = os.environ.get("HUAWEI_PUSH_CREDENTIAL_FILE")
    if configured:
        return Path(configured).expanduser()
    return Path.home() / ".config" / "huawei-push-mcp" / "client.json"


def load_credentials() -> tuple[str, str]:
    endpoint = os.environ.get("HUAWEI_PUSH_WEBHOOK_URL", "")
    token = os.environ.get("HUAWEI_PUSH_WEBHOOK_TOKEN", "")
    path = credential_file()
    file_token = ""
    if path.exists():
        data = json.loads(path.read_text(encoding="utf-8"))
        endpoint = endpoint or str(data.get("webhook_url", ""))
        file_token = str(data.get("token", ""))
    if not token and sys.platform == "darwin":
        for service in (AGENT_KEYCHAIN_SERVICE,):
            keychain = subprocess.run(
                ["security", "find-generic-password", "-w", "-s", service],
                check=False,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if keychain.returncode == 0:
                token = keychain.stdout.strip()
                break
    token = token or file_token
    if not token and sys.platform == "darwin":
        keychain = subprocess.run(
            ["security", "find-generic-password", "-w", "-s", LEGACY_KEYCHAIN_SERVICE],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
        if keychain.returncode == 0:
            token = keychain.stdout.strip()
    if not endpoint:
        raise RuntimeError(
            f"Missing webhook URL; set HUAWEI_PUSH_WEBHOOK_URL or add webhook_url to {path}"
        )
    if not token:
        raise RuntimeError(
            f"Missing webhook credentials; set environment variables or create {path}"
        )
    return endpoint, token


def outbox_directory() -> Path:
    configured = os.environ.get("HUAWEI_PUSH_CODEX_OUTBOX_DIR")
    if configured:
        return Path(configured).expanduser()
    return credential_file().parent / "codex-outbox"


def pending_path(directory: Path, event: dict[str, object]) -> Path:
    identity = f"{event.get('thread-id', '')}\0{event.get('turn-id', '')}"
    return directory / f"{hashlib.sha256(identity.encode('utf-8')).hexdigest()}.json"


def atomic_write_event(path: Path, event: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=".pending.", dir=path.parent, text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(event, handle, ensure_ascii=False, separators=(",", ":"))
            handle.write("\n")
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def send_event(endpoint: str, token: str, event: dict[str, object]) -> None:
    body = json.dumps(event, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "codex-huawei-push/3.0",
        },
    )
    with urllib.request.urlopen(request, timeout=12) as response:
        result = json.loads(response.read(64 * 1024).decode("utf-8"))
    if not isinstance(result, dict) or result.get("success") is not True:
        raise RuntimeError(f"Worker did not record the Hook event: {result!r}")


def flush_outbox(endpoint: str, token: str, directory: Path) -> None:
    if not directory.is_dir():
        return
    for path in sorted(directory.glob("*.json"), key=lambda item: item.stat().st_mtime):
        try:
            event = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(event, dict):
                continue
            send_event(endpoint, token, event)
            path.unlink()
        except (OSError, ValueError, RuntimeError, urllib.error.URLError):
            return


def main() -> int:
    if len(sys.argv) != 2:
        return 0
    try:
        event = json.loads(sys.argv[1])
        if event.get("type") != "agent-turn-complete":
            return 0
        thread_id = event.get("thread-id")
        if isinstance(thread_id, str) and thread_id and not event.get("thread-title"):
            thread_title = resolve_thread_title(thread_id)
            if thread_title:
                event["thread-title"] = thread_title
        endpoint, token = load_credentials()
        directory = outbox_directory()
        flush_outbox(endpoint, token, directory)
        path = pending_path(directory, event)
        atomic_write_event(path, event)
        send_event(endpoint, token, event)
        path.unlink(missing_ok=True)
        return 0
    except (OSError, ValueError, RuntimeError, urllib.error.URLError) as error:
        print(f"Huawei push notification failed: {error}", file=sys.stderr)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
