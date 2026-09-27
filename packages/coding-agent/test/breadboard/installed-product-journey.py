from __future__ import annotations

import argparse
import base64
import binascii
from collections import deque
import codecs
import ctypes
from dataclasses import dataclass
import errno
import fcntl
import hashlib
import ipaddress
import json
import math
import os
import pty
import pwd
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import termios
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

ROWS = 36
COLUMNS = 140
GIT_OBJECT_RE = re.compile(r"^[0-9a-f]{40}$")
ANSI_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
TIMING_NONCE_ENV = "PI_TIMING_NONCE"
TIMING_NONCE_RE = re.compile(r"^[0-9a-f]{32}$")
MAX_FRAME_EVENTS = 1024
MAX_FRAME_METADATA_BYTES = 4096

def new_timing_nonce() -> str:
    return secrets.token_hex(16)


def timing_environment(env: dict[str, str]) -> dict[str, str]:
    child_env = dict(env)
    child_env[TIMING_NONCE_ENV] = new_timing_nonce()
    return child_env


@dataclass(frozen=True)
class FrameTimingEvent:
    nonce: str
    metadata: dict[str, Any]
    raw_metadata: str
    screen: str
    observed_at_monotonic: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "nonce": self.nonce,
            "metadata": dict(self.metadata),
            "rawMetadata": self.raw_metadata,
            "screen": self.screen,
            "observedAtMonotonic": self.observed_at_monotonic,
        }


def _valid_timing_number(value: Any, *, nonnegative: bool = True) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        number = float(value)
    except OverflowError:
        return False
    return math.isfinite(number) and (not nonnegative or number >= 0)


def _parse_frame_timing(
    raw_metadata: str,
    nonce: str,
    previous_frame_id: int | None,
    previous_input_id: int | None,
    previous_input_data: str | None,
    previous_input_at: float | None,
) -> tuple[dict[str, Any] | None, str | None]:
    if len(raw_metadata) > MAX_FRAME_METADATA_BYTES:
        return None, "oversized_metadata"
    try:
        decoded = base64.b64decode(raw_metadata, validate=True).decode("utf-8")
        metadata = json.loads(decoded)
    except (json.JSONDecodeError, TypeError, ValueError, UnicodeError, binascii.Error, RecursionError):
        return None, "invalid_json"
    if (
        not isinstance(metadata, dict)
        or isinstance(metadata.get("version"), bool)
        or metadata.get("version") != 1
    ):
        return None, "invalid_version"
    frame_id = metadata.get("frameId")
    input_id = metadata.get("inputId")
    if (
        not _valid_timing_number(frame_id)
        or not isinstance(frame_id, int)
        or not _valid_timing_number(input_id)
        or not isinstance(input_id, int)
    ):
        return None, "invalid_id"
    if frame_id != (0 if previous_frame_id is None else previous_frame_id + 1):
        return None, "unexpected_frame_id"
    if previous_input_id is not None and input_id < previous_input_id:
        return None, "nonmonotonic_input_id"
    input_data = metadata.get("inputData")
    if not isinstance(input_data, str):
        return None, "invalid_input_data"
    try:
        base64.b64decode(input_data, validate=True)
    except (ValueError, binascii.Error):
        return None, "invalid_input_data"
    input_at = metadata.get("inputAtMs")
    if input_id == 0:
        if input_data != "" or input_at is not None:
            return None, "invalid_startup_input"
    else:
        if not _valid_timing_number(input_at):
            return None, "invalid_input_time"
        if previous_input_id == input_id and (
            input_data != previous_input_data or input_at != previous_input_at
        ):
            return None, "changed_input"
    if input_at is not None and not _valid_timing_number(input_at):
        return None, "invalid_input_time"
    written_at = metadata.get("writtenAtMs")
    if not _valid_timing_number(written_at) or (input_at is not None and written_at < input_at):
        return None, "invalid_written_time"
    origin = metadata.get("monotonicOriginMs")
    uncertainty = metadata.get("clockUncertaintyMs")
    if (origin is None) != (uncertainty is None):
        return None, "partial_clock_mapping"
    if origin is not None and (
        not _valid_timing_number(origin, nonnegative=False) or not _valid_timing_number(uncertainty)
    ):
        return None, "invalid_clock_mapping"
    return metadata, None


class JourneyFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class MonotonicClockMapping:
    origin_ms: float
    uncertainty_ms: float
    source: str = "mach_absolute_time"

class _MachTimebaseInfo(ctypes.Structure):
    _fields_ = [
        ("numer", ctypes.c_uint32),
        ("denom", ctypes.c_uint32),
    ]


_mach_clock: tuple[ctypes.CDLL, _MachTimebaseInfo] | None = None


def _mach_absolute_ms() -> float:
    global _mach_clock
    if sys.platform != "darwin":
        raise OSError("mach clock is only available on Darwin")
    if _mach_clock is None:
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        info = _MachTimebaseInfo()
        timebase_info = library.mach_timebase_info
        timebase_info.argtypes = [ctypes.POINTER(_MachTimebaseInfo)]
        timebase_info.restype = ctypes.c_int
        if timebase_info(ctypes.byref(info)) != 0 or info.denom == 0:
            raise OSError("mach_timebase_info failed")
        library.mach_absolute_time.argtypes = []
        library.mach_absolute_time.restype = ctypes.c_uint64
        _mach_clock = library, info
    library, info = _mach_clock
    return float(library.mach_absolute_time()) * info.numer / info.denom / 1_000_000.0


def capture_mapped_monotonic_time() -> tuple[float, MonotonicClockMapping | None]:
    try:
        mach_before = _mach_absolute_ms()
    except (OSError, AttributeError):
        return time.monotonic(), None
    timestamp = time.monotonic()
    try:
        mach_after = _mach_absolute_ms()
    except (OSError, AttributeError):
        return timestamp, None
    mono_ms = timestamp * 1000.0
    if not all(math.isfinite(value) for value in (mach_before, mono_ms, mach_after)) or mach_after < mach_before:
        return timestamp, None
    rounding_bound = 2.0 * sys.float_info.epsilon * (abs(mach_before) + abs(mach_after) + abs(mono_ms))
    return timestamp, MonotonicClockMapping(
        origin_ms=((mach_before + mach_after) / 2.0) - mono_ms,
        uncertainty_ms=(mach_after - mach_before) / 2.0 + rounding_bound,
    )

class TerminalScreen:
    def __init__(
        self,
        rows: int = ROWS,
        columns: int = COLUMNS,
        timing_nonce: str | None = None,
    ) -> None:
        if timing_nonce is not None and TIMING_NONCE_RE.fullmatch(timing_nonce) is None:
            raise ValueError("timing nonce must be exactly 32 lowercase hex characters")
        self.rows = rows
        self.columns = columns
        self.grid = [[" "] * columns for _ in range(rows)]
        self.row = 0
        self.column = 0
        self.saved = (0, 0)
        self.primary_screen: tuple[list[list[str]], int, int] | None = None
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.timing_nonce = timing_nonce
        self._frame_events: deque[FrameTimingEvent] = deque(maxlen=MAX_FRAME_EVENTS)
        self._frame_rejections: dict[str, int] = {}
        self._last_frame_id: int | None = None
        self._last_input_id: int | None = None
        self._last_input_data: str | None = None
        self._last_input_at: float | None = None
        self._saw_valid_frame = False


    @property
    def frame_rejections(self) -> dict[str, int]:
        return dict(self._frame_rejections)


    @property
    def latest_input_id(self) -> int | None:
        return self._last_input_id


    def drain_frame_events(self) -> list[FrameTimingEvent]:
        events = list(self._frame_events)
        self._frame_events.clear()
        return events


    def resize(self, rows: int, columns: int) -> None:
        if rows <= 0 or columns <= 0:
            raise ValueError("terminal dimensions must be positive")
        self.rows = rows
        self.columns = columns
        self.grid = [[" "] * columns for _ in range(rows)]
        self.row = max(0, min(self.row, rows - 1))
        self.column = max(0, min(self.column, columns - 1))
        self.saved = (
            max(0, min(self.saved[0], rows - 1)),
            max(0, min(self.saved[1], columns - 1)),
        )
        if self.primary_screen is not None:
            _, row, column = self.primary_screen
            self.primary_screen = (
                [[" "] * columns for _ in range(rows)],
                max(0, min(row, rows - 1)),
                max(0, min(column, columns - 1)),
            )

    def feed(self, data: bytes, observed_at_monotonic: float | None = None) -> None:
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
                self._osc(self.pending[index + 2 : end], observed_at_monotonic)
                index = end + (2 if self.pending.startswith("\x1b\\", end) else 1)
                continue
            if kind == "7":
                self.saved = (self.row, self.column)
            elif kind == "8":
                self.row, self.column = self.saved
            index += 2
        self.pending = self.pending[index:]


    def _reject_frame(self, reason: str) -> None:
        self._frame_rejections[reason] = self._frame_rejections.get(reason, 0) + 1


    def _osc(self, raw: str, observed_at_monotonic: float | None) -> None:
        parts = raw.split(";", 3)
        if len(parts) != 4 or parts[0] != "777" or parts[1] != "omp-frame-timing":
            return
        nonce, raw_metadata = parts[2], parts[3]
        if self.timing_nonce is None:
            return
        if nonce != self.timing_nonce:
            self._reject_frame("wrong_nonce")
            return
        metadata, reason = _parse_frame_timing(
            raw_metadata,
            nonce,
            self._last_frame_id,
            self._last_input_id,
            self._last_input_data,
            self._last_input_at,
        )
        if metadata is None:
            self._reject_frame(reason or "invalid")
            return
        frame_id = metadata["frameId"]
        input_id = metadata["inputId"]
        input_data = metadata["inputData"]
        input_at = metadata["inputAtMs"]
        if not self._saw_valid_frame and input_id != 0:
            self._reject_frame("missing_startup_frame")
            return
        if len(self._frame_events) == MAX_FRAME_EVENTS:
            self._reject_frame("event_overflow")
        self._frame_events.append(
            FrameTimingEvent(
                nonce=nonce,
                metadata=metadata,
                raw_metadata=raw_metadata,
                screen=self.text(),
                observed_at_monotonic=observed_at_monotonic,
            )
        )
        self._last_frame_id = frame_id
        self._last_input_id = input_id
        self._last_input_data = input_data
        self._last_input_at = input_at
        self._saw_valid_frame = True

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
        if final in {"h", "l"}:
            if raw.startswith("?") and 1049 in values:
                if final == "h" and self.primary_screen is None:
                    self.primary_screen = (self.grid, self.row, self.column)
                    self.saved = (self.row, self.column)
                    self.grid = [[" "] * self.columns for _ in range(self.rows)]
                elif final == "l" and self.primary_screen is not None:
                    self.grid, self.row, self.column = self.primary_screen
                    self.saved = (self.row, self.column)
                    self.primary_screen = None
            return
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
    def __init__(
        self,
        argv: list[str],
        cwd: Path,
        env: dict[str, str],
        rows: int = ROWS,
        columns: int = COLUMNS,
    ) -> None:
        if rows <= 0 or columns <= 0:
            raise ValueError("terminal dimensions must be positive")
        timing_nonce = env.get(TIMING_NONCE_ENV)
        if timing_nonce is not None and TIMING_NONCE_RE.fullmatch(timing_nonce) is None:
            raise ValueError("timing nonce must be exactly 32 lowercase hex characters")
        self.timing_nonce = timing_nonce
        self.clock_mapping = (
            capture_mapped_monotonic_time()[1] if timing_nonce is not None else None
        )
        pid, master = pty.fork()
        if pid == 0:
            try:
                os.chdir(cwd)
                fcntl.ioctl(
                    0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0)
                )
                os.closerange(3, os.sysconf("SC_OPEN_MAX"))
                os.execve(argv[0], argv, env)
            except OSError as error:
                os.write(2, f"PTY exec failed: {error}\n".encode())
                os._exit(127)
        self.pid = pid
        self.master = master
        self.raw = bytearray()
        self.screen = TerminalScreen(rows, columns, timing_nonce=timing_nonce)
        self.rows = rows
        self.columns = columns
        self.last_output_at: float | None = None
        self.output_reads = 0
        self.exit_status: int | None = None
        fcntl.ioctl(
            master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0)
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
                observed_at = time.monotonic()
                self.last_output_at = observed_at
                self.output_reads += 1
                self.raw.extend(data)
                self.screen.feed(data, observed_at)
                if len(data) < 65536:
                    break
        self._observe_exit()

    def drain_frame_events(self) -> list[FrameTimingEvent]:
        return self.screen.drain_frame_events()

    def resize(self, rows: int, columns: int) -> None:
        if rows <= 0 or columns <= 0:
            raise ValueError("terminal dimensions must be positive")
        fcntl.ioctl(
            self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0)
        )
        self.screen.resize(rows, columns)
        self.rows = rows
        self.columns = columns

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

    def send_typed_line(self, text: str) -> None:
        for character in text:
            self.send(character.encode("utf-8"))
            time.sleep(0.03)
        self.send_enter()


    def send_escape(self) -> None:
        self.send(b"\x1b")

    def send_enter(self) -> None:
        self.send(b"\r")

    def permission_dialog_tool(self) -> str | None:
        screen = self.screen.text()
        if "up/down navigate  enter select  esc cancel" not in screen:
            return None
        match = re.search(r"BreadBoard permission request · ([^·\n]+)", screen)
        return match.group(1).strip() if match is not None else None

    def permission_dialog_ready(self) -> bool:
        return self.permission_dialog_tool() == "run_shell"


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


def listener_snapshot(endpoint: str) -> dict[str, Any]:
    parsed = urlsplit(endpoint)
    if parsed.hostname is None or parsed.port is None:
        raise JourneyFailure(f"invalid authority endpoint: {endpoint}")
    command = [
        "/usr/sbin/lsof",
        "-nP",
        f"-iTCP:{parsed.port}",
        "-sTCP:LISTEN",
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return {
        "argv": command,
        "exitCode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "socketConnectable": endpoint_open(endpoint),
    }


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
def assert_loopback_listeners(processes: dict[str, Any], label: str) -> None:
    violations: list[str] = []
    for process_name, snapshot in processes.items():
        lsof = snapshot.get("lsof")
        output = lsof.get("stdout") if isinstance(lsof, dict) else None
        if not isinstance(output, str):
            continue
        for line in output.splitlines():
            if "LISTEN" in line:
                match = re.search(r"TCP\s+([^\s]+)", line)
                if match:
                    endpoint = match.group(1)
                    if endpoint.startswith("[") and "]:" in endpoint:
                        host = endpoint[1 : endpoint.index("]")]
                    else:
                        host, separator, _ = endpoint.rpartition(":")
                        if not separator:
                            host = endpoint
                    try:
                        loopback = ipaddress.ip_address(host).is_loopback
                    except ValueError:
                        loopback = host in ("localhost", "127.0.0.1", "::1", "*")
                    if not loopback:
                        violations.append(f"{process_name}:{endpoint}")
    if violations:
        raise JourneyFailure(f"{label} opened non-loopback listeners: {violations}")


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

def process_start_token(pid: int) -> str | None:
    """Observe Darwin's kernel start identity, not the authority file's claim."""
    if sys.platform != "darwin":
        return None
    try:
        proc_pidinfo = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo
        proc_pidinfo.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int,
        ]
        proc_pidinfo.restype = ctypes.c_int
        info = ctypes.create_string_buffer(136)
        if proc_pidinfo(pid, 3, 0, info, len(info)) != len(info):
            return None
        if struct.unpack_from("=I", info, 12)[0] != pid:
            return None
        seconds, microseconds = struct.unpack_from("=QQ", info, 120)
        if seconds == 0 or microseconds >= 1_000_000:
            return None
        return f"darwin:{seconds}:{microseconds}"
    except (AttributeError, OSError):
        return None

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

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

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

def positive_dimension(value: str) -> int:
    try:
        dimension = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if dimension <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return dimension

def main() -> int:
    parser = argparse.ArgumentParser(
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument("--bb", type=Path, required=True)
    parser.add_argument("--pi-natives", type=Path, required=True)
    parser.add_argument("--tui-source-commit", required=True)
    parser.add_argument("--tui-source-tree", required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--config-root", type=Path, required=True)
    parser.add_argument("--agent-root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--forbid-root", type=Path, action="append", default=[])
    parser.add_argument(
        "--rows", type=positive_dimension, default=ROWS, help="PTY row count"
    )
    parser.add_argument(
        "--cols", type=positive_dimension, default=COLUMNS, help="PTY column count"
    )
    parser.add_argument("--startup-timeout", type=float, default=120.0)
    parser.add_argument("--turn-timeout", type=float, default=180.0)
    options = parser.parse_args()

    bb = options.bb.resolve(strict=True)
    pi_natives = options.pi_natives.resolve(strict=True)
    product_root = bb.parent
    expected_native = product_root / "native" / "pi_natives.darwin-arm64.node"

    forbid_roots = [root.resolve() for root in options.forbid_root]

    home = options.home.resolve()
    config_root = options.config_root.resolve()
    agent_root = options.agent_root.resolve()
    workspace = options.workspace.resolve()
    temp_root = options.temp_root.resolve()
    output_path = options.output.resolve()

    for d in (home, config_root, agent_root, workspace, temp_root):
        d.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    results: dict[str, Any] = {
        "schemaVersion": "bb.installed_product_journey.v2",
        "product": "bb",
        "target": "darwin-arm64",
        "timestamp": time.time(),
        "runtimeSelfVerification": "none",
        "checks": {},
    }

    all_passed = True

    # 1. Install Identity
    identity_check: dict[str, Any] = {"passed": False}
    try:
        if pi_natives != expected_native:
            raise JourneyFailure(f"pi_natives mismatch: expected {expected_native}, got {pi_natives}")
        manifest_path = product_root / "install-manifest.v1.json"
        if not manifest_path.is_file():
            raise JourneyFailure(f"install manifest missing: {manifest_path}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

        binary_info = manifest.get("binary", {})
        native_info = manifest.get("nativeAddon", {})
        if binary_info.get("path") != "bb":
            raise JourneyFailure(f"manifest binary path mismatch: {binary_info.get('path')}")
        if native_info.get("path") != "native/pi_natives.darwin-arm64.node":
            raise JourneyFailure(f"manifest native addon path mismatch: {native_info.get('path')}")

        bb_sha = sha256_file(bb)
        native_sha = sha256_file(pi_natives)
        expected_bb_sha = binary_info.get("sha256", "").removeprefix("sha256:")
        expected_native_sha = native_info.get("sha256", "").removeprefix("sha256:")

        if bb_sha != expected_bb_sha:
            raise JourneyFailure(f"bb sha256 mismatch: manifest {expected_bb_sha} != actual {bb_sha}")
        if native_sha != expected_native_sha:
            raise JourneyFailure(f"pi_natives sha256 mismatch: manifest {expected_native_sha} != actual {native_sha}")

        provenance_path = product_root / "provenance.v1.json"
        if not provenance_path.is_file():
            raise JourneyFailure(f"provenance missing: {provenance_path}")
        provenance = json.loads(provenance_path.read_text(encoding="utf-8"))
        product_source = provenance.get("productSource", {})

        actual_commit = product_source.get("commit")
        actual_tree = product_source.get("tree")
        if actual_commit != options.tui_source_commit:
            raise JourneyFailure(f"provenance commit mismatch: expected {options.tui_source_commit}, got {actual_commit}")
        if actual_tree != options.tui_source_tree:
            raise JourneyFailure(f"provenance tree mismatch: expected {options.tui_source_tree}, got {actual_tree}")

        engine_dir = product_root / "engine"
        if engine_dir.exists():
            raise JourneyFailure(f"engine directory unexpectedly exists: {engine_dir}")

        identity_check.update({
            "passed": True,
            "manifestPath": str(manifest_path),
            "provenancePath": str(provenance_path),
            "binarySha256": bb_sha,
            "nativeSha256": native_sha,
            "commit": actual_commit,
            "tree": actual_tree,
            "engineAbsent": True,
        })
    except Exception as error:
        identity_check["error"] = str(error)
        all_passed = False

    results["checks"]["installIdentity"] = identity_check

    # 2. Refusals
    refusals_check: dict[str, Any] = {"passed": True}
    base_env = exact_environment(home, config_root, agent_root, temp_root)

    refusal_cases = [
        {
            "id": "cliEngineMode",
            "source": "--engine-mode",
            "value": "local-owned",
            "argv": [str(bb), "--engine-mode", "local-owned"],
            "env": dict(base_env),
            "setup": None,
        },
        {
            "id": "cliEngineUrl",
            "source": "--engine-url",
            "value": "http://127.0.0.1:1",
            "argv": [str(bb), "--engine-url", "http://127.0.0.1:1"],
            "env": dict(base_env),
            "setup": None,
        },
        {
            "id": "envEngineMode",
            "source": "BREADBOARD_ENGINE_MODE",
            "value": "local-owned",
            "argv": [str(bb)],
            "env": {**base_env, "BREADBOARD_ENGINE_MODE": "local-owned"},
            "setup": None,
        },
        {
            "id": "settingsEngineMode",
            "source": "breadboard.engineMode",
            "value": "local-owned",
            "argv": [str(bb)],
            "env": dict(base_env),
            "setup": "write_config",
        },
    ]

    expected_refusal_template = (
        'bb: the Python engine bridge was removed; {source} requests "{value}". '
        'bb runs the native OMP loop; remove {source} to use it.'
    )

    for case in refusal_cases:
        case_id = case["id"]
        source = case["source"]
        value = case["value"]
        expected_msg = expected_refusal_template.format(source=source, value=value)

        sessions_dir = agent_root / "sessions"
        if sessions_dir.exists():
            shutil.rmtree(sessions_dir, ignore_errors=True)
        for cfg in (config_root / "config.yml", agent_root / "config.yml", home / ".breadboard" / "agent" / "config.yml"):
            if cfg.exists():
                cfg.unlink()

        if case["setup"] == "write_config":
            cfg_text = "breadboard:\n  engineMode: local-owned\n"
            (config_root / "config.yml").write_text(cfg_text, encoding="utf-8")
            (agent_root / "config.yml").write_text(cfg_text, encoding="utf-8")
            (home / ".breadboard" / "agent").mkdir(parents=True, exist_ok=True)
            (home / ".breadboard" / "agent" / "config.yml").write_text(cfg_text, encoding="utf-8")

        proc = subprocess.Popen(
            case["argv"],
            cwd=workspace,
            env=case["env"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        python_descendants = []
        try:
            for _ in range(5):
                if proc.poll() is not None:
                    break
                time.sleep(0.05)
                desc = process_descendants(proc.pid)
                py_desc = [d for d in desc if "python" in Path(d["command"].split()[0]).name.lower()]
                if py_desc:
                    python_descendants.extend(py_desc)
            stdout, stderr = proc.communicate(timeout=15)
        except Exception as err:
            proc.kill()
            stdout, stderr = proc.communicate()
            stderr += f"\nProcess error: {err}"

        returncode = proc.returncode
        stderr_stripped = stderr.strip()
        stderr_matched = expected_msg in stderr_stripped
        no_sessions = not (sessions_dir.exists() and any(sessions_dir.iterdir()))
        no_py = len(python_descendants) == 0

        case_passed = (returncode == 2 and stderr_matched and no_sessions and no_py)
        if not case_passed:
            refusals_check["passed"] = False
            all_passed = False

        refusals_check[case_id] = {
            "passed": case_passed,
            "returncode": returncode,
            "expectedReturncode": 2,
            "stderrMatched": stderr_matched,
            "expectedStderr": expected_msg,
            "actualStderr": stderr_stripped,
            "noSessionFiles": no_sessions,
            "noPythonDescendants": no_py,
        }

    for cfg in (config_root / "config.yml", agent_root / "config.yml", home / ".breadboard" / "agent" / "config.yml"):
        if cfg.exists():
            cfg.unlink()

    results["checks"]["refusals"] = refusals_check

    # 3. PTY Launch
    pty_check: dict[str, Any] = {"passed": False}
    try:
        pty_env = exact_environment(home, config_root, agent_root, temp_root)
        child = PtyChild(
            [str(bb)],
            cwd=workspace,
            env=pty_env,
            rows=options.rows,
            columns=options.cols,
        )
        try:
            deadline = time.monotonic() + options.startup_timeout
            reached_idle = False
            identity_visible = False
            python_descendants = []
            loopback_ok = True

            while time.monotonic() < deadline:
                child.pump(0.1)
                txt = child.screen.text()
                if "BreadBoard" in txt:
                    identity_visible = True
                if identity_visible and ("workspace" in txt or "╰─" in txt):
                    reached_idle = True
                    break
                if child.exit_status is not None:
                    break

            if not reached_idle:
                raise JourneyFailure(f"bb did not reach idle editor within {options.startup_timeout}s\nScreen:\n{child.screen.text()}")

            desc = process_descendants(child.pid)
            py_desc = [d for d in desc if "python" in Path(d["command"].split()[0]).name.lower()]
            if py_desc:
                python_descendants.extend(py_desc)

            snapshot = process_snapshot(child.pid)
            try:
                assert_loopback_listeners({"bb": snapshot}, "bb PTY child")
            except JourneyFailure as net_err:
                loopback_ok = False
                pty_check["networkError"] = str(net_err)

            time.sleep(0.5)
            child.send_typed_line("/exit")
            try:
                exit_status = child.wait_for_exit(3)
            except Exception:
                child.send_enter()
                exit_status = child.wait_for_exit(10)
            if exit_status != 0:
                raise JourneyFailure(f"bb exited with non-zero status: {exit_status}")

            no_py = len(python_descendants) == 0
            pty_passed = (reached_idle and identity_visible and exit_status == 0 and no_py and loopback_ok)
            if not pty_passed:
                all_passed = False

            pty_check.update({
                "passed": pty_passed,
                "idleEditorReached": reached_idle,
                "productIdentityVisible": identity_visible,
                "exitCode": exit_status,
                "noPythonDescendants": no_py,
                "loopbackNetworkOnly": loopback_ok,
            })
        finally:
            child.close()
    except Exception as error:
        pty_check["error"] = str(error)
        all_passed = False

    results["checks"]["ptyLaunch"] = pty_check
    results["passed"] = all_passed

    result_text = json.dumps(results, indent=2, sort_keys=True)
    if forbid_roots:
        assert_no_forbidden_paths(result_text, forbid_roots, "journey output")

    write_json(output_path, results)
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
