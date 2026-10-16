#!/usr/bin/env python3
"""Run one Pi task and turn its JSON event stream into concise progress output."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a one-shot Pi coding agent")
    parser.add_argument("--cwd", default=os.getcwd(), help="Repository working directory")
    # Provider, model and thinking are optional; when omitted Pi uses its own configured defaults.
    parser.add_argument("--provider")
    parser.add_argument("--model")
    parser.add_argument(
        "--thinking",
        choices=("off", "minimal", "low", "medium", "high", "xhigh", "max"),
    )
    parser.add_argument("--name", default="Delegated task")
    parser.add_argument("--no-session", action="store_true")
    parser.add_argument("--approve", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def assistant_text(message: dict[str, Any]) -> str:
    content = message.get("content", [])
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""

    parts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
    return "\n".join(parts)


def tool_hint(args: Any) -> str:
    """One short line naming what a tool call works on, e.g. the command or the file."""
    if not isinstance(args, dict):
        return ""
    for key in ("command", "path", "file_path", "pattern", "url"):
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:120]
    return ""


def emit_event(event: dict[str, Any]) -> None:
    event_type = event.get("type")

    if event_type == "session":
        print(
            f"[pi] session id={event.get('id', 'unknown')} cwd={event.get('cwd', 'unknown')}",
            flush=True,
        )
        return

    if event_type == "tool_execution_start":
        hint = tool_hint(event.get("args"))
        print(f"[pi] tool:start {event.get('toolName', 'unknown')}{' ' + hint if hint else ''}", flush=True)
        return

    if event_type == "tool_execution_end":
        status = "error" if event.get("isError") else "ok"
        print(f"[pi] tool:end {event.get('toolName', 'unknown')} {status}", flush=True)
        return

    if event_type == "message_end":
        message = event.get("message")
        if isinstance(message, dict) and message.get("role") == "assistant":
            text = assistant_text(message)
            if text:
                print(f"[pi/assistant]\n{text}", flush=True)
        return

    if event_type == "auto_retry_start":
        print(
            f"[pi] retry {event.get('attempt', '?')}/{event.get('maxAttempts', '?')}: "
            f"{event.get('errorMessage', 'unknown error')}",
            flush=True,
        )
        return

    if event_type == "compaction_start":
        print(f"[pi] compacting context ({event.get('reason', 'unknown')})", flush=True)


def stream_stderr(stderr: Any) -> None:
    for line in stderr:
        text = line.decode("utf-8", "replace").rstrip()
        if text:
            print(f"[pi/stderr] {text}", file=sys.stderr, flush=True)


class Pi:
    """Pi in RPC mode: one prompt, steering messages from an inbox file, exit once settled."""

    def __init__(self, process: subprocess.Popen, cwd: Path, inbox: Path):
        self.process = process
        self.cwd = cwd
        self.inbox = inbox
        self.lock = threading.Lock()
        self.done = threading.Event()

    def send(self, record: dict[str, Any]) -> None:
        with self.lock:
            if self.done.is_set() or self.process.stdin is None or self.process.stdin.closed:
                return
            try:
                self.process.stdin.write(json.dumps(record).encode("utf-8") + b"\n")
                self.process.stdin.flush()
            except (BrokenPipeError, ValueError):
                self.done.set()

    def finish(self) -> None:
        with self.lock:
            self.done.set()
            try:
                if self.process.stdin and not self.process.stdin.closed:
                    self.process.stdin.close()
            except (BrokenPipeError, ValueError):
                pass

    def on_record(self, record: dict[str, Any]) -> None:
        if record.get("type") != "response":
            if record.get("type") == "agent_settled":
                self.finish()
            emit_event(record)
            return
        data = record.get("data") if isinstance(record.get("data"), dict) else {}
        if record.get("id") == "state" and record.get("success"):
            print(f"[pi] session id={data.get('sessionId', 'unknown')} cwd={self.cwd}", flush=True)
        elif record.get("id") == "prompt":
            if not record.get("success"):
                print(f"[pi/error] {record.get('error', 'the prompt was rejected')}", flush=True)
                self.finish()
            elif data.get("disposition") == "handled":
                self.finish()
        elif record.get("command") == "steer" and not record.get("success"):
            print(f"[pi/error] message not delivered: {record.get('error', 'unknown error')}", flush=True)

    def read_inbox(self) -> None:
        offset = 0
        while not self.done.wait(0.5):
            try:
                with self.inbox.open("rb") as fh:
                    fh.seek(offset)
                    chunk = fh.read()
            except OSError:
                continue
            end = chunk.rfind(b"\n")
            if end < 0:
                continue
            offset += end + 1
            for raw in chunk[: end + 1].splitlines():
                try:
                    text = json.loads(raw).get("text", "")
                except (json.JSONDecodeError, AttributeError):
                    continue
                if isinstance(text, str) and text.strip():
                    print(f"[pi/user]\n{text.strip()}", flush=True)
                    self.send({"type": "steer", "message": text.strip()})


def make_inbox() -> Path:
    base = Path(os.environ.get("XDG_RUNTIME_DIR") or "/tmp") / "pi-inbox"
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    inbox = base / f"{os.getpid()}.jsonl"
    inbox.touch(mode=0o600)
    return inbox


def main() -> int:
    args = parse_args()
    cwd = Path(args.cwd).expanduser().resolve()
    if not cwd.is_dir():
        print(f"[pi/error] Working directory does not exist: {cwd}", file=sys.stderr)
        return 2

    task = sys.stdin.read().strip()
    if not task:
        print("[pi/error] Pass exactly one task through stdin.", file=sys.stderr)
        return 2

    prompt = f"""You are a one-shot delegated coding agent. Complete exactly the task below in the current working directory.
Work autonomously and keep the scope narrow. Preserve all unrelated existing work. Do not wait for follow-up questions; when ambiguity is minor, choose the safest reasonable interpretation. Do not commit, push, deploy, use secrets, run sudo, or perform destructive/irreversible actions. Run relevant verification before finishing. Messages from the user may arrive while you work; follow them. In your final response, summarize changed files, verification, and any remaining issue.

TASK
{task}
"""

    command = ["pi", "--mode", "rpc", "--name", args.name]
    for flag, value in (("--provider", args.provider), ("--model", args.model), ("--thinking", args.thinking)):
        if value:
            command += [flag, value]
    if args.no_session:
        command.append("--no-session")
    if args.approve:
        command.append("--approve")

    # The app parses this line, so "default" stands in for an omitted value.
    settings = (
        f"provider={args.provider or 'default'} model={args.model or 'default'} "
        f"thinking={args.thinking or 'default'}"
    )

    if args.dry_run:
        print(f"[pi] ready cwd={cwd} {settings} task_chars={len(task)}", flush=True)
        return 0

    print(f"[pi] starting {settings}", flush=True)

    try:
        process = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        print("[pi/error] The pi executable is not available on PATH.", file=sys.stderr)
        return 127

    inbox = make_inbox()
    print(f"[pi] inbox path={inbox}", flush=True)
    pi = Pi(process, cwd, inbox)
    assert process.stdout is not None
    assert process.stderr is not None
    stderr_thread = threading.Thread(target=stream_stderr, args=(process.stderr,), daemon=True)
    stderr_thread.start()
    threading.Thread(target=pi.read_inbox, daemon=True).start()
    signal.signal(signal.SIGTERM, lambda *_: process.terminate())

    pi.send({"id": "state", "type": "get_state"})
    pi.send({"id": "prompt", "type": "prompt", "message": prompt})
    try:
        # readline on a binary pipe splits on LF only, as the RPC framing requires.
        while line := process.stdout.readline():
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                text = line.decode("utf-8", "replace").rstrip()
                if text:
                    print(f"[pi/output] {text}", flush=True)
                continue
            if isinstance(record, dict):
                pi.on_record(record)
    except KeyboardInterrupt:
        process.terminate()
        print("[pi] interrupted; terminating child process", file=sys.stderr, flush=True)
    finally:
        pi.finish()
        inbox.unlink(missing_ok=True)

    exit_code = process.wait()
    stderr_thread.join(timeout=1)
    print(f"[pi] finished exit={exit_code}", flush=True)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
