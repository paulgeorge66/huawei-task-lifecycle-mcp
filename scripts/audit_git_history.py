#!/usr/bin/env python3
"""Report commits and paths whose reachable blobs contain private deployment patterns."""

from __future__ import annotations

from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parent.parent
PATTERNS = {
    "non-example workers.dev URL": r"https://(?!example\.workers\.dev)[A-Za-z0-9.-]+\.workers\.dev",
    "absolute macOS user path": r"/Users/[^/[:space:]]+/",
    "Google user-bound OAuth redirect": r"oauth-redirect\.googleusercontent\.com/r/user_bound",
    "long Agent Token": r"hpa_[A-Za-z0-9_-]{20,}",
    "non-placeholder configured secret": (
        r"^(OWNER_PASSWORD|HUAWEI_AUTH_CODE)[[:space:]]*=[[:space:]]*"
        r"(?![\"']?[Rr][Ee][Pp][Ll][Aa][Cc][Ee])[^[:space:]]+"
    ),
}


def revisions() -> list[str]:
    output = subprocess.check_output(["git", "rev-list", "--all"], cwd=ROOT, text=True)
    return output.splitlines()


def matches(revision: str, pattern: str) -> list[str]:
    process = subprocess.run(
        [
            "git",
            "grep",
            "-I",
            "-l",
            "-P",
            pattern,
            revision,
            "--",
            ".",
            ":(exclude)scripts/audit_git_history.py",
        ],
        cwd=ROOT,
        check=False,
        text=True,
        capture_output=True,
    )
    if process.returncode not in {0, 1}:
        raise RuntimeError(process.stderr.strip() or "git grep failed")
    return [line for line in process.stdout.splitlines() if line]


def main() -> int:
    findings: dict[str, set[str]] = {}
    finding_revisions: dict[str, set[str]] = {}
    for revision in revisions():
        for label, pattern in PATTERNS.items():
            for match in matches(revision, pattern):
                _matched_revision, path = match.split(":", 1)
                findings.setdefault(label, set()).add(path)
                finding_revisions.setdefault(label, set()).add(revision)
    if findings:
        print("Git history is not ready for public visibility:")
        for label, items in findings.items():
            print(f"\n{label} ({len(finding_revisions[label])} commits):")
            for item in sorted(items):
                print(f"  {item}")
        print("\nRotate any affected credentials, then rewrite history or publish a clean repository.")
        return 1
    print("PASS: reachable Git history contains no configured private deployment patterns")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Error: {error}")
        raise SystemExit(2)
