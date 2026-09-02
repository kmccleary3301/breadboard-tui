#!/usr/bin/env python3
"""Drive the installed BreadBoard two-turn and resume journey through a real PTY."""

from __future__ import annotations

import atexit
import argparse
import codecs
import csv
import errno
import fcntl
import hashlib
import ipaddress
import json
import os
import pty
import pwd
import re
import select
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import termios
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

ROWS = 36
COLUMNS = 120
ASSISTANT_SENTINEL = "Proceed to build and test."
SYNTHETIC_ASSISTANT_SENTINEL = "Bubble sort validation complete."
FIRST_PROMPT = "Create the deterministic protofilesystem fixture now."
SECOND_PROMPT = "Report the next action after the fixture is ready."
SYNTHETIC_PROMPT = "Create and validate the deterministic bubble sort fixture."
RECONNECT_PROMPT = (
    "Prove the recovered engine can execute the deterministic validation."
)
BINDING_SCHEMA = "breadboard.session-binding.v3"
BINDING_TYPE = "breadboard.session-binding"
EXPECTED_FILES = (
    "Makefile",
    "protofilesystem.h",
    "protofilesystem.c",
    "test_filesystem.c",
)
EVENT_ID_RE = re.compile(
    r"(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|sha256:[0-9a-f]{64})"
)
SYNTHETIC_TOOLS = ("todo.write_board", "write", "run_shell")
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
                ends = [
                    candidate
                    for candidate in (bell, string_terminator)
                    if candidate >= 0
                ]
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
            self.column = max(
                0,
                min(self.columns - 1, ((values[1] if len(values) > 1 else 1) or 1) - 1),
            )
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
                self.grid[self.row][self.column :] = [" "] * (
                    self.columns - self.column
                )
                for row in range(self.row + 1, self.rows):
                    self.grid[row] = [" "] * self.columns
            elif mode == 1:
                for row in range(self.row):
                    self.grid[row] = [" "] * self.columns
                self.grid[self.row][: self.column + 1] = [" "] * (self.column + 1)
        elif final == "K":
            mode = values[0]
            if mode == 0:
                self.grid[self.row][self.column :] = [" "] * (
                    self.columns - self.column
                )
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
                fcntl.ioctl(
                    0, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLUMNS, 0, 0)
                )
                os.closerange(3, os.sysconf("SC_OPEN_MAX"))
                os.execve(argv[0], argv, env)
            except OSError as error:
                os.write(2, f"PTY exec failed: {error}\n".encode())
                os._exit(127)
        self.pid = pid
        self.master = master
        self.raw = bytearray()
        self.screen = TerminalScreen()
        self.exit_status: int | None = None
        fcntl.ioctl(
            master, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLUMNS, 0, 0)
        )
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

    def wait_until(
        self, predicate: Callable[[], Any], timeout: float, label: str
    ) -> Any:
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

    def send(self, payload: bytes) -> None:
        if self.exit_status is not None:
            raise JourneyFailure(f"cannot send to exited bb ({self.exit_status})")
        offset = 0
        while offset < len(payload):
            try:
                offset += os.write(self.master, payload[offset:])
            except BlockingIOError:
                select.select([], [self.master], [], 0.2)

    def send_line(self, text: str) -> None:
        self.send(text.encode("utf-8") + b"\r")

    def send_escape(self) -> None:
        self.send(b"\x1b")

    def send_enter(self) -> None:
        self.send(b"\r")

    def wait_for_exit(self, timeout: float) -> int:
        deadline = time.monotonic() + timeout
        while self.exit_status is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise JourneyFailure(
                    f"bb did not exit through /exit\n{self.screen.text()}"
                )
            self.pump(min(0.2, remaining))
        self.pump(0)
        return self.exit_status

    def close_fd(self) -> None:
        try:
            os.close(self.master)
        except OSError:
            pass

    def close(self) -> None:
        if self.exit_status is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            while self.exit_status is None and time.monotonic() < deadline:
                self.pump(0.1)
            if self.exit_status is None:
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    _, status = os.waitpid(self.pid, 0)
                    self.exit_status = os.waitstatus_to_exitcode(status)
                except ChildProcessError:
                    self._observe_exit()
        self.close_fd()


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


def active_terminal_session_files(agent_root: Path) -> set[Path]:
    latest: tuple[int, Path] | None = None
    terminal_root = agent_root / "terminal-sessions"
    for path in sorted(terminal_root.iterdir()) if terminal_root.exists() else ():
        try:
            modified = path.stat().st_mtime_ns
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        if len(lines) < 2 or not lines[1]:
            continue
        candidate = (modified, Path(lines[1]).resolve())
        if latest is None or candidate[0] > latest[0]:
            latest = candidate
    return {latest[1]} if latest is not None else set()


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
    active_files = active_terminal_session_files(agent_root)
    active_candidates = [
        candidate for candidate in candidates if candidate.session_file in active_files
    ]
    if len(active_candidates) == 1:
        return active_candidates[0]
    if not active_candidates and active_files:
        return None
    if len(candidates) == 1:
        return candidates[0]
    raise JourneyFailure(
        "expected one active OMP session binding file, "
        f"found {len(active_candidates)} among {len(candidates)} retained files"
    )


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
    assistant: list[str] = []
    assistant_stops: list[str | None] = []
    assistant_errors: list[str] = []
    users: list[str] = []
    tool_calls: list[str] = []
    tool_results: list[str] = []
    tool_call_rows: list[dict[str, Any]] = []
    tool_result_rows: list[dict[str, Any]] = []
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
            stop_reason = message.get("stopReason")
            assistant_stops.append(
                stop_reason if isinstance(stop_reason, str) else None
            )
            error_message = message.get("errorMessage")
            if isinstance(error_message, str) and error_message:
                assistant_errors.append(error_message)
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict) or item.get("type") != "toolCall":
                        continue
                    name = str(item.get("name", ""))
                    tool_calls.append(name)
                    tool_call_rows.append(
                        {
                            "id": str(item.get("id", "")),
                            "name": name,
                            "arguments": item.get("arguments"),
                        }
                    )
        elif role == "user":
            text = content_text(content)
            if text:
                users.append(text)
        elif role == "toolResult":
            name = str(message.get("toolName", ""))
            tool_results.append(name)
            tool_result_rows.append(
                {
                    "id": str(message.get("toolCallId", "")),
                    "name": name,
                    "isError": message.get("isError") is True,
                    "content": content_text(content),
                }
            )
    return {
        "assistantTexts": assistant,
        "assistantErrors": assistant_errors,
        "assistantStopReasons": assistant_stops,
        "userTexts": users,
        "sentinelCount": sum(ASSISTANT_SENTINEL in text for text in assistant),
        "completionSentinelCount": sum("TASK COMPLETE" in text for text in assistant),
        "toolCalls": tool_calls,
        "toolResults": tool_results,
        "toolCallRows": tool_call_rows,
        "toolResultRows": tool_result_rows,
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
        if (
            isinstance(value, dict)
            and value.get("schemaVersion") == "p30.local-authority.v4"
        ):
            candidates.append((path.resolve(), value))
    if not candidates:
        return None
    if len(candidates) != 1:
        raise JourneyFailure(
            f"expected one active engine authority, found {len(candidates)}"
        )
    return candidates[0]


def normalized_transcript(raw: bytes) -> str:
    stripped = ANSI_RE.sub(b"", raw).decode("utf-8", "replace")
    stripped = stripped.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in stripped.splitlines()) + "\n"


def write_capture(output: Path, name: str, child: PtyChild) -> None:
    (output / f"{name}.ansi").write_bytes(bytes(child.raw))
    (output / f"{name}.normalized.txt").write_text(
        normalized_transcript(bytes(child.raw)), encoding="utf-8"
    )
    (output / f"{name}.screen.txt").write_text(child.screen.text(), encoding="utf-8")


def process_snapshot(pid: int) -> dict[str, Any]:
    commands = {
        "ps": ["/bin/ps", "-o", "pid=,ppid=,state=,command=", "-p", str(pid)],
        "lsof": ["/usr/sbin/lsof", "-nP", "-p", str(pid)],
    }
    result: dict[str, Any] = {}
    for name, command in commands.items():
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=10, check=False
        )
        result[name] = {
            "argv": command,
            "exitCode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        }
    return result


def process_environment_contains(pid: int, value: str) -> bool | None:
    completed = subprocess.run(
        ["/bin/ps", "eww", "-p", str(pid), "-o", "command="],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        return None
    return value in completed.stdout


def assert_loopback_network(processes: dict[str, Any], label: str) -> None:
    violations: list[str] = []
    for process_name, snapshot in processes.items():
        lsof = snapshot.get("lsof")
        output = lsof.get("stdout") if isinstance(lsof, dict) else None
        if not isinstance(output, str):
            raise JourneyFailure(f"{label} has no lsof output for {process_name}")
        for transport, address in re.findall(r"\b(TCP|UDP) ([^\s]+)", output):
            for endpoint in address.split("->"):
                if endpoint.startswith("[") and "]:" in endpoint:
                    host = endpoint[1 : endpoint.index("]")]
                else:
                    host, separator, _ = endpoint.rpartition(":")
                    if not separator:
                        host = ""
                try:
                    loopback = ipaddress.ip_address(host).is_loopback
                except ValueError:
                    loopback = False
                if not loopback:
                    violations.append(f"{process_name}:{transport}:{endpoint}")
    if violations:
        raise JourneyFailure(
            f"{label} opened non-loopback network endpoints: {violations}"
        )


def create_browser_launch_guard(
    temp_root: Path, environment: dict[str, str]
) -> tuple[Path, dict[str, Any]]:
    guard_root = temp_root / "g6-browser-guard-bin"
    guard_root.mkdir(mode=0o700)
    marker = temp_root / "g6-browser-launch-attempted"
    guard = guard_root / "open"
    guard.write_text(
        "#!/usr/bin/python3\n"
        "from pathlib import Path\n"
        f"Path({str(marker)!r}).open('a', encoding='utf-8').write('attempted\\n')\n"
        "raise SystemExit(125)\n",
        encoding="utf-8",
    )
    guard.chmod(0o700)
    environment["BROWSER"] = str(guard)
    environment["PATH"] = f"{guard_root}:{environment['PATH']}"
    probe = subprocess.run(
        [str(guard), "control-probe"],
        cwd=temp_root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if (
        probe.returncode != 125
        or not marker.is_file()
        or marker.read_text(encoding="utf-8").splitlines() != ["attempted"]
    ):
        raise JourneyFailure("OAuth browser launch guard control probe failed")
    marker.unlink()
    return marker, {
        "schemaVersion": "bb.g6_browser_launch_guard.v1",
        "status": "pass",
        "environmentKey": "BROWSER",
        "pathCommand": "open",
        "controlProbeExitCode": probe.returncode,
        "attemptCount": 0,
    }


def start_network_audit(
    temp_root: Path,
) -> tuple[Path, subprocess.Popen[str], Any]:
    nettop = Path("/usr/bin/nettop")
    if not nettop.is_file() or not os.access(nettop, os.X_OK):
        raise JourneyFailure("continuous network audit requires /usr/bin/nettop")
    raw_path = temp_root / "g6-network-audit.raw.csv"
    stream = raw_path.open("w", encoding="utf-8", newline="")
    process = subprocess.Popen(
        [
            str(nettop),
            "-L",
            "0",
            "-n",
            "-x",
            "-s",
            "1",
        ],
        stdout=stream,
        stderr=subprocess.PIPE,
        text=True,
    )
    if process.poll() is not None:
        stream.close()
        raise JourneyFailure("continuous network audit exited during startup")
    return raw_path, process, stream


def stop_network_audit(process: subprocess.Popen[str], stream: Any) -> str:
    if process.poll() is None:
        process.terminate()
    try:
        _, stderr = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        _, stderr = process.communicate(timeout=5)
    stream.close()
    if process.returncode not in (0, -signal.SIGTERM):
        raise JourneyFailure(
            f"continuous network audit exited unexpectedly: {process.returncode}"
        )
    return stderr


def analyze_network_audit(
    raw_path: Path, filtered_path: Path, expected_pids: set[int], stderr: str
) -> dict[str, Any]:
    selected_rows: list[list[str]] = []
    connection_rows: list[dict[str, Any]] = []
    observed_pids: set[int] = set()
    current_pid: int | None = None
    with raw_path.open(encoding="utf-8", newline="") as stream:
        for row in csv.reader(stream):
            if not row:
                continue
            if row[0] == "time":
                if not selected_rows:
                    selected_rows.append(row)
                continue
            descriptor = row[1] if len(row) > 1 else ""
            summary = (
                None
                if descriptor.startswith(("tcp", "udp"))
                else re.fullmatch(r".+\.(\d+)", descriptor)
            )
            if summary is not None:
                current_pid = int(summary.group(1))
                if current_pid in expected_pids:
                    observed_pids.add(current_pid)
                    selected_rows.append(row)
                continue
            if current_pid not in expected_pids or not descriptor.startswith(
                ("tcp", "udp")
            ):
                continue
            interface = row[2] if len(row) > 2 else ""
            connection = {
                "pid": current_pid,
                "descriptor": descriptor,
                "interface": interface,
                "state": row[3] if len(row) > 3 else "",
            }
            connection_rows.append(connection)
            selected_rows.append(row)
    missing_pids = sorted(expected_pids - observed_pids)
    if missing_pids:
        raise JourneyFailure(
            f"continuous network audit missed managed process IDs: {missing_pids}"
        )
    violations = [row for row in connection_rows if row["interface"] not in ("", "lo0")]
    if violations:
        raise JourneyFailure(
            f"managed product opened non-loopback network connections: {violations}"
        )
    with filtered_path.open("w", encoding="utf-8", newline="") as stream:
        csv.writer(stream).writerows(selected_rows)
    raw_path.unlink()
    return {
        "schemaVersion": "bb.g6_network_observation.v1",
        "status": "pass",
        "sampleIntervalMilliseconds": 1_000,
        "observedPids": sorted(observed_pids),
        "connectionSampleCount": len(connection_rows),
        "nonLoopbackConnectionCount": len(violations),
        "loopbackOnly": True,
        "filteredTrace": filtered_path.name,
        "filteredTraceSha256": hashlib.sha256(filtered_path.read_bytes()).hexdigest(),
        "stderr": stderr,
    }


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
    return sorted(
        str(path.resolve())
        for path in temp_root.glob("bb-engine-runtime-*")
        if path.is_dir()
    )


def ray_runtime_roots(temp_root: Path) -> set[str]:
    return {
        str(path.resolve())
        for path in temp_root.glob("bb-ray-*")
        if path.is_dir() and not path.is_symlink()
    }


def ray_runtime_snapshot(runtime_root: str) -> dict[str, Any]:
    ray_root = Path(runtime_root) / "ray"
    sessions = sorted(
        path.resolve()
        for path in ray_root.glob("session_*")
        if path.is_dir() and not path.is_symlink()
    )
    if len(sessions) != 1:
        raise JourneyFailure(f"expected one ephemeral Ray session, found {sessions}")
    logs_root = sessions[0] / "logs"
    log_files = (
        [
            path
            for path in logs_root.rglob("*")
            if path.is_file() and not path.is_symlink()
        ]
        if logs_root.is_dir()
        else []
    )
    log_bytes = sum(path.stat().st_size for path in log_files)
    log_byte_limit = 1_048_576
    if log_bytes > log_byte_limit:
        raise JourneyFailure(
            f"ephemeral Ray logs exceed {log_byte_limit} bytes: {log_bytes}"
        )
    return {
        "runtimeRoot": str(Path(runtime_root).resolve()),
        "rayRoot": str(ray_root.resolve()),
        "sessionPath": str(sessions[0]),
        "logFileCount": len(log_files),
        "logBytes": log_bytes,
        "logByteLimit": log_byte_limit,
    }


def load_retained_state(agent_root: Path) -> tuple[Path, dict[str, Any], bytes]:
    candidates = (
        sorted(agent_root.rglob("session-state/*.json")) if agent_root.exists() else []
    )
    if not candidates:
        raise JourneyFailure("expected one retained session-state file, found 0")
    active_binding = binding_snapshot(agent_root)
    active_session_id = (
        active_binding.data.get("sessionId") if active_binding is not None else None
    )
    matches: list[tuple[Path, dict[str, Any], bytes]] = []
    for candidate in candidates:
        raw = candidate.read_bytes()
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise JourneyFailure("retained session state is not JSON") from error
        if not isinstance(value, dict):
            raise JourneyFailure("retained session state is not an object")
        session = value.get("session")
        if (
            len(candidates) == 1
            or isinstance(session, dict)
            and session.get("session_id") == active_session_id
        ):
            matches.append((candidate.resolve(), value, raw))
    if len(matches) != 1:
        raise JourneyFailure(
            "expected one retained state for the active session, "
            f"found {len(matches)} among {len(candidates)} retained files"
        )
    return matches[0]


def retained_state_snapshot(
    agent_root: Path,
) -> tuple[Path, dict[str, Any], bytes] | None:
    candidates = (
        sorted(agent_root.rglob("session-state/*.json")) if agent_root.exists() else []
    )
    if not candidates:
        return None
    return load_retained_state(agent_root)


def terminal_turns(state: dict[str, Any]) -> list[dict[str, Any]]:
    turns = state.get("turns")
    if not isinstance(turns, list) or not all(isinstance(turn, dict) for turn in turns):
        raise JourneyFailure("retained state has invalid turns")
    return [turn for turn in turns if turn.get("terminal_resolution_committed") is True]


def terminal_envelopes(state: dict[str, Any]) -> list[dict[str, Any]]:
    envelopes = state.get("terminal_event_envelopes")
    if not isinstance(envelopes, list) or not all(
        isinstance(envelope, dict) for envelope in envelopes
    ):
        raise JourneyFailure("retained state has invalid terminal envelopes")
    return envelopes


def wait_for_terminal_state(
    child: PtyChild,
    agent_root: Path,
    count: int,
    timeout: float,
    label: str,
    outcome: str | None = None,
) -> tuple[Path, dict[str, Any], bytes]:
    def ready() -> tuple[Path, dict[str, Any], bytes] | None:
        snapshot = retained_state_snapshot(agent_root)
        if snapshot is None:
            return None
        turns = terminal_turns(snapshot[1])
        if len(turns) < count:
            return None
        if outcome is not None and turns[count - 1].get("terminal_outcome") != outcome:
            return None
        return snapshot

    result = child.wait_until(ready, timeout, label)
    assert isinstance(result, tuple)
    return result


def binding_history(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        row["data"]
        for row in rows
        if row.get("type") == "custom"
        and row.get("customType") == BINDING_TYPE
        and isinstance(row.get("data"), dict)
        and row["data"].get("schemaVersion") == BINDING_SCHEMA
    ]


def validate_binding_history(rows: list[dict[str, Any]]) -> dict[str, Any]:
    history = binding_history(rows)
    if not history:
        raise JourneyFailure("transcript contains no BreadBoard binding history")
    session_ids = {entry.get("sessionId") for entry in history}
    replay_digests = {entry.get("replayConfigurationDigest") for entry in history}
    if len(session_ids) != 1 or len(replay_digests) != 1:
        raise JourneyFailure(
            "binding history changed session or replay configuration identity"
        )
    prior_sequence = -1
    event_ids: dict[int, str | None] = {}
    for entry in history:
        cursor = entry.get("cursor")
        if not isinstance(cursor, dict) or type(cursor.get("sequence")) is not int:
            raise JourneyFailure("binding history contains an invalid cursor")
        sequence = int(cursor["sequence"])
        event_id = cursor.get("eventId")
        if event_id is not None and (
            not isinstance(event_id, str) or EVENT_ID_RE.fullmatch(event_id) is None
        ):
            raise JourneyFailure("binding history contains an invalid event identity")
        if sequence < prior_sequence:
            raise JourneyFailure("binding history rolled back its cursor")
        if sequence in event_ids and event_ids[sequence] != event_id:
            raise JourneyFailure("binding history conflicts at one cursor sequence")
        event_ids[sequence] = event_id
        prior_sequence = sequence
        submissions = owned_submissions(entry)
        for field in ("clientMessageId", "inputId", "turnId"):
            values = [submission.get(field) for submission in submissions]
            if len(values) != len(set(values)) or any(
                not isinstance(value, str) or not value for value in values
            ):
                raise JourneyFailure(
                    f"binding history contains duplicate or invalid {field} values"
                )
    return {
        "entryCount": len(history),
        "sessionId": next(iter(session_ids)),
        "replayConfigurationDigest": next(iter(replay_digests)),
        "firstCursor": history[0]["cursor"],
        "finalCursor": history[-1]["cursor"],
        "uniqueCursorCount": len(event_ids),
        "cursorRollback": False,
        "cursorConflict": False,
    }


def session_event_journal(agent_root: Path) -> tuple[Path, list[dict[str, Any]]]:
    candidates = sorted(agent_root.rglob("session-events/*/session_events.jsonl"))
    if len(candidates) > 1:
        active_binding = binding_snapshot(agent_root)
        active_session_id = (
            active_binding.data.get("sessionId") if active_binding is not None else None
        )
        candidates = [
            path for path in candidates if path.parent.name == active_session_id
        ]
    if len(candidates) != 1:
        raise JourneyFailure(
            "expected one retained event journal for the active session, "
            f"found {len(candidates)}"
        )
    rows = parse_jsonl(candidates[0])
    if not rows:
        raise JourneyFailure("retained session event journal is empty")
    expected_sequences = list(range(1, len(rows) + 1))
    sequences = [row.get("sequence") for row in rows]
    if sequences != expected_sequences:
        raise JourneyFailure(
            f"retained session event journal is not contiguous: {sequences}"
        )
    session_ids = {row.get("session_id") for row in rows}
    if len(session_ids) != 1 or not isinstance(next(iter(session_ids)), str):
        raise JourneyFailure("retained session event journal changed session identity")
    return candidates[0].resolve(), rows


def validate_tool_receipts(facts: dict[str, Any]) -> dict[str, Any]:
    call_rows = facts["toolCallRows"]
    result_rows = facts["toolResultRows"]
    if any(not row["id"] or not row["name"] for row in call_rows):
        raise JourneyFailure(
            "transcript has a tool call without a call identity or name"
        )
    if any(not row["id"] or not row["name"] for row in result_rows):
        raise JourneyFailure(
            "transcript has a tool result without a call identity or name"
        )
    call_counts: dict[tuple[str, str], int] = {}
    result_counts: dict[tuple[str, str], int] = {}
    for row in call_rows:
        key = (row["id"], row["name"])
        call_counts[key] = call_counts.get(key, 0) + 1
    for row in result_rows:
        key = (row["id"], row["name"])
        result_counts[key] = result_counts.get(key, 0) + 1
    unmatched = sorted(
        f"{call_id}:{name}"
        for (call_id, name), count in result_counts.items()
        if count > call_counts.get((call_id, name), 0)
    )
    if unmatched:
        raise JourneyFailure(f"transcript has uncorrelated tool results: {unmatched}")
    return {
        "callCount": len(call_rows),
        "resultCount": len(result_rows),
        "uniqueCallIdentities": len(call_counts),
        "uncorrelatedResultIds": [],
    }


def authority_identity(authority: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "pid",
        "osProcessStartToken",
        "engineInstanceId",
        "engineBootId",
        "launchId",
        "ownerGeneration",
        "recordRevision",
        "normalizedEndpoint",
    )
    return {field: authority.get(field) for field in fields}


def process_descendants(root_pid: int) -> list[dict[str, Any]]:
    completed = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,state=,command="],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    rows: list[dict[str, Any]] = []
    for line in completed.stdout.splitlines():
        fields = line.strip().split(maxsplit=3)
        if len(fields) != 4 or not fields[0].isdigit() or not fields[1].isdigit():
            continue
        rows.append(
            {
                "pid": int(fields[0]),
                "ppid": int(fields[1]),
                "state": fields[2],
                "command": fields[3],
            }
        )
    descendants: list[dict[str, Any]] = []
    parents = {root_pid}
    while True:
        children = [
            row for row in rows if row["ppid"] in parents and row not in descendants
        ]
        if not children:
            return descendants
        descendants.extend(children)
        parents.update(int(child["pid"]) for child in children)


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def native_auth_row_counts(agent_root: Path) -> dict[str, int]:
    database = agent_root / "agent.db"
    if not database.is_file():
        return {}
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        tables = [
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'auth_%' ORDER BY name"
            )
        ]
        return {
            table: int(
                connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            )
            for table in tables
        }


def parse_status_identity(output: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(value, dict)
            and value.get("schemaVersion") == "bb.installed_engine_identity.v1"
        ):
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


def installed_status(
    bb: Path,
    workspace: Path,
    environment: dict[str, str],
    label: str,
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any], Path]:
    completed = subprocess.run(
        [str(bb), "engine", "status"],
        cwd=workspace,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0 or completed.stderr:
        raise JourneyFailure(
            f"{label} failed: {completed.returncode}: {completed.stderr}"
        )
    identity = parse_status_identity(completed.stdout)
    if completed.stdout != json.dumps(identity, separators=(",", ":")) + "\n":
        raise JourneyFailure(
            f"{label} did not emit exactly one canonical identity line"
        )
    distribution_id = identity.get("distributionId")
    if (
        not isinstance(distribution_id, str)
        or re.fullmatch(r"sha256:[0-9a-f]{64}", distribution_id) is None
    ):
        raise JourneyFailure(f"{label} emitted an invalid distribution identity")
    manifest_path = (
        bb.parent
        / "engine"
        / distribution_id.removeprefix("sha256:")
        / "breadboard-engine-manifest.v1.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if identity != expected_identity(manifest):
        raise JourneyFailure(f"{label} identity does not match the trusted manifest")
    return completed, identity, manifest_path


def exact_environment(
    home: Path, config: Path, agent: Path, temp: Path
) -> dict[str, str]:
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
        key
        for key in environment
        if key in forbidden_exact or key.startswith(forbidden_prefixes)
    )
    if leaked:
        raise JourneyFailure(
            f"constructed environment contains forbidden keys: {leaked}"
        )
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


TAMPER_REMEDIATION = (
    "Reinstall BreadBoard from one complete trusted distribution; "
    "do not edit the manifest or supply replacement hashes."
)
TAMPER_MESSAGES = {
    "engine_artifact_mismatch": (
        "The installed BreadBoard engine executable does not match its trusted distribution."
    ),
    "engine_manifest_untrusted": (
        "The installed BreadBoard engine manifest is not trusted by this bb build."
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mutate_sealed_byte(path: Path, offset: int, replacement: int) -> tuple[int, int]:
    if path.is_symlink() or not path.is_file():
        raise JourneyFailure(f"tamper target is not one regular file: {path}")
    if offset < 0 or offset >= path.stat().st_size:
        raise JourneyFailure(f"tamper offset is outside target: {offset}")
    parent = path.parent
    os.chmod(parent, 0o700)
    os.chmod(path, 0o600)
    descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        original = os.pread(descriptor, 1, offset)
        if len(original) != 1 or original[0] == replacement:
            raise JourneyFailure("tamper mutation did not replace exactly one byte")
        if os.pwrite(descriptor, bytes((replacement,)), offset) != 1:
            raise JourneyFailure("tamper mutation did not write exactly one byte")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
        os.chmod(path, 0o400)
        os.chmod(parent, 0o500)
    return original[0], replacement


def remove_readonly_tree(path: Path) -> None:
    if not path.exists():
        return
    for root, directories, files in os.walk(path, topdown=False):
        for name in files:
            candidate = Path(root) / name
            if not candidate.is_symlink():
                os.chmod(candidate, 0o600)
        for name in directories:
            candidate = Path(root) / name
            if not candidate.is_symlink():
                os.chmod(candidate, 0o700)
        os.chmod(root, 0o700)
    shutil.rmtree(path)


def run_tamper_failure(
    bb: Path,
    output: Path,
    case: str,
    expected_code: str,
    forbidden_roots: list[Path],
) -> dict[str, Any]:
    install_copy = output / f"{case}-installed"
    isolated = output / f"{case}-isolated"
    if install_copy.exists() or isolated.exists():
        raise JourneyFailure(f"tamper case path already exists: {case}")
    shutil.copytree(bb.parent, install_copy, copy_function=shutil.copy2)
    try:
        engine_root = install_copy / "engine"
        distributions = [
            path
            for path in engine_root.iterdir()
            if path.is_dir() and not path.is_symlink()
        ]
        if len(distributions) != 1:
            raise JourneyFailure(
                f"tamper copy has unexpected distributions: {distributions}"
            )
        distribution = distributions[0]
        manifest_path = distribution / "breadboard-engine-manifest.v1.json"
        manifest_bytes = manifest_path.read_bytes()
        try:
            manifest = json.loads(manifest_bytes)
        except json.JSONDecodeError as error:
            raise JourneyFailure("trusted manifest copy is not JSON") from error

        if case == "bundle-tamper":
            target = distribution / manifest["engine"]["runtimeBundle"]["path"]
            offset = target.stat().st_size // 2
            with target.open("rb") as handle:
                handle.seek(offset)
                original = handle.read(1)
            if len(original) != 1:
                raise JourneyFailure("runtime bundle mutation offset is unreadable")
            replacement = original[0] ^ 1
        elif case == "manifest-profile-tamper":
            target = manifest_path
            profile = b"daily_driver.v1"
            profile_offset = manifest_bytes.find(profile)
            if profile_offset < 0:
                raise JourneyFailure(
                    "trusted manifest has no daily_driver.v1 profile identity"
                )
            offset = profile_offset + len(profile) - 1
            replacement = ord("2")
        else:
            raise JourneyFailure(f"unknown tamper case: {case}")

        before_sha256 = sha256_file(target)
        original_byte, replacement_byte = mutate_sealed_byte(
            target, offset, replacement
        )
        after_sha256 = sha256_file(target)
        if before_sha256 == after_sha256:
            raise JourneyFailure(f"{case} did not change the target digest")

        roots = {
            label: isolated / label
            for label in ("home", "config", "agent", "workspace", "temp")
        }
        for root in roots.values():
            root.mkdir(parents=True, mode=0o700)
            ensure_empty_directory(root, f"{case} {root.name}")
        environment = exact_environment(
            roots["home"], roots["config"], roots["agent"], roots["temp"]
        )
        baseline_ray_roots = ray_runtime_roots(roots["temp"])
        if endpoint_open("http://127.0.0.1:9099"):
            raise JourneyFailure(
                "port 9099 is unexpectedly occupied before tamper failure"
            )
        completed = subprocess.run(
            [str(install_copy / "bb"), "engine", "start"],
            cwd=roots["workspace"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        expected_stderr = (
            f"BreadBoard installed engine error [{expected_code}]: "
            f"{TAMPER_MESSAGES[expected_code]}\n{TAMPER_REMEDIATION}\n"
        )
        if completed.returncode != 1:
            raise JourneyFailure(f"{case} exited {completed.returncode}, expected 1")
        if completed.stdout != "" or completed.stderr != expected_stderr:
            raise JourneyFailure(
                f"{case} emitted unexpected output: {completed.stdout!r} {completed.stderr!r}"
            )
        assert_no_forbidden_paths(completed.stderr, forbidden_roots, f"{case} output")
        support_files = sorted(
            str(path.relative_to(roots["agent"]))
            for path in roots["agent"].rglob("*")
            if path.is_file() or path.is_symlink()
        )
        publications = [
            path
            for path in support_files
            if path.endswith((".authority.json", ".jsonl")) or "session-state/" in path
        ]
        if publications:
            raise JourneyFailure(
                f"{case} published engine or session state: {publications}"
            )
        if active_authority(roots["agent"]) is not None:
            raise JourneyFailure(f"{case} published an engine authority")
        if binding_snapshot(roots["agent"]) is not None:
            raise JourneyFailure(f"{case} published a session binding")
        if extraction_roots(roots["temp"]):
            raise JourneyFailure(f"{case} extracted an engine runtime")
        if ray_runtime_roots(roots["temp"]) != baseline_ray_roots:
            raise JourneyFailure(f"{case} created a Ray runtime root")
        if endpoint_open("http://127.0.0.1:9099"):
            raise JourneyFailure(f"{case} opened port 9099")

        result = {
            "case": case,
            "status": "pass",
            "expectedCode": expected_code,
            "exitCode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "targetRelativePath": str(target.relative_to(install_copy)),
            "supportFiles": support_files,
            "targetSizeBytes": target.stat().st_size,
            "targetSha256Before": before_sha256,
            "targetSha256After": after_sha256,
            "mutation": {
                "offset": offset,
                "originalByte": original_byte,
                "replacementByte": replacement_byte,
            },
            "environmentKeys": sorted(environment),
            "preSpawnFailure": True,
            "listenerPublished": False,
            "authorityPublished": False,
            "bindingPublished": False,
            "sessionStatePublished": False,
            "runtimeExtracted": False,
            "rayRuntimeCreated": False,
            "fallbackUsed": False,
        }
    finally:
        remove_readonly_tree(install_copy)
        remove_readonly_tree(isolated)
    return result


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
    host_agent_root = Path.home().resolve() / ".omp" / "agent"
    if not bb.is_file() or not os.access(bb, os.X_OK):
        raise JourneyFailure(f"bb is not executable: {bb}")
    for label, root in roots.items():
        ensure_empty_directory(root, label)
    if any(root == output or output.is_relative_to(root) for root in roots.values()):
        raise JourneyFailure("output must be outside isolated journey roots")
    assert_no_forbidden_paths(str(bb), forbidden_roots, "installed bb path")
    assert_no_forbidden_paths(
        str(roots["workspace"]), forbidden_roots, "workspace path"
    )

    environment = exact_environment(
        roots["home"], roots["config"], roots["agent"], roots["temp"]
    )
    secret_canary = f"g6-secret-{hashlib.sha256(os.urandom(32)).hexdigest()}"
    environment["BB_G6_SECRET_CANARY"] = secret_canary
    browser_marker, browser_observation = create_browser_launch_guard(
        roots["temp"], environment
    )
    network_audit_raw, network_audit_process, network_audit_stream = (
        start_network_audit(roots["temp"])
    )

    def stop_network_audit_at_exit() -> None:
        if network_audit_process.poll() is None:
            network_audit_process.terminate()
            try:
                network_audit_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                network_audit_process.kill()
                network_audit_process.wait(timeout=5)
        if not network_audit_stream.closed:
            network_audit_stream.close()

    atexit.register(stop_network_audit_at_exit)
    recorded_environment = {
        key: "<secret-canary>" if key == "BB_G6_SECRET_CANARY" else value
        for key, value in environment.items()
    }
    write_json(
        output / "environment.json",
        {"keys": sorted(environment), "values": recorded_environment},
    )
    action_trace: list[dict[str, Any]] = []
    journey_started = time.monotonic()

    def record_action(action: str, **details: Any) -> None:
        action_trace.append(
            {
                "action": action,
                "elapsedSeconds": round(time.monotonic() - journey_started, 6),
                **details,
            }
        )
        write_json(output / "ui-action-trace.json", action_trace)

    baseline_ray_runtime_roots = ray_runtime_roots(roots["temp"])
    preflight_status, preflight_status_identity, preflight_manifest_path = (
        installed_status(
            bb,
            roots["workspace"],
            environment,
            "engine status before launch",
        )
    )
    (output / "engine-status-before-launch.json").write_text(
        json.dumps(
            {
                "exitCode": preflight_status.returncode,
                "stdout": preflight_status.stdout,
                "stderr": preflight_status.stderr,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    preflight_status_text = json.dumps(preflight_status_identity, sort_keys=True)
    for unsafe in (
        str(bb.parent),
        str(roots["home"]),
        str(roots["agent"]),
        str(roots["config"]),
    ):
        if unsafe in preflight_status_text:
            raise JourneyFailure("preflight status identity contains a local path")
    if (
        active_authority(roots["agent"]) is not None
        or binding_snapshot(roots["agent"]) is not None
        or extraction_roots(roots["temp"])
        or ray_runtime_roots(roots["temp"]) != baseline_ray_runtime_roots
        or endpoint_open("http://127.0.0.1:9099")
    ):
        raise JourneyFailure(
            "preflight status created runtime authority or process state"
        )
    initial = PtyChild([str(bb)], roots["workspace"], environment)
    try:
        initial.wait_until(
            lambda: (
                "mock/reference" in initial.screen.text()
                and "No LSP servers" in initial.screen.text()
            ),
            options.startup_timeout,
            "initial TUI readiness",
        )
        write_capture(output, "initial-ready", initial)
        if binding_snapshot(roots["agent"]) is not None:
            raise JourneyFailure(
                "new TUI created a session binding before the first submitted turn"
            )
        _initial_authority_path, first_authority = initial.wait_until(
            lambda: active_authority(roots["agent"]),
            options.startup_timeout,
            "initial engine authority",
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
            if (
                "list_dir" not in facts["toolCalls"]
                or "apply_unified_patch" not in facts["toolCalls"]
            ):
                return None
            if (
                "list_dir" not in facts["toolResults"]
                or "apply_unified_patch" not in facts["toolResults"]
            ):
                return None
            return snapshot

        first = initial.wait_until(
            first_turn_ready, options.turn_timeout, "first terminal turn"
        )
        assert isinstance(first, BindingSnapshot)
        write_capture(output, "initial-turn-1", initial)
        first_facts = transcript_facts(first.rows)
        if first_facts["userTexts"] != [FIRST_PROMPT]:
            raise JourneyFailure(
                f"first turn has unexpected user messages: {first_facts['userTexts']}"
            )
        if first_facts["assistantTexts"].count(ASSISTANT_SENTINEL) != 1:
            raise JourneyFailure(
                "first turn does not contain exactly one terminal assistant sentinel"
            )
        if first_facts["toolCalls"] != ["list_dir", "apply_unified_patch"]:
            raise JourneyFailure(
                f"first turn has unexpected tool calls: {first_facts['toolCalls']}"
            )
        if first_facts["toolResults"] != ["list_dir", "apply_unified_patch"]:
            raise JourneyFailure(
                f"first turn has unexpected tool results: {first_facts['toolResults']}"
            )
        first_cursor = cursor_sequence(first.data)

        initial.send_line(SECOND_PROMPT)

        def second_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or len(owned_submissions(snapshot.data)) != 2:
                return None
            facts = transcript_facts(snapshot.rows)
            if (
                facts["sentinelCount"] < 2
                or cursor_sequence(snapshot.data) <= first_cursor
            ):
                return None
            return snapshot

        second = initial.wait_until(
            second_turn_ready, options.turn_timeout, "second terminal turn"
        )
        assert isinstance(second, BindingSnapshot)
        write_capture(output, "initial-turn-2", initial)
        during_initial_extractions = extraction_roots(roots["temp"])
        if len(during_initial_extractions) != 1:
            raise JourneyFailure(
                f"expected one live extraction root, found {during_initial_extractions}"
            )
        during_initial_ray_roots = (
            ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots
        )
        if len(during_initial_ray_roots) != 1:
            raise JourneyFailure(
                f"expected one live ephemeral Ray root, found {sorted(during_initial_ray_roots)}"
            )
        initial_ray_runtime = ray_runtime_snapshot(next(iter(during_initial_ray_roots)))
        first_processes = {
            "bb": process_snapshot(initial.pid),
            "engine": process_snapshot(int(first_authority["pid"])),
        }
        process_text = json.dumps(first_processes, sort_keys=True)
        assert_no_forbidden_paths(
            process_text,
            [*forbidden_roots, host_agent_root],
            "initial process snapshot",
        )
        assert_loopback_network(first_processes, "initial process snapshot")
        if process_environment_contains(int(first_authority["pid"]), secret_canary):
            raise JourneyFailure("managed engine inherited the secret canary")
        initial_engine_canary_absent = True

        record_action("open-model-selector", command="/switch")
        initial.send_line("/switch")
        initial.wait_until(
            lambda: "Session-only switch" in initial.screen.text(),
            options.startup_timeout,
            "public model selector",
        )
        initial.send(b"cli_mock/reference")
        initial.wait_until(
            lambda: "cli_mock/reference" in initial.screen.text(),
            options.startup_timeout,
            "synthetic model selector result",
        )
        initial.send_enter()
        initial.wait_until(
            lambda: (
                "Session-only switch" not in initial.screen.text()
                and "cli_mock/reference" in initial.screen.text()
            ),
            options.startup_timeout,
            "deferred locked model selection",
        )
        record_action("select-locked-model", model="cli_mock/reference")
        initial.send_line(SYNTHETIC_PROMPT)
        record_action("submit-locked-model-turn", prompt=SYNTHETIC_PROMPT)
        initial.wait_until(
            lambda: (
                "lock_immutable" in initial.screen.text()
                and "model overrides are rejected after session.start"
                in initial.screen.text()
            ),
            options.startup_timeout,
            "immutable model-role lock rejection",
        )
        write_capture(output, "immutable-model-switch-rejected", initial)
        locked_provider_free = binding_snapshot(roots["agent"])
        if (
            locked_provider_free is None
            or locked_provider_free.session_file != second.session_file
        ):
            raise JourneyFailure("locked model rejection changed session lineage")
        record_action(
            "reject-locked-model-switch",
            model="cli_mock/reference",
            reason="lock_immutable",
        )

        provider_free_pid = initial.pid
        provider_free_authority = first_authority
        provider_free_processes = first_processes
        record_action("exit-provider-free-tui", command="/exit")
        initial.send_line("/exit")
        provider_free_exit = initial.wait_for_exit(60)
        write_capture(output, "provider-free-exit", initial)
        initial.close()
        if provider_free_exit != 0:
            raise JourneyFailure(f"provider-free bb exit was {provider_free_exit}")
        if process_alive(int(provider_free_authority["pid"])):
            raise JourneyFailure("provider-free engine remained alive after TUI close")
        if active_authority(roots["agent"]) is not None:
            raise JourneyFailure(
                "provider-free engine authority remained after TUI close"
            )
        if extraction_roots(roots["temp"]):
            raise JourneyFailure(
                "provider-free engine extraction remained after TUI close"
            )
        if ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots:
            raise JourneyFailure("provider-free Ray runtime remained after TUI close")
        permission_rule_path = (
            roots["workspace"] / ".breadboard" / "permission_rules.json"
        )
        write_json(
            permission_rule_path,
            {
                "version": 1,
                "rules": [
                    {
                        "category": "shell",
                        "pattern": "*",
                        "decision": "allow",
                        "scope": "project",
                    }
                ],
            },
        )

        initial = PtyChild(
            [
                str(bb),
                "--model",
                "cli_mock/reference",
                "--approval-mode",
                "yolo",
            ],
            roots["workspace"],
            environment,
        )
        initial.wait_until(
            lambda: "cli_mock/reference" in initial.screen.text(),
            options.startup_timeout,
            "fresh synthetic TUI readiness",
        )
        if binding_snapshot(roots["agent"]) is not None:
            raise JourneyFailure(
                "fresh synthetic TUI created a binding before its first turn"
            )
        _synthetic_authority_path, first_authority = initial.wait_until(
            lambda: active_authority(roots["agent"]),
            options.startup_timeout,
            "fresh synthetic engine authority",
        )
        if not endpoint_open(str(first_authority["normalizedEndpoint"])):
            raise JourneyFailure("fresh synthetic engine listener is not open")
        if first_authority.get("launchId") == provider_free_authority.get("launchId"):
            raise JourneyFailure("fresh synthetic launch reused engine authority")
        during_initial_extractions = extraction_roots(roots["temp"])
        if len(during_initial_extractions) != 1:
            raise JourneyFailure(
                "fresh synthetic launch did not use one extraction identity"
            )
        during_initial_ray_roots = (
            ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots
        )
        if len(during_initial_ray_roots) != 1:
            raise JourneyFailure(
                "fresh synthetic launch did not use one ephemeral Ray root"
            )
        initial_ray_runtime = ray_runtime_snapshot(next(iter(during_initial_ray_roots)))
        first_processes = {
            "bb": process_snapshot(initial.pid),
            "engine": process_snapshot(int(first_authority["pid"])),
        }
        assert_no_forbidden_paths(
            json.dumps(first_processes, sort_keys=True),
            [*forbidden_roots, host_agent_root],
            "fresh synthetic process snapshot",
        )
        assert_loopback_network(first_processes, "fresh synthetic process snapshot")
        if process_environment_contains(int(first_authority["pid"]), secret_canary):
            raise JourneyFailure("fresh synthetic engine inherited the secret canary")
        write_capture(output, "synthetic-model-selected", initial)
        record_action(
            "launch-synthetic-session",
            model="cli_mock/reference",
        )

        initial.send_line(SYNTHETIC_PROMPT)
        record_action("submit-synthetic-turn", prompt=SYNTHETIC_PROMPT)
        initial.wait_until(
            lambda: (
                snapshot
                if (snapshot := binding_snapshot(roots["agent"])) is not None
                and snapshot.session_file != locked_provider_free.session_file
                else None
            ),
            options.turn_timeout,
            "fresh synthetic session binding",
        )
        _, _synthetic_state, _ = wait_for_terminal_state(
            initial,
            roots["agent"],
            1,
            options.turn_timeout,
            "synthetic terminal turn",
            "completed",
        )

        def synthetic_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or len(owned_submissions(snapshot.data)) != 1:
                return None
            facts = transcript_facts(snapshot.rows)
            if tuple(facts["toolCalls"][-3:]) != SYNTHETIC_TOOLS:
                return None
            if tuple(facts["toolResults"][-3:]) != SYNTHETIC_TOOLS:
                return None
            return snapshot

        synthetic = initial.wait_until(
            synthetic_turn_ready,
            options.turn_timeout,
            "synthetic projected terminal turn",
        )
        assert isinstance(synthetic, BindingSnapshot)
        synthetic_facts = transcript_facts(synthetic.rows)
        synthetic_cursor = cursor_sequence(synthetic.data)
        if synthetic_facts["completionSentinelCount"] != 0:
            raise JourneyFailure(
                "control-only completion sentinel reached the TUI transcript"
            )
        bubble_sort = roots["workspace"] / "bubble_sort.py"
        if not bubble_sort.is_file() or "def bubble_sort" not in bubble_sort.read_text(
            encoding="utf-8"
        ):
            raise JourneyFailure(
                "synthetic write tool did not create the expected fixture"
            )
        write_capture(output, "synthetic-completed", initial)

        crash_authority_path, crash_authority = initial.wait_until(
            lambda: active_authority(roots["agent"]),
            options.startup_timeout,
            "idle crash engine authority",
        )
        crash_pid = int(crash_authority["pid"])
        if crash_pid == initial.pid or not process_alive(crash_pid):
            raise JourneyFailure("crash target is not one live managed engine child")
        descendants_before_crash = process_descendants(initial.pid)
        if not any(row["pid"] == crash_pid for row in descendants_before_crash):
            raise JourneyFailure(
                "authenticated engine crash target is not a bb descendant"
            )
        crash_identity = authority_identity(crash_authority)
        current_authority = active_authority(roots["agent"])
        if (
            current_authority is None
            or current_authority[0] != crash_authority_path
            or current_authority[1].get("pid") != crash_authority.get("pid")
            or current_authority[1].get("osProcessStartToken")
            != crash_authority.get("osProcessStartToken")
            or current_authority[1].get("engineInstanceId")
            != crash_authority.get("engineInstanceId")
        ):
            raise JourneyFailure(
                "engine authority changed before authenticated crash injection"
            )
        write_capture(output, "engine-crash-checkpoint", initial)
        os.kill(crash_pid, signal.SIGKILL)
        record_action(
            "kill-authenticated-idle-engine",
            pid=crash_pid,
            osProcessStartToken=crash_authority["osProcessStartToken"],
            engineInstanceId=crash_authority["engineInstanceId"],
        )
        initial.wait_until(
            lambda: not process_alive(crash_pid),
            options.startup_timeout,
            "old engine process death",
        )
        initial.send_line(RECONNECT_PROMPT)
        record_action("submit-reconnect-turn", prompt=RECONNECT_PROMPT)

        def replacement_authority_ready() -> tuple[Path, dict[str, Any]] | None:
            authority = active_authority(roots["agent"])
            if authority is None:
                return None
            candidate = authority[1]
            for field in (
                "pid",
                "osProcessStartToken",
                "engineInstanceId",
                "engineBootId",
                "launchId",
            ):
                if candidate.get(field) == crash_authority.get(field):
                    return None
            if not process_alive(int(candidate["pid"])):
                return None
            if not endpoint_open(str(candidate["normalizedEndpoint"])):
                return None
            return authority

        replacement_authority_path, replacement_authority = initial.wait_until(
            replacement_authority_ready,
            options.turn_timeout,
            "bounded replacement engine authority",
        )
        replacement_identity = authority_identity(replacement_authority)
        if any(
            not isinstance(authority.get("ownerGeneration"), int)
            or int(authority["ownerGeneration"]) < 1
            for authority in (crash_authority, replacement_authority)
        ):
            raise JourneyFailure("engine authority has an invalid owner generation")
        if replacement_authority_path != crash_authority_path:
            raise JourneyFailure(
                "replacement engine changed the public authority record path"
            )
        crash_cursor = synthetic_cursor
        initial.wait_until(
            lambda: "cli_mock/reference" in initial.screen.text(),
            options.turn_timeout,
            "reconnected TUI readiness",
        )
        replacement_processes = {
            "bb": process_snapshot(initial.pid),
            "engine": process_snapshot(int(replacement_authority["pid"])),
        }
        replacement_process_text = json.dumps(replacement_processes, sort_keys=True)
        assert_no_forbidden_paths(
            replacement_process_text,
            [*forbidden_roots, host_agent_root],
            "replacement process snapshot",
        )
        assert_loopback_network(replacement_processes, "replacement process snapshot")
        replacement_current = active_authority(roots["agent"])
        replacement_environment = process_environment_contains(
            int(replacement_authority["pid"]), secret_canary
        )
        write_json(
            output / "replacement-authority.json",
            {
                "selected": replacement_identity,
                "selectedAlive": process_alive(int(replacement_authority["pid"])),
                "current": (
                    authority_identity(replacement_current[1])
                    if replacement_current is not None
                    else None
                ),
                "environmentReadable": replacement_environment is not None,
            },
        )
        if replacement_environment is None:
            raise JourneyFailure("replacement engine died before readiness evidence")
        if replacement_environment:
            raise JourneyFailure("replacement engine inherited the secret canary")
        replacement_engine_canary_absent = True
        write_capture(output, "engine-reconnected", initial)
        initial.wait_until(
            lambda: "HTTP request failed" in initial.screen.text(),
            options.turn_timeout,
            "failed submission after engine replacement",
        )
        initial.send_line(RECONNECT_PROMPT)
        record_action("retry-reconnect-turn", prompt=RECONNECT_PROMPT)

        _, reconnect_state, _ = wait_for_terminal_state(
            initial,
            roots["agent"],
            2,
            options.turn_timeout,
            "post-reconnect terminal turn",
            "completed",
        )
        reconnect_turn_id = str(reconnect_state["turns"][-1].get("turn_id") or "")
        if not reconnect_turn_id:
            raise JourneyFailure("post-reconnect turn is missing durable identity")

        def reconnect_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or not any(
                str(submission.get("turnId")) == reconnect_turn_id
                for submission in owned_submissions(snapshot.data)
            ):
                return None
            facts = transcript_facts(snapshot.rows)
            if cursor_sequence(snapshot.data) <= crash_cursor:
                return None
            if tuple(facts["toolCalls"][-3:]) != SYNTHETIC_TOOLS:
                return None
            if tuple(facts["toolResults"][-3:]) != SYNTHETIC_TOOLS:
                return None
            return snapshot

        reconnected = initial.wait_until(
            reconnect_turn_ready,
            options.turn_timeout,
            "post-reconnect projected terminal turn",
        )
        assert isinstance(reconnected, BindingSnapshot)
        reconnected_facts = transcript_facts(reconnected.rows)
        if reconnected_facts["completionSentinelCount"] != 0:
            raise JourneyFailure(
                "post-reconnect completion sentinel reached the TUI transcript"
            )
        write_capture(output, "post-reconnect-completed", initial)

        record_action("exit-initial-tui", command="/exit")
        initial.send_line("/exit")
        initial_exit = initial.wait_for_exit(60)
        write_capture(output, "initial-exit", initial)
        if initial_exit != 0:
            raise JourneyFailure(f"initial bb exit was {initial_exit}")
    finally:
        initial.close()

    final_initial = binding_snapshot(roots["agent"])
    if final_initial is None:
        raise JourneyFailure("binding disappeared after initial exit")
    final_initial_cursor = cursor_sequence(final_initial.data)
    initial_owned = owned_submissions(final_initial.data)
    final_initial_facts = transcript_facts(final_initial.rows)
    if len(initial_owned) != 2 or final_initial_cursor < cursor_sequence(
        reconnected.data
    ):
        raise JourneyFailure(
            "initial close regressed the durable post-reconnect cursor"
        )
    for field in ("clientMessageId", "inputId", "turnId"):
        values = [item.get(field) for item in initial_owned]
        if len(values) != 2 or len(set(values)) != 2:
            raise JourneyFailure(
                f"owned submissions do not have two unique {field} values"
            )
    for authority in (first_authority, crash_authority, replacement_authority):
        if process_alive(int(authority["pid"])):
            raise JourneyFailure("a managed engine PID remains alive after TUI close")
    if endpoint_open(str(replacement_authority["normalizedEndpoint"])):
        raise JourneyFailure("replacement engine listener remains open after TUI close")
    if active_authority(roots["agent"]) is not None:
        raise JourneyFailure("active authority remains after initial close")
    if extraction_roots(roots["temp"]):
        raise JourneyFailure("initial engine extraction root remains after close")
    if ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots:
        raise JourneyFailure("initial ephemeral Ray runtime root remains after close")

    state_path, retained_state, retained_bytes_before_restart = load_retained_state(
        roots["agent"]
    )
    if retained_state.get("schema_version") != "bb.cli_bridge.session_state.v1":
        raise JourneyFailure("retained state has the wrong schema")
    turns = retained_state.get("turns")
    envelopes = retained_state.get("terminal_event_envelopes")
    if not isinstance(turns, list) or len(turns) != 2:
        raise JourneyFailure("retained state does not have exactly two turns")
    if not isinstance(envelopes, list) or len(envelopes) != 2:
        raise JourneyFailure(
            "retained state does not have exactly two terminal envelopes"
        )
    if any(turn.get("terminal_resolution_committed") is not True for turn in turns):
        raise JourneyFailure("retained turns are not terminally committed")
    terminal_outcomes = [turn.get("terminal_outcome") for turn in turns]
    if terminal_outcomes != [
        "completed",
        "completed",
    ]:
        raise JourneyFailure(
            f"retained turns have unexpected terminal outcomes: {terminal_outcomes}"
        )
    state_session = retained_state.get("session")
    if not isinstance(state_session, dict) or state_session.get(
        "session_id"
    ) != final_initial.data.get("sessionId"):
        raise JourneyFailure("retained state and binding disagree on session identity")
    state_event_sequence = state_session.get("event_seq")
    if (
        type(state_event_sequence) is not int
        or state_event_sequence < final_initial_cursor
    ):
        raise JourneyFailure("retained state head regressed the durable binding cursor")
    if state_session.get("model") != "cli_mock/reference":
        raise JourneyFailure(
            f"retained session lost the selected synthetic model: {state_session.get('model')!r}"
        )
    model_role_lock = state_session.get("model_role_lock")
    if model_role_lock is not None:
        model_role_text = json.dumps(model_role_lock, sort_keys=True)
        if (
            not isinstance(model_role_lock, dict)
            or '"kind": "synthetic"' not in model_role_text
            or '"source": "synthetic"' not in model_role_text
        ):
            raise JourneyFailure(
                f"retained synthetic model role lock is invalid: {model_role_text}"
            )
        if re.search(
            r'"(?:account|secret|credential_ref)"\s*:\s*"(?!none\b)',
            model_role_text,
        ):
            raise JourneyFailure(
                "retained synthetic model role lock contains account or secret material"
            )
    retained_text = retained_bytes_before_restart.decode("utf-8")
    for prompt in (
        FIRST_PROMPT,
        SECOND_PROMPT,
        SYNTHETIC_PROMPT,
        RECONNECT_PROMPT,
    ):
        if prompt in retained_text:
            raise JourneyFailure("retained engine state contains raw prompt text")
    if secret_canary in retained_text:
        raise JourneyFailure("retained engine state contains the secret canary")
    assert_no_forbidden_paths(
        retained_text, [*forbidden_roots, bb.parent], "retained engine state"
    )

    status, status_identity, manifest_path = installed_status(
        bb,
        roots["workspace"],
        environment,
        "engine status after initial exit",
    )
    (output / "engine-status.json").write_text(
        json.dumps(
            {
                "exitCode": status.returncode,
                "stdout": status.stdout,
                "stderr": status.stderr,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    if (
        status_identity != preflight_status_identity
        or status.stdout != preflight_status.stdout
        or manifest_path != preflight_manifest_path
    ):
        raise JourneyFailure("initial journey changed the installed status identity")
    status_text = json.dumps(status_identity, sort_keys=True)
    for unsafe in (
        str(bb.parent),
        str(roots["home"]),
        str(roots["agent"]),
        str(roots["config"]),
    ):
        if unsafe in status_text:
            raise JourneyFailure("status identity contains a local path")

    resume = PtyChild(
        [str(bb), "--resume", str(final_initial.session_file)],
        roots["workspace"],
        environment,
    )
    try:

        def resume_ready() -> tuple[Path, dict[str, Any]] | None:
            authority = active_authority(roots["agent"])
            if authority is None or authority[1].get(
                "launchId"
            ) == replacement_authority.get("launchId"):
                return None
            if SYNTHETIC_ASSISTANT_SENTINEL not in normalized_transcript(
                bytes(resume.raw)
            ):
                return None
            snapshot = binding_snapshot(roots["agent"])
            if (
                snapshot is None
                or snapshot.session_file != final_initial.session_file
                or snapshot.data.get("sessionId") != final_initial.data.get("sessionId")
                or snapshot.data.get("replayConfigurationDigest")
                != final_initial.data.get("replayConfigurationDigest")
                or owned_submissions(snapshot.data) != initial_owned
                or cursor_sequence(snapshot.data) < final_initial_cursor
                or transcript_facts(snapshot.rows) != final_initial_facts
            ):
                return None
            return authority

        _, second_authority = resume.wait_until(
            resume_ready, options.startup_timeout, "resume read-back"
        )
        if not endpoint_open(str(second_authority["normalizedEndpoint"])):
            raise JourneyFailure("resumed engine listener is not open")
        for field in (
            "engineInstanceId",
            "engineBootId",
            "launchId",
            "pid",
            "osProcessStartToken",
        ):
            if second_authority.get(field) == replacement_authority.get(field):
                raise JourneyFailure(f"process restart did not change {field}")
        if second_authority.get("normalizedEndpoint") != replacement_authority.get(
            "normalizedEndpoint"
        ):
            raise JourneyFailure("process restart changed the managed endpoint")
        during_resume_extractions = extraction_roots(roots["temp"])
        if (
            len(during_resume_extractions) != 1
            or during_resume_extractions == during_initial_extractions
        ):
            raise JourneyFailure("restart did not use one new extraction identity")
        during_resume_ray_roots = (
            ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots
        )
        if (
            len(during_resume_ray_roots) != 1
            or during_resume_ray_roots == during_initial_ray_roots
        ):
            raise JourneyFailure("restart did not use one new ephemeral Ray root")
        resume_ray_runtime = ray_runtime_snapshot(next(iter(during_resume_ray_roots)))
        second_processes = {
            "bb": process_snapshot(resume.pid),
            "engine": process_snapshot(int(second_authority["pid"])),
        }
        assert_no_forbidden_paths(
            json.dumps(second_processes, sort_keys=True),
            [*forbidden_roots, host_agent_root],
            "resume process snapshot",
        )
        assert_loopback_network(second_processes, "resume process snapshot")
        if process_environment_contains(int(second_authority["pid"]), secret_canary):
            raise JourneyFailure("resumed engine inherited the secret canary")
        resume_engine_canary_absent = True
        write_capture(output, "resume-readback", resume)
        record_action("exit-resumed-tui", command="/exit")
        resume.send_line("/exit")
        resume_exit = resume.wait_for_exit(60)
        write_capture(output, "resume-exit", resume)
        if resume_exit != 0:
            raise JourneyFailure(f"resumed bb exit was {resume_exit}")
    finally:
        resume.close()

    final_resume = binding_snapshot(roots["agent"])
    if final_resume is None:
        raise JourneyFailure("durable binding disappeared after resume read-back")
    if (
        final_resume.data.get("sessionId") != final_initial.data.get("sessionId")
        or final_resume.data.get("replayConfigurationDigest")
        != final_initial.data.get("replayConfigurationDigest")
        or len(owned_submissions(final_resume.data)) != 2
        or cursor_sequence(final_resume.data) < final_initial_cursor
    ):
        raise JourneyFailure("resume read-back changed lineage or regressed durability")
    _, retained_state_after, _retained_bytes_after_restart = load_retained_state(
        roots["agent"]
    )
    turns_after = retained_state_after.get("turns")
    envelopes_after = retained_state_after.get("terminal_event_envelopes")
    if not isinstance(turns_after, list) or len(turns_after) != 2:
        raise JourneyFailure("resumed state does not have exactly two turns")
    if not isinstance(envelopes_after, list) or len(envelopes_after) != 2:
        raise JourneyFailure(
            "resumed state does not have exactly two terminal envelopes"
        )
    if turns_after != turns or envelopes_after != envelopes:
        raise JourneyFailure("process resume changed pre-existing durable turn state")
    if process_alive(int(second_authority["pid"])):
        raise JourneyFailure("resumed engine PID remains alive after TUI close")
    if endpoint_open(str(second_authority["normalizedEndpoint"])):
        raise JourneyFailure("resumed engine listener remains open after TUI close")
    if active_authority(roots["agent"]) is not None:
        raise JourneyFailure("active authority remains after resumed close")
    if extraction_roots(roots["temp"]):
        raise JourneyFailure("resumed engine extraction root remains after close")
    if ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots:
        raise JourneyFailure("resumed ephemeral Ray runtime root remains after close")
    network_audit_stderr = stop_network_audit(
        network_audit_process, network_audit_stream
    )
    atexit.unregister(stop_network_audit_at_exit)
    network_observation = analyze_network_audit(
        network_audit_raw,
        output / "network-observation.csv",
        {
            provider_free_pid,
            int(provider_free_authority["pid"]),
            initial.pid,
            int(first_authority["pid"]),
            int(replacement_authority["pid"]),
            resume.pid,
            int(second_authority["pid"]),
        },
        network_audit_stderr,
    )
    write_json(output / "network-observation.json", network_observation)

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
        raise JourneyFailure(
            "restart changed the installed distribution or profile identity"
        )
    if restart_status.stdout != status.stdout:
        raise JourneyFailure("restart changed the canonical installed status bytes")
    post_status_binding = binding_snapshot(roots["agent"])
    if post_status_binding is None or post_status_binding.data != final_resume.data:
        raise JourneyFailure("engine status changed the durable session binding")
    if active_authority(roots["agent"]) is not None or extraction_roots(roots["temp"]):
        raise JourneyFailure("engine status spawned managed engine state")
    tamper_results = [
        run_tamper_failure(
            bb,
            output,
            "bundle-tamper",
            "engine_artifact_mismatch",
            forbidden_roots,
        ),
        run_tamper_failure(
            bb,
            output,
            "manifest-profile-tamper",
            "engine_manifest_untrusted",
            forbidden_roots,
        ),
    ]
    write_json(
        output / "tamper-failures.json",
        {
            "schemaVersion": "bb.installed_tamper_failures.v1",
            "status": "pass",
            "cases": tamper_results,
        },
    )
    provider_free_facts = transcript_facts(locked_provider_free.rows)
    if provider_free_facts["userTexts"] != [
        FIRST_PROMPT,
        SECOND_PROMPT,
        SYNTHETIC_PROMPT,
    ]:
        raise JourneyFailure(
            "provider-free session has unexpected submitted prompts: "
            f"{provider_free_facts['userTexts']}"
        )
    if provider_free_facts["assistantTexts"].count(ASSISTANT_SENTINEL) != 2:
        raise JourneyFailure(
            "provider-free session does not retain exactly two assistant texts"
        )
    expected_mock_tools = ["list_dir", "apply_unified_patch"] * 2
    if (
        provider_free_facts["toolCalls"] != expected_mock_tools
        or provider_free_facts["toolResults"] != expected_mock_tools
    ):
        raise JourneyFailure("provider-free session has unexpected tool activity")

    facts = transcript_facts(final_resume.rows)
    expected_prompts = [
        SYNTHETIC_PROMPT,
        RECONNECT_PROMPT,
        RECONNECT_PROMPT,
    ]
    if facts["userTexts"] != expected_prompts:
        raise JourneyFailure(
            f"OMP transcript has unexpected submitted prompts: {facts['userTexts']}"
        )
    if facts["assistantTexts"].count(ASSISTANT_SENTINEL) != 0:
        raise JourneyFailure(
            "provider-free assistant text crossed the fresh-session boundary"
        )
    if facts["completionSentinelCount"] != 0:
        raise JourneyFailure(
            "control-only completion sentinel reached the durable TUI transcript"
        )
    expected_tool_calls = list(SYNTHETIC_TOOLS) * 2
    expected_tool_results = list(SYNTHETIC_TOOLS) * 2
    if facts["toolCalls"] != expected_tool_calls:
        raise JourneyFailure(
            f"OMP transcript has unexpected tool calls: {facts['toolCalls']}"
        )
    if facts["toolResults"] != expected_tool_results:
        raise JourneyFailure(
            f"OMP transcript has unexpected tool results: {facts['toolResults']}"
        )
    shell_results = [
        row for row in facts["toolResultRows"] if row["name"] == "run_shell"
    ]
    if len(shell_results) != 2 or any(
        row["isError"] or "[1, 2, 3, 4, 5]" not in row["content"]
        for row in shell_results
    ):
        raise JourneyFailure(
            f"installed shell validations did not succeed exactly twice: {shell_results}"
        )
    tool_receipt_evidence = validate_tool_receipts(facts)
    session_text = final_resume.session_file.read_text(encoding="utf-8")
    if secret_canary in session_text:
        raise JourneyFailure("OMP JSONL contains the secret canary")
    provider_free_session_text = locked_provider_free.session_file.read_text(
        encoding="utf-8"
    )
    if secret_canary in provider_free_session_text:
        raise JourneyFailure("provider-free OMP JSONL contains the secret canary")
    assert_no_forbidden_paths(
        provider_free_session_text,
        [*forbidden_roots, bb.parent],
        "provider-free OMP JSONL",
    )
    assert_no_forbidden_paths(session_text, [*forbidden_roots, bb.parent], "OMP JSONL")

    final_binding_history = validate_binding_history(final_resume.rows)
    event_journal_path, event_journal_rows = session_event_journal(roots["agent"])
    event_kinds: dict[str, int] = {}
    for event in event_journal_rows:
        kind = event.get("kind")
        if (
            not isinstance(kind, str)
            or not kind
            or "unknown" in kind
            or "legacy" in kind
        ):
            raise JourneyFailure(
                f"retained session event journal contains an invalid event family: {kind}"
            )
        event_kinds[kind] = event_kinds.get(kind, 0) + 1
        payload = event.get("payload")
        if isinstance(payload, dict):
            for key, value in payload.items():
                if key.endswith(("_hash", "_sha256")) and (
                    not isinstance(value, str)
                    or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None
                ):
                    raise JourneyFailure(
                        f"retained session event {kind} has an invalid digest field {key}"
                    )
    for envelope in envelopes_after:
        if (
            not isinstance(envelope.get("id"), str)
            or EVENT_ID_RE.fullmatch(envelope["id"]) is None
        ):
            raise JourneyFailure(
                "retained terminal envelope has an invalid event identity"
            )
    native_auth_counts = native_auth_row_counts(roots["agent"])
    for table in (
        "auth_credentials",
        "auth_credential_blocks",
        "auth_credential_refresh_leases",
    ):
        if native_auth_counts.get(table, 0) != 0:
            raise JourneyFailure(f"native OMP AuthStorage mutated {table}")
    credential_rows = sum(
        native_auth_counts.get(table, 0)
        for table in (
            "auth_credentials",
            "auth_credential_blocks",
            "auth_credential_refresh_leases",
        )
    )
    browser_launch_attempts = (
        len(browser_marker.read_text(encoding="utf-8").splitlines())
        if browser_marker.is_file()
        else 0
    )
    if browser_launch_attempts != 0:
        raise JourneyFailure("installed product attempted an OAuth browser launch")
    retained_session = retained_state_after.get("session")
    synthetic_evidence_only = (
        isinstance(retained_session, dict)
        and retained_session.get("model") == "cli_mock/reference"
        and credential_rows == 0
    )
    if not synthetic_evidence_only:
        raise JourneyFailure(
            "configured route is not retained as credential-free synthetic evidence"
        )
    browser_observation["attemptCount"] = browser_launch_attempts
    provider_observation = {
        "schemaVersion": "bb.g6_provider_observation.v1",
        "status": "pass",
        "network": network_observation,
        "browser": browser_observation,
    }
    write_json(output / "provider-observation.json", provider_observation)

    binding_extract = {
        "schemaVersion": "bb.g6_binding_extract.v1",
        "status": "pass",
        "history": binding_history(final_resume.rows),
        "validation": final_binding_history,
    }
    event_extract = {
        "schemaVersion": "bb.g6_session_event_extract.v1",
        "status": "pass",
        "path": str(event_journal_path),
        "events": event_journal_rows,
        "eventKinds": event_kinds,
    }
    process_timeline = {
        "schemaVersion": "bb.g6_process_authority_timeline.v1",
        "status": "pass",
        "providerFreeAuthority": provider_free_authority,
        "initialAuthority": first_authority,
        "crashAuthority": crash_authority,
        "replacementAuthority": replacement_authority,
        "resumeAuthority": second_authority,
        "authenticatedCrash": {
            "authorityPath": str(crash_authority_path),
            "identity": crash_identity,
            "descendantsBeforeCrash": descendants_before_crash,
        },
        "replacementIdentity": replacement_identity,
        "processes": {
            "providerFree": provider_free_processes,
            "initial": first_processes,
            "replacement": replacement_processes,
            "resume": second_processes,
        },
    }
    provider_evidence = {
        "schemaVersion": "bb.g6_provider_role_evidence.v1",
        "status": "pass",
        "providerFreeModel": "mock/reference",
        "configuredModel": "cli_mock/reference",
        "modelRoleLock": model_role_lock,
        "nativeAuthRowCounts": native_auth_counts,
        "providerRequests": network_observation["nonLoopbackConnectionCount"],
        "credentialRows": credential_rows,
        "oauthBrowserLaunches": browser_launch_attempts,
        "syntheticEvidenceOnly": synthetic_evidence_only,
        "isolationObservation": provider_observation,
    }
    write_json(output / "binding-extract.json", binding_extract)
    write_json(output / "engine-event-extract.json", event_extract)
    write_json(output / "process-authority-timeline.json", process_timeline)
    write_json(output / "provider-role-evidence.json", provider_evidence)
    write_json(output / "retained-state-extract.json", retained_state_after)
    write_json(output / "ui-action-trace.json", action_trace)

    cleanup = {
        "providerFreePidDead": True,
        "initialPidDead": True,
        "crashedPidDead": True,
        "replacementPidDead": True,
        "resumePidDead": True,
        "initialListenerClosed": True,
        "replacementListenerClosed": True,
        "resumeListenerClosed": True,
        "initialExtractionRemoved": True,
        "initialRayRuntimeRemoved": True,
        "resumeExtractionRemoved": True,
        "resumeRayRuntimeRemoved": True,
        "activeAuthorityAbsent": True,
        "durableStateRetained": True,
        "knownManagedPidsDead": all(
            not process_alive(int(authority["pid"]))
            for authority in (
                provider_free_authority,
                first_authority,
                crash_authority,
                replacement_authority,
                second_authority,
            )
        ),
    }
    if not cleanup["knownManagedPidsDead"]:
        raise JourneyFailure("one known managed process remains alive after final exit")
    summary = {
        "schemaVersion": "bb.installed_g6_journey.v1",
        "status": "pass",
        "bb": str(bb),
        "environmentKeys": sorted(environment),
        "manualEngineOrSessionConfiguration": False,
        "persistentPermissionRule": str(permission_rule_path.resolve()),
        "sessionFile": str(final_resume.session_file),
        "sessionId": final_resume.data["sessionId"],
        "preTurnBindingPresent": False,
        "preflightStatusIdentity": preflight_status_identity,
        "preflightRuntimeStateAbsent": True,
        "cursors": {
            "first": first_cursor,
            "second": cursor_sequence(second.data),
            "synthetic": synthetic_cursor,
            "afterIdleCrash": crash_cursor,
            "beforeResume": final_initial_cursor,
            "final": cursor_sequence(final_resume.data),
        },
        "ownedSubmissions": owned_submissions(final_resume.data),
        "transcript": facts,
        "toolReceiptValidation": tool_receipt_evidence,
        "bindingValidation": final_binding_history,
        "createdFiles": [
            *[str((roots["workspace"] / name).resolve()) for name in EXPECTED_FILES],
            str(bubble_sort.resolve()),
            str(permission_rule_path.resolve()),
        ],
        "statePath": str(state_path),
        "retainedTurnCount": len(turns_after),
        "retainedTerminalEnvelopeCount": len(envelopes_after),
        "terminalOutcomes": [turn.get("terminal_outcome") for turn in turns_after],
        "statusIdentity": status_identity,
        "manifestPath": str(manifest_path.resolve()),
        "authorities": {
            "initial": authority_identity(first_authority),
            "crash": crash_identity,
            "replacement": replacement_identity,
            "resume": authority_identity(second_authority),
        },
        "initialExtractionRoots": during_initial_extractions,
        "resumeExtractionRoots": during_resume_extractions,
        "initialRayRuntime": initial_ray_runtime,
        "resumeRayRuntime": resume_ray_runtime,
        "cleanup": cleanup,
        "providerIsolation": {
            "providerCalls": network_observation["nonLoopbackConnectionCount"] != 0,
            "loopbackOnlyNetwork": network_observation["loopbackOnly"],
            "nativeAuthMutation": credential_rows != 0,
            "oauthBrowserLaunches": browser_launch_attempts,
            "secretCanaryAbsentFromEngineEnvironments": (
                initial_engine_canary_absent
                and replacement_engine_canary_absent
                and resume_engine_canary_absent
            ),
        },
        "sourceCheckoutPathsAbsent": True,
        "hostAgentPathsAbsent": True,
        "tamperFailures": tamper_results,
    }
    write_json(output / "journey-summary.json", summary)
    canary_bytes = secret_canary.encode("utf-8")
    scan_roots = (output, roots["agent"], roots["config"], roots["workspace"])
    for scan_root in scan_roots:
        for evidence_file in scan_root.rglob("*"):
            if not evidence_file.is_file() or evidence_file.is_symlink():
                continue
            with evidence_file.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    if canary_bytes in chunk:
                        raise JourneyFailure(
                            f"secret canary leaked into {evidence_file}"
                        )
    print(
        json.dumps(
            {
                "status": "pass",
                "sessionId": summary["sessionId"],
                "cursor": cursor_sequence(final_resume.data),
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except JourneyFailure as error:
        print(f"installed journey failed: {error}", file=sys.stderr)
        raise SystemExit(1)
