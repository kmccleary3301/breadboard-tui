#!/usr/bin/env python3
"""Exercise installed ``bb research compare`` failure terminalization journeys.

The source fixture and owner inspector are imported from the successful compare
journey.  Only the installed executable runs the comparison.  The two cases
are local-only so this script never needs provider credentials or a remote
scheduler.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shlex
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

_THIS = Path(__file__).resolve()
_SUCCESS_PATH = _THIS.with_name("research-compare-journey.py")
_spec = importlib.util.spec_from_file_location(
    "research_compare_journey", _SUCCESS_PATH
)
if _spec is None or _spec.loader is None:
    raise RuntimeError(f"cannot load compare journey helpers: {_SUCCESS_PATH}")
_journey = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _journey
_spec.loader.exec_module(_journey)

JourneyFailure = _journey.JourneyFailure

FORGED_REPORT_PROGRAM = """
import base64, json, sys, zlib
admitted = json.loads(zlib.decompress(base64.b64decode(sys.argv[-1], validate=True)))
print(json.dumps({"equivalent": True, "differences": [], "projection": admitted["projection"], "records": [{}, {}]}))
"""


def _persisted_snapshot(root: Path) -> dict[str, bytes]:
    root = root.resolve(strict=True)
    return {
        str(path.relative_to(root)): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _write_forged_world(
    source: Path, run_root: Path, workspace: Path
) -> tuple[Path, Path]:
    try:
        world = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise JourneyFailure(f"world configuration is not JSON: {error}") from error
    if not isinstance(world, dict) or world.get("kind") != "local":
        raise JourneyFailure("failure journey requires a declared local world")
    forged_python = workspace / "forged-world-python"
    forged_python.write_text(
        f"#!{sys.executable}\n" + FORGED_REPORT_PROGRAM, encoding="utf-8"
    )
    forged_python.chmod(0o700)
    world["python"] = str(forged_python)
    forged_input = run_root / "WORLD-forged.json"
    _journey.write_json(forged_input, world)
    return forged_input, forged_python


def _run_id(workspace: Path) -> str | None:
    candidates = sorted(
        workspace.glob(".breadboard/sessions/research-*/session_events.jsonl")
    )
    if len(candidates) != 1:
        return None
    return candidates[0].parent.name


def _failure_result(result: dict[str, Any], expected_code: str) -> None:
    error = result.get("error")
    if (
        result.get("schema_version") != "bb.cli.result.v1"
        or result.get("ok") is not False
        or result.get("exit_code") != 4
        or not isinstance(error, dict)
        or error.get("error_code") != expected_code
        or result.get("record_refs") != []
    ):
        raise JourneyFailure(
            f"failure result does not match {expected_code}/4: {result}"
        )


def _authenticate_child_target(
    state: dict[str, Any], engine_root: Path
) -> dict[str, Any]:
    child_state = state.get("child_state")
    if not isinstance(child_state, dict):
        raise JourneyFailure("inspector did not retain child state")
    target = child_state.get("execution_target")
    if not isinstance(target, dict):
        raise JourneyFailure("inspector did not retain an execution target")
    pid = target.get("pid")
    group = target.get("process_group_id")
    expected_token = target.get("start_token")
    if (
        type(pid) is not int
        or pid <= 0
        or type(group) is not int
        or group <= 0
        or type(expected_token) is not str
    ):
        raise JourneyFailure("retained child target identity is invalid")
    actual_token = _journey.process_start_token(pid)
    if actual_token is not None and sys.platform == "darwin":
        _, seconds, microseconds = str(actual_token).split(":")
        actual_token = int(seconds) * 1_000_000 + int(microseconds)
    if actual_token is None or f"kernel:{actual_token}" != expected_token:
        raise JourneyFailure("retained child PID/start-token identity did not verify")
    try:
        actual_group = os.getpgid(pid)
    except OSError as error:
        raise JourneyFailure(
            f"retained child process group disappeared: {error}"
        ) from error
    if actual_group != group:
        raise JourneyFailure("retained child process group identity did not verify")
    if group == os.getpgrp():
        raise JourneyFailure("refusing to kill the journey process group")
    observation = state.get("child_process_observation")
    if observation != "running":
        raise JourneyFailure(f"retained child process is not running: {observation}")
    processes = subprocess.run(
        ["ps", "-g", str(group), "-o", "pid=,ppid=,args="],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout
    if "breadboard-research-world" not in processes:
        raise JourneyFailure("owned process group has no installed research worker")
    if str(engine_root) in processes or str(Path(__file__).parents[4]) in processes:
        raise JourneyFailure("installed child process group uses a source checkout")
    return {
        "pid": pid,
        "process_group_id": group,
        "start_token": expected_token,
        "processes": processes,
    }


def _assert_failed_state(
    state: dict[str, Any],
    *,
    run_id: str,
    error_code: str,
    case: str,
) -> None:
    if state.get("owner_replay_equal") is not True:
        raise JourneyFailure(
            "failed owner state does not replay to its durable snapshot"
        )
    parent = state.get("parent_read_model")
    if not isinstance(parent, dict) or parent.get("status") != "failed":
        raise JourneyFailure(f"research parent Session is not failed: {parent}")
    if state.get("work_status") != "failed":
        raise JourneyFailure(
            f"research parent WorkItem is not failed: {state.get('work_status')}"
        )
    terminal = state.get("terminal_outcome")
    if not isinstance(terminal, dict) or terminal.get("error") != error_code:
        raise JourneyFailure(f"parent terminal error is not {error_code}: {terminal}")
    if state.get("annotation_events") != [] or "report" in state:
        raise JourneyFailure("failed comparison accepted a report or annotation")
    if (
        state.get("joined_count") != 1
        or state.get("child_terminal_count") != 1
        or state.get("child_joined") is not True
        or state.get("attempt_count") != 1
    ):
        raise JourneyFailure(
            "failed comparison did not settle exactly one child attempt"
        )
    expected_child = {
        "forged-report": ("completed", "completed", 1),
        "lost-result": ("failed", "failed", 0),
    }[case]
    if (
        state.get("child_terminal_outcome"),
        state.get("child_session_status"),
        state.get("child_completed_count"),
    ) != expected_child:
        raise JourneyFailure(
            f"unexpected child settlement for {case}: "
            f"{state.get('child_terminal_outcome')}, "
            f"{state.get('child_session_status')}, "
            f"{state.get('child_completed_count')}"
        )


def _assert_snapshots(
    workspace: Path, before: dict[str, dict[str, bytes]], state: dict[str, Any]
) -> None:
    for name, expected in before.items():
        actual = _persisted_snapshot(workspace / name)
        if actual != expected:
            raise JourneyFailure(f"persisted {name} snapshot changed")
    if not isinstance(state.get("source_message_bytes"), dict):
        raise JourneyFailure(
            "owner probe did not return E/EPrime persisted message bytes"
        )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run installed research compare failure journeys"
    )
    parser.add_argument(
        "--case", choices=("forged-report", "lost-result"), required=True
    )
    parser.add_argument("--bb", type=Path, required=True)
    parser.add_argument("--engine-root", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, required=True)
    parser.add_argument("--world", type=Path, required=True)
    parser.add_argument("--startup-timeout", type=float, default=30.0)
    parser.add_argument("--turn-timeout", type=float, default=120.0)
    options = parser.parse_args()
    if sys.version_info < (3, 11):
        raise JourneyFailure("research compare failure journey requires Python 3.11+")
    bb = options.bb.resolve(strict=True)
    engine_root = options.engine_root.resolve(strict=True)
    world_input = options.world.resolve(strict=True)
    temp_root = options.temp_root.resolve(strict=True)
    if not bb.is_file() or not os.access(bb, os.X_OK):
        raise JourneyFailure(f"--bb is not executable: {bb}")
    if not engine_root.is_dir():
        raise JourneyFailure(f"--engine-root is not a directory: {engine_root}")
    if not world_input.is_file():
        raise JourneyFailure(f"--world is not a file: {world_input}")
    try:
        declared_world = json.loads(world_input.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise JourneyFailure(f"--world is not JSON: {error}") from error
    if not isinstance(declared_world, dict) or declared_world.get("kind") != "local":
        raise JourneyFailure("failure journey requires --world with kind local")

    helpers = _journey.load_installed_helpers()
    helpers.ensure_empty_directory(temp_root, "temp-root")
    run_root = temp_root
    output = run_root / "evidence"
    output.mkdir(mode=0o700)
    home = run_root / "home"
    config = run_root / "config"
    agent = run_root / "agent"
    workspace = run_root / "workspace"
    runtime_tmp = run_root / "runtime-tmp"
    for path in (home, config, agent, workspace, runtime_tmp):
        path.mkdir(mode=0o700)
    environment = helpers.exact_environment(home, config, agent, runtime_tmp)
    environment["BREADBOARD_PRODUCT"] = "1"
    if any(
        key.startswith(("OPENAI_", "ANTHROPIC_", "GOOGLE_", "GEMINI_"))
        for key in environment
    ):
        raise JourneyFailure(
            "installed environment unexpectedly contains provider credentials"
        )

    usage = subprocess.run(
        [str(bb), "research", "compare"],
        cwd=workspace,
        env=environment,
        capture_output=True,
        text=True,
        timeout=options.startup_timeout,
        check=False,
    )
    (output / "usage.stdout.txt").write_text(usage.stdout)
    (output / "usage.stderr.txt").write_text(usage.stderr)
    if usage.returncode != 1 or any(
        flag not in usage.stderr
        for flag in (
            "--definition",
            "--world",
            "--generation",
            "--projection",
            "--compare",
            "--help",
        )
    ):
        raise JourneyFailure(
            "invalid comparison invocation lost the shared command usage/help"
        )

    _journey.run_source_program(
        _journey.FIXTURE_PROGRAM,
        [str(workspace)],
        engine_root=engine_root,
        cwd=workspace,
        stdout_path=output / "fixture.stdout.txt",
        stderr_path=output / "fixture.stderr.txt",
        timeout=options.turn_timeout,
    )
    snapshots = {
        name: _persisted_snapshot(workspace / name) for name in ("E", "E_PRIME")
    }
    run_world_input = world_input
    if options.case == "forged-report":
        run_world_input, _ = _write_forged_world(world_input, run_root, workspace)
    world_path, world, gate_started, gate_release = _journey.copy_world_input(
        run_world_input, workspace, run_root
    )
    if world["kind"] != "local":
        raise JourneyFailure("failure journey copied a non-local world")
    if str(engine_root) in json.dumps(world, sort_keys=True):
        raise JourneyFailure("world configuration would expose the source checkout")
    command = [
        str(bb),
        "research",
        "compare",
        "--definition",
        "EXPERIMENT.json",
        "--world",
        world_path.name,
        "--generation",
        "GENERATION.json",
        "--projection",
        "PROJECTION.json",
        "--compare",
        "E.json,E_PRIME.json",
    ]
    print("INVOCATION", shlex.join(command))
    first: subprocess.Popen[bytes] | None = None
    first_streams: tuple[Any, Any] | None = None
    repeat: subprocess.Popen[bytes] | None = None
    repeat_streams: tuple[Any, Any] | None = None
    primary_error: BaseException | None = None
    summary: dict[str, Any] | None = None
    try:
        first, stdout, stderr = _journey.process_command(
            command, workspace, environment, output, "first"
        )
        first_streams = (stdout, stderr)

        def gate_ready() -> bool:
            if first is None:
                return False
            if first.poll() is not None:
                raise JourneyFailure(
                    f"installed compare exited {first.returncode} before world start; "
                    f"stderr={output / 'first.stderr.txt'}"
                )
            return _journey.world_gate_started(world, gate_started)

        _journey.wait_until(gate_ready, options.startup_timeout, "world gate start")
        run_id = _journey.wait_until(
            lambda: _run_id(workspace),
            options.startup_timeout,
            "durable research run",
        )
        kill_identity: dict[str, Any] | None = None
        if options.case == "lost-result":

            def waiting_state() -> dict[str, Any] | None:
                try:
                    candidate = _journey.invoke_inspector(
                        workspace=workspace,
                        agent_root=agent,
                        run_id=run_id,
                        engine_root=engine_root,
                        output=output,
                        label="before-loss",
                        timeout=options.startup_timeout,
                    )
                except JourneyFailure:
                    return None
                decision = candidate.get("decision", {})
                return (
                    candidate
                    if decision.get("action") == "wait"
                    and decision.get("active_step_ids") == ["compare"]
                    and decision.get("completed_step_ids") == []
                    else None
                )

            held = _journey.wait_until(
                waiting_state,
                options.startup_timeout,
                "workflow wait before lost result",
                0.2,
            )
            kill_identity = _authenticate_child_target(held, engine_root)
            os.killpg(kill_identity["process_group_id"], signal.SIGKILL)
            _journey.wait_until(
                lambda: not _journey.process_alive(kill_identity["pid"]),
                options.startup_timeout,
                "owned child group death",
            )
            print("KILL", json.dumps(kill_identity, sort_keys=True))
        _journey.release_world_gate(world, gate_release)
        exit_code = _journey.wait_process(
            first, options.turn_timeout, "installed failure command"
        )
        first_streams[0].flush()
        first_streams[1].flush()
        first_result = _journey.command_result(
            output / "first.stdout.txt", output / "first.stderr.txt", "first"
        )
        expected_code = (
            "research_world_report_invalid"
            if options.case == "forged-report"
            else "research_world_result_unavailable"
        )
        if exit_code != 4:
            raise JourneyFailure(
                f"installed failure command exited {exit_code}, expected 4"
            )
        _failure_result(first_result, expected_code)
        print("RESULT first", json.dumps(first_result, sort_keys=True))
        failed = _journey.invoke_inspector(
            workspace=workspace,
            agent_root=agent,
            run_id=run_id,
            engine_root=engine_root,
            output=output,
            label="failed",
            timeout=options.startup_timeout,
        )
        _assert_failed_state(
            failed, run_id=run_id, error_code=expected_code, case=options.case
        )
        _assert_snapshots(workspace, snapshots, failed)
        baseline_parent_events = failed["parent_events"]
        baseline_work_events = failed["work_events"]
        baseline_attempts = failed["attempt_count"]
        repeat, repeat_stdout, repeat_stderr = _journey.process_command(
            command, workspace, environment, output, "repeat"
        )
        repeat_streams = (repeat_stdout, repeat_stderr)
        repeat_exit = _journey.wait_process(
            repeat, options.turn_timeout, "identical failed command"
        )
        repeat_streams[0].flush()
        repeat_streams[1].flush()
        repeat_result = _journey.command_result(
            output / "repeat.stdout.txt", output / "repeat.stderr.txt", "repeat"
        )
        if repeat_exit != 4:
            raise JourneyFailure(
                f"identical failed command exited {repeat_exit}, expected 4"
            )
        _failure_result(repeat_result, "research_run_terminal")
        print("RESULT repeat", json.dumps(repeat_result, sort_keys=True))
        repeated = _journey.invoke_inspector(
            workspace=workspace,
            agent_root=agent,
            run_id=run_id,
            engine_root=engine_root,
            output=output,
            label="repeated",
            timeout=options.startup_timeout,
        )
        _assert_failed_state(
            repeated, run_id=run_id, error_code=expected_code, case=options.case
        )
        _assert_snapshots(workspace, snapshots, repeated)
        if (
            repeated["parent_events"] != baseline_parent_events
            or repeated["work_events"] != baseline_work_events
            or repeated["attempt_count"] != baseline_attempts
            or _run_id(workspace) != run_id
            or repeated.get("source_message_bytes")
            != failed.get("source_message_bytes")
        ):
            raise JourneyFailure(
                "identical failed request appended owner events or attempts"
            )
        summary = {
            "status": "pass",
            "case": options.case,
            "run_id": run_id,
            "first_code": expected_code,
            "repeat_code": "research_run_terminal",
            "exit_code": 4,
            "parent_status": failed["parent_read_model"]["status"],
            "work_status": failed["work_status"],
            "child_terminal_outcome": failed["child_terminal_outcome"],
            "persisted_snapshots_unchanged": True,
            "owner_events_unchanged": True,
            "invocation": shlex.join(command),
            "evidence_directory": str(output),
        }
    except BaseException as error:
        primary_error = error
    finally:
        try:
            _journey.release_world_gate(world, gate_release)
        except BaseException as cleanup_error:
            if primary_error is None:
                primary_error = cleanup_error
            else:
                print(f"world gate cleanup failed: {cleanup_error}", file=sys.stderr)
        needs_cleanup = (
            primary_error is not None
            or (first is not None and first.poll() is None)
            or (repeat is not None and repeat.poll() is None)
            or helpers.active_authority(agent) is not None
        )
        if needs_cleanup:
            try:
                _journey.cleanup_failed_run(
                    helpers, workspace, agent, engine_root, output
                )
            except BaseException as cleanup_error:
                if primary_error is None:
                    primary_error = cleanup_error
                else:
                    print(
                        f"owned process cleanup failed: {cleanup_error}",
                        file=sys.stderr,
                    )
        _journey.cleanup_process(repeat, repeat_streams, 5.0)
        _journey.cleanup_process(first, first_streams, 5.0)
    if primary_error is not None:
        raise primary_error
    if summary is None:
        raise JourneyFailure("failure journey produced no pass summary")
    _journey.write_json(output / "journey-summary.json", summary)
    print("PASS", json.dumps(summary, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except JourneyFailure as error:
        print(f"research compare failure journey failed: {error}", file=sys.stderr)
        raise SystemExit(1)
