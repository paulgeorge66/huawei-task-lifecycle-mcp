#!/usr/bin/env python3
"""Verify public-template safety, repository links, versions, migrations, and release archives."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile


ROOT = Path(__file__).resolve().parent.parent
SECRET_PATTERNS = (
    re.compile(rb"hpa_[A-Za-z0-9_-]{20,}"),
    re.compile(rb"(?im)^(?:OWNER_PASSWORD|HUAWEI_AUTH_CODE)\s*=\s*(?![\"']?replace)[^\s]+"),
    re.compile(rb"(?i)client_secret\s*[=:]\s*[A-Za-z0-9_-]{16,}"),
)
PRIVATE_DATA_PATTERNS = (
    re.compile(r"/" r"Users/[^/\s]+/"),
    re.compile(r"https://" r"(?!example\.workers\.dev)[A-Za-z0-9.-]+\.workers\.dev"),
    re.compile(r"oauth-" r"redirect\.googleusercontent\.com/r/user_bound"),
)


def candidate_files() -> list[Path]:
    raw = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=ROOT
    )
    paths = [ROOT / item.decode() for item in raw.split(b"\0") if item]
    return [path for path in paths if path.is_file()]


def verify_tracked_files(files: list[Path]) -> None:
    for path in files:
        relative = path.relative_to(ROOT)
        if path.is_symlink():
            raise RuntimeError(f"tracked symbolic link is not allowed: {relative}")
        if path.name == ".env" or path.suffix in {".zip", ".pyc"}:
            raise RuntimeError(f"private/generated file is tracked: {relative}")
        data = path.read_bytes()
        if any(pattern.search(data) for pattern in SECRET_PATTERNS):
            raise RuntimeError(f"possible secret in tracked file: {relative}")
        text = data.decode("utf-8", errors="ignore")
        if relative.as_posix() != "scripts/audit_git_history.py" and any(
            pattern.search(text) for pattern in PRIVATE_DATA_PATTERNS
        ):
            raise RuntimeError(f"private deployment or local path in tracked file: {relative}")


def verify_versions() -> None:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    plugin = json.loads(
        (ROOT / "plugins/huawei-task-push/.codex-plugin/plugin.json").read_text(encoding="utf-8")
    )
    version = package["version"]
    if lock["name"] != package["name"] or lock["version"] != version:
        raise RuntimeError("package-lock name/version differs from package.json")
    if plugin["version"] != version:
        raise RuntimeError("plugin version differs from service version")
    source = (ROOT / "src/version.ts").read_text(encoding="utf-8")
    if f'"{version}"' not in source:
        raise RuntimeError("src/version.ts differs from package version")


def verify_template() -> None:
    raw = (ROOT / "wrangler.example.jsonc").read_text(encoding="utf-8")
    without_comments = re.sub(r"/\*.*?\*/", "", raw, flags=re.DOTALL)
    without_comments = re.sub(r"(?m)^\s*//.*$", "", without_comments)
    config = json.loads(re.sub(r",(\s*[}\]])", r"\1", without_comments))
    encoded = json.dumps(config)
    for placeholder in ("REPLACE_WITH_KV_NAMESPACE_ID", "REPLACE_WITH_D1_DATABASE_ID", "OWNER"):
        if placeholder not in encoded:
            raise RuntimeError(f"wrangler template is missing placeholder {placeholder}")
    if config["vars"]["V3_DELIVERY"] != "false":
        raise RuntimeError("public template must keep v3 delivery disabled before canary validation")


def verify_markdown_links(files: list[Path]) -> None:
    pattern = re.compile(r"\[[^\]]+\]\((?!https?://|#|mailto:)([^)]+)\)")
    for path in files:
        if path.suffix != ".md":
            continue
        for target in pattern.findall(path.read_text(encoding="utf-8")):
            clean = target.split("#", 1)[0]
            if clean and not (path.parent / clean).resolve().exists():
                raise RuntimeError(f"broken local link in {path.relative_to(ROOT)}: {target}")


def verify_migrations() -> None:
    names = sorted(path.name for path in (ROOT / "migrations").glob("*.sql"))
    expected = [f"{index:04d}" for index in range(1, len(names) + 1)]
    actual = [name.split("_", 1)[0] for name in names]
    if actual != expected:
        raise RuntimeError(f"migration sequence is not contiguous: {names}")


def verify_archives() -> None:
    sums_file = ROOT / "dist/SHA256SUMS"
    if not sums_file.is_file():
        raise RuntimeError("dist/SHA256SUMS is missing; run npm run package:skills")
    for line in sums_file.read_text(encoding="utf-8").splitlines():
        digest, name = line.split("  ", 1)
        archive_path = ROOT / "dist" / name
        if hashlib.sha256(archive_path.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"archive checksum mismatch: {name}")
        with zipfile.ZipFile(archive_path) as archive:
            if not any(item.endswith("/MANIFEST.sha256") for item in archive.namelist()):
                raise RuntimeError(f"archive manifest missing: {name}")
            if archive.testzip():
                raise RuntimeError(f"corrupt archive: {name}")


def main() -> int:
    files = candidate_files()
    verify_tracked_files(files)
    verify_versions()
    verify_template()
    verify_markdown_links(files)
    verify_migrations()
    verify_archives()
    print("PASS: release template, versions, secrets, links, migrations, and archives")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
