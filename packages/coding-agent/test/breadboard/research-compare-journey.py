#!/usr/bin/env python3
"""Exercise the installed ``bb research compare`` product end to end.

The fixture and inspection helpers run in a source-enabled *test* process.  The
installed command is always started with the exact clean environment used by
``installed-product-journey.py``; it never receives the source checkout or a
provider credential.
"""

from __future__ import annotations

import argparse
import ctypes
import importlib.util
import json
import os
import pwd
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

MASK = ["/occurred_at", "/timestamp"]
EXPECTED_EVENT_KINDS = [
    "session.started",
    "input.accepted",
    "assistant_message",
    "annotation",
    "context.compacted",
    "context.compacted",
    "context.compacted",
    "session.reconfigured",
    "session.completed",
]
EXPECTED_CONTEXT = '[{"role":"user","content":"Retained facts one, two, and three."}]'
EXPECTED_FACTS = ["ctn_000001", "ctn_000002", "ctn_000003"]
WORLD_KINDS = ("local", "container", "ray", "slurm")


class JourneyFailure(RuntimeError):
    pass


# This is deliberately a test-only source owner fixture.  It creates the
# recorded sessions through the product Session/compiler/artifact owners and
# captures bytes after the real OpenAI SDK has dispatched the request to an
# httpx MockTransport.  The installed process is never given this program.
FIXTURE_PROGRAM = r"""
from __future__ import annotations
import json
import sys
from pathlib import Path
import httpx
from openai import OpenAI
from breadboard.product.harness.resolution import compile_harness_source
from breadboard.product.operations.harness import LockHarnessRequest, lock_harness
from breadboard.product.operations.model import OperationContext
from breadboard.product.runtime.artifacts import put_workspace_artifact
from breadboard.product.runtime.events import AnnotationRecord, CompactionSnapshot, Session, rebuild, replay_differential
from breadboard.product.runtime.session_store import create_session
from breadboard_engine.provider.contract_exchange import ProviderExchangeV2
from breadboard_engine.provider.contract_runtime import ProviderRuntimeContext
from breadboard_engine.provider.contract_wire import canonical_json
from breadboard_engine.provider.routing import provider_router
from breadboard_engine.provider.runtimes.openai.chat import OpenAIChatRuntime
from breadboard_engine.state.session_state import SessionState

MASK = ["/occurred_at", "/timestamp"]
CONTEXT = b'[{"role":"user","content":"Retained facts one, two, and three."}]'
FACTS = ("ctn_000001", "ctn_000002", "ctn_000003")
EVENT_KINDS = [
    "session.started", "input.accepted", "assistant_message", "annotation",
    "context.compacted", "context.compacted", "context.compacted",
    "session.reconfigured", "session.completed",
]

class Clock:
    def __init__(self, timestamp):
        self.timestamp = timestamp
    def now(self):
        return self.timestamp

class CapturingAdapter:
    def __init__(self, path):
        self.path = path
    def __call__(self, request):
        self.path.with_name("held-out-wire.json").write_bytes(request.content)
        self.path.write_bytes(canonical_json(json.loads(request.content)).encode())
        return httpx.Response(200, json={
            "id": "held-out", "created": 1, "model": "gpt-4o-mini",
            "object": "chat.completion", "choices": [{
                "index": 0, "finish_reason": "stop",
                "message": {"role": "assistant", "content": "Recorded answer."},
            }],
        })

def prepare(root):
    root.mkdir(parents=True, exist_ok=True)
    context = OperationContext(root, path_policy="contained-public", reference_root=root)
    definition = {
        "schema_version": "bb.harness_definition.v1", "version": 1,
        "workspace": {"root": "."},
        "providers": {
            "default_model": "openai/gpt-4o-mini",
            "models": [{"id": "openai/gpt-4o-mini", "adapter": "openai_chat"}],
        },
        "modes": [{"name": "compare"}],
        "loop": {"sequence": [{"mode": "compare"}]},
    }
    (root / "EXPERIMENT.json").write_text(json.dumps(definition), encoding="utf-8")
    generation = {**definition, "dossier": {"generation": "adopted"}}
    (root / "GENERATION-SOURCE.json").write_text(json.dumps(generation), encoding="utf-8")
    for source, output in (("EXPERIMENT.json", "EXPERIMENT.lock.json"), ("GENERATION-SOURCE.json", "GENERATION.json")):
        result = lock_harness(LockHarnessRequest(source, output), context)
        if not result.ok:
            raise AssertionError(result.as_dict())
    compiled = compile_harness_source(root / "EXPERIMENT.json", root, True)
    adopted = compile_harness_source(root / "GENERATION-SOURCE.json", root, True)
    if compiled.lock == adopted.lock:
        raise AssertionError("generation adoption did not create a distinct Lock")
    descriptor, model = provider_router.get_runtime_descriptor(definition["providers"]["default_model"])
    if descriptor.runtime_id != "openai_chat":
        raise AssertionError(descriptor)
    messages = [{
        "message_id": "recorded-input", "role": "user",
        "content": [{"type": "text", "text": "Recorded question."}],
    }]
    runtime_context = ProviderRuntimeContext(
        session_state=SessionState(str(root), "", compiled.as_dict()),
        agent_config=compiled.as_dict(), stream=False,
        session_id="recorded-session", input_id="recorded-input", turn_id="recorded-turn",
    )
    with OpenAI(
        api_key="offline-fixture-not-a-credential", base_url="http://recorded.invalid/v1",
        max_retries=0,
        http_client=httpx.Client(
            transport=httpx.MockTransport(CapturingAdapter(root / "held-out-request.json")),
            trust_env=False,
        ),
    ) as client:
        OpenAIChatRuntime(descriptor).invoke(
            client=client, model=model, messages=messages, tools=[], stream=False,
            context=runtime_context,
        )
    exchange = {
        "schema_version": "bb.provider_exchange.v2", "exchange_id": "recorded-exchange",
        "correlation": {
            "session_id": "recorded-session", "input_id": "recorded-input", "turn_id": "recorded-turn",
        },
        "provider": {
            "provider_id": descriptor.provider_id, "runtime_id": descriptor.runtime_id,
            "route_id": definition["providers"]["default_model"], "model": model,
        },
        "request": {"stream": False, "messages": messages, "tools": []},
        "events": [
            {"sequence": 0, "kind": "response_start"},
            {"sequence": 1, "kind": "text_start", "content_index": 0, "message_id": "recorded-answer"},
            {"sequence": 2, "kind": "text_delta", "content_index": 0, "message_id": "recorded-answer", "delta": "Recorded answer."},
            {"sequence": 3, "kind": "text_end", "content_index": 0, "message_id": "recorded-answer"},
        ],
        "terminal": {
            "kind": "done", "output_emitted": True, "finish_reason": "stop",
            "raw_provider_finish": "stop",
            "assistant_messages": [{
                "message_id": "recorded-answer", "role": "assistant",
                "content": [{"type": "text", "text": "Recorded answer."}],
            }],
            "provider_replay": [], "evidence_refs": [],
        },
    }
    ProviderExchangeV2.from_dict(exchange)
    exchange_bytes = canonical_json(exchange).encode()
    for name, timestamp in (("E", "2026-09-05T00:00:00Z"), ("E_PRIME", "2026-09-05T01:00:00Z")):
        workspace = root / name
        workspace.mkdir()
        ref = put_workspace_artifact(workspace, exchange_bytes, media_type="application/json")
        session = Session.start(compiled.lock, "recorded comparison", session_id="recorded-session", clock=Clock(timestamp))
        session.input("Recorded question.", (ref,))
        segment = session.read_model.trajectory_segment_id
        session.assistant_message("Recorded answer.", message_id="recorded-answer", trajectory_id=segment)
        session.annotate(AnnotationRecord(
            "recorded-annotation", "recorded-answer", segment, "correct",
            "fixture-author", compiled.lock["graph_hash"],
        ))
        session.compact(CompactionSnapshot(
            b'[{"role":"user","content":"Retained fact one."}]', ("ctn_000001",),
        ))
        session.compact(CompactionSnapshot(
            b'[{"role":"user","content":"Retained facts one and two."}]',
            ("ctn_000001", "ctn_000002"),
        ))
        session.compact(CompactionSnapshot(CONTEXT, FACTS))
        if replay_differential(session) != {} or rebuild(session.events) != session.read_model:
            raise AssertionError("pre-operation Session replay diverged")
        session.adopt_generation(adopted.lock, "recorded quiescent adoption")
        session.complete("recorded result")
        create_session(workspace, session)
        (root / (name + ".json")).write_text(json.dumps({
            "definition": "EXPERIMENT.json", "workspace": name,
            "session_id": "recorded-session", "request_ref": ref.digest,
        }), encoding="utf-8")
    projection = {"projector_version": "bb.session.projector.v2", "as_of": len(session.events)}
    (root / "PROJECTION.json").write_text(json.dumps(projection), encoding="utf-8")
    pre = {
        "definition_lock": compiled.lock.as_dict(),
        "generation_lock": adopted.lock.as_dict(),
        "events": [event.as_dict() for event in session.events],
        "generation_sequence": list(session.generation_sequence),
        "trajectory_segments": [dict(item) for item in session.trajectory_segments],
        "event_kinds": EVENT_KINDS,
        "event_count": len(session.events),
        "compaction_count": sum(event.kind == "context.compacted" for event in session.events),
        "effective_context": CONTEXT.decode(), "raw_fact_ids": list(FACTS),
        "replay_differential": replay_differential(session),
        "projection": {
            "value": session.read_model.as_dict(),
            "projector_version": projection["projector_version"],
            "as_of": len(session.events),
            "source": {
                "stream": "session:recorded-session",
                "components": [],
                "first_sequence": 1,
                "last_sequence": len(session.events),
            },
        },
    }
    (root / "pre-operation-oracle.json").write_text(json.dumps(pre, sort_keys=True), encoding="utf-8")
    print(json.dumps({"workspace": str(root), "event_count": len(session.events), "compaction_count": 3}))

if __name__ == "__main__":
    prepare(Path(sys.argv[1]).resolve())
"""


INSPECT_PROGRAM = r"""
from __future__ import annotations
import asyncio
import json
import sys
from pathlib import Path
from breadboard.product.coordination.work_items import WorkItem, WorkItemRepository
from breadboard.product.runtime.artifacts import ArtifactRef
from breadboard.product.runtime.session_store import load_session
from breadboard.product.runtime.children import ChildSpec, ChildState, DurableChildFactory, ProcessExecutionAdapter, RESEARCH_WORLD_WORKER_COMMAND
from breadboard.product.harness.lock import load_lock
from breadboard.product.runtime.artifacts import read_workspace_artifact, workspace_artifact_ref
from breadboard.product.runtime.workflows import ReplayableWorkflowController, WorkflowDefinition, WorkflowStep
from breadboard_engine.api.cli_bridge.registry.registry_impl import SessionRegistry

workspace = Path(sys.argv[1]).resolve()
agent_root = Path(sys.argv[2]).resolve()
run_id = sys.argv[3]

def registry_candidates():
    paths = set()
    for path in agent_root.rglob("*.json") if agent_root.exists() else ():
        if path.parent.name in {"session-state", "session_state"}:
            paths.add(path.parent.resolve())
    return sorted(paths)

async def inspect_state():
    found = []
    for root in registry_candidates():
        registry = SessionRegistry(state_root=root)
        records = await registry.records()
        durable = [record for record in records if isinstance(record.metadata, dict) and "durable_child" in record.metadata]
        if durable:
            found.append((root, registry, records, durable))
    if len(found) != 1:
        raise RuntimeError(f"expected one isolated retained registry with a durable child, found {len(found)}")
    registry_root, registry, records, durable = found[0]
    if not registry_root.is_relative_to(agent_root):
        raise RuntimeError("retained registry escaped the isolated agent root")
    forbidden = workspace / ".breadboard" / "session_state"
    if forbidden.exists():
        raise RuntimeError("installed compare used source CLI workspace/.breadboard/session_state")
    child_record = durable[0]
    child = ChildState.from_retained(child_record.metadata["durable_child"])
    factory = DurableChildFactory.with_async_registry(
        workspace, registry=registry,
        repository=WorkItemRepository(workspace / ".breadboard" / "work_items.jsonl"),
        adapters=(ProcessExecutionAdapter(command=RESEARCH_WORLD_WORKER_COMMAND),),
    )
    ref = child.child_spec["task_artifact_ref"]
    task_bytes = factory.artifacts.read(ArtifactRef(ref["digest"], ref["size_bytes"], ref["media_type"]))
    task = task_bytes.decode()
    generation = load_lock(workspace / "GENERATION.json", workspace, explicit=True)[0]
    spec = ChildSpec(
        child.child_spec["title"], task, generation,
        child.child_spec["worker_id"], child.adapter_family,
    )
    controller = ReplayableWorkflowController(
        factory, workflow_id=child.child_spec["workflow_id"],
        parent_session_id=child.parent_session_id,
        root_session_id=child.root_session_id,
        parent_work_item_id=child.parent_work_item_id,
        definition=WorkflowDefinition((WorkflowStep("compare", spec),)),
    )
    decision = (await asyncio.to_thread(controller.decision)).as_dict()
    parent, _ = load_session(workspace, run_id)
    parent_value = parent.read_model.as_dict()
    work = WorkItem.restore(factory.repository, run_id + ":work")
    result = {
        "registry_root": str(registry_root),
        "registry_record_count": len(records),
        "child_state": child.retained(),
        "decision": decision,
        "parent_events": [event.as_dict() for event in parent.events],
        "parent_read_model": parent_value,
        "work_events": [event.as_dict() for event in work.events],
        "joined_count": sum(event.kind == "child.joined" for event in work.events),
        "attempt_count": sum(event.kind == "attempt.started" for event in work.events),
        "annotation_events": [event.as_dict() for event in parent.events if event.kind == "annotation"],
        "generation_sequence": list(parent.generation_sequence),
        "trajectory_segments": [dict(item) for item in parent.trajectory_segments],
        "effective_context": None if parent.effective_context is None else parent.effective_context.decode(),
        "raw_fact_ids": list(parent.raw_fact_ids),
        "terminal_outcome": parent_value["terminal_outcome"],
    }
    joined = [event for event in work.events if event.kind == "child.joined"]
    if len(joined) == 1:
        child_session, _ = load_session(workspace, joined[0].payload["child_session_id"])
        result["child_session_events"] = [event.as_dict() for event in child_session.events]
        result["child_session_read_model"] = child_session.read_model.as_dict()
        result["child_completed_count"] = sum(event.kind == "session.completed" for event in child_session.events)
        result["child_parent_session_id"] = child_session.read_model.lineage.parent_session_id if child_session.read_model.lineage else None
        world_result = json.loads(
            read_workspace_artifact(workspace, workspace_artifact_ref(workspace, child.result_refs[0]))
        )
        result["execution_evidence"] = world_result["execution_evidence"]
    report_id = None
    if parent.read_model.terminal_outcome is not None:
        report_id = parent.read_model.terminal_outcome.get("summary")
    if isinstance(report_id, str):
        report = json.loads(read_workspace_artifact(workspace, workspace_artifact_ref(workspace, report_id)))
        result["report"] = report
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))

asyncio.run(inspect_state())
"""


class _DarwinProcBsdInfo(ctypes.Structure):
    _fields_ = [
        ("pbi_flags", ctypes.c_uint32),
        ("pbi_status", ctypes.c_uint32),
        ("pbi_xstatus", ctypes.c_uint32),
        ("pbi_pid", ctypes.c_uint32),
        ("pbi_ppid", ctypes.c_uint32),
        ("pbi_uid", ctypes.c_uint32),
        ("pbi_gid", ctypes.c_uint32),
        ("pbi_ruid", ctypes.c_uint32),
        ("pbi_rgid", ctypes.c_uint32),
        ("pbi_svuid", ctypes.c_uint32),
        ("pbi_svgid", ctypes.c_uint32),
        ("rfu_1", ctypes.c_uint32),
        ("pbi_comm", ctypes.c_char * 16),
        ("pbi_name", ctypes.c_char * 32),
        ("pbi_nfiles", ctypes.c_uint32),
        ("pbi_pgid", ctypes.c_uint32),
        ("pbi_pjobc", ctypes.c_uint32),
        ("e_tdev", ctypes.c_uint32),
        ("e_tpgid", ctypes.c_uint32),
        ("pbi_nice", ctypes.c_int32),
        ("pbi_start_tvsec", ctypes.c_uint64),
        ("pbi_start_tvusec", ctypes.c_uint64),
    ]


def load_installed_helpers() -> Any:
    helper_path = Path(__file__).with_name("installed-product-journey.py")
    spec = importlib.util.spec_from_file_location(
        "installed_product_journey", helper_path
    )
    if spec is None or spec.loader is None:
        raise JourneyFailure(f"cannot load installed journey helpers: {helper_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def process_start_token(pid: int) -> str | int | None:
    if sys.platform.startswith("linux"):
        try:
            data = Path(f"/proc/{pid}/stat").read_bytes()
            boot_id = (
                Path("/proc/sys/kernel/random/boot_id")
                .read_text(encoding="ascii")
                .strip()
            )
        except OSError:
            return None
        fields = data[data.rfind(b")") + 1 :].split()
        if len(fields) <= 19:
            return None
        try:
            return f"{boot_id}:{int(fields[19])}"
        except ValueError:
            return None
    if sys.platform == "darwin":
        try:
            libproc = ctypes.CDLL("libproc.dylib", use_errno=True)
            proc_pidinfo = libproc.proc_pidinfo
            proc_pidinfo.argtypes = [
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_uint64,
                ctypes.c_void_p,
                ctypes.c_int,
            ]
            proc_pidinfo.restype = ctypes.c_int
            info = _DarwinProcBsdInfo()
            size = ctypes.sizeof(info)
            if proc_pidinfo(pid, 3, 0, ctypes.byref(info), size) != size:
                return None
            if info.pbi_start_tvsec == 0 or info.pbi_start_tvusec >= 1_000_000:
                return None
            return f"darwin:{info.pbi_start_tvsec}:{info.pbi_start_tvusec}"
        except OSError:
            return None
    return None


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise JourneyFailure(f"cannot read JSON {path}: {error}") from error


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def run_source_program(
    program: str,
    args: list[str],
    *,
    engine_root: Path,
    cwd: Path,
    stdout_path: Path,
    stderr_path: Path,
    timeout: float,
) -> subprocess.CompletedProcess[str]:
    home = cwd.parent / "home"
    home.mkdir(mode=0o700, exist_ok=True)
    environment = {
        "HOME": str(home.resolve()),
        "PATH": os.defpath,
        "PYTHONPATH": str(engine_root),
        "RAY_SCE_LOCAL_MODE": "1",
        # The verified service omits HOME. Match its OS-user Session authority,
        # while the fixture's provider state remains under the isolated HOME.
        "BREADBOARD_SESSION_AUTHORITY_ROOT": str(
            Path(pwd.getpwuid(os.getuid()).pw_dir) / ".breadboard" / "session-authority"
        ),
    }
    with stdout_path.open("w", encoding="utf-8") as stdout, stderr_path.open(
        "w", encoding="utf-8"
    ) as stderr:
        completed = subprocess.run(
            [sys.executable, "-c", program, *args],
            cwd=cwd,
            env=environment,
            text=True,
            stdout=stdout,
            stderr=stderr,
            timeout=timeout,
            check=False,
        )
    if completed.returncode != 0:
        raise JourneyFailure(
            f"source setup/inspection failed with exit {completed.returncode}; "
            f"stdout={stdout_path} stderr={stderr_path}"
        )
    return completed


def invoke_inspector(
    *,
    workspace: Path,
    agent_root: Path,
    run_id: str,
    engine_root: Path,
    output: Path,
    label: str,
    timeout: float,
) -> dict[str, Any]:
    stdout_path = output / f"{label}-inspector.stdout.txt"
    stderr_path = output / f"{label}-inspector.stderr.txt"
    run_source_program(
        INSPECT_PROGRAM,
        [str(workspace), str(agent_root), run_id],
        engine_root=engine_root,
        cwd=workspace,
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        timeout=timeout,
    )
    try:
        lines = [
            line
            for line in stdout_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        if not lines:
            raise ValueError("inspector emitted no JSON")
        value = json.loads(lines[-1])
    except (OSError, json.JSONDecodeError, ValueError) as error:
        raise JourneyFailure(
            f"{label} inspector emitted invalid JSON: {error}"
        ) from error
    if not isinstance(value, dict):
        raise JourneyFailure(f"{label} inspector emitted a non-object")
    return value


def wait_until(
    predicate: Any, timeout: float, label: str, interval: float = 0.05
) -> Any:
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value is not None and value is not False:
            return value
        if time.monotonic() >= deadline:
            raise JourneyFailure(f"timed out waiting for {label}")
        time.sleep(interval)


def command_result(stdout_path: Path, stderr_path: Path, label: str) -> dict[str, Any]:
    try:
        lines = [
            line
            for line in stdout_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
    except OSError as error:
        raise JourneyFailure(f"{label} stdout is unavailable: {error}") from error
    if not lines:
        stderr = stderr_path.read_text(encoding="utf-8", errors="replace")
        raise JourneyFailure(f"{label} emitted no JSON result; stderr={stderr}")
    try:
        value = json.loads(lines[-1])
    except json.JSONDecodeError as error:
        raise JourneyFailure(f"{label} emitted invalid JSON: {error}") from error
    if not isinstance(value, dict):
        raise JourneyFailure(f"{label} result is not an object")
    return value


def process_command(
    command: list[str],
    workspace: Path,
    environment: dict[str, str],
    output: Path,
    label: str,
) -> tuple[subprocess.Popen[bytes], Any, Any]:
    stdout = (output / f"{label}.stdout.txt").open("wb")
    stderr = (output / f"{label}.stderr.txt").open("wb")
    try:
        process = subprocess.Popen(
            command, cwd=workspace, env=environment, stdout=stdout, stderr=stderr
        )
    except BaseException:
        stdout.close()
        stderr.close()
        raise
    return process, stdout, stderr


def wait_process(process: subprocess.Popen[bytes], timeout: float, label: str) -> int:
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise JourneyFailure(
            f"timed out waiting for {label} (pid {process.pid})"
        ) from error


def slurm_gate_command(
    world: dict[str, Any], command: str
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [world["ssh_program"], world["ssh_target"], command],
        env={"PATH": os.defpath},
        capture_output=True,
        text=True,
        timeout=world["command_timeout_ms"] / 1000,
    )
    if result.returncode != 0:
        raise JourneyFailure(f"Slurm gate command failed: {result.stderr}")
    return result


def world_gate_started(world: dict[str, Any], path: Path) -> bool:
    if world["kind"] == "slurm":
        result = slurm_gate_command(
            world, f"if test -f {shlex.quote(str(path))}; then printf started; fi"
        )
        return result.stdout == "started"
    return path.exists()


def release_world_gate(world: dict[str, Any], path: Path) -> None:
    if world["kind"] == "slurm":
        slurm_gate_command(world, f"touch {shlex.quote(str(path))}")
    else:
        path.touch(exist_ok=True)


def copy_world_input(
    world_path: Path, workspace: Path, run_root: Path
) -> tuple[Path, dict[str, Any], Path, Path]:
    try:
        world = json.loads(world_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise JourneyFailure(f"world configuration is not JSON: {error}") from error
    if not isinstance(world, dict):
        raise JourneyFailure("world configuration must be an object")
    if world.get("kind") not in WORLD_KINDS:
        raise JourneyFailure(f"world.kind must be one of {WORLD_KINDS}")
    if world.get("field_mask") != MASK:
        raise JourneyFailure(
            "world.field_mask must be exactly ['/occurred_at','/timestamp']"
        )
    python = world.get("python")
    if not isinstance(python, str) or not python:
        raise JourneyFailure("world must declare its Python executable")
    world_for_run = dict(world)
    if world["kind"] == "container":
        storage_root = workspace
        execution_root = Path(world["workspace_mount_target"])
    elif world["kind"] == "slurm":
        storage_root = Path(world["remote_evidence_directory"]) / run_root.name
        execution_root = storage_root
        world_for_run["remote_evidence_directory"] = str(storage_root)
    else:
        storage_root = execution_root = run_root
    gate_started = storage_root / "world-started"
    gate_release = storage_root / "world-release"
    gate_python = storage_root / "world-gated-python"
    gate_program = (
        "#!/bin/sh\n"
        "set -eu\n"
        f"printf '%s\\n' \"${{SLURM_JOB_ID:-$$}}\" > {shlex.quote(str(execution_root / 'world-started'))}\n"
        f"while [ ! -e {shlex.quote(str(execution_root / 'world-release'))} ]; do sleep 0.02; done\n"
        f'exec {shlex.quote(python)} "$@"\n'
    )
    if world["kind"] == "slurm":
        slurm_gate_command(
            world_for_run,
            f"set -eu; umask 077; mkdir -p {shlex.quote(str(storage_root.parent))}; "
            f"mkdir {shlex.quote(str(storage_root))}; "
            f"printf %s {shlex.quote(gate_program)} > {shlex.quote(str(gate_python))}; "
            f"chmod 700 {shlex.quote(str(gate_python))}",
        )
    else:
        gate_python.write_text(gate_program, encoding="utf-8")
        gate_python.chmod(0o700)
    world_for_run["python"] = str(execution_root / gate_python.name)
    run_world = workspace / "WORLD-under-test.json"
    write_json(run_world, world_for_run)
    return run_world, world_for_run, gate_started, gate_release


def finish_slurm_world(
    world: dict[str, Any], marker: Path, evidence: list[dict[str, Any]]
) -> dict[str, Any]:
    job_id = evidence[-1]["executionId"].split("@", 1)[0]
    if not job_id.isascii() or not job_id.isdigit():
        raise JourneyFailure("Slurm execution has no numeric scheduler identity")
    observed_id = slurm_gate_command(
        world, f"cat {shlex.quote(str(marker))}"
    ).stdout.strip()
    if observed_id != job_id:
        raise JourneyFailure(
            "Slurm gate and execution evidence identify different jobs"
        )
    accounting = slurm_gate_command(
        world,
        f"sacct -n -P -X -j {job_id} "
        "--format=JobIDRaw,State,ExitCode,AllocCPUS,ReqMem,Timelimit,WorkDir%500",
    ).stdout
    rows = [line.split("|") for line in accounting.splitlines() if line.strip()]
    if len(rows) != 1 or len(rows[0]) != 7:
        raise JourneyFailure(
            f"Slurm accounting did not return one complete job record: {accounting}"
        )
    actual_id, state, exit_code, cpus, memory, time_limit, workdir = rows[0]
    if (actual_id, state, exit_code, workdir) != (
        job_id,
        "COMPLETED",
        "0:0",
        world["remote_evidence_directory"],
    ):
        raise JourneyFailure(
            f"Slurm job has not completed in its owned workspace: {accounting}"
        )
    slurm_gate_command(world, f"rm -rf -- {shlex.quote(workdir)}")
    return {
        "job_id": job_id,
        "state": state,
        "exit_code": exit_code,
        "allocated_cpus": int(cpus),
        "requested_memory": memory,
        "time_limit": time_limit,
        "owned_workspace_removed": workdir,
    }


def authenticate_controller(
    helpers: Any,
    process: subprocess.Popen[bytes],
    agent_root: Path,
    engine_root: Path,
) -> dict[str, Any]:
    authority_record = helpers.active_authority(agent_root)
    if authority_record is None:
        raise JourneyFailure(
            "local kill gate requires the installed engine's managed authority record; "
            "no authenticated authority appeared under the isolated agent root"
        )
    authority_path, authority = authority_record
    try:
        pid = int(authority["pid"])
        expected_token = authority["osProcessStartToken"]
    except (KeyError, TypeError, ValueError) as error:
        raise JourneyFailure(
            f"managed authority has invalid process identity: {error}"
        ) from error
    actual_token = process_start_token(pid)
    if actual_token is None or str(actual_token) != str(expected_token):
        raise JourneyFailure(
            "managed authority PID/start-token identity did not verify"
        )
    if not process_alive(pid):
        raise JourneyFailure("managed authority engine PID is not alive")
    snapshot = helpers.process_snapshot(pid)
    snapshot_text = json.dumps(snapshot, sort_keys=True)
    if engine_root.as_posix() in snapshot_text:
        raise JourneyFailure(
            "installed controller process contains the source checkout path"
        )
    if pid == process.pid:
        role = "installed-engine-controller"
    else:
        role = "managed-engine-controller"
    return {
        "pid": pid,
        "start_token": expected_token,
        "authority_path": str(authority_path),
        "identity": helpers.authority_identity(authority),
        "role": role,
    }


def assert_report_and_owners(
    state: dict[str, Any],
    oracle: dict[str, Any],
    held_request: bytes,
    held_wire: bytes,
    *,
    run_id: str,
    report_id: str,
) -> None:
    if (
        oracle.get("event_kinds") != EXPECTED_EVENT_KINDS
        or oracle.get("compaction_count") != 3
    ):
        raise JourneyFailure("pre-operation oracle does not contain three compactions")
    if (
        oracle.get("effective_context") != EXPECTED_CONTEXT
        or oracle.get("raw_fact_ids") != EXPECTED_FACTS
    ):
        raise JourneyFailure("pre-operation context oracle changed")
    if state.get("generation_sequence") != oracle.get("generation_sequence"):
        raise JourneyFailure("generation sequence changed across operation")
    annotations = state.get("annotation_events")
    if not isinstance(annotations, list) or len(annotations) != 1:
        raise JourneyFailure("expected exactly one immutable annotation")
    annotation = annotations[0].get("payload", {})
    if annotation.get("author") != "research.compare" or annotation.get(
        "generation"
    ) != state.get("parent_read_model", {}).get("effective_lock_hash"):
        raise JourneyFailure(
            "comparison annotation is not bound to the accepted generation"
        )
    if state.get("joined_count") != 1 or state.get("child_completed_count") != 1:
        raise JourneyFailure("expected exactly one child join and one child settlement")
    if state.get("child_parent_session_id") != run_id:
        raise JourneyFailure("child lineage does not point at the research run")
    report = state.get("report")
    if (
        not isinstance(report, dict)
        or report.get("equivalent") is not True
        or report.get("differences") != []
    ):
        raise JourneyFailure("research report did not prove equivalence")
    records = report.get("records")
    if not isinstance(records, list) or len(records) != 2:
        raise JourneyFailure("research report does not contain exactly two records")
    canonical_held_request = held_request
    try:
        held_out_value = json.loads(held_wire)
    except json.JSONDecodeError as error:
        raise JourneyFailure(
            f"held-out OpenAI SDK request was not JSON: {error}"
        ) from error
    canonical_wire = json.dumps(
        held_out_value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode()
    if canonical_wire != canonical_held_request:
        raise JourneyFailure("held-out OpenAI SDK request was not captured canonically")
    if not held_wire:
        raise JourneyFailure("held-out OpenAI SDK request bytes are empty")
    for record in records:
        if record.get("request_body", "").encode() != canonical_held_request:
            raise JourneyFailure(
                "report request projection differs from held-out SDK request bytes"
            )
        if record.get("raw_fact_ids") != EXPECTED_FACTS:
            raise JourneyFailure("report lost one or more retained raw facts")
        if record.get("effective_context") != EXPECTED_CONTEXT:
            raise JourneyFailure("report effective context differs from exact oracle")
        if record.get("generation_sequence") != oracle["generation_sequence"]:
            raise JourneyFailure("report changed the recorded generation sequence")
        if record.get("trajectory_segments") != oracle["trajectory_segments"]:
            raise JourneyFailure("report changed the recorded trajectory segments")
        if record.get("projection") != oracle["projection"]:
            raise JourneyFailure(
                "report projection differs from the pre-operation live owner"
            )
        expected_events = [
            {key: value for key, value in event.items() if "/" + key not in MASK}
            for event in oracle["events"]
        ]
        if record.get("events") != expected_events:
            raise JourneyFailure(
                "report changed recorded events outside the declared mask"
            )
    if state.get("terminal_outcome", {}).get("summary") != report_id:
        raise JourneyFailure("report identity is not the parent terminal summary")


def cleanup_process(
    process: subprocess.Popen[bytes] | None,
    output_streams: tuple[Any, Any] | None,
    timeout: float,
) -> None:
    if process is not None and process.poll() is None:
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=timeout)
    if output_streams is not None:
        for stream in output_streams:
            stream.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run installed bb research compare acceptance journey"
    )
    parser.add_argument(
        "--bb", type=Path, required=True, help="freshly built installed bb executable"
    )
    parser.add_argument(
        "--engine-root",
        type=Path,
        required=True,
        help="source engine root used only by fixture/owner probes",
    )
    parser.add_argument(
        "--temp-root",
        type=Path,
        required=True,
        help="empty directory for isolated runtime and retained evidence",
    )
    parser.add_argument(
        "--world",
        type=Path,
        required=True,
        help="world configuration input (local/container/ray/slurm)",
    )
    parser.add_argument("--startup-timeout", type=float, default=30.0)
    parser.add_argument("--turn-timeout", type=float, default=120.0)
    options = parser.parse_args()
    if sys.version_info < (3, 11):
        raise JourneyFailure("research compare journey requires Python 3.11+")
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
    helpers = load_installed_helpers()
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
    write_json(
        output / "environment.json",
        {
            "keys": sorted(environment),
            "values": {
                key: ("<redacted>" if "TOKEN" in key or "KEY" in key else value)
                for key, value in environment.items()
            },
            "source_root_excluded": str(engine_root) not in json.dumps(environment),
        },
    )
    if any(
        key.startswith(("OPENAI_", "ANTHROPIC_", "GOOGLE_", "GEMINI_"))
        for key in environment
    ):
        raise JourneyFailure(
            "installed environment unexpectedly contains provider credentials"
        )
    fixture_stdout = output / "fixture.stdout.txt"
    fixture_stderr = output / "fixture.stderr.txt"
    run_source_program(
        FIXTURE_PROGRAM,
        [str(workspace)],
        engine_root=engine_root,
        cwd=workspace,
        stdout_path=fixture_stdout,
        stderr_path=fixture_stderr,
        timeout=options.turn_timeout,
    )
    oracle = read_json(workspace / "pre-operation-oracle.json")
    held_request = (workspace / "held-out-request.json").read_bytes()
    held_wire = (workspace / "held-out-wire.json").read_bytes()
    world_path, world, gate_started, gate_release = copy_world_input(
        world_input, workspace, run_root
    )
    if str(engine_root) in json.dumps(world, sort_keys=True):
        raise JourneyFailure(
            "world configuration would expose the source checkout to the installed process"
        )
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
    second: subprocess.Popen[bytes] | None = None
    second_streams: tuple[Any, Any] | None = None
    third: subprocess.Popen[bytes] | None = None
    third_streams: tuple[Any, Any] | None = None
    slurm_cleaned = False
    try:
        first, first_stdout, first_stderr = process_command(
            command, workspace, environment, output, "first"
        )
        first_streams = (first_stdout, first_stderr)

        def gate_ready() -> bool:
            if first.poll() is not None:
                raise JourneyFailure(
                    f"installed compare exited {first.returncode} before its world started; "
                    f"stderr={output / 'first.stderr.txt'}"
                )
            return world_gate_started(world, gate_started)

        wait_until(gate_ready, options.startup_timeout, "world gate start")
        discovered = wait_until(
            lambda: next(
                (
                    candidate.parent.name
                    for candidate in workspace.glob(
                        ".breadboard/sessions/research-*/session_events.jsonl"
                    )
                ),
                None,
            ),
            options.startup_timeout,
            "durable research run",
        )
        run_id = str(discovered)
        before = wait_until(
            lambda: (
                invoke_inspector(
                    workspace=workspace,
                    agent_root=agent,
                    run_id=run_id,
                    engine_root=engine_root,
                    output=output,
                    label="before-kill",
                    timeout=options.startup_timeout,
                )
                if _inspector_wait_ready(workspace, agent, run_id, engine_root, output)
                else None
            ),
            options.startup_timeout,
            "workflow wait before kill",
            0.2,
        )
        if (
            before["decision"].get("action") != "wait"
            or before["decision"].get("active_step_ids") != ["compare"]
            or before["decision"].get("completed_step_ids") != []
        ):
            raise JourneyFailure(
                f"workflow was not waiting at kill gate: {before['decision']}"
            )
        controller = authenticate_controller(helpers, first, agent, engine_root)
        controller_pid = int(controller["pid"])
        if str(process_start_token(controller_pid)) != str(controller["start_token"]):
            raise JourneyFailure(
                "authenticated controller identity stopped before kill"
            )
        os.kill(controller_pid, signal.SIGKILL)
        wait_until(
            lambda: not process_alive(controller_pid),
            options.startup_timeout,
            "authenticated controller death",
        )
        if first.poll() is None:
            try:
                first.wait(timeout=5.0)
            except subprocess.TimeoutExpired:
                first.terminate()
                first.wait(timeout=5.0)
        first_streams[0].flush()
        first_streams[1].flush()
        print("KILL", json.dumps(controller, sort_keys=True))
        second, second_stdout, second_stderr = process_command(
            command, workspace, environment, output, "restart"
        )
        second_streams = (second_stdout, second_stderr)

        def replacement_ready() -> dict[str, Any] | None:
            candidate = helpers.active_authority(agent)
            if candidate is None:
                return None
            _, authority = candidate
            if (
                authority["pid"] == controller["pid"]
                and authority["osProcessStartToken"] == controller["start_token"]
            ):
                return None
            return authenticate_controller(helpers, second, agent, engine_root)

        replacement = wait_until(
            replacement_ready,
            options.startup_timeout,
            "authenticated replacement controller",
        )
        print("RESTART", json.dumps(replacement, sort_keys=True))
        after = wait_until(
            lambda: (
                invoke_inspector(
                    workspace=workspace,
                    agent_root=agent,
                    run_id=run_id,
                    engine_root=engine_root,
                    output=output,
                    label="after-restart",
                    timeout=options.startup_timeout,
                )
                if _inspector_wait_ready(workspace, agent, run_id, engine_root, output)
                else None
            ),
            options.startup_timeout,
            "workflow wait after restart",
            0.2,
        )
        if after["decision"] != before["decision"]:
            raise JourneyFailure("restart changed the retained wait decision")
        release_world_gate(world, gate_release)
        second_exit = wait_process(
            second, options.turn_timeout, "installed restart command"
        )
        second_streams[0].flush()
        second_streams[1].flush()
        if second_exit != 0:
            raise JourneyFailure(f"installed restart command exited {second_exit}")
        second_result = command_result(
            output / "restart.stdout.txt", output / "restart.stderr.txt", "restart"
        )
        print("RESULT restart", json.dumps(second_result, sort_keys=True))
        data = second_result.get("data")
        if not isinstance(data, dict) or set(data) != {"run_id", "report_id"}:
            raise JourneyFailure(
                f"result data is not {run_id, 'report_id'}: {second_result}"
            )
        if str(data["run_id"]) != run_id:
            raise JourneyFailure("result run_id differs from durable parent identity")
        report_id = str(data["report_id"])
        if not run_id or not report_id:
            raise JourneyFailure("PublicResult identities must be non-empty")
        completed_state = invoke_inspector(
            workspace=workspace,
            agent_root=agent,
            run_id=run_id,
            engine_root=engine_root,
            output=output,
            label="completed",
            timeout=options.startup_timeout,
        )
        if (
            completed_state["decision"].get("action") != "complete"
            or completed_state["decision"].get("active_step_ids") != []
            or completed_state["decision"].get("completed_step_ids") != ["compare"]
        ):
            raise JourneyFailure(
                f"workflow did not complete: {completed_state['decision']}"
            )
        assert_report_and_owners(
            completed_state,
            oracle,
            held_request,
            held_wire,
            run_id=run_id,
            report_id=report_id,
        )
        baseline_parent_events = completed_state["parent_events"]
        baseline_work_events = completed_state["work_events"]
        third, third_stdout, third_stderr = process_command(
            command, workspace, environment, output, "resume"
        )
        third_streams = (third_stdout, third_stderr)
        third_exit = wait_process(
            third, options.turn_timeout, "identical resume command"
        )
        third_streams[0].flush()
        third_streams[1].flush()
        if third_exit != 0:
            raise JourneyFailure(f"identical resume command exited {third_exit}")
        third_result = command_result(
            output / "resume.stdout.txt", output / "resume.stderr.txt", "resume"
        )
        print("RESULT resume", json.dumps(third_result, sort_keys=True))
        if third_result.get("data") != data:
            raise JourneyFailure(
                "identical inputs did not return the same run/report IDs"
            )
        resumed_state = invoke_inspector(
            workspace=workspace,
            agent_root=agent,
            run_id=run_id,
            engine_root=engine_root,
            output=output,
            label="resumed",
            timeout=options.startup_timeout,
        )
        if (
            resumed_state["parent_events"] != baseline_parent_events
            or resumed_state["work_events"] != baseline_work_events
        ):
            raise JourneyFailure("identical resume appended owner events")
        if resumed_state.get("attempt_count") != completed_state.get("attempt_count"):
            raise JourneyFailure("identical resume changed the owner attempt/run count")
        assert_report_and_owners(
            resumed_state,
            oracle,
            held_request,
            held_wire,
            run_id=run_id,
            report_id=report_id,
        )
        summary = {
            "status": "pass",
            "run_id": run_id,
            "report_id": report_id,
            "world": {
                "kind": world["kind"],
                "field_mask": world["field_mask"],
                "execution_workspace": (
                    world.get("remote_evidence_directory")
                    if world["kind"] == "slurm"
                    else (
                        world.get("workspace_mount_target")
                        if world["kind"] == "container"
                        else str(workspace)
                    )
                ),
            },
            "invocation": shlex.join(command),
            "kill_gate": {
                "exercised": True,
                "controller": controller,
                "replacement": replacement,
            },
            "execution_evidence": resumed_state["execution_evidence"],
            "acceptance": {
                "definition_generation_trajectory": True,
                "three_compactions": True,
                "context_oracle": True,
                "held_out_openai_request_bytes": True,
                "projection_replay": True,
                "annotation": True,
                "single_child_join_settlement": True,
                "identical_resume_same_ids": True,
                "owner_events_unchanged": True,
                "isolated_agent_registry": resumed_state["registry_root"],
            },
            "evidence_directory": str(output),
        }
        if world["kind"] == "slurm":
            summary["scheduler_cleanup"] = finish_slurm_world(
                world, gate_started, resumed_state["execution_evidence"]
            )
            slurm_cleaned = True
        write_json(output / "journey-summary.json", summary)
        print(json.dumps(summary, sort_keys=True))
        return 0
    finally:
        try:
            if not slurm_cleaned:
                release_world_gate(world, gate_release)
        finally:
            cleanup_process(third, third_streams, 5.0)
            cleanup_process(second, second_streams, 5.0)
            cleanup_process(first, first_streams, 5.0)


def _inspector_wait_ready(
    workspace: Path, agent: Path, run_id: str, engine_root: Path, output: Path
) -> bool:
    try:
        state = invoke_inspector(
            workspace=workspace,
            agent_root=agent,
            run_id=run_id,
            engine_root=engine_root,
            output=output,
            label="wait-probe",
            timeout=10.0,
        )
    except JourneyFailure:
        return False
    return state.get("decision", {}).get("action") == "wait"


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except JourneyFailure as error:
        print(f"research compare journey failed: {error}", file=sys.stderr)
        raise SystemExit(1)
