#!/usr/bin/env python3
"""Drive the installed BreadBoard two-turn and resume journey through a real PTY."""

from __future__ import annotations

import argparse
import codecs
import errno
import fcntl
import json
import os
import pty
import pwd
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

ROWS = 36
COLUMNS = 120
ASSISTANT_SENTINEL = "Proceed to build and test."
FIRST_PROMPT = "Create the deterministic protofilesystem fixture now."
SECOND_PROMPT = "Report the next action after the fixture is ready."
BINDING_SCHEMA = "breadboard.session-binding.v3"
BINDING_TYPE = "breadboard.session-binding"
EXPECTED_FILES = ("Makefile", "protofilesystem.h", "protofilesystem.c", "test_filesystem.c")
ANSI_RE = re.compile(
    rb"(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-_])"
)


class JourneyFailure(RuntimeError):
    pass


class TerminalScreen:
    def __init__(self, rows: int = ROWS, columns: int = COLUMNS) -> None:
        self.rows = rows
        self.columns = columns
        self.grid = [[" "] * columns for _ in range(rows)]
        self.row = 0
        self.column = 0
        self.saved = (0, 0)
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def feed(self, data: bytes) -> None:
        self.pending += self.decoder.decode(data)
        index = 0
        while index < len(self.pending):
            character = self.pending[index]
            if character != "\x1b":
                self._character(character)
                index += 1
                continue
            if index + 1 >= len(self.pending):
                break
            kind = self.pending[index + 1]
            if kind == "[":
                end = index + 2
                while end < len(self.pending) and not ("@" <= self.pending[end] <= "~"):
                    end += 1
                if end >= len(self.pending):
                    break
                self._csi(self.pending[index + 2 : end], self.pending[end])
                index = end + 1
                continue
            if kind == "]":
                bell = self.pending.find("\x07", index + 2)
                string_terminator = self.pending.find("\x1b\\", index + 2)
                ends = [candidate for candidate in (bell, string_terminator) if candidate >= 0]
                if not ends:
                    break
                end = min(ends)
                index = end + (2 if self.pending.startswith("\x1b\\", end) else 1)
                continue
            if kind == "7":
                self.saved = (self.row, self.column)
            elif kind == "8":
                self.row, self.column = self.saved
            index += 2
        self.pending = self.pending[index:]

    def _scroll(self) -> None:
        while self.row >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.columns)
            self.row -= 1

    def _character(self, character: str) -> None:
        if character == "\r":
            self.column = 0
            return
        if character == "\n":
            self.row += 1
            self._scroll()
            return
        if character == "\b":
            self.column = max(0, self.column - 1)
            return
        if character == "\t":
            self.column = min(self.columns - 1, ((self.column // 8) + 1) * 8)
            return
        if ord(character) < 32 or ord(character) == 127:
            return
        if unicodedata.combining(character):
            if self.column > 0:
                self.grid[self.row][self.column - 1] += character
            return
        width = 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
        if self.column >= self.columns:
            self.column = 0
            self.row += 1
            self._scroll()
        self.grid[self.row][self.column] = character
        if width == 2 and self.column + 1 < self.columns:
            self.grid[self.row][self.column + 1] = " "
        self.column += width

    @staticmethod
    def _params(raw: str) -> list[int]:
        raw = raw.lstrip("?>!")
        if not raw:
            return [0]
        result: list[int] = []
        for value in raw.split(";"):
            try:
                result.append(int(value or "0"))
            except ValueError:
                result.append(0)
        return result

    def _csi(self, raw: str, final: str) -> None:
        values = self._params(raw)
        count = values[0] or 1
        if final in {"H", "f"}:
            self.row = max(0, min(self.rows - 1, (values[0] or 1) - 1))
            self.column = max(0, min(self.columns - 1, ((values[1] if len(values) > 1 else 1) or 1) - 1))
        elif final == "A":
            self.row = max(0, self.row - count)
        elif final == "B":
            self.row = min(self.rows - 1, self.row + count)
        elif final == "C":
            self.column = min(self.columns - 1, self.column + count)
        elif final == "D":
            self.column = max(0, self.column - count)
        elif final == "E":
            self.row = min(self.rows - 1, self.row + count)
            self.column = 0
        elif final == "F":
            self.row = max(0, self.row - count)
            self.column = 0
        elif final == "G":
            self.column = max(0, min(self.columns - 1, count - 1))
        elif final == "d":
            self.row = max(0, min(self.rows - 1, count - 1))
        elif final == "J":
            mode = values[0]
            if mode in {2, 3}:
                self.grid = [[" "] * self.columns for _ in range(self.rows)]
                self.row = self.column = 0
            elif mode == 0:
                self.grid[self.row][self.column :] = [" "] * (self.columns - self.column)
                for row in range(self.row + 1, self.rows):
                    self.grid[row] = [" "] * self.columns
            elif mode == 1:
                for row in range(self.row):
                    self.grid[row] = [" "] * self.columns
                self.grid[self.row][: self.column + 1] = [" "] * (self.column + 1)
        elif final == "K":
            mode = values[0]
            if mode == 0:
                self.grid[self.row][self.column :] = [" "] * (self.columns - self.column)
            elif mode == 1:
                self.grid[self.row][: self.column + 1] = [" "] * (self.column + 1)
            elif mode == 2:
                self.grid[self.row] = [" "] * self.columns
        elif final == "s":
            self.saved = (self.row, self.column)
        elif final == "u":
            self.row, self.column = self.saved

    def text(self) -> str:
        lines = ["".join(row).rstrip() for row in self.grid]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines) + ("\n" if lines else "")


class PtyChild:
    def __init__(self, argv: list[str], cwd: Path, env: dict[str, str]) -> None:
        pid, master = pty.fork()
        if pid == 0:
            try:
                os.chdir(cwd)
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLUMNS, 0, 0))
                os.execve(argv[0], argv, env)
            except BaseException as error:
                os.write(2, f"PTY exec failed: {error}\n".encode())
                os._exit(127)
        self.pid = pid
        self.master = master
        self.raw = bytearray()
        self.screen = TerminalScreen()
        self.exit_status: int | None = None
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLUMNS, 0, 0))
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def _observe_exit(self) -> None:
        if self.exit_status is not None:
            return
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid:
            self.exit_status = os.waitstatus_to_exitcode(status)

    def pump(self, timeout: float) -> None:
        readable, _, _ = select.select([self.master], [], [], max(0.0, timeout))
        if readable:
            while True:
                try:
                    data = os.read(self.master, 65536)
                except BlockingIOError:
                    break
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                self.raw.extend(data)
                self.screen.feed(data)
                if len(data) < 65536:
                    break
        self._observe_exit()

    def wait_until(self, predicate: Callable[[], Any], timeout: float, label: str) -> Any:
        deadline = time.monotonic() + timeout
        while True:
            value = predicate()
            if value:
                return value
            self._observe_exit()
            if self.exit_status is not None:
                raise JourneyFailure(
                    f"{label}: bb exited early with {self.exit_status}\n{self.screen.text()}"
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise JourneyFailure(f"{label}: timed out\n{self.screen.text()}")
            self.pump(min(0.2, remaining))

    def send_line(self, text: str) -> None:
        if self.exit_status is not None:
            raise JourneyFailure(f"cannot send to exited bb ({self.exit_status})")
        payload = text.encode("utf-8") + b"\r"
        offset = 0
        while offset < len(payload):
            try:
                offset += os.write(self.master, payload[offset:])
            except BlockingIOError:
                select.select([], [self.master], [], 0.2)

    def wait_for_exit(self, timeout: float) -> int:
        deadline = time.monotonic() + timeout
        while self.exit_status is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise JourneyFailure(f"bb did not exit through /exit\n{self.screen.text()}")
            self.pump(min(0.2, remaining))
        self.pump(0)
        return self.exit_status

    def close_fd(self) -> None:
        try:
            os.close(self.master)
        except OSError:
            pass


@dataclass(frozen=True)
class BindingSnapshot:
    session_file: Path
    data: dict[str, Any]
    rows: list[dict[str, Any]]


def parse_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        content = path.read_text(encoding="utf-8")
    except (FileNotFoundError, UnicodeDecodeError, OSError):
        return rows
    for line in content.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def binding_snapshot(agent_root: Path) -> BindingSnapshot | None:
    candidates: list[BindingSnapshot] = []
    for path in sorted(agent_root.rglob("*.jsonl")) if agent_root.exists() else ():
        rows = parse_jsonl(path)
        bindings = [
            row.get("data")
            for row in rows
            if row.get("type") == "custom"
            and row.get("customType") == BINDING_TYPE
            and isinstance(row.get("data"), dict)
            and row["data"].get("schemaVersion") == BINDING_SCHEMA
        ]
        if bindings:
            candidates.append(BindingSnapshot(path.resolve(), bindings[-1], rows))
    if not candidates:
        return None
    if len(candidates) != 1:
        raise JourneyFailure(f"expected one OMP session binding file, found {len(candidates)}")
    return candidates[0]


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        str(item.get("text", ""))
        for item in content
        if isinstance(item, dict) and item.get("type") in {"text", "thinking"}
    )


def transcript_facts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    assistant = []
    users: list[str] = []
    tool_calls: list[str] = []
    tool_results: list[str] = []
    for row in rows:
        message = row.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role == "assistant":
            text = content_text(content)
            if text:
                assistant.append(text)
            if isinstance(content, list):
                tool_calls.extend(
                    str(item.get("name"))
                    for item in content
                    if isinstance(item, dict) and item.get("type") == "toolCall"
                )
        elif role == "user":
            text = content_text(content)
            if text:
                users.append(text)
        elif role == "toolResult":
            tool_results.append(str(message.get("toolName", "")))
    return {
        "assistantTexts": assistant,
        "userTexts": users,
        "sentinelCount": sum(ASSISTANT_SENTINEL in text for text in assistant),
        "toolCalls": tool_calls,
        "toolResults": tool_results,
    }


def cursor_sequence(binding: dict[str, Any]) -> int:
    cursor = binding.get("cursor")
    if not isinstance(cursor, dict) or not isinstance(cursor.get("sequence"), int):
        raise JourneyFailure("binding has no integer cursor sequence")
    return int(cursor["sequence"])


def owned_submissions(binding: dict[str, Any]) -> list[dict[str, Any]]:
    value = binding.get("ownedSubmissions")
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise JourneyFailure("binding has invalid ownedSubmissions")
    return value


def active_authority(agent_root: Path) -> tuple[Path, dict[str, Any]] | None:
    candidates: list[tuple[Path, dict[str, Any]]] = []
    for path in agent_root.rglob("*.authority.json") if agent_root.exists() else ():
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict) and value.get("schemaVersion") == "p30.local-authority.v4":
            candidates.append((path.resolve(), value))
    if not candidates:
        return None
    if len(candidates) != 1:
        raise JourneyFailure(f"expected one active engine authority, found {len(candidates)}")
    return candidates[0]


def normalized_transcript(raw: bytes) -> str:
    stripped = ANSI_RE.sub(b"", raw).decode("utf-8", "replace")
    stripped = stripped.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in stripped.splitlines()) + "\n"


def write_capture(output: Path, name: str, child: PtyChild) -> None:
    (output / f"{name}.ansi").write_bytes(bytes(child.raw))
    (output / f"{name}.normalized.txt").write_text(normalized_transcript(bytes(child.raw)), encoding="utf-8")
    (output / f"{name}.screen.txt").write_text(child.screen.text(), encoding="utf-8")


def process_snapshot(pid: int) -> dict[str, Any]:
    commands = {
        "ps": ["/bin/ps", "-o", "pid=,ppid=,state=,command=", "-p", str(pid)],
        "lsof": ["/usr/sbin/lsof", "-nP", "-p", str(pid)],
    }
    result: dict[str, Any] = {}
    for name, command in commands.items():
        completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
        result[name] = {
            "argv": command,
            "exitCode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        }
    return result


def endpoint_open(endpoint: str) -> bool:
    parsed = urlsplit(endpoint)
    host = parsed.hostname
    port = parsed.port
    if host is None or port is None:
        raise JourneyFailure(f"invalid authority endpoint: {endpoint}")
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def extraction_roots(temp_root: Path) -> list[str]:
    return sorted(str(path.resolve()) for path in temp_root.glob("bb-engine-runtime-*") if path.is_dir())


def load_retained_state(agent_root: Path) -> tuple[Path, dict[str, Any], bytes]:
    candidates = sorted(agent_root.rglob("session-state/*.json")) if agent_root.exists() else []
    if len(candidates) != 1:
        raise JourneyFailure(f"expected one retained session-state file, found {len(candidates)}")
    raw = candidates[0].read_bytes()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise JourneyFailure("retained session state is not JSON") from error
    if not isinstance(value, dict):
        raise JourneyFailure("retained session state is not an object")
    return candidates[0].resolve(), value, raw


def parse_status_identity(output: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and value.get("schemaVersion") == "bb.installed_engine_identity.v1":
            return value
    raise JourneyFailure(f"status did not emit installed identity JSON: {output}")


def expected_identity(manifest: dict[str, Any]) -> dict[str, Any]:
    engine = manifest["engine"]
    profile = manifest["profile"]
    return {
        "schemaVersion": "bb.installed_engine_identity.v1",
        "distributionId": manifest["distributionId"],
        "productVersion": manifest["productVersion"],
        "target": manifest["target"],
        "signature": {"kind": manifest["signature"]["kind"]},
        "engine": {
            "runtimeBundleSha256": engine["runtimeBundle"]["sha256"],
            "executableSha256": engine["executableSha256"],
            "engineSourceSha256": engine["engineSourceSha256"],
            "servedBackendCommit": engine["servedBackendCommit"],
            "servedBackendTree": engine["servedBackendTree"],
            "interfaceVersion": engine["interfaceVersion"],
            "interfaceRange": engine["interfaceRange"],
        },
        "profile": {
            "profileId": profile["profileId"],
            "schemaVersion": profile["schemaVersion"],
            "sourceSha256": profile["sourceSha256"],
            "effectiveLockSchemaVersion": profile["effectiveLockSchemaVersion"],
            "effectiveLockSha256": profile["effectiveLockSha256"],
        },
    }


def exact_environment(home: Path, config: Path, agent: Path, temp: Path) -> dict[str, str]:
    user = pwd.getpwuid(os.getuid()).pw_name
    environment = {
        "HOME": str(home),
        "TMPDIR": f"{temp}{os.sep}",
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "SHELL": "/bin/zsh",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "en_US.UTF-8",
        "LC_ALL": "en_US.UTF-8",
        "USER": user,
        "LOGNAME": user,
        "OMP_SKIP_SETUP": "1",
        "BREADBOARD_CONFIG_DIR": str(config),
        "PI_CODING_AGENT_DIR": str(agent),
    }
    forbidden_prefixes = (
        "BREADBOARD_ENGINE_",
        "BREADBOARD_API_",
        "BREADBOARD_SESSION_",
        "BREADBOARD_RUNTIME_",
        "OPENAI_",
        "ANTHROPIC_",
        "OPENROUTER_",
        "GOOGLE_",
        "GEMINI_",
        "OTEL_",
    )
    forbidden_exact = {"PYTHONPATH", "PYTHONHOME", "NODE_PATH"}
    leaked = sorted(
        key for key in environment if key in forbidden_exact or key.startswith(forbidden_prefixes)
    )
    if leaked:
        raise JourneyFailure(f"constructed environment contains forbidden keys: {leaked}")
    return environment


def ensure_empty_directory(path: Path, label: str) -> None:
    if not path.is_absolute() or not path.is_dir() or path.is_symlink():
        raise JourneyFailure(f"{label} must be one absolute real directory: {path}")
    if any(path.iterdir()):
        raise JourneyFailure(f"{label} must be empty before first launch: {path}")


def assert_no_forbidden_paths(value: str, roots: list[Path], label: str) -> None:
    matches = [str(root) for root in roots if str(root) in value]
    if matches:
        raise JourneyFailure(f"{label} contains source checkout paths: {matches}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bb", type=Path, required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--config-root", type=Path, required=True)
    parser.add_argument("--agent-root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--forbid-root", type=Path, action="append", default=[])
    parser.add_argument("--startup-timeout", type=float, default=120.0)
    parser.add_argument("--turn-timeout", type=float, default=180.0)
    options = parser.parse_args()

    bb = options.bb.resolve(strict=True)
    roots = {
        "home": options.home.resolve(strict=True),
        "config": options.config_root.resolve(strict=True),
        "agent": options.agent_root.resolve(strict=True),
        "workspace": options.workspace.resolve(strict=True),
        "temp": options.temp_root.resolve(strict=True),
    }
    output = options.output.resolve(strict=True)
    forbidden_roots = [path.resolve(strict=True) for path in options.forbid_root]
    if not bb.is_file() or not os.access(bb, os.X_OK):
        raise JourneyFailure(f"bb is not executable: {bb}")
    for label, root in roots.items():
        ensure_empty_directory(root, label)
    if any(root == output or output.is_relative_to(root) for root in roots.values()):
        raise JourneyFailure("output must be outside isolated journey roots")
    assert_no_forbidden_paths(str(bb), forbidden_roots, "installed bb path")
    assert_no_forbidden_paths(str(roots["workspace"]), forbidden_roots, "workspace path")

    environment = exact_environment(roots["home"], roots["config"], roots["agent"], roots["temp"])
    (output / "environment.json").write_text(
        json.dumps({"keys": sorted(environment), "values": environment}, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    initial = PtyChild([str(bb)], roots["workspace"], environment)
    try:
        ready = initial.wait_until(
            lambda: binding_snapshot(roots["agent"]), options.startup_timeout, "initial session binding"
        )
        assert isinstance(ready, BindingSnapshot)
        initial_binding = ready.data
        if owned_submissions(initial_binding):
            raise JourneyFailure("new session binding already owns submissions")
        initial_cursor = cursor_sequence(initial_binding)
        authority_path, first_authority = initial.wait_until(
            lambda: active_authority(roots["agent"]), options.startup_timeout, "initial engine authority"
        )
        if not endpoint_open(str(first_authority["normalizedEndpoint"])):
            raise JourneyFailure("managed engine listener is not open before turn one")

        initial.send_line(FIRST_PROMPT)

        def first_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or len(owned_submissions(snapshot.data)) != 1:
                return None
            facts = transcript_facts(snapshot.rows)
            if facts["sentinelCount"] < 1:
                return None
            if not all(
                (roots["workspace"] / name).is_file()
                and (roots["workspace"] / name).stat().st_size > 0
                for name in EXPECTED_FILES
            ):
                return None
            if "list_dir" not in facts["toolCalls"] or "apply_unified_patch" not in facts["toolCalls"]:
                return None
            if "list_dir" not in facts["toolResults"] or "apply_unified_patch" not in facts["toolResults"]:
                return None
            return snapshot

        first = initial.wait_until(first_turn_ready, options.turn_timeout, "first terminal turn")
        assert isinstance(first, BindingSnapshot)
        write_capture(output, "initial-turn-1", initial)
        first_cursor = cursor_sequence(first.data)

        initial.send_line(SECOND_PROMPT)

        def second_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or len(owned_submissions(snapshot.data)) != 2:
                return None
            facts = transcript_facts(snapshot.rows)
            if facts["sentinelCount"] < 2 or cursor_sequence(snapshot.data) <= initial_cursor:
                return None
            return snapshot

        second = initial.wait_until(second_turn_ready, options.turn_timeout, "second terminal turn")
        assert isinstance(second, BindingSnapshot)
        write_capture(output, "initial-turn-2", initial)
        during_initial_extractions = extraction_roots(roots["temp"])
        if len(during_initial_extractions) != 1:
            raise JourneyFailure(f"expected one live extraction root, found {during_initial_extractions}")
        first_processes = {
            "bb": process_snapshot(initial.pid),
            "engine": process_snapshot(int(first_authority["pid"])),
        }
        process_text = json.dumps(first_processes, sort_keys=True)
        assert_no_forbidden_paths(process_text, forbidden_roots, "initial process snapshot")

        initial.send_line("/exit")
        initial_exit = initial.wait_for_exit(60)
        write_capture(output, "initial-exit", initial)
        if initial_exit != 0:
            raise JourneyFailure(f"initial bb exit was {initial_exit}")
    finally:
        initial.close_fd()

    final_initial = binding_snapshot(roots["agent"])
    if final_initial is None:
        raise JourneyFailure("binding disappeared after initial exit")
    final_initial_cursor = cursor_sequence(final_initial.data)
    initial_owned = owned_submissions(final_initial.data)
    if len(initial_owned) != 2 or final_initial_cursor <= cursor_sequence(second.data):
        raise JourneyFailure("initial close did not durably commit the second terminal turn")
    if len({item.get("clientMessageId") for item in initial_owned}) != 2:
        raise JourneyFailure("owned submissions do not have two unique client identities")
    if len({item.get("inputId") for item in initial_owned}) != 2:
        raise JourneyFailure("owned submissions do not have two unique input identities")
    if len({item.get("turnId") for item in initial_owned}) != 2:
        raise JourneyFailure("owned submissions do not have two unique turn identities")
    if process_alive(int(first_authority["pid"])):
        raise JourneyFailure("initial engine PID remains alive after TUI close")
    if endpoint_open(str(first_authority["normalizedEndpoint"])):
        raise JourneyFailure("initial engine listener remains open after TUI close")
    if active_authority(roots["agent"]) is not None:
        raise JourneyFailure("active authority remains after initial close")
    if extraction_roots(roots["temp"]):
        raise JourneyFailure("initial engine extraction root remains after close")

    state_path, retained_state, retained_bytes_before_restart = load_retained_state(roots["agent"])
    if retained_state.get("schema_version") != "bb.cli_bridge.session_state.v1":
        raise JourneyFailure("retained state has the wrong schema")
    turns = retained_state.get("turns")
    envelopes = retained_state.get("terminal_event_envelopes")
    if not isinstance(turns, list) or len(turns) != 2:
        raise JourneyFailure("retained state does not have exactly two turns")
    if not isinstance(envelopes, list) or len(envelopes) != 2:
        raise JourneyFailure("retained state does not have exactly two terminal envelopes")
    if any(turn.get("terminal_resolution_committed") is not True for turn in turns):
        raise JourneyFailure("retained turns are not terminally committed")
    state_session = retained_state.get("session")
    if not isinstance(state_session, dict) or state_session.get("session_id") != final_initial.data.get("sessionId"):
        raise JourneyFailure("retained state and binding disagree on session identity")
    if state_session.get("event_seq") != final_initial_cursor:
        raise JourneyFailure("retained state head and binding cursor disagree")
    retained_text = retained_bytes_before_restart.decode("utf-8")
    if FIRST_PROMPT in retained_text or SECOND_PROMPT in retained_text:
        raise JourneyFailure("retained engine state contains raw prompt text")
    assert_no_forbidden_paths(retained_text, [*forbidden_roots, bb.parent], "retained engine state")

    status = subprocess.run(
        [str(bb), "engine", "status"],
        cwd=roots["workspace"],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    (output / "engine-status.json").write_text(
        json.dumps(
            {"exitCode": status.returncode, "stdout": status.stdout, "stderr": status.stderr},
            indent=2,
            sort_keys=True,
        ) + "\n",
        encoding="utf-8",
    )
    if status.returncode != 0 or status.stderr:
        raise JourneyFailure(f"engine status failed: {status.returncode}: {status.stderr}")
    status_identity = parse_status_identity(status.stdout)
    if status.stdout != json.dumps(status_identity, separators=(",", ":")) + "\n":
        raise JourneyFailure("engine status did not emit exactly one canonical identity line")
    distribution_hex = str(status_identity["distributionId"]).removeprefix("sha256:")
    manifest_path = bb.parent / "engine" / distribution_hex / "breadboard-engine-manifest.v1.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if status_identity != expected_identity(manifest):
        raise JourneyFailure("status installed identity does not match the trusted manifest")
    status_text = json.dumps(status_identity, sort_keys=True)
    for unsafe in (str(bb.parent), str(roots["home"]), str(roots["agent"]), str(roots["config"])):
        if unsafe in status_text:
            raise JourneyFailure("status identity contains a local path")

    resume = PtyChild([str(bb), "--resume", str(final_initial.session_file)], roots["workspace"], environment)
    try:
        def resume_ready() -> tuple[Path, dict[str, Any]] | None:
            authority = active_authority(roots["agent"])
            if authority is None or authority[1].get("launchId") == first_authority.get("launchId"):
                return None
            if ASSISTANT_SENTINEL not in normalized_transcript(bytes(resume.raw)):
                return None
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or snapshot.data != final_initial.data:
                return None
            return authority

        _, second_authority = resume.wait_until(resume_ready, options.startup_timeout, "resume read-back")
        if not endpoint_open(str(second_authority["normalizedEndpoint"])):
            raise JourneyFailure("resumed engine listener is not open")
        for field in ("engineInstanceId", "engineBootId", "launchId", "pid", "osProcessStartToken"):
            if second_authority.get(field) == first_authority.get(field):
                raise JourneyFailure(f"restart did not change {field}")
        if second_authority.get("normalizedEndpoint") != first_authority.get("normalizedEndpoint"):
            raise JourneyFailure("restart changed the managed endpoint")
        during_resume_extractions = extraction_roots(roots["temp"])
        if len(during_resume_extractions) != 1 or during_resume_extractions == during_initial_extractions:
            raise JourneyFailure("restart did not use one new extraction identity")
        second_processes = {
            "bb": process_snapshot(resume.pid),
            "engine": process_snapshot(int(second_authority["pid"])),
        }
        assert_no_forbidden_paths(json.dumps(second_processes, sort_keys=True), forbidden_roots, "resume process snapshot")
        write_capture(output, "resume-readback", resume)
        resume.send_line("/exit")
        resume_exit = resume.wait_for_exit(60)
        write_capture(output, "resume-exit", resume)
        if resume_exit != 0:
            raise JourneyFailure(f"resumed bb exit was {resume_exit}")
    finally:
        resume.close_fd()

    final_resume = binding_snapshot(roots["agent"])
    if final_resume is None or final_resume.data != final_initial.data:
        raise JourneyFailure("resume changed the durable binding without a third turn")
    _, retained_state_after, retained_bytes_after_restart = load_retained_state(roots["agent"])
    if retained_state_after != retained_state or retained_bytes_after_restart != retained_bytes_before_restart:
        raise JourneyFailure("read-only restart changed retained session state")
    if process_alive(int(second_authority["pid"])):
        raise JourneyFailure("resumed engine PID remains alive after TUI close")
    if endpoint_open(str(second_authority["normalizedEndpoint"])):
        raise JourneyFailure("resumed engine listener remains open after TUI close")
    if active_authority(roots["agent"]) is not None:
        raise JourneyFailure("active authority remains after resumed close")
    if extraction_roots(roots["temp"]):
        raise JourneyFailure("resumed engine extraction root remains after close")

    restart_status = subprocess.run(
        [str(bb), "engine", "status"],
        cwd=roots["workspace"],
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    (output / "engine-status-after-resume.json").write_text(
        json.dumps(
            {
                "exitCode": restart_status.returncode,
                "stdout": restart_status.stdout,
                "stderr": restart_status.stderr,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    if restart_status.returncode != 0 or restart_status.stderr:
        raise JourneyFailure(
            f"engine status after resume failed: {restart_status.returncode}: {restart_status.stderr}"
        )
    if parse_status_identity(restart_status.stdout) != status_identity:
        raise JourneyFailure("restart changed the installed distribution or profile identity")
    if restart_status.stdout != status.stdout:
        raise JourneyFailure("restart changed the canonical installed status bytes")
    post_status_binding = binding_snapshot(roots["agent"])
    if post_status_binding is None or post_status_binding.data != final_resume.data:
        raise JourneyFailure("engine status changed the durable session binding")
    if active_authority(roots["agent"]) is not None or extraction_roots(roots["temp"]):
        raise JourneyFailure("engine status spawned managed engine state")

    facts = transcript_facts(final_resume.rows)
    if facts["userTexts"] != [FIRST_PROMPT, SECOND_PROMPT]:
        raise JourneyFailure(
            f"OMP transcript does not contain exactly the two submitted prompts: {facts['userTexts']}"
        )
    if facts["assistantTexts"].count(ASSISTANT_SENTINEL) != 2:
        raise JourneyFailure("OMP transcript does not contain exactly two terminal assistant sentinels")
    if facts["toolCalls"] != ["list_dir", "apply_unified_patch"]:
        raise JourneyFailure(f"OMP transcript has unexpected tool calls: {facts['toolCalls']}")
    if facts["toolResults"] != ["list_dir", "apply_unified_patch"]:
        raise JourneyFailure(f"OMP transcript has unexpected tool results: {facts['toolResults']}")
    session_text = final_resume.session_file.read_text(encoding="utf-8")
    assert_no_forbidden_paths(session_text, [*forbidden_roots, bb.parent], "OMP JSONL")
    summary = {
        "schemaVersion": "bb.installed_two_turn_journey.v1",
        "status": "pass",
        "bb": str(bb),
        "environmentKeys": sorted(environment),
        "sessionFile": str(final_resume.session_file),
        "sessionId": final_resume.data["sessionId"],
        "initialCursor": initial_cursor,
        "firstObservedCursor": first_cursor,
        "secondObservedCursor": cursor_sequence(second.data),
        "finalCursor": final_initial_cursor,
        "ownedSubmissions": initial_owned,
        "transcript": facts,
        "createdFiles": [str((roots["workspace"] / name).resolve()) for name in EXPECTED_FILES],
        "statePath": str(state_path),
        "retainedTurnCount": len(turns),
        "retainedTerminalEnvelopeCount": len(envelopes),
        "statusIdentity": status_identity,
        "manifestPath": str(manifest_path.resolve()),
        "firstAuthorityPath": str(authority_path),
        "firstAuthority": first_authority,
        "secondAuthority": second_authority,
        "initialExtractionRoots": during_initial_extractions,
        "resumeExtractionRoots": during_resume_extractions,
        "initialProcesses": first_processes,
        "resumeProcesses": second_processes,
        "cleanup": {
            "initialPidDead": True,
            "initialListenerClosed": True,
            "initialExtractionRemoved": True,
            "resumePidDead": True,
            "resumeListenerClosed": True,
            "resumeExtractionRemoved": True,
            "durableStateRetained": True,
        },
        "sourceCheckoutPathsAbsent": True,
        "thirdTurnSubmitted": False,
        "providerCalls": False,
    }
    (output / "journey-summary.json").write_text(
        json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps({"status": "pass", "sessionId": summary["sessionId"], "cursor": final_initial_cursor}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except JourneyFailure as error:
        print(f"installed journey failed: {error}", file=sys.stderr)
        raise SystemExit(1)
