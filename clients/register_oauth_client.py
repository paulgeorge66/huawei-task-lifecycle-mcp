#!/usr/bin/env python3
"""Register a confidential OAuth client and write its one-time secret to a private text file."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import tempfile
import urllib.error
import urllib.parse
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--client-name", required=True)
    parser.add_argument("--redirect-uri", required=True)
    parser.add_argument("--origin", default=os.environ.get("HUAWEI_PUSH_ORIGIN"))
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def atomic_write(path: Path, content: str) -> None:
    path = path.expanduser().resolve()
    if path.exists():
        raise RuntimeError(f"Refusing to overwrite existing credential file: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def post_registration(origin: str, client_name: str, redirect_uri: str) -> dict[str, object]:
    parsed_redirect = urllib.parse.urlparse(redirect_uri)
    if parsed_redirect.scheme != "https" or not parsed_redirect.netloc:
        raise RuntimeError("redirect URI must be an absolute HTTPS URL")
    body = json.dumps(
        {
            "client_name": client_name,
            "redirect_uris": [redirect_uri],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    request = urllib.request.Request(
        f"{origin.rstrip('/')}/oauth/register",
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "huawei-push-oauth-provision/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read(128 * 1024).decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(64 * 1024).decode("utf-8", errors="replace")
        raise RuntimeError(f"OAuth registration failed with HTTP {error.code}: {detail}") from error


def format_epoch(value: object) -> str:
    if not isinstance(value, int) or value == 0:
        return "未提供或永不过期"
    return f"{value} ({datetime.fromtimestamp(value).astimezone().isoformat(timespec='seconds')})"


def main() -> int:
    args = parse_args()
    if not args.origin:
        raise RuntimeError("--origin or HUAWEI_PUSH_ORIGIN is required")
    origin = args.origin.rstrip("/")
    result = post_registration(origin, args.client_name, args.redirect_uri)
    client_id = result.get("client_id")
    client_secret = result.get("client_secret")
    if not isinstance(client_id, str) or not isinstance(client_secret, str):
        raise RuntimeError("registration response did not contain a client ID and secret")

    content = "\n".join(
        [
            "Gemini Spark · Huawei Push MCP OAuth 凭据",
            "",
            f"MCP 服务器 URL: {origin}/mcp",
            f"OAuth 授权地址: {origin}/authorize",
            f"OAuth 令牌地址: {origin}/oauth/token",
            f"OAuth 动态注册地址: {origin}/oauth/register",
            f"重定向 URI: {args.redirect_uri}",
            f"OAuth 客户端 ID: {client_id}",
            f"OAuth 客户端密钥: {client_secret}",
            f"客户端 ID 签发时间: {format_epoch(result.get('client_id_issued_at'))}",
            f"客户端密钥到期时间: {format_epoch(result.get('client_secret_expires_at'))}",
            "Token 认证方式: client_secret_basic 或 client_secret_post",
            "OAuth Scope: push:write",
            "",
            "注意：这是明文机密文件。使用完成后请妥善保管或删除，不要上传或公开分享。",
            "",
        ]
    )
    atomic_write(args.output, content)
    print(f"OAuth client registered; credential file written to {args.output.expanduser().resolve()}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Error: {error}")
        raise SystemExit(1)
