#!/usr/bin/env python3
"""Preserve the existing Codex Computer Use notifier and add Huawei push."""

from __future__ import annotations

from pathlib import Path
import subprocess
import sys

import codex_notify


EXISTING_NOTIFY = [
    str(
        Path.home()
        / ".codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/"
        "SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient"
    ),
    "turn-ended",
]


def main() -> int:
    if len(sys.argv) != 2:
        return 0
    try:
        subprocess.run(
            [*EXISTING_NOTIFY, sys.argv[1]],
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        print(f"Existing Codex notifier failed: {error}", file=sys.stderr)
    return codex_notify.main()


if __name__ == "__main__":
    raise SystemExit(main())
