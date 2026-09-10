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
IDENTITY_FIELDS = (
    "pid",
    "osProcessStartToken",
    "engineInstanceId",
    "engineBootId",
    "launchId",
)
PROOF_FIELDS = (
    "engineInstanceId",
    "engineBootId",
    "launchId",
    "registrationId",
    "registrationGeneration",
    "clientInstanceId",
    "credentialSha256",
)


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
def authority_identity(authority: dict[str, Any]) -> dict[str, Any]:
    return {
        field: authority.get(field)
        for field in IDENTITY_FIELDS
        + ("ownerGeneration", "recordRevision", "normalizedEndpoint")
    }


def same_authority(left: dict[str, Any], right: dict[str, Any]) -> bool:
    return all(left.get(field) == right.get(field) for field in IDENTITY_FIELDS)


def valid_digest(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def valid_request_proof(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    required_strings = (
        "engineInstanceId",
        "engineBootId",
        "launchId",
        "registrationId",
        "clientInstanceId",
    )
    return (
        all(isinstance(value.get(field), str) and value[field] for field in required_strings)
        and type(value.get("registrationGeneration")) is int
        and value["registrationGeneration"] >= 1
        and valid_digest(value.get("credentialSha256"))
    )


def proof_matches_authority(trace: dict[str, Any], authority: dict[str, Any]) -> bool:
    proof = trace.get("proof")
    return (
        valid_request_proof(proof)
        and all(proof.get(field) == authority.get(field) for field in IDENTITY_FIELDS[2:])
    )


def trace_is_input(trace: dict[str, Any], session_id: str) -> bool:
    return (
        trace.get("method") == "POST"
        and trace.get("path")
        == f"/v1/internal/sessions/{urllib.parse.quote(session_id, safe='')}/input"
        and valid_digest(trace.get("bodySha256"))
    )


def replacement_registration_trace(
    traces: list[dict[str, Any]],
    authority: dict[str, Any],
    predecessor: dict[str, Any],
) -> dict[str, Any] | None:
    for trace in traces:
        if not isinstance(trace, dict) or not proof_matches_authority(trace, authority):
            continue
        proof = trace["proof"]
        if all(
            proof.get(field) == predecessor.get(field)
            for field in ("engineInstanceId", "engineBootId", "launchId")
        ):
            continue
        return dict(trace)
    return None


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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

def launch(
    runner: Any,
    bb: Path,
    roots: dict[str, Path],
    rows: int,
    cols: int,
    proxy: Any | None = None,
):
    (roots["agent"] / "config.yml").write_text("tools:\n  approvalMode: always-ask\n", encoding="utf-8")
    env = runner.exact_environment(roots["home"], roots["config"], roots["agent"], roots["temp"])
    if proxy is not None:
        env.update(proxy.environment())
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
    agent_root: Path,
    child: Any,
    descendants: list[dict[str, Any]],
    endpoint: str,
    engine_pid: int | None,
    engine_authority: dict[str, Any] | None,
) -> dict[str, Any]:
    tui_exit_code: int | None = child.exit_status
    cleanup_forced = False
    child_start_token = runner.process_start_token(child.pid)
    for row in descendants:
        row["osProcessStartToken"] = runner.process_start_token(row["pid"])
    current_authority = runner.active_authority(agent_root)
    authenticated_engine = (
        engine_pid is not None
        and isinstance(engine_authority, dict)
        and current_authority is not None
        and same_authority(current_authority[1], engine_authority)
        and int(engine_authority.get("pid", -1)) == engine_pid
        and runner.process_alive(engine_pid)
        and runner.process_start_token(engine_pid) == engine_authority["osProcessStartToken"]
        and any(int(row.get("pid", -1)) == engine_pid for row in descendants)
    )
    try:
        child.send_line("/exit")
        tui_exit_code = child.wait_for_exit(20)
    except Exception:
        runner.signal_process_if_same(child.pid, child_start_token, signal.SIGTERM)
    engine_exited = wait_engine_exit(runner, endpoint, engine_pid, timeout=5)
    listener_pids_after, _ = listener_pids(runner, endpoint)
    leaked_pids = list(listener_pids_after)
    if not engine_exited["observed"]:
        if (
            authenticated_engine
            and engine_pid is not None
            and runner.process_alive(engine_pid)
        ):
            cleanup_forced = runner.signal_process_if_same(
                engine_pid, engine_authority["osProcessStartToken"], signal.SIGTERM,
            )
            deadline = time.monotonic() + 0.5
            while runner.process_alive(engine_pid) and time.monotonic() < deadline:
                time.sleep(0.05)
            if runner.process_alive(engine_pid):
                cleanup_forced = runner.signal_process_if_same(
                    engine_pid, engine_authority["osProcessStartToken"], signal.SIGKILL,
                ) or cleanup_forced
            wait_engine_exit(runner, endpoint, engine_pid, timeout=5)
        for pid in leaked_pids:
            write_orphan_snapshot(
                runner,
                raw_root,
                endpoint,
                pid,
                "authenticated engine listener remained after teardown"
                if authenticated_engine and pid == engine_pid
                else "unowned engine listener remained after teardown",
            )
    for row in reversed(descendants):
        pid = row.get("pid")
        if not isinstance(pid, int) or pid == engine_pid:
            continue
        runner.signal_process_if_same(pid, row.get("osProcessStartToken"), signal.SIGTERM)
    time.sleep(0.2)
    for row in reversed(descendants):
        pid = row.get("pid")
        if not isinstance(pid, int) or pid == engine_pid:
            continue
        runner.signal_process_if_same(pid, row.get("osProcessStartToken"), signal.SIGKILL)
    child.close()
    endpoint_closed = not runner.endpoint_open(endpoint)
    return {
        "tuiExitCode": tui_exit_code,
        "engineExited": engine_exited,
        "engineCleanupForced": cleanup_forced,
        "engineTargetAuthenticated": authenticated_engine,
        "unownedListenerPids": [
            pid for pid in leaked_pids if not authenticated_engine or pid != engine_pid
        ],
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
    proxy = None
    engine_pid: int | None = None
    engine_authority: dict[str, Any] | None = None
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
        nonlocal child, proxy, engine_pid, engine_authority, endpoint
        record["lockWaitSeconds"] = round(held.waited_seconds, 3)
        try:
            if row == "F10a":
                proxy_type = getattr(runner, "HeldSessionMutationProxy", None)
                if proxy_type is None:
                    raise RuntimeError("installed runner does not provide HeldSessionMutationProxy")
                proxy = proxy_type(DEFAULT_ENDPOINT)
                proxy.start()
                record["proxyEnvironment"] = dict(proxy.environment())
            child, authority, _ = launch(
                runner,
                bb,
                roots,
                rows,
                cols,
                proxy,
            )
            endpoint = str(authority["normalizedEndpoint"])
            if proxy is not None and endpoint != DEFAULT_ENDPOINT:
                raise RuntimeError(
                    f"proxy target endpoint mismatch: authority={endpoint!r}, target={DEFAULT_ENDPOINT!r}"
                )
            listeners, listener_receipt = listener_pids(runner, endpoint)
            write_json(output / "listener-after-start.json", listener_receipt)
            if not listeners:
                raise RuntimeError("engine authority has no listener on the default endpoint")
            authority_pid = authority.get("pid")
            if type(authority_pid) is not int or authority_pid not in listeners:
                raise RuntimeError("engine authority PID is not the listener observed on its endpoint")
            engine_pid = authority_pid
            engine_authority = dict(authority)
            record["enginePid"] = engine_pid
            record["engineEndpoint"] = endpoint
            record["engineAuthority"] = authority_identity(authority)
            if proxy is None:
                result = action(runner, child, roots, output, endpoint, authority)
            else:
                result = action(runner, child, roots, output, endpoint, authority, proxy)
            record.update(result)
            replacement = result.get("replacementAuthority")
            if isinstance(replacement, dict) and type(replacement.get("pid")) is int:
                engine_pid = int(replacement["pid"])
                engine_authority = dict(replacement)
                record["cleanupEnginePid"] = engine_pid
                record["cleanupEngineAuthority"] = authority_identity(replacement)
            record["actionResult"] = result.get("verdict", "UNKNOWN")
            record["verdict"] = record["actionResult"]
        except Exception as error:
            record.update({"verdict": "UNKNOWN", "reason": f"{type(error).__name__}: {error}"})
            if child is not None:
                capture(runner, output, "exception", child, roots, None)
        finally:
            if child is not None:
                try:
                    descendants = runner.process_descendants(child.pid)
                    record["processBeforeClose"] = descendants
                    record.update(
                        end_child(
                            runner,
                            base,
                            roots["agent"],
                            child,
                            descendants,
                            endpoint,
                            engine_pid,
                            engine_authority,
                        )
                    )
                    engine_exit = record.get("engineExited")
                    engine_exit_within_deadline = (
                        isinstance(engine_exit, dict)
                        and engine_exit.get("observed") is True
                        and isinstance(engine_exit.get("seconds"), (int, float))
                        and engine_exit["seconds"] <= 5
                    )
                    endpoint_closed = record.get("endpointClosed") is True
                    finalize_teardown(record, engine_exit_within_deadline, endpoint_closed)
                except Exception as error:
                    record["verdict"] = "UNKNOWN"
                    record["reason"] = (
                        f"{record.get('reason', '')}; teardown failed: "
                        f"{type(error).__name__}: {error}"
                    ).lstrip("; ")
            if proxy is not None:
                try:
                    record["proxyCleanup"] = proxy.stop()
                except Exception as error:
                    record["proxyCleanup"] = {
                        "closed": False,
                        "error": f"{type(error).__name__}: {error}",
                    }
                    record["verdict"] = "fail"
                    record["reason"] = (
                        f"{record.get('reason', '')}; proxy cleanup failed"
                    ).lstrip("; ")

    try:
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
        write_json(output / "observation.json", record)
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


def f10a(
    runner: Any,
    child: Any,
    roots: dict[str, Path],
    output: Path,
    endpoint: str,
    authority: dict[str, Any],
    proxy: Any | None = None,
) -> dict[str, Any]:
    if proxy is None:
        raise RuntimeError("F10a requires the installed runner HeldSessionMutationProxy")
    if endpoint != DEFAULT_ENDPOINT:
        raise RuntimeError(f"F10a requires the loopback engine endpoint {DEFAULT_ENDPOINT}")

    prior_prompt = "Establish a deterministic prior turn and wait for permission."
    child.send_typed_line(prior_prompt)
    prior_request_id = child.wait_until(
        lambda: child.permission_dialog_ready(),
        30,
        "F10a prior-turn permission",
    )
    prior_binding = child.wait_until(
        lambda: runner.binding_snapshot(roots["agent"]),
        30,
        "F10a prior-turn binding",
    )
    child.send_escape()
    prior_terminal = runner.wait_for_terminal_state(
        child,
        roots["agent"],
        1,
        30,
        "F10a prior-turn denial",
        "cancelled",
    )
    prior = capture(runner, output, "prior-turn-denied", child, roots, endpoint)
    session_id = prior_binding.data.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise RuntimeError("F10a session binding has no session id")

    proxy.arm(session_id)
    old_prompt = SYNTHETIC_PROMPT
    child.send_typed_line(old_prompt)
    held = child.wait_until(
        lambda: (
            trace
            if isinstance(trace := proxy.held_request, dict)
            and trace_is_input(trace, session_id)
            else None
        ),
        30,
        "F10a held old session input",
    )
    held_request = dict(held)
    if not proof_matches_authority(held_request, authority):
        raise RuntimeError("F10a held request proof does not identify the current engine")
    if proxy.outcome is not None:
        raise RuntimeError("F10a held request already has an upstream outcome")
    write_json(output / "held-request.json", held_request)
    before_discontinuity = capture(
        runner,
        output,
        "before-discontinuity",
        child,
        roots,
        endpoint,
    )

    old_pid = authority.get("pid")
    if (
        type(old_pid) is not int
        or any(
            not isinstance(authority.get(field), str) or not authority[field]
            for field in ("osProcessStartToken", "engineInstanceId", "engineBootId", "launchId")
        )
    ):
        raise RuntimeError("F10a current authority lacks complete process identity")
    current_path_authority = runner.active_authority(roots["agent"])
    descendants_before_kill = runner.process_descendants(child.pid)
    kill_authenticated = (
        current_path_authority is not None
        and same_authority(current_path_authority[1], authority)
        and runner.process_alive(old_pid)
        and runner.process_start_token(old_pid) == authority["osProcessStartToken"]
        and any(int(row.get("pid", -1)) == old_pid for row in descendants_before_kill)
    )
    write_json(
        output / "kill-authentication.json",
        {
            "authorityPath": None if current_path_authority is None else str(current_path_authority[0]),
            "authority": authority_identity(authority),
            "descendantsBeforeKill": descendants_before_kill,
            "authenticated": kill_authenticated,
        },
    )
    if not kill_authenticated:
        raise RuntimeError("F10a refused to kill an unauthenticated engine PID")
    if not runner.signal_process_if_same(old_pid, authority["osProcessStartToken"], signal.SIGKILL):
        raise RuntimeError("F10a engine identity changed before kill")
    child.wait_until(
        lambda: not runner.process_alive(old_pid),
        30,
        "F10a old engine death",
    )
    write_json(
        output / "engine-killed.json",
        {
            "authority": authority_identity(authority),
            "pidDead": not runner.process_alive(old_pid),
            "descendantsBeforeKill": descendants_before_kill,
        },
    )

    def replacement_authority_ready() -> tuple[Path, dict[str, Any]] | None:
        selected = runner.active_authority(roots["agent"])
        if selected is None:
            return None
        candidate = selected[1]
        if selected[0] != current_path_authority[0]:
            return None
        if any(candidate.get(field) == authority.get(field) for field in IDENTITY_FIELDS):
            return None
        candidate_pid = candidate.get("pid")
        candidate_endpoint = candidate.get("normalizedEndpoint")
        if (
            type(candidate_pid) is not int
            or candidate_endpoint != endpoint
            or any(
                not isinstance(candidate.get(field), str) or not candidate[field]
                for field in ("osProcessStartToken", "engineInstanceId", "engineBootId", "launchId")
            )
            or not runner.process_alive(candidate_pid)
            or runner.process_start_token(candidate_pid) != candidate["osProcessStartToken"]
            or not runner.endpoint_open(str(candidate_endpoint))
        ):
            return None
        if not any(int(row.get("pid", -1)) == candidate_pid for row in runner.process_descendants(child.pid)):
            return None
        return selected

    replacement_path, replacement = child.wait_until(
        replacement_authority_ready,
        60,
        "F10a replacement authority",
    )
    replacement_registration = child.wait_until(
        lambda: replacement_registration_trace(
            list(proxy.requests),
            replacement,
            authority,
        ),
        30,
        "F10a replacement registration proof",
    )
    if replacement_registration is None:
        raise RuntimeError("F10a replacement registration proof was not observed")
    write_json(
        output / "replacement-authority.json",
        {
            "path": str(replacement_path),
            "authority": authority_identity(replacement),
            "process": runner.process_snapshot(int(replacement["pid"])),
            "descendants": runner.process_descendants(child.pid),
            "registrationProof": replacement_registration,
        },
    )

    def settled_before_release() -> tuple[Path, dict[str, Any], bytes] | None:
        snapshot = runner.retained_state_snapshot(roots["agent"])
        if snapshot is None:
            return None
        state = snapshot[1]
        turns = state.get("turns")
        if (
            not isinstance(turns, list)
            or not turns
            or any(
                not isinstance(turn, dict)
                or turn.get("terminal_resolution_committed") is not True
                for turn in turns
            )
        ):
            return None
        binding = runner.binding_snapshot(roots["agent"])
        if binding is None or binding.data.get("sessionId") != session_id:
            return None
        if child.permission_dialog_ready():
            return None
        return snapshot

    settled_snapshot = child.wait_until(
        settled_before_release,
        30,
        "F10a settled replacement state before stale release",
    )
    settled_before_release_value = capture(
        runner,
        output,
        "settled-before-release",
        child,
        roots,
        endpoint,
    )
    write_json(
        output / "restart-terminalization-delta.json",
        {
            "beforeDiscontinuity": before_discontinuity,
            "settledBeforeRelease": settled_before_release_value,
            "equal": before_discontinuity == settled_before_release_value,
        },
    )

    proxy.release()
    stale_outcome = child.wait_until(
        lambda: proxy.outcome,
        30,
        "F10a stale request outcome",
    )
    if not isinstance(stale_outcome, dict):
        raise RuntimeError("F10a stale request outcome was not an object")
    error_code = stale_outcome.get("errorCode")
    typed_stale_rejection = (
        type(stale_outcome.get("status")) is int
        and stale_outcome["status"] == 409
        and error_code == "engine_identity_mismatch"
        and "responseBody" in stale_outcome
    )
    write_json(output / "stale-outcome.json", stale_outcome)
    after_stale_release = capture(
        runner,
        output,
        "after-stale-release",
        child,
        roots,
        endpoint,
    )
    stale_release_sections = {
        field: settled_before_release_value.get(field) == after_stale_release.get(field)
        for field in ("binding", "retainedState", "session", "records", "events", "authority")
    }
    stale_release_unchanged = all(stale_release_sections.values())
    write_json(
        output / "stale-release-delta.json",
        {
            "before": settled_before_release_value,
            "after": after_stale_release,
            "sectionsEqual": stale_release_sections,
            "equal": settled_before_release_value == after_stale_release,
        },
    )

    baseline_binding = runner.binding_snapshot(roots["agent"])
    baseline_submission_keys = {
        (
            item.get("clientMessageId"),
            item.get("inputId"),
            item.get("turnId"),
        )
        for item in (
            []
            if baseline_binding is None
            else baseline_binding.data.get("ownedSubmissions", [])
        )
        if isinstance(item, dict)
    }
    settled_state = settled_snapshot[1]
    settled_turns = settled_state.get("turns", [])
    if not isinstance(settled_turns, list):
        raise RuntimeError("F10a settled state has no turns")
    baseline_terminal_count = sum(
        isinstance(turn, dict) and turn.get("terminal_resolution_committed") is True
        for turn in settled_turns
    )
    fresh_prompt = "Prove the replacement engine can execute one deterministic validation."
    child.send_line(fresh_prompt)
    fresh_terminal, approvals = runner.wait_for_terminal_state_with_permissions(
        child,
        roots["agent"],
        baseline_terminal_count + 1,
        60,
        "F10a replacement positive-control turn",
        "completed",
    )
    fresh_binding = child.wait_until(
        lambda: (
            snapshot
            if (snapshot := runner.binding_snapshot(roots["agent"])) is not None
            and any(
                isinstance(item, dict)
                and (
                    item.get("clientMessageId"),
                    item.get("inputId"),
                    item.get("turnId"),
                )
                not in baseline_submission_keys
                for item in snapshot.data.get("ownedSubmissions", [])
            )
            else None
        ),
        30,
        "F10a replacement positive-control admission",
    )
    positive_requests = [
        dict(trace)
        for trace in list(proxy.requests)
        if isinstance(trace, dict)
        and proof_matches_authority(trace, replacement)
        and valid_digest(trace.get("bodySha256"))
    ]
    positive_input_requests = [
        trace for trace in positive_requests if trace_is_input(trace, session_id)
    ]
    fresh_state = fresh_terminal[1]
    fresh_terminal_turns = [
        turn
        for turn in fresh_state.get("turns", [])
        if isinstance(turn, dict) and turn.get("terminal_resolution_committed") is True
    ]
    fresh_turn = fresh_terminal_turns[-1] if fresh_terminal_turns else None
    fresh_submission = next(
        item
        for item in fresh_binding.data.get("ownedSubmissions", [])
        if isinstance(item, dict)
        and (
            item.get("clientMessageId"),
            item.get("inputId"),
            item.get("turnId"),
        )
        not in baseline_submission_keys
    )
    fresh_submission_key = (
        fresh_submission.get("clientMessageId"),
        fresh_submission.get("inputId"),
        fresh_submission.get("turnId"),
    )
    positive = capture(
        runner,
        output,
        "replacement-positive-control",
        child,
        roots,
        endpoint,
    )
    write_json(
        output / "positive-control.json",
        {
            "replacementAuthority": authority_identity(replacement),
            "registrationProof": replacement_registration,
            "requests": positive_requests,
            "inputRequests": positive_input_requests,
            "submission": fresh_submission,
            "approvals": approvals,
            "terminalTurn": fresh_turn,
            "durable": positive,
        },
    )
    positive_control = (
        isinstance(fresh_turn, dict)
        and fresh_turn.get("terminal_outcome") == "completed"
        and bool(positive_input_requests)
        and fresh_submission_key not in baseline_submission_keys
        and fresh_prompt in child.screen.text()
    )
    checks = {
        "heldFullProof": trace_is_input(held_request, session_id)
        and proof_matches_authority(held_request, authority),
        "killAuthenticated": kill_authenticated,
        "replacementAuthority": replacement.get("pid") != authority.get("pid")
        and replacement.get("launchId") != authority.get("launchId"),
        "replacementRegistration": replacement_registration is not None,
        "typedStaleRejection": typed_stale_rejection,
        "staleReleaseUnchanged": stale_release_unchanged,
        "positiveControl": positive_control,
    }
    return {
        "matrix": "F10a",
        "priorRequestId": prior_request_id,
        "sessionId": session_id,
        "oldAuthority": authority_identity(authority),
        "replacementAuthority": replacement,
        "heldRequest": held_request,
        "staleOutcome": stale_outcome,
        "restartTerminalization": {
            "settled": True,
            "changed": before_discontinuity != settled_before_release_value,
        },
        "staleReleaseDelta": {
            "sectionsEqual": stale_release_sections,
            "unchanged": stale_release_unchanged,
        },
        "positiveControl": {
            "submission": fresh_submission,
            "terminalTurn": fresh_turn,
            "requests": positive_requests,
            "approvals": approvals,
        },
        "visible": child.screen.text(),
        "durable": positive,
        "resource": runner.process_descendants(child.pid),
        "checks": checks,
        "verdict": "pass" if all(checks.values()) else "fail",
        "reason": None if all(checks.values()) else "F10a oracle assertion failed",
    }

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
