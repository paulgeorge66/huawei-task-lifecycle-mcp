#!/usr/bin/env python3
"""Repository wrapper for the canonical pure-Skill lifecycle client."""

from pathlib import Path
import runpy


CLIENT = (
    Path(__file__).resolve().parents[1]
    / "plugins"
    / "huawei-task-push"
    / "skills"
    / "huawei-task-push"
    / "scripts"
    / "push_event.py"
)


if __name__ == "__main__":
    runpy.run_path(str(CLIENT), run_name="__main__")
