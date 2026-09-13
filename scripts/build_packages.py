#!/usr/bin/env python3
"""Build reproducible Skill archives from explicit, credential-free allowlists."""

from __future__ import annotations

import hashlib
from pathlib import Path
import re
import zipfile


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
PACKAGES: dict[str, tuple[Path, tuple[str, ...]]] = {
    "huawei-task-lifecycle-skill.zip": (
        ROOT / "skills" / "huawei-task-lifecycle",
        ("SKILL.md", "agents/openai.yaml"),
    ),
    "huawei-task-push-webhook-plugin.zip": (
        ROOT / "plugins" / "huawei-task-push",
        (
            ".codex-plugin/plugin.json",
            "skills/huawei-task-push/.env.example",
            "skills/huawei-task-push/SKILL.md",
            "skills/huawei-task-push/agents/openai.yaml",
            "skills/huawei-task-push/scripts/provision_agent.py",
            "skills/huawei-task-push/scripts/push_event.py",
        ),
    ),
}
SECRET_PATTERNS = (
    re.compile(rb"hpa_[A-Za-z0-9_-]{20,}"),
    re.compile(rb"(?im)^(?:OWNER_PASSWORD|HUAWEI_AUTH_CODE)\s*=\s*(?![\"']?replace)[^\s]+"),
    re.compile(rb"(?i)client_secret\s*[=:]\s*[A-Za-z0-9_-]{16,}"),
)


def public_bytes(source: Path, relative: str) -> bytes:
    path = source / relative
    if source.is_symlink() or path.is_symlink():
        raise RuntimeError(f"refusing symbolic link in package input: {path}")
    if not path.is_file() or not path.resolve().is_relative_to(source.resolve()):
        raise RuntimeError(f"missing or escaped package input: {path}")
    data = path.read_bytes()
    if any(pattern.search(data) for pattern in SECRET_PATTERNS):
        raise RuntimeError(f"possible credential found in package input: {path}")
    return data


def add_bytes(archive: zipfile.ZipFile, name: str, data: bytes, executable: bool = False) -> None:
    info = zipfile.ZipInfo(name)
    info.date_time = (2026, 1, 1, 0, 0, 0)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (0o755 if executable else 0o644) << 16
    archive.writestr(info, data)


def build(name: str, source: Path, allowlist: tuple[str, ...]) -> str:
    output = DIST / name
    output.unlink(missing_ok=True)
    manifest: list[str] = []
    entries: list[tuple[str, bytes]] = []
    for relative in allowlist:
        data = public_bytes(source, relative)
        archive_name = str(Path(source.name) / relative)
        entries.append((archive_name, data))
        manifest.append(f"{hashlib.sha256(data).hexdigest()}  {archive_name}")
    manifest_data = ("\n".join(manifest) + "\n").encode()
    with zipfile.ZipFile(output, "w") as archive:
        for archive_name, data in entries:
            add_bytes(archive, archive_name, data, archive_name.endswith(".py"))
        add_bytes(archive, f"{source.name}/MANIFEST.sha256", manifest_data)
    with zipfile.ZipFile(output) as archive:
        names = archive.namelist()
        expected = [name for name, _data in entries] + [f"{source.name}/MANIFEST.sha256"]
        if names != expected:
            raise RuntimeError(f"archive entries differ from allowlist: {output}")
        if archive.testzip():
            raise RuntimeError(f"corrupt archive: {output}")
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    print(f"built {output.relative_to(ROOT)} ({len(names)} files, sha256 {digest})")
    return digest


def main() -> int:
    DIST.mkdir(mode=0o755, exist_ok=True)
    sums = [f"{build(name, source, files)}  {name}" for name, (source, files) in PACKAGES.items()]
    (DIST / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
