#!/usr/bin/env python3
"""Provider-free cancellation/recovery observations through the installed BB PTY."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

LOCK_MODULE = Path(
    "/Users/kylemccleary/projects/breadboard-tui-excellence-artifacts/runs/20260908T202438Z_01a01244/tooling/installed_candidate_lock.py"
)

DEFAULT_ENDPOINT = "http://127.0.0.1:9099"
SYNTHETIC_PROMPT = "Create and validate the deterministic bubble sort fixture."


def load_runner(path: Path):
    spec = importlib.util.spec_from_file_location("installed_product_journey", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load journey runner: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load_lock(path: Path):
    spec = importlib.util.spec_from_file_location("installed_candidate_lock", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load installed candidate lock: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def mkdir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.chmod(0o700)


def request_json(endpoint: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(
        endpoint.rstrip("/") + path,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            value = json.loads(response.read().decode())
            return {"status": response.status, "body": value}
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors="replace")
        try:
            decoded: Any = json.loads(body)
        except json.JSONDecodeError:
            decoded = body
        return {"status": error.code, "body": decoded}
    except Exception as error:  # evidence records infrastructure failures as UNKNOWN
        return {"status": None, "error": f"{type(error).__name__}: {error}"}


def stream_events(endpoint: str, session_id: str) -> dict[str, Any]:
    path = f"/v1/internal/sessions/{urllib.parse.quote(session_id, safe='')}/events?replay=true&limit=1000"
    request = urllib.request.Request(endpoint.rstrip("/") + path, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            raw = response.read().decode(errors="replace")
        events: list[dict[str, Any]] = []
        for row in raw.split("\n\n"):
            payload = "\n".join(line[5:] for line in row.splitlines() if line.startswith("data:"))
            if not payload:
                continue
            try:
                value = json.loads(payload)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
        return {"status": 200, "eventCount": len(events), "events": events}
    except urllib.error.HTTPError as error:
        return {"status": error.code, "body": error.read().decode(errors="replace")}
    except Exception as error:
        return {"status": None, "error": f"{type(error).__name__}: {error}"}


def roots_for(base: Path, row: str) -> dict[str, Path]:
    root = base / "roots" / row
    mkdir(root)
    roots = {name: root / name for name in ("home", "config", "agent", "workspace", "temp")}
    for path in roots.values():
        mkdir(path)
    return roots


def listener_pids(runner: Any, endpoint: str) -> tuple[list[int], dict[str, Any]]:
    receipt = runner.listener_snapshot(endpoint)
    stdout = receipt.get("stdout", "")
    pids: list[int] = []
    for line in stdout.splitlines()[1:]:
        fields = line.split()
        if len(fields) >= 2 and fields[1].isdigit():
            pid = int(fields[1])
            if pid not in pids:
                pids.append(pid)
    return pids, receipt


def write_orphan_snapshot(
    runner: Any, raw_root: Path, endpoint: str, pid: int, reason: str
) -> None:
    listener = runner.listener_snapshot(endpoint)
    process = runner.process_snapshot(pid)
    lsof = listener.get("stdout", "")
    lsof_error = listener.get("stderr", "")
    ps = process.get("ps", {})
    ps_stdout = ps.get("stdout", "") if isinstance(ps, dict) else ""
    ps_stderr = ps.get("stderr", "") if isinstance(ps, dict) else ""
    text = (
        f"reason: {reason}\n\n"
        f"lsof:\n{lsof}"
        f"{'' if lsof.endswith(chr(10)) else chr(10)}"
        f"{lsof_error}"
        f"\nps:\n{ps_stdout}"
        f"{'' if ps_stdout.endswith(chr(10)) else chr(10)}"
        f"{ps_stderr}"
    )
    (raw_root / f"orphan-engine-{pid}.txt").write_text(text, encoding="utf-8")


def terminate_pid(pid: int) -> None:
    try:
        os.kill(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    time.sleep(0.2)
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def cleanup_leaked_endpoint(lock_mod: Any, runner: Any, raw_root: Path, endpoint: str, label: str) -> None:
    with lock_mod.installed_candidate_launch(label, require_endpoint_closed=False):
        pids, _ = listener_pids(runner, endpoint)
        for pid in pids:
            write_orphan_snapshot(runner, raw_root, endpoint, pid, "engine listener remained before launch")
            terminate_pid(pid)
        lock_mod.wait_endpoint_closed(deadline_seconds=5)


def wait_engine_exit(
    runner: Any, endpoint: str, engine_pid: int | None, timeout: float = 5
) -> dict[str, Any]:
    started = time.monotonic()
    deadline = started + timeout
    if engine_pid is None:
        return {"observed": False, "seconds": None}
    while time.monotonic() < deadline:
        if not runner.process_alive(engine_pid) and not runner.endpoint_open(endpoint):
            return {"observed": True, "seconds": round(time.monotonic() - started, 3)}
        time.sleep(0.05)
    if not runner.process_alive(engine_pid) and not runner.endpoint_open(endpoint):
        return {"observed": True, "seconds": round(time.monotonic() - started, 3)}
    return {"observed": False, "seconds": None}

def launch(runner: Any, bb: Path, roots: dict[str, Path], rows: int, cols: int):
    (roots["agent"] / "config.yml").write_text("tools:\n  approvalMode: always-ask\n", encoding="utf-8")
    env = runner.exact_environment(roots["home"], roots["config"], roots["agent"], roots["temp"])
    runner.create_browser_launch_guard(roots["temp"], env)
    child = runner.PtyChild(
        [str(bb), "--model", "cli_mock/reference"],
        roots["workspace"],
        env,
        rows=rows,
        columns=cols,
    )
    child.wait_until(
        lambda: "mock/reference" in child.screen.text() and "No LSP servers" in child.screen.text(),
        60,
        "TUI readiness",
    )
    authority = child.wait_until(lambda: runner.active_authority(roots["agent"]), 60, "engine authority")
    return child, authority[1], env


def wait_binding(runner: Any, roots: dict[str, Path], child: Any, timeout: float = 20):
    return child.wait_until(lambda: runner.binding_snapshot(roots["agent"]), timeout, "session binding")


def durable(runner: Any, roots: dict[str, Path], endpoint: str | None) -> dict[str, Any]:
    binding = runner.binding_snapshot(roots["agent"])
    state = runner.retained_state_snapshot(roots["agent"])
    session_id = None if binding is None else binding.data.get("sessionId")
    active = runner.active_authority(roots["agent"])
    result: dict[str, Any] = {
        "binding": None if binding is None else binding.data,
        "retainedState": None if state is None else state[1],
        "authority": None if active is None else {"path": str(active[0]), "data": active[1]},
    }
    if endpoint and isinstance(session_id, str):
        result["session"] = request_json(endpoint, f"/v1/internal/sessions/{urllib.parse.quote(session_id, safe='')}")
        result["records"] = request_json(endpoint, f"/v1/internal/sessions/{urllib.parse.quote(session_id, safe='')}/records?limit=1000")
        result["events"] = stream_events(endpoint, session_id)
    return result


def capture(runner: Any, output: Path, name: str, child: Any, roots: dict[str, Path], endpoint: str | None) -> dict[str, Any]:
    runner.write_capture(output, name, child)
    value = durable(runner, roots, endpoint)
    (output / f"{name}.durable.json").write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return value


def end_child(
    runner: Any,
    raw_root: Path,
    child: Any,
    descendants: list[dict[str, Any]],
    endpoint: str,
    engine_pid: int | None,
) -> dict[str, Any]:
    tui_exit_code: int | None = child.exit_status
    try:
        child.send_line("/exit")
        tui_exit_code = child.wait_for_exit(20)
    except Exception:
        try:
            os.kill(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    engine_exited = wait_engine_exit(runner, endpoint, engine_pid, timeout=5)
    listener_pids_after, _ = listener_pids(runner, endpoint)
    leaked_pids = list(listener_pids_after)
    if not engine_exited["observed"]:
        if engine_pid is not None and runner.process_alive(engine_pid) and engine_pid not in leaked_pids:
            leaked_pids.append(engine_pid)
        for pid in leaked_pids:
            write_orphan_snapshot(runner, raw_root, endpoint, pid, "engine listener remained after teardown")
            terminate_pid(pid)
    for row in reversed(descendants):
        try:
            os.kill(int(row["pid"]), signal.SIGTERM)
        except (KeyError, ProcessLookupError, PermissionError):
            pass
    time.sleep(0.2)
    for row in reversed(descendants):
        try:
            os.kill(int(row["pid"]), signal.SIGKILL)
        except (KeyError, ProcessLookupError, PermissionError):
            pass
    child.close()
    endpoint_closed = not runner.endpoint_open(endpoint)
    return {
        "tuiExitCode": tui_exit_code,
        "engineExited": engine_exited,
        "engineCleanupForced": bool(leaked_pids),
        "endpointClosed": endpoint_closed,
    }

def finalize_teardown(record: dict[str, Any], engine_exit_within_deadline: bool, endpoint_closed: bool) -> None:
    record["teardownAssertion"] = {
        "engineExitWithin5Seconds": engine_exit_within_deadline,
        "endpointClosed": endpoint_closed,
        "pass": engine_exit_within_deadline and endpoint_closed,
    }
    if not record["teardownAssertion"]["pass"]:
        record["verdict"] = "fail"
        record["reason"] = (
            f"{record.get('reason', '')}; engine teardown did not satisfy "
            "exit <= 5s and closed endpoint"
        ).lstrip("; ")
    else:
        record["verdict"] = record.get("actionResult", "UNKNOWN")


def observation(
    runner: Any,
    lock_mod: Any,
    base: Path,
    bb: Path,
    row: str,
    action: Any,
    rows: int,
    cols: int,
) -> dict[str, Any]:
    roots = roots_for(base, row)
    output = base / "captures" / row
    mkdir(output)
    child = None
    engine_pid: int | None = None
    endpoint = DEFAULT_ENDPOINT
    started = time.monotonic()
    record: dict[str, Any] = {
        "id": row,
        "startedAt": started,
        "matrix": None,
        "verdict": "UNKNOWN",
        "actionResult": "UNKNOWN",
        "teardownAssertion": None,
        "captures": str(output),
        "lockWaitSeconds": None,
        "enginePid": None,
        "engineExited": {"observed": False, "seconds": None},
        "tuiExitCode": None,
    }

    def run_locked(held: Any) -> None:
        nonlocal child, engine_pid, endpoint
        record["lockWaitSeconds"] = round(held.waited_seconds, 3)
        try:
            child, authority, _ = launch(runner, bb, roots, rows, cols)
            endpoint = str(authority["normalizedEndpoint"])
            listeners, listener_receipt = listener_pids(runner, endpoint)
            (output / "listener-after-start.json").write_text(
                json.dumps(listener_receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8"
            )
            if not listeners:
                raise RuntimeError("engine authority has no listener on the default endpoint")
            engine_pid = listeners[0]
            record["enginePid"] = engine_pid
            record["engineEndpoint"] = endpoint
            result = action(runner, child, roots, output, endpoint, authority)
            record.update(result)
            record["actionResult"] = result.get("verdict", "UNKNOWN")
            record["verdict"] = record["actionResult"]
        except Exception as error:
            record.update({"verdict": "UNKNOWN", "reason": f"{type(error).__name__}: {error}"})
            if child is not None:
                capture(runner, output, "exception", child, roots, None)
        finally:
            if child is not None:
                descendants = runner.process_descendants(child.pid)
                record["processBeforeClose"] = descendants
                record.update(end_child(runner, base, child, descendants, endpoint, engine_pid))
                engine_exit = record.get("engineExited")
                engine_exit_within_deadline = (
                    isinstance(engine_exit, dict)
                    and engine_exit.get("observed") is True
                    and isinstance(engine_exit.get("seconds"), (int, float))
                    and engine_exit["seconds"] <= 5
                )
                endpoint_closed = record.get("endpointClosed") is True
                finalize_teardown(record, engine_exit_within_deadline, endpoint_closed)

    try:
        try:
            with lock_mod.installed_candidate_launch(label=f"E3 {row}") as held:
                run_locked(held)
        except RuntimeError:
            if lock_mod.endpoint_closed():
                raise
            cleanup_leaked_endpoint(lock_mod, runner, base, DEFAULT_ENDPOINT, f"E3 cleanup before {row}")
            with lock_mod.installed_candidate_launch(label=f"E3 {row}") as held:
                run_locked(held)
    except Exception as error:
        record.update({"verdict": "UNKNOWN", "reason": f"{type(error).__name__}: {error}"})
    finally:
        record["rootsAfterClose"] = {
            name: sorted(str(path) for path in path.glob("**/*") if path.exists())
            for name, path in roots.items()
        }
        record["elapsedSeconds"] = round(time.monotonic() - started, 3)
        (output / "observation.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return record


def f04a(runner: Any, child: Any, roots: dict[str, Path], output: Path, endpoint: str, authority: dict[str, Any]) -> dict[str, Any]:
    child.send_line("Stream a long deterministic response and keep streaming.")
    child.pump(0.2)
    capture(runner, output, "before-escape", child, roots, endpoint)
    child.send_escape()
    runner.wait_for_terminal_state(child, roots["agent"], 1, 30, "cancelled stream turn", "cancelled")
    value = capture(runner, output, "after-escape", child, roots, endpoint)
    text = child.screen.text()
    state = value.get("retainedState") or {}
    turns = state.get("turns", []) if isinstance(state, dict) else []
    terminal = turns[-1].get("terminal_outcome") if turns and isinstance(turns[-1], dict) else None
    return {"matrix": "F04a", "visible": text, "durable": value, "resource": runner.process_descendants(child.pid), "verdict": "pass" if terminal == "cancelled" and "turn completed" not in text.lower() else "fail"}


def immediate_submit(runner: Any, child: Any, roots: dict[str, Path], output: Path, endpoint: str, authority: dict[str, Any]) -> dict[str, Any]:
    child.send_line("Start a deterministic response, then keep working.")
    child.pump(0.04)
    child.send_escape()
    child.pump(0.02)
    child.send_line("Continue immediately with a new deterministic response.")
    child.pump(1.0)
    value = capture(runner, output, "immediate-submit", child, roots, endpoint)
    text = child.screen.text()
    bad = "previous submission cancellation is still resolving" in text.lower()
    return {"matrix": "Cancel immediate submit", "visible": text, "durable": value, "resource": runner.process_descendants(child.pid), "verdict": "fail" if bad else "pass", "fault": bad}


def f02a(runner: Any, child: Any, roots: dict[str, Path], output: Path, endpoint: str, authority: dict[str, Any]) -> dict[str, Any]:
    prompt = "Run a deterministic active operation."
    child.send_line(prompt)
    binding = child.wait_until(
        lambda: (
            snapshot
            if (snapshot := runner.binding_snapshot(roots["agent"])) is not None
            and isinstance(snapshot.data.get("ownedSubmissions"), list)
            and snapshot.data["ownedSubmissions"]
            else None
        ),
        30,
        "active submission admission",
    )
    first_submission = binding.data["ownedSubmissions"][0]
    child.send_escape()
    child.pump(0.1)
    if child.permission_dialog_ready():
        child.send_escape()
    runner.wait_for_terminal_state(child, roots["agent"], 1, 30, "cancelled first turn", "cancelled")
    child.send_line(prompt)
    second_binding = child.wait_until(
        lambda: (
            snapshot
            if (snapshot := runner.binding_snapshot(roots["agent"])) is not None
            and isinstance(snapshot.data.get("ownedSubmissions"), list)
            and any(
                item.get("clientMessageId") != first_submission.get("clientMessageId")
                for item in snapshot.data["ownedSubmissions"]
                if isinstance(item, dict)
            )
            else None
        ),
        30,
        "second active submission admission",
    )
    second_submission = next(
        item
        for item in second_binding.data["ownedSubmissions"]
        if isinstance(item, dict) and item.get("clientMessageId") != first_submission.get("clientMessageId")
    )
    second_terminal, approvals = runner.wait_for_terminal_state_with_permissions(
        child,
        roots["agent"],
        2,
        30,
        "completed second turn",
        "completed",
    )
    child.pump(1.0)
    value = capture(runner, output, "second-response", child, roots, endpoint)
    text = child.screen.text()
    completed_turns = [
        turn
        for turn in second_terminal[1].get("turns", [])
        if isinstance(turn, dict) and turn.get("terminal_resolution_committed") is True
    ]
    second_turn = completed_turns[-1]
    screen_has_response = text.count(prompt) >= 2 and "previous submission cancellation is still resolving" not in text.lower()
    return {
        "matrix": "F02a",
        "firstSubmission": first_submission,
        "secondSubmission": second_submission,
        "secondTurn": second_turn,
        "approvals": approvals,
        "visible": text,
        "durable": value,
        "resource": runner.process_descendants(child.pid),
        "screenHasResponse": screen_has_response,
        "verdict": "pass"
        if second_submission.get("clientMessageId") != first_submission.get("clientMessageId")
        and second_submission.get("turnId") != first_submission.get("turnId")
        and second_turn.get("terminal_outcome") == "completed"
        and screen_has_response
        else "fail",
    }


def permission_request(runner: Any, child: Any, roots: dict[str, Path], output: Path, endpoint: str, authority: dict[str, Any], cancel: bool) -> dict[str, Any]:
    child.send_typed_line(SYNTHETIC_PROMPT)
    request_id = child.wait_until(lambda: child.permission_dialog_ready(), 30, "permission dialog")
    before = capture(runner, output, "permission-before", child, roots, endpoint)
    session_id = (before.get("binding") or {}).get("sessionId")
    stale = request_json(endpoint, f"/v1/internal/sessions/{session_id}/command", {"command": "respond_permission", "payload": {"requestId": "stale-permission-id", "decision": "allow"}})
    if cancel:
        child.send_escape()
        runner.wait_for_terminal_state(
            child,
            roots["agent"],
            1,
            30,
            "cancelled permission turn",
            "cancelled",
        )
        capture(runner, output, "permission-cancelled", child, roots, endpoint)
        late = request_json(endpoint, f"/v1/internal/sessions/{session_id}/command", {"command": "respond_permission", "payload": {"requestId": request_id, "decision": "allow"}})
        after = capture(runner, output, "late-approval", child, roots, endpoint)
        return {"matrix": "F06a", "requestId": request_id, "staleResponse": stale, "lateResponse": late, "visible": child.screen.text(), "durable": after, "resource": runner.process_descendants(child.pid), "verdict": "pass" if late.get("status") in (400, 409) else "fail"}
    after = capture(runner, output, "stale-approval", child, roots, endpoint)
    return {"matrix": "F03a", "requestId": request_id, "staleResponse": stale, "visible": child.screen.text(), "durable": after, "resource": runner.process_descendants(child.pid), "verdict": "pass" if stale.get("status") in (400, 409) else "fail"}


def f10a(runner: Any, child: Any, roots: dict[str, Path], output: Path, endpoint: str, authority: dict[str, Any]) -> dict[str, Any]:
    child.send_typed_line(SYNTHETIC_PROMPT)
    request_id = child.wait_until(lambda: child.permission_dialog_ready(), 30, "restart permission action")
    binding = child.wait_until(
        lambda: (
            snapshot
            if (snapshot := runner.binding_snapshot(roots["agent"])) is not None
            and isinstance(snapshot.data.get("ownedSubmissions"), list)
            and snapshot.data["ownedSubmissions"]
            else None
        ),
        30,
        "restart turn admission",
    )
    os.kill(int(authority["pid"]), signal.SIGKILL)
    child.pump(1.0)
    capture(runner, output, "engine-killed", child, roots, endpoint)
    child.send_line("Submit after engine replacement.")
    child.pump(2.0)
    value = capture(runner, output, "post-replacement-submit", child, roots, endpoint)
    return {"matrix": "F10a", "requestId": request_id, "actionReached": bool(binding.data["ownedSubmissions"]), "visible": child.screen.text(), "durable": value, "resource": runner.process_descendants(child.pid), "verdict": "UNKNOWN", "reason": "forced engine kill is escalation evidence; classify only with replacement authority receipt"}

def owned_engine_exit_after_turn(
    runner: Any, child: Any, roots: dict[str, Path], output: Path, endpoint: str, authority: dict[str, Any]
) -> dict[str, Any]:
    child.send_line("Produce one deterministic completed response.")
    child.wait_until(
        lambda: any(
            isinstance(turn, dict) and turn.get("terminal_outcome") in ("completed", "failed", "cancelled")
            for turn in (durable(runner, roots, endpoint).get("retainedState") or {}).get("turns", [])
        ),
        30,
        "completed turn",
    )
    value = capture(runner, output, "after-turn", child, roots, endpoint)
    return {
        "matrix": "owned-engine-exit-after-turn",
        "visible": child.screen.text(),
        "durable": value,
        "resource": runner.process_descendants(child.pid),
        "verdict": "UNKNOWN",
        "requiresEngineExit": True,
    }


def f15_repro(runner: Any, child: Any, roots: dict[str, Path], output: Path, endpoint: str, authority: dict[str, Any]) -> dict[str, Any]:
    target = 8
    seen_client_message_ids: set[str] = set()
    rows_reached = 0
    for index in range(target):
        child.send_line(f"Rotation {index}: deterministic cancellation probe.")
        binding = child.wait_until(
            lambda: (
                snapshot
                if (snapshot := runner.binding_snapshot(roots["agent"])) is not None
                and any(
                    isinstance(item, dict) and item.get("clientMessageId") not in seen_client_message_ids
                    for item in snapshot.data.get("ownedSubmissions", [])
                )
                else None
            ),
            30,
            f"rotation {index} admission",
        )
        submission = next(
            item
            for item in binding.data["ownedSubmissions"]
            if isinstance(item, dict) and item.get("clientMessageId") not in seen_client_message_ids
        )
        client_message_id = str(submission["clientMessageId"])
        seen_client_message_ids.add(client_message_id)
        rows_reached += 1
        child.send_escape()
        child.pump(0.1)
        if child.permission_dialog_ready():
            child.send_escape()
        runner.wait_for_terminal_state(child, roots["agent"], index + 1, 30, f"rotation {index} cancellation", "cancelled")
    value = capture(runner, output, "replay-rotation", child, roots, endpoint)
    text = child.screen.text()
    frame = "replay began mid-tool without the retained tool call" in text.lower()
    return {
        "matrix": "bb-ewnk.15 reproduction",
        "rowsTarget": target,
        "rowsReached": rows_reached,
        "actionReached": rows_reached > 0,
        "visible": text,
        "durable": value,
        "resource": runner.process_descendants(child.pid),
        "framesSeen": ["replay began mid-tool without the retained tool call"] if frame else [],
        "verdict": "fail" if frame else "UNKNOWN",
        "reason": "ranked sink replay fault reproduced" if frame else "no replay frame observed",
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bb", type=Path, required=True)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--lock", type=Path, default=LOCK_MODULE)
    parser.add_argument("--base", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rows", type=int, default=36)
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--only", action="append", choices=("F02a", "F03a", "F04a", "F10a", "bb-ewnk.15", "owned-engine-exit-after-turn"))
    args = parser.parse_args()
    mkdir(args.base)
    mkdir(args.output)
    runner = load_runner(args.runner)
    lock_mod = load_lock(args.lock)
    actions = [
        ("F04a", f04a),
        ("cancel-immediate-submit", immediate_submit),
        ("F02a", f02a),
        ("F03a", lambda *x: permission_request(*x, cancel=False)),
        ("F06a", lambda *x: permission_request(*x, cancel=True)),
        ("F10a", f10a),
        ("bb-ewnk.15", f15_repro),
        ("owned-engine-exit-after-turn", owned_engine_exit_after_turn),
    ]
    if args.only is not None:
        actions = [item for item in actions if item[0] in args.only]
    observations = [
        observation(runner, lock_mod, args.base, args.bb, row, action, args.rows, args.cols)
        for row, action in actions
    ]
    journey = {
        "schemaVersion": "bb.e3.cancel_recovery_journey.v2",
        "candidate": str(args.bb),
        "observations": observations,
    }
    (args.output / "journey.json").write_text(json.dumps(journey, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"observations": [(item["id"], item["verdict"]) for item in observations]}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
