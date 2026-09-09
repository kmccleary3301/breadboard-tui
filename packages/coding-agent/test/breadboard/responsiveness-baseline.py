#!/usr/bin/env python3
"""Provider-free PTY responsiveness, startup, resource, and fixture harness.

The harness deliberately measures the endpoint owned by the PTY runner: the
monotonic timestamp on the read that first makes the expected screen predicate
true.  It imports ``installed-product-journey.py`` so the two harnesses share
one terminal parser and one isolated-root environment policy.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Callable, Iterable

RUNNER_PATH = Path(__file__).with_name("installed-product-journey.py")
FIXTURE_VERSION = "bb.responsiveness-fixtures.v1"
RESULT_VERSION = "bb.responsiveness-baseline.v1"
READY_PREDICATE = "status/composer row containing mock/reference (or plain OMP no-model) and the composer glyph"
PAGE_UP = b"\x1b[5~"
PAGE_DOWN = b"\x1b[6~"
ESCAPE = b"\x1b"
BACKSPACE = b"\x7f"
ENTER = b"\r"
SCALE_NAMES = ("everyday", "complex", "adverse")
ACTION_NAMES = ("key", "menu", "scroll", "submit", "cancel")
GEOMETRIES = ((120, 36), (80, 24))


def _load_runner() -> Any:
    spec = importlib.util.spec_from_file_location("installed_product_journey", RUNNER_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import runner: {RUNNER_PATH}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runner = _load_runner()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _write_aggregate(path: Path, key: str, value: dict[str, Any]) -> None:
    """Merge command output when startup/cells/soak intentionally share a file."""
    existing: dict[str, Any] = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                existing = loaded
        except json.JSONDecodeError:
            existing = {}
    product = value.get("product")
    if existing.get("product") not in (None, product):
        raise RuntimeError(f"output already belongs to product {existing['product']!r}: {path}")
    existing.update({"schemaVersion": RESULT_VERSION, "product": product, key: value})
    write_json(path, existing)


def _parse_csv(value: str, allowed: Iterable[str], label: str) -> list[str]:
    requested = [item.strip() for item in value.split(",") if item.strip()]
    if not requested:
        raise ValueError(f"{label} must not be empty")
    unknown = sorted(set(requested) - set(allowed))
    if unknown:
        raise ValueError(f"unknown {label}: {', '.join(unknown)}")
    return requested


def _parse_geometry(value: str) -> tuple[int, int]:
    try:
        columns_text, rows_text = value.lower().split("x", 1)
        columns, rows = int(columns_text), int(rows_text)
    except ValueError as error:
        raise ValueError(f"geometry must be COLUMNSxROWS, got {value!r}") from error
    if rows <= 0 or columns <= 0:
        raise ValueError(f"geometry must be positive, got {value!r}")
    return columns, rows


def _grapheme_fixture(scale: str) -> tuple[str, str]:
    if scale == "everyday":
        value = "everyday-" + "abcdefghijklmnopqrstuvwxyz0123456789"
        return (value * math.ceil(256 / len(value)))[:256], "ascii"
    if scale == "complex":
        # Keep the logical count at 2,048 grapheme clusters while exercising
        # each non-ASCII class and staying comfortably below the 8 KiB limit.
        clusters = ["a"] * 2048
        for index, cluster in ((127, "界"), (511, "e\u0301"), (1023, "🧪"), (1535, "b")):
            clusters[index] = cluster
        return "".join(clusters), "cjk-combining-emoji-bracketed-paste"
    if scale == "adverse":
        value = "adverse-edit-0123456789-"
        return (value * math.ceil(8192 / len(value)))[:8192], "repeated-ascii-edits"
    raise ValueError(f"unknown scale: {scale}")


def _zero_usage() -> dict[str, Any]:
    return {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0},
    }


def _message_entry(entry_id: str, parent_id: str | None, message: dict[str, Any], stamp: str) -> dict[str, Any]:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": parent_id,
        "timestamp": stamp,
        "message": message,
    }


def _session_entries(scale: str, line_count: int, tool_count: int, approval_count: int) -> list[dict[str, Any]]:
    """Create ordinary session JSONL records accepted by session-loader.ts.

    Every tool block is an assistant toolCall followed by a completed toolResult;
    approval markers are valid custom entries and are intentionally ignored by
    the LLM context builder.  Remaining records are visible user/assistant rows
    so the transcript has deterministic rendered history without provider work.
    """
    stamp = {
        "everyday": "2026-01-01T00:00:00.000Z",
        "complex": "2026-01-02T00:00:00.000Z",
        "adverse": "2026-01-03T00:00:00.000Z",
    }[scale]
    entries: list[dict[str, Any]] = [
        {
            "type": "session",
            "version": 3,
            "id": f"baseline-{scale}-session",
            "timestamp": stamp,
            # Deliberately absent: SessionManager.open falls back to launch cwd,
            # keeping fixture launches inside each isolated workspace root.
            "cwd": "/__bb_responsiveness_fixture_workspace__",
            "provider": "mock",
            "modelId": "reference",
        }
    ]
    parent_id: str | None = None
    approvals_left = approval_count
    for index in range(tool_count):
        call_id = f"baseline-{scale}-call-{index:04d}"
        user_id = f"baseline-{scale}-user-{index:04d}"
        assistant_id = f"baseline-{scale}-assistant-{index:04d}"
        result_id = f"baseline-{scale}-result-{index:04d}"
        entries.append(
            _message_entry(
                user_id,
                parent_id,
                {
                    "role": "user",
                    "content": [{"type": "text", "text": f"Fixture tool turn {index + 1}: inspect deterministic state."}],
                    "timestamp": int(index * 4_000),
                },
                stamp,
            )
        )
        parent_id = user_id
        output_size = {"everyday": 320, "complex": 2_730, "adverse": 16_384}[scale]
        output = (f"{scale}-tool-output-{index:03d} " + "x" * output_size)[:output_size]
        details: dict[str, Any] = {"fixture": FIXTURE_VERSION, "block": index}
        if scale == "adverse" and index == 0:
            details["adverseEvents"] = ["approval", "cancel", "stall", "disconnect", "late-result"]
        if index == 0 and scale in {"complex", "adverse"}:
            diff_size = 32 * 1024 if scale == "complex" else 256 * 1024
            details["diff"] = (f"{scale}-diff\n" + "+" * diff_size)[:diff_size]
        tool_call = {
            "type": "toolCall",
            "id": call_id,
            "name": "run_shell" if index % 3 == 0 else "read",
            "arguments": {"command": f"printf {scale}-{index}"},
        }
        entries.append(
            _message_entry(
                assistant_id,
                parent_id,
                {
                    "role": "assistant",
                    "content": [{"type": "text", "text": f"Running deterministic fixture tool {index + 1}."}, tool_call],
                    "api": "openai-responses",
                    "provider": "mock",
                    "model": "reference",
                    "usage": _zero_usage(),
                    "stopReason": "stop",
                    "timestamp": int(index * 4_000 + 1),
                },
                stamp,
            )
        )
        parent_id = assistant_id
        if approvals_left > 0:
            entries.append(
                {
                    "type": "custom",
                    "id": f"baseline-{scale}-approval-{approval_count - approvals_left:04d}",
                    "parentId": parent_id,
                    "timestamp": stamp,
                    "customType": "baseline_approval",
                    "data": {"decision": "allow_once", "tool": "run_shell", "fixture": True},
                }
            )
            parent_id = entries[-1]["id"]
            approvals_left -= 1
        entries.append(
            _message_entry(
                result_id,
                parent_id,
                {
                    "role": "toolResult",
                    "toolCallId": call_id,
                    "toolName": tool_call["name"],
                    "content": [{"type": "text", "text": output}],
                    "details": details,
                    "isError": False,
                    "timestamp": int(index * 4_000 + 2),
                },
                stamp,
            )
        )
        parent_id = result_id

    filler_index = 0
    while len(entries) < line_count:
        entry_id = f"baseline-{scale}-filler-{filler_index:05d}"
        if filler_index % 2 == 0:
            message = {
                "role": "user",
                "content": [{"type": "text", "text": f"Transcript filler {filler_index:05d} for {scale}."}],
                "timestamp": filler_index,
            }
        else:
            message = {
                "role": "assistant",
                "content": [{"type": "text", "text": f"Deterministic transcript response {filler_index:05d}."}],
                "api": "openai-responses",
                "provider": "mock",
                "model": "reference",
                "usage": _zero_usage(),
                "stopReason": "stop",
                "timestamp": filler_index,
            }
        entries.append(_message_entry(entry_id, parent_id, message, stamp))
        parent_id = entry_id
        filler_index += 1
    return entries[:line_count]


def generate_fixtures(out_dir: Path) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    scale_config = {
        "everyday": (256, 300, 6, 1),
        "complex": (2048, 2_400, 24, 2),
        "adverse": (8192, 12_000, 64, 8),
    }
    scales: dict[str, Any] = {}
    for scale, (graphemes, lines, tools, approvals) in scale_config.items():
        scale_dir = out_dir / scale
        scale_dir.mkdir(parents=True, exist_ok=True)
        value, input_kind = _grapheme_fixture(scale)
        payload = f"\x1b[200~{value}\x1b[201~" if scale == "complex" else value
        (scale_dir / "input.txt").write_text(value, encoding="utf-8")
        (scale_dir / "input.bin").write_bytes(payload.encode("utf-8"))
        entries = _session_entries(scale, lines, tools, approvals)
        session_text = "\n".join(json.dumps(entry, separators=(",", ":")) for entry in entries) + "\n"
        session_path = scale_dir / "session.jsonl"
        session_path.write_text(session_text, encoding="utf-8")
        product_agnostic = scale_dir / f"{scale}.jsonl"
        product_agnostic.write_text(session_text, encoding="utf-8")
        scale_info = {
            "input": {
                "graphemes": graphemes,
                "unicodeScalars": len(value),
                "utf8Bytes": len(payload.encode("utf-8")),
                "path": str((scale_dir / "input.bin").resolve()),
                "kind": input_kind,
                "bracketedPaste": scale == "complex",
            },
            "session": {
                "path": str(product_agnostic.resolve()),
                "jsonlLines": len(entries),
                "toolBlocks": tools,
                "approvals": approvals,
                "format": "session header + SessionEntry JSONL (version 3)",
            },
        }
        write_json(scale_dir / "metadata.json", {"schemaVersion": FIXTURE_VERSION, "scale": scale, **scale_info})
        scales[scale] = scale_info
    manifest = {"schemaVersion": FIXTURE_VERSION, "out": str(out_dir.resolve()), "scales": scales}
    write_json(out_dir / "manifest.json", manifest)
    return manifest


class RootSet:
    def __init__(self, base: Path, label: str) -> None:
        self.base = base.resolve()
        self.label = label
        self.home = self.base / "home"
        self.config = self.base / "config"
        self.agent = self.base / "agent"
        self.workspace = self.base / "workspace"
        self.temp = self.base / "temp"
        for path in (self.home, self.config, self.agent, self.workspace, self.temp):
            path.mkdir(parents=True, exist_ok=True)
        (self.agent / "config.yml").write_text("tools:\n  approvalMode: always-ask\n", encoding="utf-8")

    def environment(self) -> dict[str, str]:
        return runner.exact_environment(self.home, self.config, self.agent, self.temp)


def _new_root_set(base: Path, product: str, label: str) -> RootSet:
    base.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix=f"{product}-{label}-", dir=str(base)))
    return RootSet(run_dir, label)


def _argv(binary: Path, fixture: Path | None) -> list[str]:
    argv = [str(binary)]
    if fixture is None:
        argv.append("--no-session")
    else:
        argv.extend(("--resume", str(fixture)))
    # `mock/reference` is the runner's normal provider-free marker.  Plain OMP
    # may lack the mock catalog but still presents a usable no-model composer;
    # retain that observable fallback instead of treating fixture open as a
    # startup failure.
    argv.extend(("--model", "mock/reference"))
    return argv


def _start_child(binary: Path, roots: RootSet, rows: int, columns: int, fixture: Path | None) -> Any:
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError(f"binary is not executable: {binary}")
    return runner.PtyChild(_argv(binary, fixture), roots.workspace, roots.environment(), rows=rows, columns=columns)


def _jsonl_rows(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"session row is not an object: {path}")
            rows.append(row)
    return rows


def _find_bound_session(agent_dir: Path) -> Path | None:
    candidates: list[Path] = []
    for candidate in agent_dir.glob("sessions/**/*.jsonl"):
        try:
            if any(row.get("customType") == "breadboard.session-binding" for row in _jsonl_rows(candidate)):
                candidates.append(candidate)
        except (OSError, json.JSONDecodeError):
            continue
    return max(candidates, key=lambda path: path.stat().st_mtime_ns) if candidates else None



def _prepare_bb_cell_fixture(
    binary: Path,
    roots: RootSet,
    rows: int,
    columns: int,
    fixture_path: Path,
) -> Path:
    """Bind fixture entries to the durable runtime owned by this cell root."""
    child = runner.PtyChild(
        [str(binary), "--model", "mock/reference"],
        roots.workspace,
        roots.environment(),
        rows=rows,
        columns=columns,
    )
    try:
        ready, _ = _wait_ready(child, 45.0)
        if not ready and child.exit_status is not None:
            raise RuntimeError(f"BB bootstrap exited before readiness: {child.screen.text()}")
        child.send(b"hello")
        child.send(ENTER)
        bound: Path | None = None
        deadline = time.monotonic() + 45.0
        while time.monotonic() < deadline and child.exit_status is None:
            child.pump(0.1)
            bound = _find_bound_session(roots.agent)
            if bound is not None:
                break
        if bound is None:
            raise RuntimeError(f"BB did not persist a durable bound session for {fixture_path.stem}")
        child.send(b"/exit")
        child.send(ENTER)
        quit_deadline = time.monotonic() + 5.0
        while child.exit_status is None and time.monotonic() < quit_deadline:
            child.pump(0.1)
        if child.exit_status is None:
            child.close()
        else:
            child.close_fd()
    except BaseException:
        if child.exit_status is None:
            child.close()
        else:
            child.close_fd()
        raise
    source_rows = _jsonl_rows(bound)
    fixture_rows = _jsonl_rows(fixture_path)
    appended = [dict(row) for row in fixture_rows[1:]]
    binding_rows = [row for row in source_rows if row.get("customType") == "breadboard.session-binding"]
    if not binding_rows:
        raise RuntimeError(f"BB durable session has no binding entry: {bound}")
    appended[0]["parentId"] = binding_rows[-1].get("id")
    with bound.open("a", encoding="utf-8") as handle:
        for row in appended:
            handle.write(json.dumps(row, separators=(",", ":")) + "\n")
    return bound

def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _process_rows() -> list[dict[str, Any]]:
    completed = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,state=,command="], capture_output=True, text=True, timeout=10, check=False
    )
    rows: list[dict[str, Any]] = []
    for line in completed.stdout.splitlines():
        fields = line.strip().split(maxsplit=3)
        if len(fields) == 4 and fields[0].isdigit() and fields[1].isdigit():
            rows.append({"pid": int(fields[0]), "ppid": int(fields[1]), "state": fields[2], "command": fields[3]})
    return rows


def _process_descendants(root_pid: int) -> list[dict[str, Any]]:
    rows = _process_rows()
    descendants: list[dict[str, Any]] = []
    parents = {root_pid}
    while True:
        children = [row for row in rows if row["ppid"] in parents and row not in descendants]
        if not children:
            return descendants
        descendants.extend(children)
        parents.update(int(child["pid"]) for child in children)


def _owned_processes(root: Path, root_pid: int) -> list[dict[str, Any]]:
    root_text = str(root.resolve())
    descendants = _process_descendants(root_pid)
    rows = _process_rows()
    known = {int(row["pid"]) for row in descendants}
    known.add(root_pid)
    owned: list[dict[str, Any]] = []
    for row in rows:
        command_path = str(row["command"]).split(maxsplit=1)[0]
        if int(row["pid"]) in known or root_text in command_path:
            owned.append(row)
    return owned


def _ps_snapshot(pid: int) -> dict[str, Any]:
    command = ["/bin/ps", "-o", "pid=,ppid=,rss=,%cpu=,etime=,command=", "-p", str(pid)]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    return {"argv": command, "exitCode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}


def _cleanup_receipt(child: Any, before: list[dict[str, Any]], root: Path | None = None) -> dict[str, Any]:
    pid = int(child.pid)
    root_path = root.resolve() if root is not None else None
    owned_before = _owned_processes(root_path, pid) if root_path is not None else []
    child.close()
    time.sleep(0.05)
    owned_after_close = _owned_processes(root_path, pid) if root_path is not None else _process_descendants(pid)
    term_pids: list[int] = []
    for row in owned_after_close:
        survivor = int(row["pid"])
        if survivor == os.getpid() or survivor == pid:
            continue
        try:
            os.kill(survivor, signal.SIGTERM)
            term_pids.append(survivor)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5.0
    survivors = owned_after_close
    while survivors and time.monotonic() < deadline:
        time.sleep(0.1)
        survivors = _owned_processes(root_path, pid) if root_path is not None else _process_descendants(pid)
    kill_pids: list[int] = []
    for row in survivors:
        survivor = int(row["pid"])
        if survivor == os.getpid() or survivor == pid:
            continue
        try:
            os.kill(survivor, signal.SIGKILL)
            kill_pids.append(survivor)
        except ProcessLookupError:
            pass
    time.sleep(0.05)
    final_owned = _owned_processes(root_path, pid) if root_path is not None else _process_descendants(pid)
    return {
        "pid": pid,
        "exitCode": child.exit_status,
        "descendantsBefore": before,
        "descendantsAfter": _process_descendants(pid),
        "processAliveAfter": _process_alive(pid),
        "descendantCountBefore": len(before),
        "descendantCountAfter": len(_process_descendants(pid)),
        "rootProcessesBefore": owned_before,
        "rootProcessesAfterClose": owned_after_close,
        "rootProcessesAfter": final_owned,
        "sigtermPids": term_pids,
        "sigkillPids": kill_pids,
        "rootProcessesGone": not final_owned,
        "gone": not _process_alive(pid) and not final_owned,
        "rootSnapshot": _ps_snapshot(pid),
    }


def _screen_hash(child: Any) -> str:
    return hashlib.sha256(child.screen.text().encode("utf-8", "replace")).hexdigest()


def _status_ready(screen: str) -> bool:
    lines = screen.splitlines()
    model_status = any(("mock/reference" in line or "no-model" in line) and ">" in line for line in lines)
    composer = any("╰─" in line for line in lines)
    return model_status and composer


def _ready(screen: str) -> bool:
    return _status_ready(screen)


def _ready_fallback(screen: str) -> bool:
    return _status_ready(screen)


def _wait_ready(child: Any, timeout: float = 30.0) -> tuple[bool, str | None]:
    return _pump_until(child, _ready_fallback, timeout)


def _pump_until(child: Any, predicate: Callable[[str], bool], timeout: float, read_before: int | None = None) -> tuple[bool, str | None]:
    deadline = time.monotonic() + timeout
    reads = child.output_reads if read_before is None else read_before
    while time.monotonic() < deadline:
        child.pump(min(0.005, max(0.0, deadline - time.monotonic())))
        if child.output_reads > reads and predicate(child.screen.text()):
            return True, child.last_output_at
        if child.exit_status is not None:
            break
    return False, None

def _tail(screen: str, rows: int = 10) -> str:
    return "\n".join(screen.splitlines()[-rows:])


def _measurement(
    child: Any,
    action: str,
    payload: bytes,
    predicate: Callable[[str, str], bool],
    timeout: float = 1.0,
    precondition: Callable[[str], bool] | None = None,
) -> dict[str, Any]:
    before = child.screen.text()
    if precondition is not None:
        for _ in range(2):
            if not precondition(before):
                break
            _reset_escape(child)
            before = child.screen.text()
        if precondition(before):
            return {
                "action": action,
                "status": "UNKNOWN",
                "latencyMs": None,
                "reason": "precondition_true",
                "readsBefore": child.output_reads,
                "readsAfter": child.output_reads,
                "alive": _process_alive(int(child.pid)),
                "exitCode": child.exit_status,
                "screenHash": _screen_hash(child),
            }
    reads_before = child.output_reads
    t0 = time.monotonic()
    try:
        child.send(payload)
    except Exception as error:
        return {
            "action": action,
            "status": "UNKNOWN",
            "latencyMs": None,
            "reason": f"send-error:{error}",
            "alive": _process_alive(int(child.pid)),
            "exitCode": child.exit_status,
            "screenHash": _screen_hash(child),
        }
    deadline = t0 + timeout
    observed = False
    while time.monotonic() < deadline:
        child.pump(min(0.005, max(0.0, deadline - time.monotonic())))
        if child.output_reads > reads_before and predicate(before, child.screen.text()):
            observed = True
            break
        if child.exit_status is not None:
            break
    t1 = child.last_output_at if observed else None
    status = "valid" if observed and t1 is not None else "UNKNOWN"
    result: dict[str, Any] = {
        "action": action,
        "status": status,
        "latencyMs": (t1 - t0) * 1000 if t1 is not None else None,
        "t0Monotonic": t0,
        "t1Monotonic": t1,
        "readsBefore": reads_before,
        "readsAfter": child.output_reads,
        "alive": _process_alive(int(child.pid)),
        "exitCode": child.exit_status,
        "screenHash": _screen_hash(child),
    }
    if not observed:
        result["reason"] = "timeout-or-exit"
    return result


def _reset_escape(child: Any) -> None:
    # Escape dismisses the palette once; Backspace then removes its slash
    # trigger so the next sample starts from the same empty composer.
    child.send(ESCAPE)
    child.pump(0.15)
    child.send(BACKSPACE)
    child.pump(0.15)

def _composer_ready(child: Any, marker: str) -> bool:
    return marker in _tail(child.screen.text())


def _prepare_composer(child: Any, marker: str = "~") -> None:
    # A single printable character is the same input path as the key sample.
    child.send(marker.encode("ascii"))
    ok, _ = _pump_until(child, lambda text: marker in _tail(text), 1.0)
    if not ok:
        raise RuntimeError(f"composer did not accept setup marker {marker!r}")


def _menu_visible(before: str, after: str) -> bool:
    # editor.ts renders autocomplete below the editor; the select-list
    # renderer marks its active item with `❯`, while the composer row retains
    # the slash trigger.
    return after != before and "\n❯ " in after and "╰─ /" in after


def _menu_residue(screen: str) -> bool:
    return "\n❯ " in screen and "╰─ /" in screen


def _feedback_visible(screen: str) -> bool:
    return any(token in screen for token in ("Working", "working", "No provider", "unavailable", "error"))


def _action_precondition(action: str, marker: str) -> Callable[[str], bool]:
    if action == "key":
        return lambda screen: marker in _tail(screen)
    if action in {"menu", "scroll"}:
        return _menu_residue
    if action in {"submit", "cancel"}:
        return lambda screen: _menu_residue(screen) or _feedback_visible(screen)
    raise ValueError(f"unknown action: {action}")


def _action_sample(child: Any, action: str, marker: str = "~") -> dict[str, Any]:
    precondition = _action_precondition(action, marker)
    if action == "key":
        result = _measurement(
            child,
            action,
            marker.encode("ascii"),
            lambda before, after: marker in _tail(after) and after != before,
            precondition=precondition,
        )
        if result["status"] == "valid":
            _measurement(child, "key-reset", BACKSPACE, lambda before, after: after != before, timeout=0.5)
        return result
    if action == "menu":
        result = _measurement(child, action, b"/", _menu_visible, precondition=precondition)
        _reset_escape(child)
        return result
    if action == "scroll":
        result = _measurement(child, action, PAGE_UP, lambda before, after: after != before, precondition=precondition)
        child.send(PAGE_DOWN)
        child.pump(0.1)
        return result
    if action == "submit":
        _prepare_composer(child, marker)
        result = _measurement(
            child,
            action,
            ENTER,
            lambda old, after: after != old and (marker not in _tail(after) or _feedback_visible(after)),
            precondition=precondition,
        )
        _reset_escape(child)
        return result
    if action == "cancel":
        _prepare_composer(child, marker)
        submit_before = child.output_reads
        child.send(ENTER)
        feedback, _ = _pump_until(child, _feedback_visible, 1.0, submit_before)
        if not feedback:
            _reset_escape(child)
            return {
                "action": action,
                "status": "UNKNOWN",
                "latencyMs": None,
                "reason": "post-submit-state-not-visible",
                "alive": _process_alive(int(child.pid)),
                "exitCode": child.exit_status,
                "screenHash": _screen_hash(child),
            }
        result = _measurement(child, action, ESCAPE, lambda before, after: after != before, precondition=precondition)
        _reset_escape(child)
        return result
    raise ValueError(f"unknown action: {action}")



def _summary(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"p50Ms": None, "p95Ms": None, "maxMs": None}
    ordered = sorted(values)
    p50 = ordered[max(1, math.ceil(0.50 * len(ordered))) - 1]
    p95 = ordered[max(1, math.ceil(0.95 * len(ordered))) - 1]
    return {"p50Ms": p50, "p95Ms": p95, "maxMs": ordered[-1]}


def _cell_summary(samples: list[dict[str, Any]], blocks: int) -> dict[str, Any]:
    valid = [float(row["latencyMs"]) for row in samples if row.get("status") == "valid" and row.get("latencyMs") is not None]
    block_size = math.ceil(len(samples) / blocks) if blocks else len(samples)
    block_rows: list[dict[str, Any]] = []
    for block in range(blocks):
        block_samples = samples[block * block_size : (block + 1) * block_size]
        block_values = [float(row["latencyMs"]) for row in block_samples if row.get("status") == "valid" and row.get("latencyMs") is not None]
        block_rows.append({"block": block + 1, "sampleCount": len(block_samples), "invalid": len(block_samples) - len(block_values), **_summary(block_values)})
    overall = _summary(valid)
    return {
        "samples": samples,
        "sampleCount": len(samples),
        "valid": len(valid),
        "invalid": len(samples) - len(valid),
        "invalidRate": (len(samples) - len(valid)) / len(samples) if samples else 1.0,
        **overall,
        "blocks": block_rows,
        "blockInvalidOver10Percent": any(row["invalid"] > row["sampleCount"] * 0.10 for row in block_rows if row["sampleCount"]),
    }


def run_startup(args: argparse.Namespace) -> dict[str, Any]:
    if args.cold < 0 or args.warm_warmup < 0 or args.warm < 0:
        raise ValueError("startup counts must be non-negative")
    if args.rows <= 0 or args.cols <= 0:
        raise ValueError("rows and cols must be positive")
    binary = Path(args.binary).resolve()
    roots_base = Path(args.roots).resolve()
    launches: list[dict[str, Any]] = []

    def launch(kind: str, index: int, retained: RootSet | None = None) -> None:
        roots = retained or _new_root_set(roots_base, args.product, kind)
        child: Any | None = None
        descendants: list[dict[str, Any]] = []
        start = time.monotonic()
        row: dict[str, Any] = {"kind": kind, "index": index, "root": str(roots.base), "rows": args.rows, "cols": args.cols}
        try:
            child = _start_child(binary, roots, args.rows, args.cols, None)
            descendants = _process_descendants(int(child.pid))
            ready, endpoint = _wait_ready(child)
            row.update({
                "ready": ready,
                "latencyMs": (endpoint - start) * 1000 if endpoint is not None else None,
                "exitCode": child.exit_status,
                "lastOutputAt": endpoint,
                "screenHash": _screen_hash(child),
            })
            if not ready:
                row["reason"] = "usable-composer-timeout-or-exit"
            row["descendantCountAtLaunch"] = len(descendants)
        except Exception as error:
            row.update({"ready": False, "latencyMs": None, "reason": f"launch-error:{error}", "exitCode": child.exit_status if child else None})
            descendants = _process_descendants(int(child.pid)) if child else []
        finally:
            if child is not None:
                row["cleanup"] = _cleanup_receipt(child, descendants, roots.base)
        launches.append(row)

    for index in range(args.cold):
        launch("cold", index)
    warm_root = _new_root_set(roots_base, args.product, "warm") if args.warm_warmup or args.warm else None
    if warm_root is not None:
        for index in range(args.warm_warmup):
            launch("warmup", index, warm_root)
        for index in range(args.warm):
            launch("warm", index, warm_root)
    cold_rows = [row for row in launches if row["kind"] == "cold"]
    warm_rows = [row for row in launches if row["kind"] == "warm"]
    return {
        "product": args.product,
        "binary": str(binary),
        "rows": args.rows,
        "cols": args.cols,
        "readyPredicate": READY_PREDICATE,
        "cold": {"requested": args.cold, "launches": cold_rows, **_summary([row["latencyMs"] for row in cold_rows if row.get("ready") and row.get("latencyMs") is not None])},
        "warmup": {"requested": args.warm_warmup, "launches": [row for row in launches if row["kind"] == "warmup"]},
        "warm": {"requested": args.warm, "launches": warm_rows, **_summary([row["latencyMs"] for row in warm_rows if row.get("ready") and row.get("latencyMs") is not None])},
    }


def _fixture_session(fixtures: Path, scale: str) -> Path:
    candidates = (fixtures / scale / f"{scale}.jsonl", fixtures / f"{scale}.jsonl", fixtures / scale / "session.jsonl")
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError(f"fixture session not found for {scale}: {candidates[0]}")


def run_cells(args: argparse.Namespace) -> dict[str, Any]:
    if args.rows <= 0 or args.cols <= 0:
        raise ValueError("rows and cols must be positive")
    if args.warmup < 0 or args.samples <= 0 or args.blocks <= 0:
        raise ValueError("warmup, samples, and blocks must be positive where applicable")
    if args.samples % args.blocks != 0:
        raise ValueError("samples must be divisible by blocks")
    scales = _parse_csv(args.scales, SCALE_NAMES, "scales")
    geometries = [_parse_geometry(value) for value in args.geometries.split(",") if value.strip()]
    actions = _parse_csv(args.actions, ACTION_NAMES, "actions")
    binary = Path(args.binary).resolve()
    roots_base = Path(args.roots).resolve()
    fixtures_base = Path(args.fixtures).resolve()
    cells: dict[str, Any] = {}
    for scale in scales:
        fixture = _fixture_session(fixtures_base, scale)
        for columns, rows in geometries:
            cell_key = f"{scale}/{columns}x{rows}"
            root = _new_root_set(roots_base, args.product, f"cell-{scale}-{columns}x{rows}")
            child: Any | None = None
            descendants: list[dict[str, Any]] = []
            active_fixture = fixture
            cell: dict[str, Any] = {"scale": scale, "geometry": f"{columns}x{rows}", "fixture": str(fixture), "actions": {}}
            try:
                if args.product == "bb":
                    active_fixture = _prepare_bb_cell_fixture(binary, root, rows, columns, fixture)
                    cell["fixture"] = str(active_fixture)
                child = _start_child(binary, root, rows, columns, active_fixture)
                descendants = _process_descendants(int(child.pid))
                ready, ready_at = _wait_ready(child, 60.0)
                cell["ready"] = ready
                cell["readyOutputAt"] = ready_at
                cell["initialScreenHash"] = _screen_hash(child)
                cell["initialScreenText"] = child.screen.text()
                if not ready:
                    for action in actions:
                        cell["actions"][action] = {"warmups": [], "samples": [], "error": "usable-composer-timeout-or-exit"}
                else:
                    for action in actions:
                        warmups = [_action_sample(child, action) for _ in range(args.warmup)]
                        samples: list[dict[str, Any]] = []
                        for _block in range(args.blocks):
                            for _sample in range(args.samples // args.blocks):
                                samples.append(_action_sample(child, action))
                        cell["actions"][action] = {"warmups": warmups, **_cell_summary(samples, args.blocks)}
            except Exception as error:
                cell["ready"] = False
                cell["error"] = str(error)
            finally:
                if child is not None:
                    cell["cleanup"] = _cleanup_receipt(child, descendants, root.base)
            cells[cell_key] = cell
    return {
        "product": args.product,
        "binary": str(binary),
        "fixtures": str(fixtures_base),
        "scales": scales,
        "warmup": args.warmup,
        "samples": args.samples,
        "blocks": args.blocks,
        "endpoint": "PtyChild.last_output_at on first read satisfying the action predicate",
        "cells": cells,
    }


def _resource_sample(root_pid: int) -> dict[str, Any]:
    descendants = _process_descendants(root_pid)
    pids = [root_pid] + [int(row["pid"]) for row in descendants]
    rows: list[dict[str, Any]] = []
    total_rss = 0
    for pid in pids:
        command = ["/bin/ps", "-o", "pid=,ppid=,rss=,%cpu=,etime=", "-p", str(pid)]
        completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
        parsed = completed.stdout.strip().split()
        row: dict[str, Any] = {"pid": pid, "argv": command, "exitCode": completed.returncode, "stdout": completed.stdout, "stderr": completed.stderr}
        if len(parsed) >= 5 and parsed[0].isdigit():
            try:
                row.update({"ppid": int(parsed[1]), "rssKb": int(parsed[2]), "cpuPercent": float(parsed[3]), "etime": parsed[4]})
                total_rss += int(parsed[2])
            except ValueError:
                pass
        rows.append(row)
    return {"rootPid": root_pid, "descendantCount": len(descendants), "rows": rows, "totalRssKb": total_rss}


def run_soak(args: argparse.Namespace) -> dict[str, Any]:
    if args.minutes <= 0:
        raise ValueError("minutes must be positive")
    binary = Path(args.binary).resolve()
    root = _new_root_set(Path(args.roots).resolve(), args.product, "soak")
    fixture = _fixture_session(Path(args.fixtures).resolve(), "adverse")
    active_fixture = fixture
    descendants: list[dict[str, Any]] = []
    started = time.monotonic()
    actions: list[dict[str, Any]] = []
    resources: list[dict[str, Any]] = []
    ready = False
    cleanup: dict[str, Any] | None = None
    try:
        if args.product == "bb":
            active_fixture = _prepare_bb_cell_fixture(binary, root, 36, 120, fixture)
        child = _start_child(binary, root, 36, 120, active_fixture)
        descendants = _process_descendants(int(child.pid))
        ready, _ = _wait_ready(child, 60.0)
        if not ready:
            actions.append({"action": "ready", "status": "UNKNOWN", "reason": "usable-composer-timeout-or-exit"})
        else:
            duration = args.minutes * 60.0
            next_action = time.monotonic()
            next_resource = next_action
            action_index = 0
            while time.monotonic() - started < duration and child.exit_status is None:
                now = time.monotonic()
                if now >= next_action:
                    action_name = ACTION_NAMES[action_index % len(ACTION_NAMES)]
                    actions.append(_action_sample(child, action_name))
                    action_index += 1
                    next_action += 1.0
                if now >= next_resource:
                    resources.append({"elapsedSeconds": now - started, **_resource_sample(int(child.pid))})
                    next_resource += 10.0
                child.pump(0.005)
                time.sleep(0.01)
            resources.append({"elapsedSeconds": time.monotonic() - started, **_resource_sample(int(child.pid))})
    finally:
        cleanup = _cleanup_receipt(child, descendants, root.base) if child is not None else None
    rss_values = [int(row["totalRssKb"]) for row in resources if row.get("totalRssKb") is not None]
    return {
        "product": args.product,
        "binary": str(binary),
        "fixture": str(active_fixture),
        "ready": ready,
        "durationSeconds": time.monotonic() - started,
        "actions": actions,
        "resources": resources,
        "startRssKb": rss_values[0] if rss_values else None,
        "endRssKb": rss_values[-1] if rss_values else None,
        "maxRssKb": max(rss_values) if rss_values else None,
        "descendantCountStart": len(descendants),
        "descendantCountEnd": resources[-1]["descendantCount"] if resources else None,
        "exitCode": child.exit_status if child is not None else None,
        "cleanup": cleanup,
    }


def _read_result(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"result must be a JSON object: {path}")
    return value


def _product_section(data: dict[str, Any], key: str) -> dict[str, Any]:
    section = data.get(key)
    if isinstance(section, dict):
        return section
    return data


def _gate(value: float | None, threshold: float, *, maximum: bool = False) -> str:
    if value is None:
        return "UNKNOWN"
    return "pass" if (value <= threshold if not maximum else value <= threshold) else "fail"


def summarize_results(bb_path: Path, omp_path: Path, out_path: Path) -> None:
    bb = _read_result(bb_path)
    omp = _read_result(omp_path)
    bb_cells = _product_section(bb, "cells").get("cells", {})
    omp_cells = _product_section(omp, "cells").get("cells", {})
    cell_keys = sorted(set(bb_cells) | set(omp_cells))
    cell_output: dict[str, Any] = {}
    for key in cell_keys:
        scale = key.split("/", 1)[0]
        p95_limit = 150.0 if scale == "adverse" else 100.0
        max_limit = 400.0 if scale == "adverse" else 250.0
        candidate_data: dict[str, Any] = {}
        for product, cells in (("bb", bb_cells), ("omp", omp_cells)):
            cell = cells.get(key, {}) if isinstance(cells, dict) else {}
            candidate_data[product] = {
                "p95Ms": cell.get("p95Ms"),
                "maxMs": cell.get("maxMs"),
                "valid": cell.get("valid"),
                "invalid": cell.get("invalid"),
                "gates": {
                    "p95": _gate(cell.get("p95Ms"), p95_limit),
                    "max": _gate(cell.get("maxMs"), max_limit),
                    "invalidRate": "pass" if cell.get("invalidRate", 1.0) <= 0.10 else "UNKNOWN",
                    "blockInvalidOver10Percent": "UNKNOWN" if cell.get("blockInvalidOver10Percent") is None else ("fail" if cell.get("blockInvalidOver10Percent") else "pass"),
                },
            }
        bb_p95, omp_p95 = candidate_data["bb"]["p95Ms"], candidate_data["omp"]["p95Ms"]
        bb_max, omp_max = candidate_data["bb"]["maxMs"], candidate_data["omp"]["maxMs"]
        candidate_data["ratios"] = {
            "p95BbOverOmp": bb_p95 / omp_p95 if isinstance(bb_p95, (int, float)) and isinstance(omp_p95, (int, float)) and omp_p95 else None,
            "maxBbOverOmp": bb_max / omp_max if isinstance(bb_max, (int, float)) and isinstance(omp_max, (int, float)) and omp_max else None,
        }
        candidate_data["thresholds"] = {"p95Ms": p95_limit, "maxMs": max_limit}
        cell_output[key] = candidate_data

    startup: dict[str, Any] = {}
    for kind, p95_limit, max_limit in (("cold", 2500.0, 4000.0), ("warm", 1000.0, 2000.0)):
        bb_kind, omp_kind = bb_start.get(kind, {}), omp_start.get(kind, {})
        startup[kind] = {
            "bb": {"p95Ms": bb_kind.get("p95Ms"), "maxMs": bb_kind.get("maxMs"), "gates": {"p95": _gate(bb_kind.get("p95Ms"), p95_limit), "max": _gate(bb_kind.get("maxMs"), max_limit)}},
            "omp": {"p95Ms": omp_kind.get("p95Ms"), "maxMs": omp_kind.get("maxMs"), "gates": {"p95": _gate(omp_kind.get("p95Ms"), p95_limit), "max": _gate(omp_kind.get("maxMs"), max_limit)}},
            "p95BbOverOmp": (bb_kind.get("p95Ms") / omp_kind.get("p95Ms") if isinstance(bb_kind.get("p95Ms"), (int, float)) and isinstance(omp_kind.get("p95Ms"), (int, float)) and omp_kind.get("p95Ms") else None),
        }
    output = {
        "schemaVersion": RESULT_VERSION,
        "contract": "bb-2j1u.6",
        "cells": cell_output,
        "startup": startup,
        "resource": {"bb": _product_section(bb, "soak").get("maxRssKb"), "omp": _product_section(omp, "soak").get("maxRssKb")},
        "gates": {
            "localFeedback": {"everydayComplexP95Ms": 100, "adverseP95Ms": 150, "everydayComplexMaxMs": 250, "adverseMaxMs": 400},
            "startup": {"coldP95Ms": 2500, "coldMaxMs": 4000, "warmP95Ms": 1000, "warmMaxMs": 2000},
        },
    }
    write_json(out_path, output)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    fixtures = subparsers.add_parser("fixtures")
    fixtures.add_argument("--out", required=True, type=Path)

    startup = subparsers.add_parser("startup")
    startup.add_argument("--binary", required=True)
    startup.add_argument("--product", required=True, choices=("bb", "omp"))
    startup.add_argument("--roots", required=True)
    startup.add_argument("--cold", type=int, default=20)
    startup.add_argument("--warm-warmup", type=int, default=5)
    startup.add_argument("--warm", type=int, default=20)
    startup.add_argument("--rows", type=int, default=36)
    startup.add_argument("--cols", type=int, default=120)
    startup.add_argument("--out", required=True, type=Path)

    cells = subparsers.add_parser("cells")
    cells.add_argument("--binary", required=True)
    cells.add_argument("--product", required=True, choices=("bb", "omp"))
    cells.add_argument("--roots", required=True)
    cells.add_argument("--fixtures", required=True)
    cells.add_argument("--scales", default=",".join(SCALE_NAMES))
    cells.add_argument("--geometries", default="120x36,80x24")
    cells.add_argument("--actions", default=",".join(ACTION_NAMES))
    cells.add_argument("--warmup", type=int, default=5)
    cells.add_argument("--samples", type=int, default=60)
    cells.add_argument("--blocks", type=int, default=3)
    cells.add_argument("--rows", type=int, default=36)
    cells.add_argument("--cols", type=int, default=120)
    cells.add_argument("--out", required=True, type=Path)

    soak = subparsers.add_parser("soak")
    soak.add_argument("--binary", required=True)
    soak.add_argument("--product", required=True, choices=("bb", "omp"))
    soak.add_argument("--roots", required=True)
    soak.add_argument("--fixtures", required=True)
    soak.add_argument("--minutes", type=int, default=30)
    soak.add_argument("--out", required=True, type=Path)

    summarize = subparsers.add_parser("summarize")
    summarize.add_argument("--bb", required=True, type=Path)
    summarize.add_argument("--omp", required=True, type=Path)
    summarize.add_argument("--out", required=True, type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "fixtures":
            write_json(args.out / "manifest.json", generate_fixtures(args.out))
        elif args.command == "startup":
            _write_aggregate(args.out, "startup", run_startup(args))
        elif args.command == "cells":
            _write_aggregate(args.out, "cells", run_cells(args))
        elif args.command == "soak":
            _write_aggregate(args.out, "soak", run_soak(args))
        elif args.command == "summarize":
            summarize_results(args.bb, args.omp, args.out)
        else:
            raise ValueError(f"unknown command: {args.command}")
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as error:
        print(f"responsiveness-baseline: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
