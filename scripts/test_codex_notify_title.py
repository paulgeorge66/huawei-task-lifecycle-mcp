#!/usr/bin/env python3
"""Isolated tests for resolving Codex's generated thread title."""

from __future__ import annotations

import os
from pathlib import Path
import sqlite3
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from clients import codex_notify


def create_database(path: Path, *, modern: bool) -> None:
    connection = sqlite3.connect(path)
    try:
        if modern:
            connection.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT)")
            connection.execute(
                "INSERT INTO threads (id, title, name) VALUES (?, ?, ?)",
                ("thread-modern", "最开始的第一句话", "Codex 自动生成标题"),
            )
        else:
            connection.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)")
            connection.execute(
                "INSERT INTO threads (id, title) VALUES (?, ?)",
                ("thread-legacy", "旧版标题"),
            )
        connection.commit()
    finally:
        connection.close()


def main() -> None:
    previous = os.environ.get("CODEX_STATE_DB")
    try:
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "state_5.sqlite"
            create_database(database, modern=True)
            os.environ["CODEX_STATE_DB"] = str(database)
            assert codex_notify.resolve_thread_title(
                "thread-modern", attempts=1, retry_delay_seconds=0
            ) == "Codex 自动生成标题"
            assert (
                codex_notify.resolve_thread_title(
                    "missing", attempts=1, retry_delay_seconds=0
                )
                is None
            )

        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "state_5.sqlite"
            create_database(database, modern=False)
            os.environ["CODEX_STATE_DB"] = str(database)
            assert codex_notify.resolve_thread_title(
                "thread-legacy", attempts=1, retry_delay_seconds=0
            ) == "旧版标题"
    finally:
        if previous is None:
            os.environ.pop("CODEX_STATE_DB", None)
        else:
            os.environ["CODEX_STATE_DB"] = previous
    print("PASS: generated name priority, missing thread, legacy title fallback")


if __name__ == "__main__":
    main()
