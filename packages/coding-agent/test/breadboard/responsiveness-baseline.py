#!/usr/bin/env python3
"""Provider-free PTY responsiveness, startup, resource, and fixture harness.

The harness consumes the child's opt-in frame-timing OSC trailers.  Each
trailer carries the screen snapshot at the actual terminal write and the
source scheduler timestamp; parent read times remain diagnostics only.  It
imports ``installed-product-journey.py`` so the two harnesses share one
terminal parser and one isolated-root environment policy.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import math
import os
import random
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable

RUNNER_PATH = Path(__file__).with_name("installed-product-journey.py")
FIXTURE_VERSION = "bb.responsiveness-fixtures.v1"
RESULT_VERSION = "bb.responsiveness-baseline.v1"
READY_PREDICATE = "status/composer row containing mock/reference (or plain OMP no-model) and the composer glyph; fixture cells additionally require the welcome panel to be gone"
PAGE_UP = b"\x1b[5~"
PAGE_DOWN = b"\x1b[6~"
ESCAPE = b"\x1b"
TIMING_ENDPOINT = (
    "first exported frame trailer matching the unchanged screen predicate, "
    "nonce, input payload, and fresh inputId; latency uses mapped scheduler write "
    "time with uncertainty upper bound"
)
GEOMETRIES = ((120, 36), (80, 24))
ACTION_NAMES = ("key", "menu", "scroll", "submit", "cancel")


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
    endpoint = value.get("endpoint")
    if endpoint is not None:
        if existing.get("endpoint") not in (None, endpoint):
            raise RuntimeError(f"output already contains mixed timing endpoints: {path}")
        existing["endpoint"] = endpoint
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
        # Plain OMP checks for updates over the network at startup and inserts a
        # banner into the transcript; the BB product never does.  Disable it so
        # both baselines render the same idle layout without network access.
        (self.agent / "config.yml").write_text(
            "tools:\n  approvalMode: always-ask\nstartup:\n  checkUpdate: false\n", encoding="utf-8"
        )

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
    return runner.PtyChild(
        _argv(binary, fixture),
        roots.workspace,
        runner.timing_environment(roots.environment()),
        rows=rows,
        columns=columns,
    )


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
        runner.timing_environment(roots.environment()),
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
        # Binding is persisted when submission starts, before the engine cursor
        # reaches the mock turn's settled boundary. Wait for render quiet so the
        # fixture snapshots the durable cursor that resume will actually verify.
        _settle(child, quiet=0.5, limit=10.0)
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
        # The root path is a per-cell mkdtemp directory, so it never appears in
        # the harness's own argv (which carries only the roots base); matching
        # the whole command line catches engine children that name the root
        # only in an argument.
        if int(row["pid"]) in known or root_text in str(row["command"]):
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


def _cleanup_root_orphans(root: Path) -> dict[str, Any]:
    owned = _owned_processes(root, -1)
    term_pids: list[int] = []
    for row in owned:
        pid = int(row["pid"])
        if pid == os.getpid():
            continue
        try:
            os.kill(pid, signal.SIGTERM)
            term_pids.append(pid)
        except ProcessLookupError:
            pass
    deadline = time.monotonic() + 5.0
    survivors = owned
    while survivors and time.monotonic() < deadline:
        time.sleep(0.1)
        survivors = _owned_processes(root, -1)
    kill_pids: list[int] = []
    for row in survivors:
        pid = int(row["pid"])
        if pid == os.getpid():
            continue
        try:
            os.kill(pid, signal.SIGKILL)
            kill_pids.append(pid)
        except ProcessLookupError:
            pass
    time.sleep(0.05)
    final_owned = _owned_processes(root, -1)
    return {
        "rootProcessesBefore": owned,
        "rootProcessesAfter": final_owned,
        "sigtermPids": term_pids,
        "sigkillPids": kill_pids,
        "rootProcessesGone": not final_owned,
    }


def _screen_hash(child: Any) -> str:
    return hashlib.sha256(child.screen.text().encode("utf-8", "replace")).hexdigest()


def _drain_frame_events(child: Any) -> list[Any]:
    drain = getattr(child, "drain_frame_events", None)
    if drain is None:
        return []
    return list(drain())


def _select_frame_event(
    events: Iterable[Any],
    before: str,
    payload: bytes,
    pre_input_id: int | None,
    predicate: Callable[[str, str], bool],
) -> Any | None:
    expected_data = base64.b64encode(payload).decode("ascii")
    for event in events:
        metadata = event.metadata
        input_id = metadata["inputId"]
        if pre_input_id is None or input_id <= pre_input_id:
            continue
        if metadata["inputData"] != expected_data:
            continue
        if predicate(before, event.screen):
            return event
    return None


def _frame_clock_details(child: Any, event: Any, t0: float) -> dict[str, Any]:
    metadata = dict(event.metadata)
    input_at = metadata.get("inputAtMs")
    written_at = metadata["writtenAtMs"]
    source_delta = written_at - input_at if input_at is not None else None
    mapping = getattr(child, "clock_mapping", None)
    origin = metadata.get("monotonicOriginMs")
    uncertainty = metadata.get("clockUncertaintyMs")
    nominal_latency: float | None = None
    upper_latency: float | None = None
    mapping_status = "unknown"
    if mapping is not None and origin is not None and uncertainty is not None:
        parent_mach_at_t0 = t0 * 1000.0 + mapping.origin_ms
        source_mach_at_write = written_at + origin
        nominal_latency = source_mach_at_write - parent_mach_at_t0
        upper_latency = (
            source_mach_at_write
            + uncertainty
            - (parent_mach_at_t0 - mapping.uncertainty_ms)
        )
        valid_mapping = all(math.isfinite(value) for value in (nominal_latency, upper_latency)) and upper_latency >= 0
        if event.observed_at_monotonic is not None:
            latest_possible_observation = (
                event.observed_at_monotonic * 1000.0 + mapping.origin_ms + mapping.uncertainty_ms
            )
            valid_mapping = valid_mapping and source_mach_at_write - uncertainty <= latest_possible_observation
        if valid_mapping:
            mapping_status = "mapped"
        else:
            upper_latency = None
            mapping_status = "invalid"
    details = event.as_dict()
    details["mappingStatus"] = mapping_status
    details["latencyNominalMs"] = nominal_latency
    details["latencyUpperBoundMs"] = upper_latency
    details["inputToWriteMs"] = source_delta
    details["parentClockMapping"] = (
        {"originMs": mapping.origin_ms, "uncertaintyMs": mapping.uncertainty_ms, "source": mapping.source}
        if mapping is not None else None
    )
    return details


def _status_ready(screen: str) -> bool:
    lines = screen.splitlines()
    model_status = any(("mock/reference" in line or "no-model" in line) and ">" in line for line in lines)
    composer = any("╰─" in line for line in lines)
    return model_status and composer


def _cell_ready(screen: str) -> bool:
    # A resumed fixture renders its transcript; the welcome panel is the
    # pre-resume frame and must not satisfy cell readiness.
    return _status_ready(screen) and "Welcome!" not in screen


def _wait_ready(
    child: Any,
    timeout: float = 30.0,
    predicate: Callable[[str], bool] = _status_ready,
) -> tuple[bool, Any | None]:
    return _pump_until(child, predicate, timeout)


def _settle(child: Any, quiet: float = 0.15, limit: float = 1.5) -> bool:
    """Pump until no output arrives for `quiet` seconds so a measured stimulus
    cannot be credited with a frame that was already in flight."""
    deadline = time.monotonic() + limit
    last = child.output_reads
    quiet_since = time.monotonic()
    while time.monotonic() < deadline:
        child.pump(0.02)
        _drain_frame_events(child)
        if child.output_reads != last:
            last = child.output_reads
            quiet_since = time.monotonic()
        elif time.monotonic() - quiet_since >= quiet:
            return True
    return False


def _pump_until(
    child: Any,
    predicate: Callable[[str], bool],
    timeout: float,
) -> tuple[bool, Any | None]:
    deadline = time.monotonic() + timeout
    _drain_frame_events(child)
    while time.monotonic() < deadline:
        child.pump(min(0.005, max(0.0, deadline - time.monotonic())))
        events = _drain_frame_events(child)
        for event in events:
            if predicate(event.screen):
                return True, event
        if child.exit_status is not None:
            break
    return False, None

def _tail(screen: str, rows: int = 10) -> str:
    return "\n".join(screen.splitlines()[-rows:])


def _composer_line(screen: str) -> str:
    # Both products draw the compact editor as a `╰─ <text>` row; it is the
    # last such row on screen.  Transcript echoes of the same marker sit above.
    for line in reversed(screen.splitlines()):
        if line.lstrip().startswith("╰─"):
            return line
    return ""


def _composer_has(screen: str, marker: str) -> bool:
    return marker in _composer_line(screen)


def _measurement(
    child: Any,
    action: str,
    payload: bytes,
    predicate: Callable[[str, str], bool],
    timeout: float = 1.0,
    precondition: Callable[[str], bool] | None = None,
    settle: bool = True,
) -> dict[str, Any]:
    settled = _settle(child) if settle else False
    before = child.screen.text()
    recovered = _recover_overlay(child)
    if recovered:
        before = child.screen.text()
    if precondition is not None:
        if precondition(before):
            _reset_composer(child)
            _pump_until(child, lambda text: not precondition(text), 1.0)
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
                "screenTail": _tail(child.screen.text(), 6),
            }
        settled = (_settle(child) and settled) if settle else False
        before = child.screen.text()
    _drain_frame_events(child)
    reads_before = child.output_reads
    pre_input_id = getattr(child.screen, "latest_input_id", None)
    rejections_before = child.screen.frame_rejections
    t0 = time.monotonic()
    try:
        child.send(payload)
    except Exception as error:
        return {
            "action": action,
            "status": "UNKNOWN",
            "latencyMs": None,
            "reason": f"send-error:{error}",
            "t0Monotonic": t0,
            "inputIdBefore": pre_input_id,
            "alive": _process_alive(int(child.pid)),
            "exitCode": child.exit_status,
            "screenHash": _screen_hash(child),
        }
    deadline = t0 + timeout
    event: Any | None = None
    while time.monotonic() < deadline:
        child.pump(min(0.005, max(0.0, deadline - time.monotonic())))
        events = _drain_frame_events(child)
        event = _select_frame_event(events, before, payload, pre_input_id, predicate)
        if event is not None:
            break
        if child.exit_status is not None:
            break
    observed = event is not None
    timing_details = _frame_clock_details(child, event, t0) if event is not None else None
    mapped_latency = (
        timing_details["latencyUpperBoundMs"] if timing_details is not None else None
    )
    mapped = (
        timing_details is not None and timing_details["latencyUpperBoundMs"] is not None
    )
    rejections = {
        reason: count - rejections_before.get(reason, 0)
        for reason, count in child.screen.frame_rejections.items()
        if reason != "wrong_nonce" and count > rejections_before.get(reason, 0)
    }
    status = "valid" if observed and mapped and not rejections else "UNKNOWN"
    result: dict[str, Any] = {
        "action": action,
        "status": status,
        "latencyMs": mapped_latency,
        "t0Monotonic": t0,
        "settledBeforeSend": settled,
        "recoveredOverlay": recovered,
        "readsBefore": reads_before,
        "readsAfter": child.output_reads,
        "inputIdBefore": pre_input_id,
        "alive": _process_alive(int(child.pid)),
        "exitCode": child.exit_status,
        "screenHash": _screen_hash(child),
    }
    if timing_details is not None:
        result["frameTiming"] = timing_details
        result["parentObservedAtMonotonic"] = event.observed_at_monotonic
        result["inputIdAfter"] = event.metadata["inputId"]
        if not mapped:
            result["reason"] = "clock-mapping-unknown"
    elif not observed:
        result["reason"] = "timeout-or-exit"
        result["screenTail"] = _tail(child.screen.text(), 6)
    if rejections:
        result["reason"] = "invalid-frame-timing"
        result["frameRejections"] = rejections
        result["latencyMs"] = None
    return result


OVERLAY_FOOTER_TOKENS = ("enter rewind", "esc cancel")


def _overlay_visible(screen: str) -> bool:
    # The transcript rewind selector (double Escape on an empty composer) and
    # the session tree render a footer with these hints; the slash palette
    # does not. Any such overlay swallows composer input until dismissed.
    return all(token in screen for token in OVERLAY_FOOTER_TOKENS)


def _recover_overlay(child: Any) -> bool:
    """Dismiss a stray full-screen overlay with exactly one Escape and wait for
    it to leave; returns whether a recovery happened so the sample records it."""
    if not _overlay_visible(child.screen.text()):
        return False
    child.send(ESCAPE)
    _pump_until(child, lambda text: not _overlay_visible(text), 1.0)
    _settle(child, quiet=0.3)
    return True


def _reset_composer(child: Any) -> None:
    """Return to an empty composer without a blind Escape: Escape is only sent
    while the slash palette is open (the editor consumes it there); leftover
    composer text is removed with Backspace. Two bare Escapes on an empty
    composer within 500 ms open the rewind selector (input-controller.ts:455-475),
    so a blind Escape is never sent."""
    if _menu_residue(child.screen.text()):
        child.send(ESCAPE)
        _pump_until(child, lambda text: not _menu_residue(text), 1.0)
    for _ in range(3):
        line = _composer_line(child.screen.text())
        text = line.lstrip()[2:].strip() if line else ""
        if not text:
            break
        for _ in range(len(text)):
            child.send(BACKSPACE)
        _pump_until(child, lambda screen: not _composer_line(screen).lstrip()[2:].strip(), 1.0)
    child.pump(0.05)


def _reset_escape(child: Any) -> None:
    _reset_composer(child)

def _prepare_composer(child: Any, marker: str = "~") -> None:
    # A single printable character is the same input path as the key sample.
    # One recovery attempt dismisses a stray overlay and clears leftover
    # composer text before the setup is declared failed.
    for attempt in range(2):
        _recover_overlay(child)
        _reset_composer(child)
        _settle(child)
        child.send(marker.encode("ascii"))
        ok, _ = _pump_until(child, lambda text: _composer_has(text, marker), 1.0)
        if ok:
            return
        if attempt == 0:
            _settle(child, quiet=0.3)
    raise RuntimeError(f"composer did not accept setup marker {marker!r}: {_tail(child.screen.text(), 4)!r}")


def _menu_visible(before: str, after: str) -> bool:
    # editor.ts renders autocomplete below the editor; the select-list
    # renderer marks its active item with `❯`, while the composer row retains
    # the slash trigger.
    return after != before and "\n❯ " in after and "╰─ /" in after


def _menu_residue(screen: str) -> bool:
    return "\n❯ " in screen and "╰─ /" in screen


def _turn_in_flight(screen: str) -> bool:
    # An in-flight turn shows the working indicator with its Escape hint; a
    # provider-free rejection renders an error block instead and is not
    # cancellable, so `cancel` is only measurable where a turn actually runs.
    return any(token in screen for token in ("Working", "working", "[esc]"))


def _unknown(child: Any, action: str, reason: str) -> dict[str, Any]:
    return {
        "action": action,
        "status": "UNKNOWN",
        "latencyMs": None,
        "reason": reason,
        "alive": _process_alive(int(child.pid)),
        "exitCode": child.exit_status,
        "screenHash": _screen_hash(child),
    }


def _action_precondition(action: str, marker: str) -> Callable[[str], bool]:
    if action == "key":
        return lambda screen: _composer_has(screen, marker) or _menu_residue(screen)
    if action in {"menu", "scroll", "submit", "cancel"}:
        return _menu_residue
    raise ValueError(f"unknown action: {action}")


def _action_sample(child: Any, action: str, marker: str = "~") -> dict[str, Any]:
    precondition = _action_precondition(action, marker)
    if action == "key":
        result = _measurement(
            child,
            action,
            marker.encode("ascii"),
            lambda before, after: after != before and _composer_has(after, marker),
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
        # Both products leave transcript paging to the terminal's native
        # scrollback, so PageUp on the composer changes nothing.  The in-app
        # navigation stimulus is a page move inside the open slash palette.
        if _menu_residue(child.screen.text()):
            _reset_escape(child)
        _settle(child)
        child.send(b"/")
        opened, _ = _pump_until(child, _menu_residue, 1.0)
        if not opened:
            _reset_escape(child)
            return _unknown(child, action, "palette-not-visible")
        result = _measurement(
            child,
            action,
            PAGE_DOWN,
            lambda before, after: after != before and _menu_residue(after),
        )
        _reset_escape(child)
        return result
    if action == "submit":
        if _menu_residue(child.screen.text()):
            _reset_escape(child)
        _prepare_composer(child, marker)
        errors_before = _error_frames(child.screen.text())
        # Endpoint: the first frame reflecting the submit, i.e. the composer no
        # longer holds the marker (echo and feedback render from that frame).
        result = _measurement(
            child,
            action,
            ENTER,
            lambda old, after: after != old and not _composer_has(after, marker),
        )
        # The turn must then run to completion without an error frame: a turn
        # that ends in "Error:" is a product failure, not a responsiveness row.
        _pump_until(child, lambda text: not _turn_in_flight(text), 3.0)
        _settle(child, limit=3.0)
        _reset_escape(child)
        return _classify_turn_end(child, result, errors_before)
    if action == "cancel":
        if _menu_residue(child.screen.text()):
            _reset_escape(child)
        if "no-model" in child.screen.text():
            # Without a provider-free model nothing streams: a submit is
            # rejected with an error frame that would masquerade as cancel
            # feedback.  Plain OMP has no mock catalog, so cancel is unavailable.
            return _unknown(child, action, "no-provider-free-model")
        _prepare_composer(child, marker)
        errors_before = _error_frames(child.screen.text())
        child.send(ENTER)
        in_flight, _ = _pump_until(child, _turn_in_flight, 1.0)
        if not in_flight:
            _settle(child, limit=3.0)
            _reset_escape(child)
            return _classify_turn_end(child, _unknown(child, action, "no-turn-in-flight"), errors_before)
        # No settle here: the working indicator animates, and the turn may end
        # on its own; Escape must land while the indicator is still on screen.
        if not _turn_in_flight(child.screen.text()):
            _settle(child, limit=3.0)
            _reset_escape(child)
            return _classify_turn_end(child, _unknown(child, action, "turn-finished-before-cancel"), errors_before)
        result = _measurement(
            child,
            action,
            ESCAPE,
            lambda before, after: after != before and not _turn_in_flight(after),
            settle=False,
        )
        # The measured Escape already cleared the turn. A cancelled pending
        # submission restores its text to the composer; remove it with
        # Backspace only, never a second Escape (double-Escape window). A
        # user-interrupt renders no label; an "Error:" frame means the turn
        # failed on its own and the Escape measured the failure, not the cancel.
        _settle(child, limit=3.0)
        _reset_composer(child)
        return _classify_turn_end(child, result, errors_before)
    raise ValueError(f"unknown action: {action}")


ERROR_FRAME_RE = re.compile(r"\bError: ")
TURN_ERROR_REASON = "turn-ended-with-error"
MAX_SESSION_ROTATIONS = 16


def _prune_root_extractions(root: Path) -> None:
    # The native addon is re-extracted into every fresh config root (~160 MB);
    # it is reproducible from the product, not evidence, so retired roots drop it.
    shutil.rmtree(root / "config" / "natives", ignore_errors=True)


# Plain OMP without a model answers a submit with this frame. It is the expected
# provider-free completion of the turn, not a product failure: the row keeps its
# first-frame latency and the session is not rotated. The exclusion is gated on
# the rendered status row, never on the words appearing somewhere on screen: the
# identical frame from a product running a model, and `⬢ no-model >` quoted in
# transcript text, still count.
PROVIDER_FREE_REJECTION_RE = re.compile(r"\bError: No model selected\.")
# The rendered plain-OMP status row is ` π  > ⬢ no-model > 📁 <workspace> > …`;
# the anchor is the row's leading product glyph and separator, so a transcript
# line that merely starts with `⬢ no-model >` is not a status row.
PROVIDER_FREE_STATUS_ROW_RE = re.compile(r"^\s*π\s+>\s+⬢ no-model >")


def _has_provider_free_status_row(screen: str) -> bool:
    return any(PROVIDER_FREE_STATUS_ROW_RE.search(line) for line in screen.splitlines())


def _error_frames(screen: str) -> int:
    count = len(ERROR_FRAME_RE.findall(screen))
    if _has_provider_free_status_row(screen):
        count -= len(PROVIDER_FREE_REJECTION_RE.findall(screen))
    return count


def _classify_turn_end(child: Any, result: dict[str, Any], errors_before: int) -> dict[str, Any]:
    """A submit or cancel row counts only when its turn ended without an error
    frame. New "Error:" text is a product failure recorded verbatim; the row is
    invalid and the caller rotates the session."""
    screen = child.screen.text()
    if _error_frames(screen) <= errors_before:
        return result
    lines = [line.strip() for line in screen.splitlines() if ERROR_FRAME_RE.search(line)]
    failed = dict(result)
    if failed.get("latencyMs") is not None:
        failed["measuredMs"] = failed["latencyMs"]
    failed["latencyMs"] = None
    failed["status"] = "UNKNOWN"
    failed["reason"] = TURN_ERROR_REASON
    failed["turnError"] = lines[-1][:200] if lines else None
    failed["screenTail"] = _tail(screen, 6)
    return failed


def _summary(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"p50Ms": None, "p95Ms": None, "maxMs": None}
    ordered = sorted(values)
    p50 = ordered[max(1, math.ceil(0.50 * len(ordered))) - 1]
    p95 = ordered[max(1, math.ceil(0.95 * len(ordered))) - 1]
    return {"p50Ms": p50, "p95Ms": p95, "maxMs": ordered[-1]}


def _cell_summary(samples: list[dict[str, Any]], blocks: int) -> dict[str, Any]:
    valid = [float(row["latencyMs"]) for row in samples if row.get("status") == "valid" and row.get("latencyMs") is not None]
    block_rows: list[dict[str, Any]] = []
    for block in range(1, blocks + 1):
        block_samples = [row for row in samples if row.get("block") == block]
        block_values = [float(row["latencyMs"]) for row in block_samples if row.get("status") == "valid" and row.get("latencyMs") is not None]
        block_rows.append({"block": block, "sampleCount": len(block_samples), "valid": len(block_values), "invalid": len(block_samples) - len(block_values), **_summary(block_values)})
    overall = _summary(valid)
    overall_p50 = overall["p50Ms"]
    block_medians_within = None
    if isinstance(overall_p50, (int, float)) and overall_p50 > 0 and all(isinstance(row["p50Ms"], (int, float)) for row in block_rows):
        block_medians_within = all(abs(float(row["p50Ms"]) - overall_p50) <= 0.20 * overall_p50 for row in block_rows)
    return {
        "samples": samples,
        "sampleCount": len(samples),
        "valid": len(valid),
        "invalid": len(samples) - len(valid),
        "invalidRate": (len(samples) - len(valid)) / len(samples) if samples else 1.0,
        "timeouts": sum(1 for row in samples if row.get("reason") == "timeout-or-exit"),
        "invalidReasons": sorted({str(row.get("reason")) for row in samples if row.get("status") != "valid"}),
        **overall,
        "blocks": block_rows,
        "blockInvalidOver10Percent": any(row["invalid"] > row["sampleCount"] * 0.10 for row in block_rows if row["sampleCount"]),
        "blockMinValid": min((row["valid"] for row in block_rows), default=0),
        "blockMediansWithin20Percent": block_medians_within,
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
        row: dict[str, Any] = {
            "kind": kind,
            "index": index,
            "root": str(roots.base),
            "rows": args.rows,
            "cols": args.cols,
        }
        try:
            child = _start_child(binary, roots, args.rows, args.cols, None)
            descendants = _process_descendants(int(child.pid))
            ready, endpoint = _wait_ready(child)
            timing_details = (
                _frame_clock_details(child, endpoint, start)
                if isinstance(endpoint, runner.FrameTimingEvent)
                else None
            )
            latency = (
                timing_details["latencyUpperBoundMs"]
                if timing_details is not None
                else None
            )
            row.update(
                {
                    "ready": ready,
                    "latencyMs": latency,
                    "exitCode": child.exit_status,
                    "parentObservedAtMonotonic": (
                        endpoint.observed_at_monotonic
                        if isinstance(endpoint, runner.FrameTimingEvent)
                        else None
                    ),
                    "screenHash": _screen_hash(child),
                }
            )
            if timing_details is not None:
                row["readyFrameTiming"] = timing_details
                if latency is None:
                    row["reason"] = "clock-mapping-unknown"
            elif not ready:
                row["reason"] = "usable-composer-timeout-or-exit"
            row["descendantCountAtLaunch"] = len(descendants)
        except Exception as error:
            row.update(
                {
                    "ready": False,
                    "latencyMs": None,
                    "reason": f"launch-error:{error}",
                    "exitCode": child.exit_status if child else None,
                }
            )
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
        "endpoint": TIMING_ENDPOINT,
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
            label = f"cell-{scale}-{columns}x{rows}"
            root = _new_root_set(roots_base, args.product, label)
            child: Any | None = None
            descendants: list[dict[str, Any]] = []
            active_fixture = fixture
            cell: dict[str, Any] = {
                "scale": scale,
                "geometry": f"{columns}x{rows}",
                "fixture": str(fixture),
                "actions": {},
                "sessionFailures": [],
                "rotations": [],
            }

            def open_child(
                current_root: RootSet,
            ) -> tuple[Any, list[dict[str, Any]], Path, bool, Any | None]:
                bound = fixture
                if args.product == "bb":
                    bound = _prepare_bb_cell_fixture(
                        binary, current_root, rows, columns, fixture
                    )
                started = _start_child(binary, current_root, rows, columns, bound)
                started_descendants = _process_descendants(int(started.pid))
                ready, ready_at = _wait_ready(started, 60.0, _cell_ready)
                return started, started_descendants, bound, ready, ready_at

            try:
                child, descendants, active_fixture, ready, ready_at = open_child(root)
                cell["fixture"] = str(active_fixture)
                cell["ready"] = ready
                cell["readyFrameTiming"] = (
                    ready_at.as_dict()
                    if isinstance(ready_at, runner.FrameTimingEvent)
                    else None
                )
                cell["readyObservedAtMonotonic"] = (
                    ready_at.observed_at_monotonic
                    if isinstance(ready_at, runner.FrameTimingEvent)
                    else None
                )
                cell["initialScreenHash"] = _screen_hash(child)
                cell["initialScreenText"] = child.screen.text()
                if not ready:
                    for action in actions:
                        cell["actions"][action] = {"warmups": [], "samples": [], "error": "usable-composer-timeout-or-exit"}
                else:
                    per_block = args.samples // args.blocks
                    order_seed = int(hashlib.sha256(f"{args.product}/{cell_key}".encode("utf-8")).hexdigest()[:8], 16)
                    rng = random.Random(order_seed)
                    cell["orderSeed"] = order_seed
                    samples: dict[str, list[dict[str, Any]]] = {action: [] for action in actions}

                    def take(action: str, **tags: Any) -> dict[str, Any]:
                        # A turn that ends in an error frame is a product failure: the
                        # row is recorded invalid, the failure is logged with the
                        # session's age, and the cell continues in a fresh bound session
                        # so later rows measure a live product, not a dead stream.
                        nonlocal child, descendants, root, active_fixture
                        row = {**tags, **_action_sample(child, action)}
                        if row.get("reason") != TURN_ERROR_REASON:
                            return row
                        cell["sessionFailures"].append(
                            {
                                **tags,
                                "action": action,
                                "turnError": row.get("turnError"),
                                "sessionRoot": str(root.base),
                                "sessionRows": sum(len(rows_) for rows_ in samples.values()),
                                "at": time.time(),
                            }
                        )
                        if len(cell["rotations"]) >= MAX_SESSION_ROTATIONS:
                            raise RuntimeError(f"session failures exceeded {MAX_SESSION_ROTATIONS} rotations: {row.get('turnError')}")
                        cell["rotations"].append(_cleanup_receipt(child, descendants, root.base))
                        _prune_root_extractions(root.base)
                        root = _new_root_set(roots_base, args.product, f"{label}-r{len(cell['rotations'])}")
                        child, descendants, active_fixture, rotated_ready, rotated_ready_at = open_child(root)
                        cell["rotations"][-1]["replacementRoot"] = str(root.base)
                        cell["rotations"][-1]["replacementReady"] = rotated_ready
                        cell["rotations"][-1]["replacementReadyFrameTiming"] = (
                            rotated_ready_at.as_dict()
                            if isinstance(rotated_ready_at, runner.FrameTimingEvent)
                            else None
                        )
                        cell["rotations"][-1]["replacementReadyObservedAtMonotonic"] = (
                            rotated_ready_at.observed_at_monotonic
                            if isinstance(rotated_ready_at, runner.FrameTimingEvent)
                            else None
                        )
                        if not rotated_ready:
                            raise RuntimeError("replacement session never reached a usable composer")
                        return row

                    warmups = {action: [take(action, warmup=True) for _ in range(args.warmup)] for action in actions}
                    # Contract: 60 valid rows per cell in three blocks of 20; every
                    # attempt is retained and invalid attempts are counted against the
                    # 10% invalid-rate rule. An invalid attempt is retried inside its
                    # block (bounded) unless the action is structurally unavailable.
                    retry_cap = per_block + max(4, per_block // 2)
                    for block in range(1, args.blocks + 1):
                        order = [action for action in actions for _ in range(per_block)]
                        rng.shuffle(order)
                        for action in order:
                            samples[action].append(take(action, block=block))
                        while True:
                            deficits = [
                                action
                                for action in actions
                                if sum(
                                    1
                                    for row in samples[action]
                                    if row["block"] == block and row.get("status") == "valid"
                                ) < per_block
                                and sum(1 for row in samples[action] if row["block"] == block)
                                < retry_cap
                                and not any(
                                    str(row.get("reason", "")).startswith("no-provider")
                                    for row in samples[action]
                                    if row["block"] == block
                                )
                            ]
                            if not deficits:
                                break
                            rng.shuffle(deficits)
                            for action in deficits:
                                samples[action].append(take(action, block=block, retry=True))
                    for action in actions:
                        cell["actions"][action] = {"warmups": warmups[action], **_cell_summary(samples[action], args.blocks)}
            except Exception as error:
                cell["ready"] = False
                cell["error"] = str(error)
            finally:
                if child is not None:
                    cell["cleanup"] = _cleanup_receipt(child, descendants, root.base)
                elif args.product == "bb":
                    cell["cleanup"] = _cleanup_root_orphans(root.base)
                _prune_root_extractions(root.base)
            cells[cell_key] = cell
    return {
        "product": args.product,
        "binary": str(binary),
        "fixtures": str(fixtures_base),
        "scales": scales,
        "warmup": args.warmup,
        "samples": args.samples,
        "blocks": args.blocks,
        "endpoint": TIMING_ENDPOINT,
        "cells": cells,
    }


def _cputime_seconds(value: str) -> float | None:
    """Parse the `ps -o time=` accumulated CPU field: `[[dd-]hh:]mm:ss.cc`."""
    text = value.strip()
    days = 0
    if "-" in text:
        day_text, text = text.split("-", 1)
        if not day_text.isdigit():
            return None
        days = int(day_text)
    try:
        numbers = [float(part) for part in text.split(":")]
    except ValueError:
        return None
    if not 1 <= len(numbers) <= 3:
        return None
    while len(numbers) < 3:
        numbers.insert(0, 0.0)
    hours, minutes, seconds = numbers
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def _resource_sample(pids: list[int]) -> dict[str, Any]:
    """One `/bin/ps` call for every owned pid: RSS plus cumulative CPU seconds."""
    command = ["/bin/ps", "-o", "pid=,ppid=,rss=,time=", "-p", ",".join(str(pid) for pid in pids)]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=10, check=False)
    rows: list[dict[str, Any]] = []
    total_rss = 0
    for line in completed.stdout.splitlines():
        fields = line.split()
        if len(fields) != 4 or not fields[0].isdigit() or not fields[1].isdigit() or not fields[2].isdigit():
            continue
        rows.append({"pid": int(fields[0]), "ppid": int(fields[1]), "rssKb": int(fields[2]), "cpuSeconds": _cputime_seconds(fields[3])})
        total_rss += int(fields[2])
    return {"rows": rows, "totalRssKb": total_rss, "exitCode": completed.returncode}


class _LibProcProbe:
    """In-process macOS `libproc` reader: `proc_pid_rusage(RUSAGE_INFO_V2)`
    for cumulative CPU and resident size, `proc_listchildpids` for descendants.
    Microseconds per sample instead of a `/bin/ps` fork, which is what keeps
    the observer under the contract's 1% overhead. CPU units are calibrated
    against `resource.getrusage` for this process before use."""

    RUSAGE_INFO_V2 = 2

    def __init__(self) -> None:
        import ctypes

        self._ctypes = ctypes
        self._lib = ctypes.CDLL("/usr/lib/libproc.dylib")
        self._lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        self._lib.proc_pid_rusage.restype = ctypes.c_int
        self._lib.proc_listchildpids.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
        self._lib.proc_listchildpids.restype = ctypes.c_int
        system = ctypes.CDLL("/usr/lib/libSystem.B.dylib")

        class Timebase(ctypes.Structure):
            _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]

        timebase = Timebase()
        system.mach_timebase_info(ctypes.byref(timebase))
        self._seconds_per_tick = (timebase.numer / timebase.denom) / 1e9
        self._buffer = ctypes.create_string_buffer(512)
        self.calibration = self._calibrate()

    def _calibrate(self) -> dict[str, Any]:
        import resource

        row = self.read(os.getpid())
        usage = resource.getrusage(resource.RUSAGE_SELF)
        truth = usage.ru_utime + usage.ru_stime
        probe = row["cpuSeconds"] if row else None
        ratio = (probe / truth) if probe is not None and truth > 0 else None
        if ratio is None or not 0.9 <= ratio <= 1.1:
            raise RuntimeError(f"libproc CPU calibration failed: probe={probe} rusage={truth} ratio={ratio}")
        return {"probeCpuSeconds": probe, "rusageCpuSeconds": truth, "ratio": ratio, "secondsPerTick": self._seconds_per_tick}

    def read(self, pid: int) -> dict[str, Any] | None:
        ctypes = self._ctypes
        ctypes.memset(self._buffer, 0, 512)
        if self._lib.proc_pid_rusage(pid, self.RUSAGE_INFO_V2, self._buffer) != 0:
            return None
        raw = self._buffer.raw
        user = int.from_bytes(raw[16:24], "little")
        system = int.from_bytes(raw[24:32], "little")
        resident = int.from_bytes(raw[64:72], "little")
        return {"pid": pid, "cpuSeconds": (user + system) * self._seconds_per_tick, "rssKb": resident // 1024}

    def children(self, pid: int) -> list[int]:
        ctypes = self._ctypes
        size = 4096 * ctypes.sizeof(ctypes.c_int)
        buffer = (ctypes.c_int * 4096)()
        count = self._lib.proc_listchildpids(pid, buffer, size)
        return [int(buffer[index]) for index in range(max(0, count)) if buffer[index] > 0]

    def descendants(self, root_pid: int) -> list[int]:
        found: list[int] = []
        frontier = [root_pid]
        while frontier:
            parent = frontier.pop()
            for child in self.children(parent):
                if child not in found and child != root_pid:
                    found.append(child)
                    frontier.append(child)
        return found

    def sample(self, pids: list[int]) -> dict[str, Any]:
        rows = [row for row in (self.read(pid) for pid in pids) if row is not None]
        return {"rows": rows, "totalRssKb": sum(int(row["rssKb"]) for row in rows), "exitCode": 0}


class _ResourceObserver:
    """Samples the root process and its descendants once per second on a
    background thread so a blocking action sample cannot open a gap. Interval
    CPU is the delta of cumulative CPU seconds over the actual wall interval,
    summed over pids present in both samples; a pid that exits between samples
    drops its last partial interval. Descendants are rediscovered every 5 s.
    Backend: calibrated libproc when available, otherwise `/bin/ps`."""

    def __init__(self, root_pid: int, started: float, phase_of: Callable[[float], str]) -> None:
        self.root_pid = root_pid
        self.started = started
        self.phase_of = phase_of
        self.samples: list[dict[str, Any]] = []
        self.observer_seconds = 0.0
        self.descendants: list[dict[str, Any]] = []
        self.backend = "ps"
        self.calibration: dict[str, Any] | None = None
        self.backend_error: str | None = None
        self._probe: _LibProcProbe | None = None
        try:
            self._probe = _LibProcProbe()
            self.backend = "libproc"
            self.calibration = self._probe.calibration
        except (OSError, AttributeError, RuntimeError) as error:
            self.backend_error = str(error)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="resource-observer", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread.join(timeout=15.0)

    def _discover(self) -> list[int]:
        if self._probe is not None:
            pids = self._probe.descendants(self.root_pid)
            self.descendants = [{"pid": pid} for pid in pids]
        else:
            self.descendants = _process_descendants(self.root_pid)
        return [self.root_pid] + [int(row["pid"]) for row in self.descendants]

    def _sample(self, pids: list[int]) -> dict[str, Any]:
        if self._probe is not None:
            return self._probe.sample(pids)
        return _resource_sample(pids)

    def _run(self) -> None:
        previous: dict[int, float] = {}
        previous_at: float | None = None
        next_sample = time.monotonic()
        next_discovery = next_sample
        pids = [self.root_pid]
        while not self._stop.is_set():
            now = time.monotonic()
            if now >= next_discovery:
                pids = self._discover()
                self.observer_seconds += time.monotonic() - now
                next_discovery = now + 5.0
            sampled_at = time.monotonic()
            sample = self._sample(pids)
            after = time.monotonic()
            self.observer_seconds += after - sampled_at
            current = {int(row["pid"]): float(row["cpuSeconds"]) for row in sample["rows"] if row.get("cpuSeconds") is not None}
            cpu_percent: float | None = None
            if previous_at is not None and sampled_at > previous_at:
                shared = [pid for pid in current if pid in previous]
                cpu_percent = sum(current[pid] - previous[pid] for pid in shared) / (sampled_at - previous_at) * 100.0
            self.samples.append({
                "elapsedSeconds": sampled_at - self.started,
                "intervalSeconds": (sampled_at - previous_at) if previous_at is not None else None,
                "phase": self.phase_of(sampled_at - self.started),
                "cpuPercent": cpu_percent,
                "totalRssKb": sample["totalRssKb"],
                "processCount": len(sample["rows"]),
                "descendantCount": len(self.descendants),
                "rows": sample["rows"],
            })
            previous, previous_at = current, sampled_at
            next_sample += 1.0
            if next_sample < after:
                next_sample = after
            self._stop.wait(max(0.0, next_sample - time.monotonic()))


def _median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2.0


def _minute_rows(samples: list[dict[str, Any]], duration: float, phase_of: Callable[[float], str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for minute in range(int(math.ceil(duration / 60.0))):
        window = [row for row in samples if minute * 60.0 <= float(row["elapsedSeconds"]) < (minute + 1) * 60.0]
        cpu = [float(row["cpuPercent"]) for row in window if row.get("cpuPercent") is not None]
        rss = [float(row["totalRssKb"]) for row in window if row.get("totalRssKb") is not None]
        rows.append({
            "minute": minute + 1,
            "phase": phase_of(minute * 60.0),
            "sampleCount": len(window),
            "cpuMedianPercent": _median(cpu),
            "rssMedianKb": _median(rss),
            "maxIntervalSeconds": max((float(row["intervalSeconds"]) for row in window if row.get("intervalSeconds") is not None), default=None),
        })
    return rows


def run_soak(args: argparse.Namespace) -> dict[str, Any]:
    """Contract bb-2j1u.6 resource run: warmup, active mix and idle tail split
    1/6, 4/6, 1/6 of `--minutes` (5/20/5 at the default 30), one action per
    second across the five local action classes during warmup and active, no
    input during the idle tail, one resource sample per second."""
    if args.minutes <= 0:
        raise ValueError("minutes must be positive")
    binary = Path(args.binary).resolve()
    root = _new_root_set(Path(args.roots).resolve(), args.product, "soak")
    fixture = _fixture_session(Path(args.fixtures).resolve(), "adverse")
    active_fixture = fixture
    duration = args.minutes * 60.0
    warmup_end = duration / 6.0
    active_end = duration * 5.0 / 6.0

    def phase_of(elapsed: float) -> str:
        if elapsed < warmup_end:
            return "warmup"
        if elapsed < active_end:
            return "active"
        return "idle"

    descendants: list[dict[str, Any]] = []
    started = time.monotonic()
    actions: list[dict[str, Any]] = []
    ready = False
    cleanup: dict[str, Any] | None = None
    child: Any | None = None
    observer: _ResourceObserver | None = None
    error: str | None = None
    try:
        if args.product == "bb":
            active_fixture = _prepare_bb_cell_fixture(binary, root, 36, 120, fixture)
        child = _start_child(binary, root, 36, 120, active_fixture)
        observer = _ResourceObserver(int(child.pid), started, phase_of)
        observer.start()
        descendants = _process_descendants(int(child.pid))
        ready, _ = _wait_ready(child, 60.0, _cell_ready)
        if not ready:
            actions.append({"action": "ready", "status": "UNKNOWN", "reason": "usable-composer-timeout-or-exit"})
        else:
            next_action = time.monotonic()
            action_index = 0
            while time.monotonic() - started < duration and child.exit_status is None:
                now = time.monotonic()
                phase = phase_of(now - started)
                if phase != "idle" and now >= next_action:
                    action_name = ACTION_NAMES[action_index % len(ACTION_NAMES)]
                    actions.append({"phase": phase, "elapsedSeconds": now - started, **_action_sample(child, action_name)})
                    action_index += 1
                    next_action = max(next_action + 1.0, time.monotonic())
                child.pump(0.005)
                time.sleep(0.01)
    except Exception as failure:
        error = str(failure)
    finally:
        if observer is not None:
            observer.stop()
        if child is not None:
            cleanup = _cleanup_receipt(child, descendants, root.base)
        elif args.product == "bb":
            cleanup = _cleanup_root_orphans(root.base)
    finished = time.monotonic()
    samples = observer.samples if observer is not None else []
    minute_rows = _minute_rows(samples, duration, phase_of)
    rss_values = [int(row["totalRssKb"]) for row in samples if row.get("totalRssKb") is not None]
    intervals = [float(row["intervalSeconds"]) for row in samples if row.get("intervalSeconds") is not None]
    return {
        "product": args.product,
        "binary": str(binary),
        "endpoint": TIMING_ENDPOINT,
        "fixture": str(active_fixture),
        "ready": ready,
        "error": error,
        "durationSeconds": finished - started,
        "plannedSeconds": duration,
        "phases": {"warmupEndSeconds": warmup_end, "activeEndSeconds": active_end, "idleEndSeconds": duration},
        "workload": "adverse fixture; key/edit, menu, scroll, submit, cancel round-robin at one action per second",
        "actions": actions,
        "actionCount": len(actions),
        "actionInvalid": sum(1 for row in actions if row.get("status") != "valid"),
        "resources": samples,
        "minutes": minute_rows,
        "sampleCount": len(samples),
        "maxIntervalSeconds": max(intervals, default=None),
        "gapsOver2Seconds": sum(1 for value in intervals if value > 2.0),
        "observerSeconds": observer.observer_seconds if observer is not None else None,
        "observerOverheadRatio": (observer.observer_seconds / (finished - started)) if observer is not None and finished > started else None,
        "observerBackend": observer.backend if observer is not None else None,
        "observerCalibration": observer.calibration if observer is not None else None,
        "observerBackendError": observer.backend_error if observer is not None else None,
        "startRssKb": rss_values[0] if rss_values else None,
        "endRssKb": rss_values[-1] if rss_values else None,
        "maxRssKb": max(rss_values) if rss_values else None,
        "descendantCountStart": len(descendants),
        "descendantCountEnd": samples[-1]["descendantCount"] if samples else None,
        "exitCode": child.exit_status if child is not None else None,
        "cleanup": cleanup,
    }


def _read_result(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"result must be a JSON object: {path}")
    return value


def _require_timing_endpoint(data: dict[str, Any], label: str) -> None:
    endpoint = data.get("endpoint")
    if endpoint != TIMING_ENDPOINT:
        raise ValueError(
            f"{label} does not use the exported-frame timing endpoint; "
            "legacy PTY read timestamps cannot be compared"
        )
    for key in ("cells", "startup", "soak"):
        section = data.get(key)
        if isinstance(section, dict) and "product" in section and section.get("endpoint") != TIMING_ENDPOINT:
            raise ValueError(f"{label} {key} section uses a different timing endpoint")


def _product_section(data: dict[str, Any], key: str) -> dict[str, Any]:
    section = data.get(key)
    if isinstance(section, dict):
        return section
    return data


RELATIVE_LIMIT = 1.5


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _gate(value: Any, threshold: float) -> str:
    if not _is_number(value):
        return "UNKNOWN"
    return "pass" if float(value) <= threshold else "fail"


def _ratio(numerator: Any, denominator: Any) -> float | None:
    if _is_number(numerator) and _is_number(denominator) and float(denominator) > 0:
        return float(numerator) / float(denominator)
    return None


def _combine(gates: Iterable[str]) -> str:
    values = list(gates)
    if any(value == "fail" for value in values):
        return "fail"
    if any(value != "pass" for value in values):
        return "UNKNOWN"
    return "pass"


def _cell_validity(action: dict[str, Any], samples_required: int, block_min_valid: int) -> dict[str, Any]:
    """Contract bb-2j1u.6: a timing cell counts only with the full valid row
    count, at least 18 valid rows per block, block medians within 20% of the
    overall median, no more than 10% invalid rows and no unresolved timeout."""
    reasons: list[str] = []
    if action.get("error"):
        reasons.append(f"cell-error:{action['error']}")
    if action.get("valid") != samples_required:
        reasons.append(f"valid-rows:{action.get('valid')}/{samples_required}")
    if (action.get("blockMinValid") or 0) < block_min_valid:
        reasons.append(f"block-min-valid:{action.get('blockMinValid')}<{block_min_valid}")
    if action.get("blockMediansWithin20Percent") is not True:
        reasons.append("block-medians-outside-20-percent")
    if action.get("invalidRate", 1.0) > 0.10:
        reasons.append(f"invalid-rate:{action.get('invalidRate')}")
    # A timeout is unresolved only when its block never reached the valid target;
    # retried-and-satisfied timeouts still count against the invalid rate above.
    if action.get("timeouts") and (action.get("blockMinValid") or 0) < block_min_valid:
        reasons.append(f"unresolved-timeouts:{action.get('timeouts')}")
    unavailable = [reason for reason in action.get("invalidReasons", []) if str(reason).startswith("no-")]
    return {"status": "pass" if not reasons else "UNKNOWN", "reasons": reasons, "unavailable": unavailable}


def _runs_over(values: list[float | None], threshold: float, consecutive: int) -> bool:
    run = 0
    for value in values:
        run = run + 1 if _is_number(value) and float(value) > threshold else 0
        if run >= consecutive:
            return True
    return False


def _slope_per_minute(points: list[tuple[float, float]]) -> float | None:
    if len(points) < 2:
        return None
    n = float(len(points))
    mean_x = sum(x for x, _ in points) / n
    mean_y = sum(y for _, y in points) / n
    denominator = sum((x - mean_x) ** 2 for x, _ in points)
    if denominator == 0:
        return None
    return sum((x - mean_x) * (y - mean_y) for x, y in points) / denominator


def _resource_gates(soak: dict[str, Any]) -> dict[str, Any]:
    """Contract bb-2j1u.6 resource gates on one soak result. Idle tail mean
    CPU <=15% of one core with no >100% interval lasting more than five
    samples; active p95 <=200% with no >300% interval lasting ten samples;
    combined RSS <=2 GiB in the final minute, max minute median minus
    minute-5 median <=256 MiB, active RSS slope <=4 MiB/minute; every owned
    process gone after cleanup; observer overhead <1% of wall time; any
    sample gap over two seconds is UNKNOWN."""
    samples = soak.get("resources") or []
    minutes = soak.get("minutes") or []
    if not samples or not minutes:
        return {"status": "UNKNOWN", "reasons": ["no-resource-samples"]}
    idle_cpu = [row.get("cpuPercent") for row in samples if row.get("phase") == "idle"]
    active_cpu = [row.get("cpuPercent") for row in samples if row.get("phase") == "active"]
    idle_values = [float(value) for value in idle_cpu if _is_number(value)]
    active_values = sorted(float(value) for value in active_cpu if _is_number(value))
    idle_mean = sum(idle_values) / len(idle_values) if idle_values else None
    active_p95 = active_values[max(1, math.ceil(0.95 * len(active_values))) - 1] if active_values else None
    rss_medians = [(int(row["minute"]), float(row["rssMedianKb"])) for row in minutes if _is_number(row.get("rssMedianKb"))]
    by_minute = dict(rss_medians)
    final_minute = max(by_minute) if by_minute else None
    final_rss = by_minute.get(final_minute) if final_minute is not None else None
    minute5 = by_minute.get(5)
    growth_kb = (max(by_minute.values()) - minute5) if by_minute and minute5 is not None else None
    active_points = [(float(minute), rss / 1024.0) for minute, rss in rss_medians if any(row["minute"] == minute and row["phase"] == "active" for row in minutes)]
    slope = _slope_per_minute(active_points)
    cleanup = soak.get("cleanup") or {}
    gates = {
        "idleMeanCpu": _gate(idle_mean, 15.0),
        "idleNoSpikeRun": "UNKNOWN" if not idle_values else ("fail" if _runs_over(idle_cpu, 100.0, 6) else "pass"),
        "activeP95Cpu": _gate(active_p95, 200.0),
        "activeNoSpikeRun": "UNKNOWN" if not active_values else ("fail" if _runs_over(active_cpu, 300.0, 10) else "pass"),
        "finalRss": _gate(final_rss, 2.0 * 1024 * 1024),
        "rssGrowth": _gate(growth_kb, 256.0 * 1024),
        "activeRssSlope": _gate(slope, 4.0),
        "cleanup": "UNKNOWN" if not cleanup else ("pass" if cleanup.get("gone") or cleanup.get("rootProcessesGone") else "fail"),
        "observerOverhead": _gate(soak.get("observerOverheadRatio"), 0.01),
        "sampleGaps": "UNKNOWN" if soak.get("gapsOver2Seconds") is None else ("pass" if soak.get("gapsOver2Seconds") == 0 else "UNKNOWN"),
        "completed": "pass" if soak.get("ready") and not soak.get("error") and soak.get("exitCode") in (None, 0) and float(soak.get("durationSeconds") or 0) >= float(soak.get("plannedSeconds") or 1) else "UNKNOWN",
    }
    return {
        "status": _combine(gates.values()),
        "gates": gates,
        "idleMeanCpuPercent": idle_mean,
        "activeP95CpuPercent": active_p95,
        "finalMinuteRssKb": final_rss,
        "minute5RssKb": minute5,
        "rssGrowthKb": growth_kb,
        "activeRssSlopeMiBPerMinute": slope,
        "sampleCount": len(samples),
        "maxIntervalSeconds": soak.get("maxIntervalSeconds"),
        "observerOverheadRatio": soak.get("observerOverheadRatio"),
        "actionCount": soak.get("actionCount"),
        "actionInvalid": soak.get("actionInvalid"),
    }


def _startup_class(rows: dict[str, Any]) -> dict[str, Any]:
    launches = rows.get("launches") or []
    invalid = sum(1 for row in launches if not row.get("ready") or row.get("latencyMs") is None)
    cleanup_failures = sum(1 for row in launches if row.get("cleanup") and not row["cleanup"].get("gone"))
    return {
        "requested": rows.get("requested"),
        "launches": len(launches),
        "invalid": invalid,
        "cleanupFailures": cleanup_failures,
        "p50Ms": rows.get("p50Ms"),
        "p95Ms": rows.get("p95Ms"),
        "maxMs": rows.get("maxMs"),
        "validity": "pass" if launches and invalid <= 2 and cleanup_failures == 0 else "UNKNOWN",
    }


def summarize_results(bb_path: Path, omp_path: Path, out_path: Path) -> None:
    """Gate the BB candidate against the plain-OMP baseline per the bb-2j1u.6
    resolution: per cell BB p95 <= 1.5x OMP p95 and BB max <= 1.5x OMP max,
    BB startup p95 <= 1.5x OMP startup p95, absolute backstops (BB p95 <= 250
    ms everyday/complex, <= 400 ms adverse; startup cold p95 <= 2,500 ms / max
    example cancel without a provider-free model) keeps its absolute gates and
    reports the relative gate UNKNOWN with the reason."""
    bb = _read_result(bb_path)
    omp = _read_result(omp_path)
    _require_timing_endpoint(bb, "BB result")
    _require_timing_endpoint(omp, "OMP result")
    if bb.get("endpoint") != omp.get("endpoint"):
        raise ValueError("BB and OMP results use mixed timing endpoints")
    bb_cells_section = _product_section(bb, "cells")
    omp_cells_section = _product_section(omp, "cells")
    bb_cells = bb_cells_section.get("cells", {}) if isinstance(bb_cells_section, dict) else {}
    omp_cells = omp_cells_section.get("cells", {}) if isinstance(omp_cells_section, dict) else {}
    samples_required = int(bb_cells_section.get("samples") or 60)
    block_min_valid = 18 if samples_required == 60 else max(1, math.ceil(samples_required * 0.30))
    cell_output: dict[str, Any] = {}
    cell_statuses: list[str] = []
    for key in sorted(set(bb_cells) | set(omp_cells)):
        scale = key.split("/", 1)[0]
        backstop_p95 = 400.0 if scale == "adverse" else 250.0
        bb_cell = bb_cells.get(key, {}) if isinstance(bb_cells, dict) else {}
        omp_cell = omp_cells.get(key, {}) if isinstance(omp_cells, dict) else {}
        actions_output: dict[str, Any] = {}
        for action in ACTION_NAMES:
            bb_action = (bb_cell.get("actions") or {}).get(action, {})
            omp_action = (omp_cell.get("actions") or {}).get(action, {})
            bb_validity = _cell_validity(bb_action, samples_required, block_min_valid)
            omp_validity = _cell_validity(omp_action, samples_required, block_min_valid)
            p95_ratio = _ratio(bb_action.get("p95Ms"), omp_action.get("p95Ms"))
            max_ratio = _ratio(bb_action.get("maxMs"), omp_action.get("maxMs"))
            relative_p95 = _gate(p95_ratio, RELATIVE_LIMIT) if omp_validity["status"] == "pass" else "UNKNOWN"
            relative_max = _gate(max_ratio, RELATIVE_LIMIT) if omp_validity["status"] == "pass" else "UNKNOWN"
            gates = {
                "bbValidity": bb_validity["status"],
                "ompValidity": omp_validity["status"],
                "relativeP95": relative_p95,
                "relativeMax": relative_max,
                "absoluteP95": _gate(bb_action.get("p95Ms"), backstop_p95) if bb_validity["status"] == "pass" else "UNKNOWN",
            }
            status = _combine(gates.values())
            row = {
                "bb": {"p50Ms": bb_action.get("p50Ms"), "p95Ms": bb_action.get("p95Ms"), "maxMs": bb_action.get("maxMs"), "valid": bb_action.get("valid"), "invalid": bb_action.get("invalid"), "validity": bb_validity},
                "omp": {"p50Ms": omp_action.get("p50Ms"), "p95Ms": omp_action.get("p95Ms"), "maxMs": omp_action.get("maxMs"), "valid": omp_action.get("valid"), "invalid": omp_action.get("invalid"), "validity": omp_validity},
                "ratios": {"p95BbOverOmp": p95_ratio, "maxBbOverOmp": max_ratio},
                "thresholds": {"relative": RELATIVE_LIMIT, "bbP95BackstopMs": backstop_p95},
                "gates": gates,
                "status": status,
            }
            if omp_validity["unavailable"] and omp_validity["status"] != "pass":
                row["note"] = f"omp-baseline-unavailable:{','.join(omp_validity['unavailable'])}"
            actions_output[action] = row
            cell_statuses.append(status)
        bb_session_failures = len(bb_cell.get("sessionFailures") or [])
        bb_rotations = len(bb_cell.get("rotations") or [])
        # A cell whose BB session died mid-sample (turn ended in an error frame,
        # fresh-session rotation) cannot be accepted on its timing numbers alone:
        # the retained valid rows describe the surviving sessions, not the
        # product. Per review-escalation-1 the cell is UNKNOWN for acceptance
        # and the failures route to repair; the numbers stay as description.
        session_integrity = "UNKNOWN" if bb_session_failures or bb_rotations else "pass"
        cell_output[key] = {
            "bbReady": bb_cell.get("ready"),
            "ompReady": omp_cell.get("ready"),
            "bbCleanup": (bb_cell.get("cleanup") or {}).get("gone", (bb_cell.get("cleanup") or {}).get("rootProcessesGone")),
            "ompCleanup": (omp_cell.get("cleanup") or {}).get("gone", (omp_cell.get("cleanup") or {}).get("rootProcessesGone")),
            "bbSessionFailures": bb_session_failures,
            "ompSessionFailures": len(omp_cell.get("sessionFailures") or []),
            "bbRotations": bb_rotations,
            "ompRotations": len(omp_cell.get("rotations") or []),
            "gates": {"bbSessionIntegrity": session_integrity},
            "actions": actions_output,
            "status": _combine([session_integrity, *(row["status"] for row in actions_output.values())]),
        }

    bb_start = _product_section(bb, "startup")
    omp_start = _product_section(omp, "startup")
    startup: dict[str, Any] = {}
    for kind, p95_limit, max_limit in (("cold", 2500.0, 4000.0), ("warm", 1000.0, 2000.0)):
        bb_kind = _startup_class(bb_start.get(kind, {}) if isinstance(bb_start, dict) else {})
        omp_kind = _startup_class(omp_start.get(kind, {}) if isinstance(omp_start, dict) else {})
        ratio = _ratio(bb_kind["p95Ms"], omp_kind["p95Ms"])
        gates = {
            "bbValidity": bb_kind["validity"],
            "ompValidity": omp_kind["validity"],
            "relativeP95": _gate(ratio, RELATIVE_LIMIT) if omp_kind["validity"] == "pass" else "UNKNOWN",
            "absoluteP95": _gate(bb_kind["p95Ms"], p95_limit) if bb_kind["validity"] == "pass" else "UNKNOWN",
            "absoluteMax": _gate(bb_kind["maxMs"], max_limit) if bb_kind["validity"] == "pass" else "UNKNOWN",
        }
        startup[kind] = {
            "bb": bb_kind,
            "omp": omp_kind,
            "p95BbOverOmp": ratio,
            "thresholds": {"relative": RELATIVE_LIMIT, "bbP95Ms": p95_limit, "bbMaxMs": max_limit},
            "gates": gates,
            "status": _combine(gates.values()),
        }

    bb_soak = _product_section(bb, "soak")
    omp_soak = _product_section(omp, "soak")
    resource = {
        "bb": _resource_gates(bb_soak if isinstance(bb_soak, dict) and bb_soak is not bb else {}),
        "omp": _resource_gates(omp_soak if isinstance(omp_soak, dict) and omp_soak is not omp else {}),
    }
    overall = _combine([*(cell["status"] for cell in cell_output.values()), *(row["status"] for row in startup.values()), resource["bb"]["status"]])
    output = {
        "schemaVersion": RESULT_VERSION,
        "contract": "bb-2j1u.6 (exported frame-written scheduler endpoint, mapped to Darwin Mach absolute time; relative-to-OMP gates)",
        "inputs": {"bb": str(bb_path), "omp": str(omp_path)},
        "samplesRequired": samples_required,
        "blockMinValid": block_min_valid,
        "cells": cell_output,
        "startup": startup,
        "resource": resource,
        "counts": {
            # Action rows (timing gates only) and cells (timing plus session
            # integrity). Acceptance reads `status`, never these counts.
            "cellActions": len(cell_statuses),
            "pass": cell_statuses.count("pass"),
            "fail": cell_statuses.count("fail"),
            "unknown": cell_statuses.count("UNKNOWN"),
            "cells": {
                "total": len(cell_output),
                "pass": sum(1 for cell in cell_output.values() if cell["status"] == "pass"),
                "fail": sum(1 for cell in cell_output.values() if cell["status"] == "fail"),
                "unknown": sum(1 for cell in cell_output.values() if cell["status"] == "UNKNOWN"),
            },
        },
        "status": overall,
        "gates": {
            "relative": {"cellP95": RELATIVE_LIMIT, "cellMax": RELATIVE_LIMIT, "startupP95": RELATIVE_LIMIT},
            "backstop": {"everydayComplexP95Ms": 250, "adverseP95Ms": 400},
            "startup": {"coldP95Ms": 2500, "coldMaxMs": 4000, "warmP95Ms": 1000, "warmMaxMs": 2000},
            "resource": {"idleMeanCpuPercent": 15, "activeP95CpuPercent": 200, "finalRssGiB": 2, "growthMiB": 256, "activeSlopeMiBPerMinute": 4},
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
            result = run_cells(args)
            _write_aggregate(args.out, "cells", result)
            incomplete = sorted(key for key, cell in result["cells"].items() if cell.get("error") or not cell.get("ready"))
            if incomplete:
                # Data is written; the cells are UNKNOWN for acceptance. Exit 3
                # so a schedule driver cannot mistake this for a clean step.
                print(f"responsiveness-baseline: incomplete cells: {', '.join(incomplete)}", file=sys.stderr)
                return 3
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
