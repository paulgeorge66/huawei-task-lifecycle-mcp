#!/usr/bin/env python3
"""Regression tests for local Hook and pure-Skill client behavior."""

from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sys
import tempfile
import threading
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from clients import codex_notify


def load_script(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_endpoint_precedence() -> None:
    with tempfile.TemporaryDirectory() as directory:
        credential = Path(directory) / "client.json"
        credential.write_text(
            json.dumps({"webhook_url": "https://file.invalid/hook", "token": "file-token"}),
            encoding="utf-8",
        )
        previous = {key: os.environ.get(key) for key in (
            "HUAWEI_PUSH_CREDENTIAL_FILE",
            "HUAWEI_PUSH_WEBHOOK_URL",
            "HUAWEI_PUSH_WEBHOOK_TOKEN",
        )}
        try:
            os.environ["HUAWEI_PUSH_CREDENTIAL_FILE"] = str(credential)
            os.environ["HUAWEI_PUSH_WEBHOOK_URL"] = "https://env.invalid/hook"
            os.environ["HUAWEI_PUSH_WEBHOOK_TOKEN"] = "env-token"
            assert codex_notify.load_credentials() == (
                "https://env.invalid/hook",
                "env-token",
            )
            os.environ.pop("HUAWEI_PUSH_WEBHOOK_URL")
            assert codex_notify.load_credentials() == (
                "https://file.invalid/hook",
                "env-token",
            )
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


def test_skill_event_ids() -> None:
    script = load_script(
        "push_event_test",
        ROOT / "plugins/huawei-task-push/skills/huawei-task-push/scripts/push_event.py",
    )
    first = script.new_event_id()
    second = script.new_event_id()
    assert first.startswith("evt:")
    assert first != second
    assert len(first) <= 128
    assert script.identifier("a" * 128) == "a" * 128
    assert script.api_url({"HUAWEI_PUSH_AGENT_URL": "https://example.test/hooks/agent"}) == (
        "https://example.test/api/v3/events"
    )


class ReliableClientHandler(BaseHTTPRequestHandler):
    attempts = 0
    event_ids: list[str] = []

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length))
        self.__class__.attempts += 1
        self.__class__.event_ids.append(payload["event_id"])
        if self.__class__.attempts == 1:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b'{"success":false}')
            return
        body = json.dumps(
            {
                "success": True,
                "acceptance": "recorded",
                "event_id": payload["event_id"],
                "task_id": payload["task_id"],
            }
        ).encode()
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def test_skill_reliable_outbox() -> None:
    script = load_script(
        "push_event_outbox_test",
        ROOT / "plugins/huawei-task-push/skills/huawei-task-push/scripts/push_event.py",
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), ReliableClientHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    ReliableClientHandler.attempts = 0
    ReliableClientHandler.event_ids = []
    try:
        with tempfile.TemporaryDirectory() as directory:
            outbox = Path(directory) / ".outbox"
            payload = {
                "task_id": "task:reliable",
                "run_id": "run:reliable",
                "event_id": "evt:reliable",
                "type": "task.completed",
                "title": "Reliable",
                "content": "done",
            }
            endpoint = f"http://127.0.0.1:{server.server_port}/api/v3/events"
            try:
                script.send_with_outbox(endpoint, "test-token", outbox, payload)
                raise AssertionError("first retryable request should fail")
            except RuntimeError:
                pass
            pending = list(outbox.glob("*.json"))
            assert len(pending) == 1
            assert pending[0].stat().st_mode & 0o777 == 0o600
            assert script.flush(endpoint, "test-token", outbox) == {
                "success": True,
                "sent": 1,
                "failed": 0,
                "remaining": 0,
            }
            assert ReliableClientHandler.event_ids == ["evt:reliable", "evt:reliable"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class CodexOutboxHandler(BaseHTTPRequestHandler):
    attempts = 0
    turn_ids: list[str] = []

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        event = json.loads(self.rfile.read(length))
        self.__class__.attempts += 1
        self.__class__.turn_ids.append(event["turn-id"])
        if self.__class__.attempts == 1:
            self.send_response(503)
            self.end_headers()
            return
        body = b'{"success":true}'
        self.send_response(202)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def test_codex_hook_outbox() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), CodexOutboxHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    CodexOutboxHandler.attempts = 0
    CodexOutboxHandler.turn_ids = []
    try:
        with tempfile.TemporaryDirectory() as directory:
            outbox = Path(directory) / "codex-outbox"
            event = {
                "type": "agent-turn-complete",
                "thread-id": "thread-1",
                "turn-id": "turn-1",
                "last-assistant-message": "done",
            }
            path = codex_notify.pending_path(outbox, event)
            codex_notify.atomic_write_event(path, event)
            assert path.stat().st_mode & 0o777 == 0o600
            endpoint = f"http://127.0.0.1:{server.server_port}/hooks/codex"
            try:
                codex_notify.send_event(endpoint, "test-token", event)
                raise AssertionError("first Hook request should fail")
            except urllib.error.HTTPError:
                pass
            codex_notify.flush_outbox(endpoint, "test-token", outbox)
            assert not path.exists()
            assert CodexOutboxHandler.turn_ids == ["turn-1", "turn-1"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class RotationHandler(BaseHTTPRequestHandler):
    requests: list[tuple[str, str, object]] = []

    def log_message(self, _format: str, *_args: object) -> None:
        pass

    def read_json(self) -> object:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def send_json(self, value: object) -> None:
        body = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        body = self.read_json() if self.path != "/admin/login" else {}
        self.requests.append(("POST", self.path, body))
        if self.path == "/admin/login":
            dashboard = b'<script>const csrf="csrf-test";const api=1</script>'
            self.send_response(200)
            self.send_header("Content-Length", str(len(dashboard)))
            self.end_headers()
            self.wfile.write(dashboard)
            return
        if self.path == "/api/admin/agents/stable-agent/token":
            self.send_json(
                {
                    "agent": {"id": "stable-agent"},
                    "token": "hpa_rotated-token",
                }
            )
            return
        self.send_error(404)

    def do_PATCH(self) -> None:
        body = self.read_json()
        self.requests.append(("PATCH", self.path, body))
        if self.path == "/api/admin/agents/stable-agent":
            self.send_json({"success": True, "agent": {"id": "stable-agent"}})
            return
        self.send_error(404)


def test_in_place_rotation() -> None:
    provision = load_script(
        "provision_agent_test",
        ROOT / "plugins/huawei-task-push/skills/huawei-task-push/scripts/provision_agent.py",
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), RotationHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    RotationHandler.requests = []
    previous_argv = sys.argv
    previous_password = os.environ.get("HUAWEI_PUSH_OWNER_PASSWORD")
    try:
        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / ".env"
            env_file.write_text(
                "HUAWEI_PUSH_AGENT_ID=stable-agent\nHUAWEI_PUSH_AGENT_TOKEN=old\n",
                encoding="utf-8",
            )
            os.environ["HUAWEI_PUSH_OWNER_PASSWORD"] = "test-only"
            sys.argv = [
                "provision_agent.py",
                "--rotate",
                "--base-url",
                f"http://127.0.0.1:{server.server_port}",
                "--display-name",
                "GPT Work",
                "--source-name",
                "GPT Work",
                "--env-file",
                str(env_file),
            ]
            with redirect_stdout(io.StringIO()):
                assert provision.main() == 0
            contents = env_file.read_text(encoding="utf-8")
            assert "HUAWEI_PUSH_AGENT_ID=stable-agent" in contents
            assert "HUAWEI_PUSH_AGENT_TOKEN=hpa_rotated-token" in contents
            assert env_file.stat().st_mode & 0o777 == 0o600
        paths = [(method, path) for method, path, _body in RotationHandler.requests]
        assert ("POST", "/api/admin/agents") not in paths
        assert ("POST", "/api/admin/agents/stable-agent/token") in paths
        policy_updates = [
            body
            for method, path, body in RotationHandler.requests
            if method == "PATCH" and path == "/api/admin/agents/stable-agent"
        ]
        assert policy_updates == [
            {"displayName": "GPT Work", "sourceLabel": "GPT Work"}
        ]
    finally:
        sys.argv = previous_argv
        if previous_password is None:
            os.environ.pop("HUAWEI_PUSH_OWNER_PASSWORD", None)
        else:
            os.environ["HUAWEI_PUSH_OWNER_PASSWORD"] = previous_password
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main() -> None:
    test_endpoint_precedence()
    test_skill_event_ids()
    test_skill_reliable_outbox()
    test_codex_hook_outbox()
    test_in_place_rotation()
    print("PASS: client precedence, reliable Skill/Hook outboxes, event IDs, and in-place Agent rotation")


if __name__ == "__main__":
    main()
