#!/usr/bin/env python3
"""Create or rotate a private long-lived webhook Agent and write the skill .env."""

from __future__ import annotations

import argparse
import getpass
import http.cookiejar
import json
import os
from pathlib import Path
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request


SKILL_DIR = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = SKILL_DIR / ".env"
def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default=os.environ.get("HUAWEI_PUSH_BASE_URL"))
    parser.add_argument("--display-name", default="GPT Work")
    parser.add_argument("--source-name", default="GPT Work")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE)
    parser.add_argument(
        "--rotate",
        action="store_true",
        help="Rotate the existing Agent token in place so task/card identity is preserved",
    )
    return parser.parse_args()


def read_existing_agent_id(path: Path) -> str | None:
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("HUAWEI_PUSH_AGENT_ID="):
            return line.split("=", 1)[1].strip().strip("\"'") or None
    return None


def request_json(opener: urllib.request.OpenerDirector, request: urllib.request.Request) -> dict[str, object]:
    try:
        with opener.open(request, timeout=20) as response:
            return json.loads(response.read(128 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(64 * 1024).decode("utf-8", errors="replace")
        raise RuntimeError(f"admin request failed with HTTP {error.code}: {detail}") from error


def admin_request(url: str, data: bytes | None = None, method: str = "GET", csrf: str | None = None) -> urllib.request.Request:
    headers = {"User-Agent": "huawei-task-push-provision/1.0"}
    if data is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    if csrf:
        headers["X-CSRF-Token"] = csrf
    return urllib.request.Request(url, data=data, method=method, headers=headers)


def atomic_write_env(path: Path, values: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"{key}={value}" for key, value in values.items()]
    descriptor, temporary = tempfile.mkstemp(prefix=".env.", dir=path.parent, text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write("\n".join(lines) + "\n")
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def main() -> int:
    args = parse_args()
    if not args.base_url:
        raise RuntimeError("--base-url or HUAWEI_PUSH_BASE_URL is required")
    env_file = args.env_file.expanduser().resolve()
    previous_agent_id = read_existing_agent_id(env_file)
    if env_file.exists() and not args.rotate:
        raise RuntimeError(f"{env_file} already exists; use --rotate to replace its credential")

    owner_password = os.environ.get("HUAWEI_PUSH_OWNER_PASSWORD") or getpass.getpass("Owner password: ")
    base_url = args.base_url.rstrip("/")
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    login_data = urllib.parse.urlencode({"password": owner_password}).encode("utf-8")
    login = urllib.request.Request(
        f"{base_url}/admin/login",
        data=login_data,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "huawei-task-push-provision/1.0",
        },
    )
    with opener.open(login, timeout=20) as response:
        dashboard = response.read(512 * 1024).decode("utf-8")
    match = re.search(r"const csrf=(\"[^\"]+\");const api", dashboard)
    if not match:
        raise RuntimeError("admin login failed or CSRF token was not found")
    csrf = json.loads(match.group(1))

    if args.rotate:
        if not previous_agent_id:
            raise RuntimeError("the existing .env does not contain HUAWEI_PUSH_AGENT_ID")
        agent_url = f"{base_url}/api/admin/agents/{urllib.parse.quote(previous_agent_id, safe='')}"
        identity_body = json.dumps(
            {
                "displayName": args.display_name,
                "sourceLabel": args.source_name,
            },
            ensure_ascii=False,
        ).encode("utf-8")
        request_json(opener, admin_request(agent_url, identity_body, "PATCH", csrf))
        credential = request_json(
            opener,
            admin_request(f"{agent_url}/token", b"", "POST", csrf),
        )
    else:
        create_body = json.dumps(
            {"display_name": args.display_name, "source_label": args.source_name},
            ensure_ascii=False,
        ).encode("utf-8")
        credential = request_json(
            opener,
            admin_request(f"{base_url}/api/admin/agents", create_body, "POST", csrf),
        )
    agent = credential.get("agent")
    token = credential.get("token")
    if not isinstance(agent, dict) or not isinstance(agent.get("id"), str) or not isinstance(token, str):
        raise RuntimeError("admin response did not contain a new Agent credential")
    agent_id = agent["id"]

    atomic_write_env(
        env_file,
        {
            "HUAWEI_PUSH_API_URL": f"{base_url}/api/v3/events",
            "HUAWEI_PUSH_AGENT_URL": f"{base_url}/hooks/agent",
            "HUAWEI_PUSH_AGENT_TOKEN": token,
            "HUAWEI_PUSH_AGENT_ID": agent_id,
            "HUAWEI_PUSH_SOURCE_NAME": args.source_name,
        },
    )

    action = "Rotated" if args.rotate else "Provisioned"
    print(f"{action} Agent {agent_id}; credential saved to {env_file} with mode 0600")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}")
        raise SystemExit(1)
