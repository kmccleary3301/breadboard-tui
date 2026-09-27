#!/usr/bin/env python3
"""Provider-free E2 everyday interaction journey.

This runner deliberately drives the installed product only through a PTY. It
records each requested interaction even when a prerequisite is unavailable, so
an absent fixture is an explicit UNKNOWN rather than a silently skipped row.
"""
from __future__ import annotations
import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime
from typing import Any, Iterator

RUNNER_PATH = Path(__file__).with_name("installed-product-journey.py")
SPEC = importlib.util.spec_from_file_location("installed_product_journey", RUNNER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"cannot import journey runner: {RUNNER_PATH}")
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)
JourneyFailure = runner.JourneyFailure

CLEANUP_PATH = Path(__file__).with_name("cancel-recovery-journey.py")
CLEANUP_SPEC = importlib.util.spec_from_file_location("cancel_recovery_journey", CLEANUP_PATH)
if CLEANUP_SPEC is None or CLEANUP_SPEC.loader is None:
    raise RuntimeError(f"cannot import cleanup runner: {CLEANUP_PATH}")
cleanup_runner = importlib.util.module_from_spec(CLEANUP_SPEC)
sys.modules[CLEANUP_SPEC.name] = cleanup_runner
CLEANUP_SPEC.loader.exec_module(cleanup_runner)


def load_launch_lock(path: Path) -> Any:
    spec = importlib.util.spec_from_file_location("installed_candidate_lock", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import launch lock: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


CONVENTIONS = {
    "compose": "decision.md:23-27,59-73",
    "history": "decision.md:26,68",
    "focus": "decision.md:28-30,70",
    "transcript": "decision.md:40-43,77",
    "tools": "decision.md:42-43,79",
    "approval": "decision.md:48-50,80",
    "slash": "decision.md:34-36,74-76",
    "unicode": "decision.md:54-56,67",
}

EXPECTED_NEW_GUARD_REASON = (
    "BreadBoard cannot start a new OMP session while the current E4 session is "
    "bound to this OMP transcript; the current E4 SDK cannot atomically rebind "
    "the bridge to the requested transcript."
)

CONTINUATION_P1_STEPS = frozenset({
    "approval-allow-tool-runs",
    "slash-new-clears-and-new-identity",
})


def mkdir0700(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path, 0o700)


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def safe_text(value: str) -> str:
    return value.replace("\x1b", "<ESC>")


def first_visible_text(screen: str) -> str | None:
    ignored_prefixes = ("•", "└", "├", "│", "⟦", "⎋", "⠁", "⠂", "⠄", "⠈", "⠐", "⠠", "╰", "Tip:")
    for line in screen.splitlines():
        text = line.strip()
        if text and not text.startswith(ignored_prefixes):
            return text
    return None


def visible_transcript_position(screen: str) -> dict[str, int] | None:
    turns = [int(match) for match in re.findall(r"\btranscript turn (\d{2})\b", screen)]
    if not turns:
        return None
    return {"first": turns[0], "last": turns[-1]}


def return_tail_details(capture: Path, screen: str, expected_tail: str) -> dict[str, Any]:
    position = visible_transcript_position(screen)
    return {
        "returnCapture": str(capture),
        "tailPosition": position,
        "expectedTail": expected_tail,
        "tailReached": position is not None and position["last"] == int(expected_tail[-2:]),
    }


def composer_line(screen: str) -> str:
    """Return the most recent compact-editor row rendered by the TUI."""
    for line in reversed(screen.splitlines()):
        if line.lstrip().startswith("╰─"):
            return line
    return ""


def composer_text(screen: str) -> str | None:
    line = composer_line(screen)
    if not line:
        return None
    return line.lstrip()[2:].strip()


def composer_is_empty(screen: str) -> bool:
    text = composer_text(screen)
    return text == "" if text is not None else False


def screen_turn_state(child: Any, agent_root: Path) -> dict[str, Any]:
    """Use both visible working status and the retained binding when available."""
    screen = child.screen.text()
    snapshot = runner.binding_snapshot(agent_root)
    active_turn_id = (
        snapshot.data.get("activeTurnId")
        if snapshot is not None and isinstance(snapshot.data.get("activeTurnId"), str)
        else None
    )
    # Only inspect the screen tail: earlier transcript rows can retain old
    # Working cards after the turn has settled.
    tail = screen.splitlines()[-8:]
    working_cue = any(
        token in line.lower() for line in tail for token in ("working", "[esc]")
    )
    return {
        "active": bool(active_turn_id) or working_cue,
        "activeTurnId": active_turn_id,
        "workingCue": working_cue,
        "screenTail": safe_text("\n".join(tail)),
    }


def diagnostic_visibility(child: Any, expected: str) -> dict[str, Any]:
    """Distinguish the captured terminal grid from raw off-grid output."""
    screen = child.screen.text()
    normalized = runner.normalized_transcript(bytes(child.raw))
    screen_has_expected = expected in screen
    raw_has_expected = expected in normalized
    return {
        "screenHasExpected": screen_has_expected,
        "rawTranscriptHasExpected": raw_has_expected,
        "renderedOutsideScreenCapture": raw_has_expected and not screen_has_expected,
        "errorRegion": (
            "screen"
            if screen_has_expected
            else "raw-transcript-only"
            if raw_has_expected
            else "absent"
        ),
    }


def retained_binding_facts(snapshot: Any) -> dict[str, Any]:
    if snapshot is None:
        raise JourneyFailure("terminal state has no retained binding snapshot")
    return runner.transcript_facts(snapshot.rows)


def extract_local_session_id(rows: list[dict[str, Any]]) -> str | None:
    """Extract local durable session ID from actual JSONL session header.
    
    The session header may follow a title entry at line 1.
    binding.data.sessionId is the engine session ID, not the local ID.
    """
    for row in rows:
        if row.get("type") == "session" and isinstance(row.get("id"), str):
            return row["id"]
    return None


def extract_engine_session_id(snapshot: Any) -> str | None:
    """Extract engine session ID from v4 binding data."""
    if snapshot is None or not hasattr(snapshot, "data") or not isinstance(snapshot.data, dict):
        return None
    session_id = snapshot.data.get("sessionId")
    return str(session_id) if session_id is not None else None


def engine_get(endpoint: str, path: str) -> tuple[int, Any, str | None]:
    request = urllib.request.Request(endpoint.rstrip("/") + path, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=2.0) as response:
            raw = response.read()
            status = int(response.status)
    except urllib.error.HTTPError as error:
        return int(error.code), None, str(error)
    try:
        return status, json.loads(raw.decode("utf-8")), None
    except (UnicodeDecodeError, json.JSONDecodeError):
        events: list[dict[str, Any]] = []
        for line in raw.decode("utf-8", "replace").splitlines():
            if not line.startswith("data:"):
                continue
            try:
                value = json.loads(line[5:].strip())
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
        return status, events, None


def engine_session_events(endpoint: str, session_id: str) -> dict[str, Any]:
    encoded = urllib.parse.quote(session_id, safe="")
    session_status, session, session_error = engine_get(
        endpoint, f"/v1/sessions/{encoded}"
    )
    event_status, events, event_error = engine_get(
        endpoint, f"/v1/sessions/{encoded}/events?replay=true"
    )
    if session_status == 404:
        session_status, session, session_error = engine_get(
            endpoint, f"/v1/internal/sessions/{encoded}"
        )
    if event_status == 404:
        event_status, events, event_error = engine_get(
            endpoint, f"/v1/internal/sessions/{encoded}/events?replay=true"
        )
    if isinstance(events, dict):
        events = events.get("events", [])
    if not isinstance(events, list):
        events = []
    return {
        "sessionStatus": session_status,
        "eventStatus": event_status,
        "session": session,
        "events": [event for event in events if isinstance(event, dict)],
        "sessionError": session_error,
        "eventError": event_error,
    }


def determine_journey_exit_code(
    sessions: list[dict[str, Any]],
    records: list[dict[str, Any]],
    required_steps: frozenset[str] = CONTINUATION_P1_STEPS,
) -> int:
    """Propagate required nonzero/signaled child exits and continuation P1 failures."""
    for s in sessions:
        code = s.get("tuiExitCode")
        if code is not None and code != 0:
            return 128 + abs(code) if code < 0 else int(code)
        if (
            s.get("engineExited") is not None
            and not s.get("engineExited", {}).get("observed", False)
        ):
            return 1
        if s.get("engineCleanupForced") is True:
            return 1
        if s.get("endpointClosed") is False:
            return 1
        if s.get("engineTargetAuthenticated") is False:
            return 1
        if s.get("unownedListenerPids"):
            return 1

    for step in records:
        if step.get("status") == "FAIL":
            return 1
        if step.get("step") in required_steps and step.get("status") != "PASS":
            return 1

    return 0


def physical_allow_evidence(agent_root: Path, workspace: Path, binding: Any) -> dict[str, Any]:
    session_id = binding.data["sessionId"]
    journals = list(agent_root.rglob(f"session-events/{session_id}/session_events.jsonl"))
    if len(journals) != 1:
        raise JourneyFailure("Allow requires exactly one journal for the bound engine session")
    events = runner.parse_jsonl(journals[0])
    inputs = [event for event in events if event["kind"] == "input.accepted"]
    requested = [event for event in events if event["kind"] == "approval.requested" and event["payload"].get("operation") == "shell"]
    resolved = [event for event in events if event["kind"] == "approval.resolved" and event["payload"].get("decision") == "once"]
    product_results = [event for event in events if event["kind"] == "tool_result" and event["payload"].get("tool") == "run_shell"]
    call_ids = {
        item["id"]
        for row in binding.rows if row.get("type") == "message"
        for item in row.get("message", {}).get("content", [])
        if isinstance(item, dict) and item.get("type") == "toolCall" and item.get("name") == "run_shell"
    }
    starts, finishes, usages, native = [], [], [], []
    for summary_path in (workspace / "logging").glob("*/meta/run_summary.json"):
        summary = json.loads(summary_path.read_text())
        log_root = summary_path.parent.parent
        usage_path = summary_path.with_name("tool_usage.json")
        usage = json.loads(usage_path.read_text())
        for event in summary["lifecycle_events"]:
            if event.get("payload", {}).get("tool") != "run_shell":
                continue
            receipt = {"path": str(summary_path), "event": event}
            if event["type"] == "tool_call_started":
                starts.append(receipt)
            elif event["type"] == "tool_call_finished":
                finishes.append(receipt)
        for turn, turn_usage in usage["turns"].items():
            for tool in turn_usage["tools"]:
                if tool["name"] == "run_shell":
                    usages.append({"path": str(usage_path), "turn": turn, "tool": tool})
        for path in (log_root / "provider_native/tool_results").glob("*.json"):
            for item in json.loads(path.read_text()):
                if item.get("fn") == "run_shell":
                    native.append({"path": str(path), "result": item})
    evidence = {
        "sessionId": session_id, "ownedSubmissions": runner.owned_submissions(binding.data),
        "journal": str(journals[0]), "inputs": inputs, "requested": requested, "resolved": resolved,
        "callIds": sorted(call_ids), "physicalStarts": starts, "physicalFinishes": finishes,
        "usage": usages, "nativeResults": native, "productResults": product_results,
    }
    counts = [len(requested), len(resolved), len(starts), len(finishes), len(usages), len(native), len(product_results)]
    if any(count > 1 for count in counts):
        evidence.update(status="FAIL", reason="Allow recorded more than one approval, execution or completion")
        return evidence
    if counts != [1] * len(counts) or len(call_ids) != 1 or len(inputs) != 1 or len(evidence["ownedSubmissions"]) != 1:
        evidence.update(status="UNKNOWN", reason="Allow execution denominator is incomplete")
        return evidence
    call_id = next(iter(call_ids))
    start, finish = starts[0]["event"], finishes[0]["event"]
    tool, result = usages[0]["tool"], native[0]["result"]
    correlation = (
        requested[0]["payload"]["request_id"] == resolved[0]["payload"]["request_id"]
        and tool["meta"]["call_id"] == result["call_id"] == call_id
        and str(start["turn"]) == str(finish["turn"]) == usages[0]["turn"]
        and requested[0]["sequence"] < resolved[0]["sequence"] < product_results[0]["sequence"]
        and start["seq"] < finish["seq"]
        and datetime.fromisoformat(resolved[0]["occurred_at"].replace("Z", "+00:00")).timestamp()
        <= start["timestamp"] <= finish["timestamp"]
        <= datetime.fromisoformat(product_results[0]["occurred_at"].replace("Z", "+00:00")).timestamp()
    )
    success = (
        finish["payload"].get("success") is True and tool.get("success") is True
        and result["out"].get("exit") == 0
        and str(result["out"].get("stdout", "")).strip() == "[1, 2, 3, 4, 5]"
        and product_results[0]["payload"].get("error") is False
    )
    evidence.update(
        status="PASS" if correlation and success else "FAIL" if correlation else "UNKNOWN",
        correlation=correlation, deterministicResult=success,
        reason=None if correlation and success else "Execution ownership/order or deterministic result did not match",
    )
    return evidence


def physical_start_snapshot(workspace: Path) -> dict[str, Any]:
    return {
        str(path): [
            event for event in json.loads(path.read_text())["lifecycle_events"]
            if event["type"] == "tool_call_started"
        ]
        for path in (workspace / "logging").glob("*/meta/run_summary.json")
    }


def guard_visible(screen: str) -> bool:
    text = "".join(char for char in screen if not char.isspace() and char not in "│┃")
    return "".join(EXPECTED_NEW_GUARD_REASON.split()) in text


class Journey:
    def __init__(self, options: argparse.Namespace, dimension: str, output: Path) -> None:
        self.options = options
        self.only = set(getattr(options, "only", ()) or ())
        self.dimension = dimension
        self.output = output
        mkdir0700(self.output)
        self.records: list[dict[str, Any]] = []
        self.actions: list[dict[str, Any]] = []
        self.sessions: list[dict[str, Any]] = []
        self.started = time.monotonic()
        self.session_counter = 0
        self.child: Any = None
        self.current_session: dict[str, Any] | None = None
        self.launch_context: Any = None
        self.roots: dict[str, Path] = {}
        self.engine_endpoint = getattr(options, "engine_endpoint", None)
        self.launch_lock = load_launch_lock(self.options.launch_lock)
        self.driver_source = str(Path(__file__).resolve())
        self.driver_source_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        self.worktree_head = self._worktree_head()

    def _worktree_head(self) -> str:
        result = subprocess.run(
            ["git", "-C", str(Path(__file__).resolve().parents[4]), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.stdout.strip() if result.returncode == 0 else "UNKNOWN"

    def action(self, name: str, **details: Any) -> None:
        item = {"action": name, "elapsedSeconds": round(time.monotonic() - self.started, 6), **details}
        self.actions.append(item)
        write_json(self.output / "actions.json", self.actions)

    def capture(self, name: str) -> Path:
        path = self.output / name
        runner.write_capture(self.output, name, self.child)
        return path.with_suffix(".screen.txt")

    def record(self, step: str, status: str, capture: Path | None, convention: str, **details: Any) -> None:
        if status not in {"PASS", "FAIL", "UNKNOWN"}:
            raise ValueError(status)
        item = {
            "step": step,
            "status": status,
            "capture": str(capture) if capture is not None else None,
            "convention": convention,
            "details": details,
        }
        self.records.append(item)
        write_json(self.output / "steps.json", self.records)

    def new_session(
        self,
        label: str,
        model: str | None = None,
        approval_mode: str = "always-ask",
    ) -> Any:
        self.launch_context = self.launch_lock.installed_candidate_launch(label)
        try:
            held = self.launch_context.__enter__()
        except BaseException:
            self.launch_context = None
            raise
        self.current_session = {
            "label": label,
            "lockWaitSeconds": round(held.waited_seconds, 6),
            "enginePid": None,
            "engineAuthority": None,
            "engineAuthorityPath": None,
            "tuiExitCode": None,
            "engineExited": {"observed": False, "seconds": None},
        }
        self.sessions.append(self.current_session)
        self.session_counter += 1
        root = self.output / "roots" / f"session-{self.session_counter:02d}-{label}"
        self.roots = {name: root / name for name in ("home", "config", "agent", "workspace", "temp")}
        for path in self.roots.values():
            mkdir0700(path)
        (self.roots["agent"] / "config.yml").write_text(
            f"tools:\n  approvalMode: {approval_mode}\n", encoding="utf-8"
        )
        selected_config = getattr(self.options, "breadboard_config", None)
        if selected_config is not None:
            with (self.roots["agent"] / "config.yml").open("a", encoding="utf-8") as config:
                config.write(f"breadboard: {json.dumps(selected_config)}\n")
        env = runner.exact_environment(
            self.roots["home"], self.roots["config"], self.roots["agent"], self.roots["temp"]
        )
        self.child = runner.PtyChild(
            [str(self.options.bb)] + (["--model", model] if model is not None else []),
            self.roots["workspace"],
            env,
            rows=self.options.rows,
            columns=self.options.cols,
        )
        self.action("launch", label=label, rows=self.options.rows, cols=self.options.cols)
        self.child.wait_until(
            lambda: "mock/reference" in self.child.screen.text() and "No LSP servers" in self.child.screen.text(),
            self.options.startup_timeout,
            f"{label} startup",
        )
        authority = self.child.wait_until(
            lambda: runner.active_authority(self.roots["agent"]), 10.0, "owned engine authority"
        )
        self.current_session["enginePid"] = authority[1]["pid"]
        self.current_session["engineAuthorityPath"] = str(authority[0])
        self.current_session["engineAuthority"] = {
            **authority[1],
            "osProcessStartToken": runner.process_start_token(authority[1]["pid"]),
        }
        self.capture(f"{label}-ready")
        return self.child

    def close_session(self) -> None:
        child = self.child
        try:
            if child is not None and self.current_session is not None:
                try:
                    if self.current_session["engineAuthority"] is None:
                        authority = runner.active_authority(self.roots["agent"])
                        if authority is not None:
                            self.current_session["enginePid"] = authority[1]["pid"]
                            self.current_session["engineAuthority"] = {
                                **authority[1],
                                "osProcessStartToken": runner.process_start_token(authority[1]["pid"]),
                            }
                    if child.exit_status is None:
                        if screen_turn_state(child, self.roots["agent"])["active"]:
                            child.send_escape()
                            child.wait_until(
                                lambda: not screen_turn_state(child, self.roots["agent"])["active"],
                                10.0, "turn settled before exit",
                            )
                        for _ in range(256):
                            if composer_is_empty(child.screen.text()):
                                break
                            child.send(b"\x15\x7f")
                            child.pump(0.01)
                finally:
                    cleanup = cleanup_runner.end_child(
                        runner, self.output, self.roots["agent"], child,
                        runner.process_descendants(child.pid), self.engine_endpoint or "http://127.0.0.1:9099",
                        self.current_session["enginePid"], self.current_session["engineAuthority"],
                    )
                    self.current_session.update(cleanup)
                    write_json(self.output / "cleanup.json", cleanup)
        finally:
            if child is not None:
                child.close_fd()
            self.child = None
            self.current_session = None
            if self.launch_context is not None:
                self.launch_context.__exit__(None, None, None)
                self.launch_context = None

    def wait_binding(self, count: int, timeout: float = 15.0) -> Any:
        def ready() -> Any:
            candidate = runner.binding_snapshot(self.roots["agent"])
            if candidate is None:
                return None
            session_id = candidate.data["sessionId"]
            submitted_turns = {
                submission["turnId"]
                for binding in runner.binding_history(candidate.rows)
                if binding.get("sessionId") == session_id
                for submission in runner.owned_submissions(binding)
            }
            return candidate if len(submitted_turns) >= count else None

        return self.child.wait_until(ready, timeout, f"binding submission {count}")

    def wait_terminal(self, count: int, timeout: float = 60.0) -> Any:
        return runner.wait_for_terminal_state(self.child, self.roots["agent"], count, timeout, f"terminal turn {count}")

    def maybe_select_model(self) -> bool:
        if "mock/reference" in self.child.screen.text():
            return True
        try:
            self.child.send_line("/model")
            self.child.wait_until(lambda: "All models" in self.child.screen.text(), 15.0, "model selector")
            self.child.send(b"\x1b[Ccli_mock/reference")
            self.child.wait_until(lambda: "cli_mock/reference" in self.child.screen.text(), 15.0, "mock model result")
            self.child.send_enter()
            self.child.send_enter()
            self.child.send_escape()
            self.child.send_escape()
            self.child.send_escape()
            self.child.wait_until(
                lambda: "Default model: cli_mock/reference" in self.child.screen.text(),
                15.0,
                "mock model active",
            )
            return True
        except Exception as error:
            self.action("model-selection-error", error=str(error))
            return False

    def step_compose_unicode(self) -> None:
        text = "wrapped-abcdefghijklmnopqrstuvwxyz0123456789-界e\u0301-👩\u200d💻"
        expected = text[:-3]  # Left then forward-delete must remove the final grapheme cluster.
        try:
            self.new_session("compose-unicode")
            self.child.send(text.encode("utf-8"))
            self.child.pump(0.2)
            self.child.send(b"\x1b[D\x1b[3~\r")
            snapshot = self.wait_binding(1)
            facts = runner.transcript_facts(snapshot.rows)
            got = facts["userTexts"][-1] if facts["userTexts"] else ""
            capture = self.capture("compose-unicode-submit")
            self.record(
                "compose-multiline-unicode-grapheme-edit",
                "PASS" if got == expected else "FAIL",
                capture,
                CONVENTIONS["unicode"],
                expected=expected,
                submitted=got,
                text=text,
            )
        except Exception as error:
            capture = self.capture("compose-unicode-failure") if self.child is not None else None
            self.record(
                "compose-multiline-unicode-grapheme-edit",
                "UNKNOWN",
                capture,
                CONVENTIONS["unicode"],
                error=str(error),
                reason=f"unicode edit ended before retained submission evidence was available: {error}",
                limitationType="oracle",
                missingObservable="retained submitted grapheme text",
                limitation="the PTY run ended before the binding transcript could classify the edit",
            )
        finally:
            self.close_session()

    def step_bracketed_paste(self) -> None:
        payload = "first pasted line\nsecond pasted line\nCJK 界 e\u0301 emoji 👩\u200d💻"
        expected = unicodedata.normalize("NFC", payload)
        try:
            self.new_session("bracketed-paste")
            burst = b"\x1b[200~" + payload.encode("utf-8") + b"\x1b[201~\r"
            self.child.send(burst)
            snapshot = self.wait_binding(1)
            facts = runner.transcript_facts(snapshot.rows)
            submissions = facts["userTexts"]
            capture = self.capture("bracketed-paste-enter")
            self.record(
                "compose-bracketed-paste-trailing-enter",
                "PASS" if submissions == [expected] else "FAIL",
                capture,
                CONVENTIONS["compose"],
                expected=[expected],
                pasted=payload,
                submitted=submissions,
            )
        except Exception as error:
            capture = self.capture("bracketed-paste-failure") if self.child is not None else None
            self.record(
                "compose-bracketed-paste-trailing-enter",
                "UNKNOWN",
                capture,
                CONVENTIONS["compose"],
                error=str(error),
                reason=f"bracketed paste ended before retained submission evidence was available: {error}",
                limitationType="oracle",
                missingObservable="retained pasted submission text",
                limitation="the PTY run ended before the binding transcript could classify the paste",
            )
        finally:
            self.close_session()

    def step_history_and_focus(self) -> None:
        prompts = ["history alpha", "history beta", "history beta"]
        try:
            self.new_session("history")
            for index, prompt in enumerate(prompts, start=1):
                self.child.send_typed_line(prompt)
                self.wait_binding(index)
                try:
                    self.wait_terminal(index, 45.0)
                except Exception:
                    pass
            self.child.send(b"\x1b[A")
            self.child.pump(0.2)
            up_text = self.child.screen.text()
            up_capture = self.capture("history-up-edge")
            self.child.send(b"\x1b[A")
            self.child.pump(0.2)
            repeated_up_text = self.child.screen.text()
            repeated_capture = self.capture("history-up-edge-repeat")
            self.child.send(b"\x1b[5~")
            self.child.pump(0.2)
            page_text = self.child.screen.text()
            page_capture = self.capture("history-pageup")
            up_draft = first_visible_text(up_text)
            repeated_draft = first_visible_text(repeated_up_text)
            page_draft = first_visible_text(page_text)
            up_pass = up_draft == "history beta" and repeated_draft == "history beta"
            page_focus = page_draft == "history beta" and "Search" not in page_text
            page_pass = page_draft == repeated_draft == "history beta" and page_focus
            self.record(
                "history-up-edge-and-consecutive-dedup",
                "PASS" if up_pass else "UNKNOWN",
                up_capture,
                CONVENTIONS["history"],
                draftBefore=up_draft,
                draftAfter=repeated_draft,
                focus="composer" if up_pass else None,
                reason=None if up_pass else "history edge draft was not observable as exact history beta",
                limitationType=None if up_pass else "oracle",
                missingObservable=None if up_pass else "exact composer draft after consecutive Up at this geometry",
                limitation=None if up_pass else "the PTY cell capture does not expose a reliable composer draft at this geometry",
            )
            self.record(
                "history-pageup-does-not-load-history",
                "PASS" if page_pass else "UNKNOWN",
                page_capture,
                CONVENTIONS["history"],
                draftBefore=repeated_draft,
                draftAfter=page_draft,
                focus="composer" if page_focus else None,
                reason=None if page_pass else "PageUp did not expose the unchanged history beta draft with composer focus",
                limitationType=None if page_pass else "oracle",
                missingObservable=None if page_pass else "unchanged composer draft after PageUp at this geometry",
                limitation=None if page_pass else "the PTY cell capture does not expose a reliable composer draft at this geometry",
            )
            self.child.send(b"\x11")  # Ctrl+R
            self.child.wait_until(lambda: "Search" in self.child.screen.text() or "history" in self.child.screen.text().lower(), 10.0, "history search overlay")
            search_capture = self.capture("history-search-open")
            self.record("history-ctrl-r-opens-search", "PASS", search_capture, CONVENTIONS["history"], screen=safe_text(self.child.screen.text()))
            self.child.send_escape()
            self.child.pump(0.2)
            close_capture = self.capture("history-search-esc")
            self.record("history-search-esc-closes", "PASS" if "Search" not in self.child.screen.text() else "FAIL", close_capture, CONVENTIONS["focus"], screen=safe_text(self.child.screen.text()))
        except Exception as error:
            capture = self.capture("history-failure") if self.child is not None else None
            self.record(
                "history-and-focus-sequence",
                "UNKNOWN",
                capture,
                CONVENTIONS["history"],
                error=str(error),
                reason=f"history interaction ended before the requested screen observables were available: {error}",
                limitationType="oracle",
                missingObservable="history composer/focus state",
                limitation="the PTY capture did not expose enough state to classify this interaction",
            )
        finally:
            self.close_session()

    def step_immediate_next_input(self) -> None:
        try:
            self.new_session("immediate-next-input", model="cli_mock/reference", approval_mode="yolo")
            if not self.maybe_select_model():
                self.record(
                    "streaming-immediate-next-input",
                    "UNKNOWN",
                    self.capture("immediate-model-unavailable"),
                    CONVENTIONS["focus"],
                    reason="mock/reference model was unavailable for the streaming fixture",
                    limitationType="fixture",
                    fixtureGap="provider-free mock catalog did not expose mock/reference",
                )
                return
            first_prompt = "Create deterministic protofilesystem fixture now."
            queued_prompt = "queued while streaming"
            self.child.send(first_prompt.encode("utf-8"))
            self.child.send_enter()
            self.child.pump(0.1)
            before_state = screen_turn_state(self.child, self.roots["agent"])
            self.child.send(queued_prompt.encode("utf-8"))
            self.child.send_enter()
            self.child.pump(1.0)
            capture = self.capture("immediate-next-input")
            snapshot = runner.binding_snapshot(self.roots["agent"])
            if snapshot is None:
                event_paths = sorted(
                    self.roots["agent"].rglob("session-events/*/session_events.jsonl")
                )
                authority = runner.active_authority(self.roots["agent"])
                endpoint = (
                    str(authority[1].get("normalizedEndpoint"))
                    if authority is not None and authority[1].get("normalizedEndpoint")
                    else None
                )
                session_ids = {path.parent.name for path in event_paths}
                if len(session_ids) != 1 or endpoint is None:
                    self.record(
                        "streaming-immediate-next-input",
                        "UNKNOWN",
                        capture,
                        CONVENTIONS["focus"],
                        activeBeforeSecond=before_state["active"],
                        reason="engine session endpoint or id was unavailable for immediate-input oracle",
                        limitationType="oracle",
                        missingObservable="engine session and event records",
                        limitation="the PTY run did not retain a unique event journal and endpoint",
                    )
                    return
                session_id = next(iter(session_ids))
                try:
                    engine = engine_session_events(endpoint, session_id)
                except Exception as error:
                    self.record(
                        "streaming-immediate-next-input",
                        "UNKNOWN",
                        capture,
                        CONVENTIONS["focus"],
                        activeBeforeSecond=before_state["active"],
                        engineSessionPath="/v1/sessions/<session_id>",
                        engineEventsPath="/v1/sessions/<session_id>/events?replay=true",
                        reason=f"engine session/event query timed out: {error}",
                        limitationType="oracle",
                        missingObservable="engine session and event records",
                        limitation="the retained engine endpoint did not respond within the bounded query window",
                    )
                    return
                accepted = [
                    event for event in engine["events"] if event.get("kind") == "input.accepted"
                ]
                user_texts = [
                    runner.content_text(row["message"].get("content"))
                    for path in self.roots["agent"].rglob("sessions/**/*.jsonl")
                    for row in runner.parse_jsonl(path)
                    if row.get("type") == "message"
                    and isinstance(row.get("message"), dict)
                    and row["message"].get("role") == "user"
                ]
                observed_hashes = [
                    event.get("payload", {}).get("content_hash")
                    for event in accepted
                    if isinstance(event.get("payload"), dict)
                ]
                exact_inputs = user_texts == [first_prompt, queued_prompt]
                exact_accepts = len(accepted) == 2
                has_queue_cue = any(
                    token in self.child.screen.text().lower()
                    for token in ("queue", "steer", "pending", "stream")
                )
                api_ready = engine["sessionStatus"] == 200 and engine["eventStatus"] == 200
                status = (
                    "PASS"
                    if api_ready and exact_inputs and exact_accepts and before_state["active"] and has_queue_cue
                    else "UNKNOWN"
                )
                self.record(
                    "streaming-immediate-next-input",
                    status,
                    capture,
                    CONVENTIONS["focus"],
                    submitted=user_texts,
                    expectedSubmitted=[first_prompt, queued_prompt],
                    acceptedInputEvents=len(accepted),
                    acceptedInputHashes=observed_hashes,
                    acceptedInputCountExact=exact_accepts,
                    activeBeforeSecond=before_state["active"],
                    queueCue=has_queue_cue,
                    engineSessionStatus=engine["sessionStatus"],
                    engineEventStatus=engine["eventStatus"],
                    engineSessionPath="/v1/sessions/<session_id>",
                    engineEventsPath="/v1/sessions/<session_id>/events?replay=true",
                    reason=None
                    if status == "PASS"
                    else "engine session/event oracle did not prove exactly two accepted inputs with one active turn",
                    limitationType=None if status == "PASS" else "oracle",
                    missingObservable=None
                    if status == "PASS"
                    else "visible queue ownership or active-turn evidence",
                    limitation=None
                    if status == "PASS"
                    else "the PTY grid or retained binding did not expose the queue indicator",
                )
                return
            owned = runner.owned_submissions(snapshot.data)
            session_id = snapshot.data.get("sessionId")
            authority = runner.active_authority(self.roots["agent"])
            endpoint = (
                str(authority[1].get("normalizedEndpoint"))
                if authority is not None and authority[1].get("normalizedEndpoint")
                else None
            )
            if not isinstance(session_id, str) or endpoint is None:
                self.record(
                    "streaming-immediate-next-input",
                    "UNKNOWN",
                    capture,
                    CONVENTIONS["focus"],
                    activeBeforeSecond=before_state["active"],
                    ownedSubmissions=len(owned),
                    reason="engine session endpoint or id was unavailable for immediate-input oracle",
                    limitationType="oracle",
                    missingObservable="engine session and event records",
                    limitation="the PTY run did not retain the endpoint needed to query the engine's own input journal",
                )
                return
            engine = engine_session_events(endpoint, session_id)
            accepted = [event for event in engine["events"] if event.get("kind") == "input.accepted"]
            facts = retained_binding_facts(snapshot)
            has_queue_cue = any(
                token in self.child.screen.text().lower()
                for token in ("queue", "steer", "pending", "stream")
            )
            observed = facts["userTexts"]
            exact_inputs = observed == [first_prompt, queued_prompt]
            exact_accepts = len(accepted) == 2
            observed_hashes = [
                event.get("payload", {}).get("content_hash")
                for event in accepted
                if isinstance(event.get("payload"), dict)
            ]
            api_ready = engine["sessionStatus"] == 200 and engine["eventStatus"] == 200
            status = (
                "PASS"
                if api_ready and exact_inputs and exact_accepts and before_state["active"] and has_queue_cue
                else "UNKNOWN"
            )
            self.record(
                "streaming-immediate-next-input",
                status,
                capture,
                CONVENTIONS["focus"],
                submitted=observed,
                expectedSubmitted=[first_prompt, queued_prompt],
                acceptedInputEvents=len(accepted),
                acceptedInputHashes=observed_hashes,
                acceptedInputCountExact=exact_accepts,
                activeBeforeSecond=before_state["active"],
                queueCue=has_queue_cue,
                engineSessionStatus=engine["sessionStatus"],
                engineEventStatus=engine["eventStatus"],
                engineSessionPath="/v1/sessions/<session_id>",
                engineEventsPath="/v1/sessions/<session_id>/events?replay=true",
                reason=None
                if status == "PASS"
                else "engine session/event oracle did not prove exactly two accepted inputs with one active turn",
                limitationType=None if status == "PASS" else "oracle",
                missingObservable=None
                if status == "PASS"
                else "visible queue ownership or active-turn evidence",
                limitation=None
                if status == "PASS"
                else "the PTY grid or retained binding did not expose the queue indicator",
            )
        except Exception as error:
            capture = self.capture("immediate-failure") if self.child is not None else None
            self.record(
                "streaming-immediate-next-input",
                "UNKNOWN",
                capture,
                CONVENTIONS["focus"],
                error=str(error),
                reason=f"streaming immediate-input sequence ended before the required observables were available: {error}",
                limitationType="oracle",
                missingObservable="engine session and event records",
                limitation="the PTY run ended before the driver could collect the requested observable",
            )
        finally:
            self.close_session()

    def step_transcript_scroll(self) -> None:
        try:
            self.new_session("transcript-scroll")
            prompts = [f"transcript turn {index:02d}" for index in range(8)]
            for index, prompt in enumerate(prompts, start=1):
                self.child.send_typed_line(prompt)
                self.wait_binding(index)
                try:
                    self.wait_terminal(index, 45.0)
                except Exception:
                    pass
            tail_capture = self.capture("transcript-tail")
            before_position = visible_transcript_position(self.child.screen.text())
            for _ in range(6):
                self.child.send(b"\x1b[5~")
                self.child.pump(0.1)
            up_capture = self.capture("transcript-pageup")
            after_position = visible_transcript_position(self.child.screen.text())
            for _ in range(4):
                self.child.send(b"\x1b[<64;20;10M")
                self.child.pump(0.05)
            wheel_capture = self.capture("transcript-wheel")
            wheel_position = visible_transcript_position(self.child.screen.text())
            self.child.send_typed_line("transcript append during manual scroll")
            self.wait_binding(9)
            try:
                self.wait_terminal(9, 30.0)
            except Exception:
                pass
            append_capture = self.capture("transcript-append")
            append_position = visible_transcript_position(self.child.screen.text())
            for _ in range(6):
                self.child.send(b"\x1b[6~")
                self.child.pump(0.1)
            tail_return_capture = self.capture("transcript-tail-return")
            tail_text = self.child.screen.text()
            binding = runner.binding_snapshot(self.roots["agent"])
            try:
                if binding is None:
                    raise JourneyFailure("retained binding snapshot unavailable for native scrollback oracle")
                _, events = runner.session_event_journals(self.roots["agent"], {binding.data["sessionId"]})
                accepted_inputs = sum(event.get("kind") == "input.accepted" for event in events)
                native_oracle = {"sessionId": binding.data["sessionId"], "inputAccepted": accepted_inputs}
            except (JourneyFailure, KeyError) as error:
                native_oracle = None
                native_oracle_reason = str(error)
            page_pass = (
                native_oracle is not None
                and native_oracle["inputAccepted"] >= 8
                and before_position is not None
                and after_position is not None
                and after_position["first"] < before_position["first"]
            )
            page_reason = (
                None
                if page_pass
                else "native scrollback rows and viewport position after PageUp were not observable in PTY cells"
            )
            self.record(
                "navigate-long-transcript-page-scroll",
                "UNKNOWN",
                up_capture,
                CONVENTIONS["transcript"],
                reason=page_reason,
                limitationType="oracle",
                missingObservable="native scrollback viewport rows after PageUp",
                limitation="PTY cell capture exposes only the current grid; retained session events prove inputs but not the viewport position",
                tailCapture=str(tail_capture),
                beforePosition=before_position,
                nativeOracle=native_oracle,
            )
            wheel_pass = (
                native_oracle is not None
                and native_oracle["inputAccepted"] >= 8
                and before_position is not None
                and after_position is not None
                and after_position != before_position
                and append_position == after_position
            )
            self.record(
                "navigate-long-transcript-wheel-anchor",
                "PASS" if wheel_pass else "UNKNOWN",
                wheel_capture,
                CONVENTIONS["transcript"],
                beforePosition=before_position,
                afterPosition=after_position,
                appendPosition=append_position,
                appendCapture=str(append_capture),
                nativeOracle=native_oracle,
                reason=None if wheel_pass else "manual wheel position and append anchor were not both observable in PTY cells",
                limitationType=None if wheel_pass else "oracle",
                limitation=None if wheel_pass else "PTY cells cannot expose native scrollback rows at this geometry",
            )
            return_details = return_tail_details(tail_return_capture, tail_text, "transcript turn 07")
            return_pass = native_oracle is not None and return_details["tailReached"]
            self.record(
                "navigate-long-transcript-return-tail",
                "PASS" if return_pass else "UNKNOWN",
                tail_return_capture,
                CONVENTIONS["transcript"],
                **return_details,
                reason=None if return_pass else "tail return did not expose the latest submitted transcript turn and retained session event oracle",
                limitationType=None if return_pass else "oracle",
                missingObservable=None if return_pass else "latest transcript rows in the PTY grid",
                limitation=None if return_pass else "PTY capture omits native scrollback rows; session events only prove accepted inputs",
            )
        except Exception as error:
            capture = self.capture("transcript-scroll-failure") if self.child is not None else None
            self.record(
                "navigate-long-transcript",
                "UNKNOWN",
                capture,
                CONVENTIONS["transcript"],
                error=str(error),
                reason=f"transcript navigation ended before the requested viewport observables were available: {error}",
                limitationType="oracle",
                missingObservable="transcript viewport and anchor state",
                limitation="the PTY capture did not expose enough scrollback state to classify the interaction",
            )
        finally:
            self.close_session()

    def step_tools_and_slash(self) -> None:
        try:
            self.new_session("tools-slash", model="cli_mock/reference")
            if not self.maybe_select_model():
                self.record(
                    "tools-diff-disclosure",
                    "UNKNOWN",
                    self.capture("tools-model-unavailable"),
                    CONVENTIONS["tools"],
                    reason="mock/reference model was unavailable for the tool fixture",
                    limitationType="fixture",
                    fixtureGap="provider-free mock catalog did not expose mock/reference",
                )
            else:
                actionable = False
                self.child.send_typed_line("Create the deterministic protofilesystem fixture now.")
                try:
                    self.child.wait_until(self.child.permission_dialog_ready, 60.0, "tool approval")
                    approval_screen = self.child.screen.text()
                    approval_capture = self.capture("tools-approval-dialog")
                    approval_lower = approval_screen.lower()
                    actionable = (
                        self.child.permission_dialog_tool() == "run_shell"
                        and "allow" in approval_lower
                        and "deny" in approval_lower
                        and "esc" in approval_lower
                    )
                    self.record(
                        "approval-dialog-visible-actionable",
                        "PASS" if actionable else "UNKNOWN",
                        approval_capture,
                        CONVENTIONS["approval"],
                        tool=self.child.permission_dialog_tool(),
                        allow="allow" in approval_lower,
                        deny="deny" in approval_lower,
                        cancel="esc" in approval_lower,
                        reason=None if actionable else "installed approval fixture reached a dialog without all visible Allow/Deny/Esc actions",
                        limitationType=None if actionable else "fixture",
                        fixtureGap=None if actionable else "dialog fixture omitted one or more actionable labels",
                    )
                    if actionable:
                        self.child.send_enter()
                except Exception as error:
                    self.record(
                        "approval-dialog-visible-actionable",
                        "UNKNOWN",
                        self.capture("tools-approval-unavailable"),
                        CONVENTIONS["approval"],
                        error=str(error),
                        reason="installed approval fixture did not reach the run_shell dialog",
                        limitationType="fixture",
                        fixtureGap="mock/reference did not emit the run_shell permission request",
                    )
                try:
                    self.wait_terminal(1, 90.0)
                    binding = runner.binding_snapshot(self.roots["agent"])
                    facts = retained_binding_facts(binding)
                    tool_capture = self.capture("tools-diff-collapsed")

                    self.child.wait_until(
                        lambda: list((self.roots["workspace"] / "logging").glob("*/meta/run_summary.json")),
                        5.0, "persisted engine execution summary",
                    )
                    allow = physical_allow_evidence(self.roots["agent"], self.roots["workspace"], binding)
                    write_json(self.output / "allow-execution-evidence.json", allow)
                    allow_details = {k: v for k, v in allow.items() if k != "status"}
                    self.record(
                        "approval-allow-tool-runs", allow["status"], tool_capture,
                        CONVENTIONS["approval"], **allow_details,
                    )
                    if allow["status"] != "PASS":
                        return

                    screen = self.child.screen.text()
                    has_expand_hint = "ctrl+o" in screen.lower() and "expand" in screen.lower()
                    self.record(
                        "tools-diff-collapsed-hint",
                        "PASS" if has_expand_hint else "UNKNOWN",
                        tool_capture,
                        CONVENTIONS["tools"],
                        toolCalls=facts["toolCalls"],
                        hint=has_expand_hint,
                        reason=None if has_expand_hint else "retained binding terminal facts did not expose the visible Ctrl+O affordance",
                        limitationType=None if has_expand_hint else "oracle",
                        missingObservable=None if has_expand_hint else "visible Ctrl+O affordance in the captured PTY grid",
                        limitation=None if has_expand_hint else "binding facts identify tools but cannot prove a clipped screen affordance",
                    )
                    self.child.send(b"\x0f")
                    self.child.pump(0.5)
                    expanded_screen = self.child.screen.text()
                    expand_capture = self.capture("tools-diff-expanded")
                    expanded = expanded_screen != screen and "ctrl+o" not in expanded_screen.lower() and any(tool in expanded_screen for tool in facts["toolCalls"])
                    self.record(
                        "tools-diff-ctrl-o-expand",
                        "PASS" if expanded else "UNKNOWN",
                        expand_capture,
                        CONVENTIONS["tools"],
                        before=safe_text(screen[-400:]),
                        after=safe_text(expanded_screen[-400:]),
                        toolCalls=facts["toolCalls"],
                        reason=None if expanded else "Ctrl+O did not produce a distinct expanded tool view with a retained tool name",
                        limitationType=None if expanded else "oracle",
                        missingObservable=None if expanded else "expanded tool name in the 80-column PTY grid",
                        limitation=None if expanded else "the narrow cell capture can clip the expanded card even when tool facts are retained",
                    )
                except Exception as error:
                    self.record(
                        "tools-diff-collapsed-hint",
                        "UNKNOWN",
                        self.capture("tools-diff-unavailable"),
                        CONVENTIONS["tools"],
                        error=str(error),
                        reason="retained binding terminal facts were unavailable",
                        limitationType="oracle",
                        missingObservable="retained tool-call facts",
                        limitation="the durable binding/event oracle was unavailable for this row",
                    )
                    return
            baseline_tools = list(facts["toolCalls"]) if "facts" in locals() else []
            deny_capture: Path | None = None
            deny_ready = False
            deny_error: str | None = None
            try:
                self.child.send_typed_line("Create the deterministic protofilesystem fixture now.")
                self.child.wait_until(self.child.permission_dialog_ready, 30.0, "tool denial")
                deny_capture = self.capture("tools-deny-dialog")
                deny_lower = self.child.screen.text().lower()
                deny_ready = (
                    self.child.permission_dialog_tool() == "run_shell"
                    and "deny" in deny_lower
                    and "esc" in deny_lower
                )
                if deny_ready:
                    self.child.send(b"\x1b[B\r")
                    try:
                        self.wait_terminal(2, 30.0)
                        self.child.pump(1.0)
                    except Exception as error:
                        deny_error = str(error)
            except Exception as error:
                deny_error = str(error)
                deny_capture = self.capture("tools-deny-unavailable")
            denied_binding = runner.binding_snapshot(self.roots["agent"])
            denied_tools: list[str] = []
            denied_events: list[dict[str, Any]] = []
            if denied_binding is not None:
                denied_facts = retained_binding_facts(denied_binding)
                denied_tools = list(denied_facts["toolCalls"])
                for _ in range(25):
                    denied_events = []
                    for event_path in self.roots["agent"].rglob(
                        "session-events/*/session_events.jsonl"
                    ):
                        denied_events.extend(runner.parse_jsonl(event_path))
                    accepted_count = sum(
                        event.get("kind") == "input.accepted" for event in denied_events
                    )
                    has_rejection = any(
                        event.get("kind") == "approval.resolved"
                        and isinstance(event.get("payload"), dict)
                        and event["payload"].get("decision") in {"reject", "rejected", "cancel"}
                        for event in denied_events
                    )
                    if accepted_count >= 2 and has_rejection:
                        break
                    self.child.pump(0.2)
            accepted_events = [
                event for event in denied_events if event.get("kind") == "input.accepted"
            ]
            second_input_sequence = (
                accepted_events[-1].get("sequence") if len(accepted_events) >= 2 else None
            )
            rejected_after_second = (
                isinstance(second_input_sequence, int)
                and any(
                    event.get("kind") == "approval.resolved"
                    and isinstance(event.get("payload"), dict)
                    and event["payload"].get("decision") in {"reject", "rejected", "cancel"}
                    and event.get("sequence", 0) > second_input_sequence
                    for event in denied_events
                )
            )
            successful_run_shell_after_second = (
                isinstance(second_input_sequence, int)
                and any(
                    event.get("kind") == "tool_result"
                    and isinstance(event.get("payload"), dict)
                    and event["payload"].get("tool") == "run_shell"
                    and event["payload"].get("error") is False
                    and event.get("sequence", 0) > second_input_sequence
                    for event in denied_events
                )
            )
            no_new_run_shell = rejected_after_second and not successful_run_shell_after_second
            deny_pass = deny_ready and no_new_run_shell
            self.record(
                "approval-deny-no-execution",
                "PASS" if deny_pass else "UNKNOWN",
                deny_capture,
                CONVENTIONS["approval"],
                baselineToolCalls=baseline_tools,
                deniedToolCalls=denied_tools,
                dialogReady=deny_ready,
                rejectedAfterSecond=rejected_after_second,
                successfulRunShellAfterSecond=successful_run_shell_after_second,
                noNewRunShell=no_new_run_shell,
                denialWaitError=deny_error,
                reason=None
                if deny_pass
                else "Deny did not prove that the requested run_shell was not executed",
                limitationType=None if deny_pass else "oracle",
                missingObservable=None
                if deny_pass
                else "durable denial decision and unchanged run_shell execution count",
                limitation=None
                if deny_pass
                else "the permission dialog or retained post-denial event state was unavailable",
            )
            expected = 'Session "nope" not found'
            self.child.send_line("/resume nope")
            wait_started = time.monotonic()
            wait_error: str | None = None
            try:
                self.child.wait_until(
                    lambda: expected in self.child.screen.text(),
                    5.0,
                    "missing resume diagnostic",
                )
            except Exception as error:
                wait_error = str(error)
            wait_elapsed = time.monotonic() - wait_started
            resume_capture = self.capture("resume-missing")
            text = self.child.screen.text()
            visibility = diagnostic_visibility(self.child, expected)
            self.record(
                "slash-resume-missing-diagnostic",
                "PASS" if wait_error is None and expected in text else "FAIL",
                resume_capture,
                CONVENTIONS["slash"],
                expected=expected,
                screen=safe_text(text),
                boundedWaitSeconds=5.0,
                waitElapsedSeconds=round(wait_elapsed, 6),
                waitError=wait_error,
                finalScreen=safe_text(text) if wait_error is not None else None,
                showErrorSurface="full terminal grid, matching other TUI showError diagnostics",
                **visibility,
                oracleAssessment=(
                    "bounded wait observed the diagnostic; the prior fixed pump was an oracle defect"
                    if wait_error is None and expected in text
                    else None
                ),
            )

            # /new safe rejection contract:
            # Must assert visible exact guard reason, old local ID/path/history retained,
            # no hidden execution, live child and exit code 0.
            before_new = runner.binding_snapshot(self.roots["agent"])
            before_local_id = extract_local_session_id(before_new.rows) if before_new else None
            before_session_file = str(before_new.session_file) if before_new else None
            before_row_count = len(before_new.rows) if before_new else 0
            before_starts = physical_start_snapshot(self.roots["workspace"])

            self.child.send_line("/new")
            try:
                self.child.wait_until(
                    lambda: (
                        guard_visible(self.child.screen.text())
                        or self.child.exit_status is not None
                    ),
                    5.0,
                    "/new guard reason",
                )
            except Exception:
                pass
            self.child.pump(1.0)
            new_capture = self.capture("slash-new")
            new_screen = self.child.screen.text()

            after_new = runner.binding_snapshot(self.roots["agent"])
            after_local_id = extract_local_session_id(after_new.rows) if after_new else None
            after_session_file = str(after_new.session_file) if after_new else None
            after_row_count = len(after_new.rows) if after_new else 0
            after_starts = physical_start_snapshot(self.roots["workspace"])

            guard_ok = guard_visible(new_screen)
            child_alive = (self.child.exit_status is None)
            local_id_retained = (
                before_local_id is not None
                and after_local_id is not None
                and after_local_id == before_local_id
            )
            path_retained = (
                before_session_file is not None
                and after_session_file is not None
                and after_session_file == before_session_file
            )
            history_retained = (
                after_row_count >= before_row_count
                and (before_new is None or after_new is None or before_new.rows == after_new.rows[:before_row_count])
            )
            no_hidden_execution = (before_starts == after_starts)
            safe_rejection_pass = (
                guard_ok
                and child_alive
                and local_id_retained
                and path_retained
                and history_retained
                and no_hidden_execution
            )

            if not child_alive:
                new_status = "FAIL"
                new_reason = f"/new caused child process to exit unexpectedly with code {self.child.exit_status}"
            elif not guard_ok:
                new_status = "FAIL"
                new_reason = "/new did not present the required in-TUI safe rejection guard notice"
            elif safe_rejection_pass:
                new_status = "PASS"
                new_reason = None
            else:
                new_status = "FAIL"
                new_reason = (
                    f"/new violated safe rejection invariants: localIdRetained={local_id_retained}, "
                    f"pathRetained={path_retained}, historyRetained={history_retained}, "
                    f"noHiddenExecution={no_hidden_execution}"
                )

            self.record(
                "slash-new-clears-and-new-identity",
                new_status,
                new_capture,
                CONVENTIONS["slash"],
                guardReasonVisible=guard_ok,
                expectedGuardReason=EXPECTED_NEW_GUARD_REASON,
                childAlive=child_alive,
                childExitStatus=self.child.exit_status,
                beforeLocalId=before_local_id,
                afterLocalId=after_local_id,
                localIdRetained=local_id_retained,
                sessionFile=after_session_file,
                pathRetained=path_retained,
                historyRetained=history_retained,
                noHiddenExecution=no_hidden_execution,
                reason=new_reason,
                limitationType=None if new_status == "PASS" else "product",
            )

            # /fresh requires all 4 observables or honest UNKNOWN/P2:
            # 1) accepted /fresh status
            # 2) unchanged local durable ID
            # 3) unchanged JSONL path/transcript
            # 4) provider reset marker tied to the command
            if after_new is not None:
                self.child.send_line("/fresh")
                self.child.pump(1.0)
                fresh_capture = self.capture("slash-fresh")
                fresh_screen = self.child.screen.text()
                after_fresh = runner.binding_snapshot(self.roots["agent"])

                fresh_status_visible = "fresh provider session started" in fresh_screen.lower()
                after_fresh_local_id = extract_local_session_id(after_fresh.rows) if after_fresh else None
                after_fresh_session_file = str(after_fresh.session_file) if after_fresh else None

                fresh_local_id_retained = (
                    after_local_id is not None
                    and after_fresh_local_id is not None
                    and after_fresh_local_id == after_local_id
                )
                fresh_path_retained = (
                    after_session_file is not None
                    and after_fresh_session_file is not None
                    and after_fresh_session_file == after_session_file
                )
                fresh_transcript_preserved = (
                    after_fresh is not None
                    and len(after_fresh.rows) >= after_row_count
                )

                # Search for provider reset marker tied to /fresh command
                provider_reset_marker_observed = False
                if after_fresh is not None:
                    provider_reset_marker_observed = any(
                        row.get("type") in {"provider_reset", "fresh_session"}
                        or (row.get("type") == "custom" and row.get("customType") in {"breadboard.provider-reset", "provider_reset"})
                        for row in after_fresh.rows[after_row_count:]
                    )

                if (
                    fresh_status_visible
                    and fresh_local_id_retained
                    and fresh_path_retained
                    and fresh_transcript_preserved
                    and provider_reset_marker_observed
                ):
                    fresh_status = "PASS"
                    fresh_reason = None
                    fresh_limitation_type = None
                    fresh_missing = None
                else:
                    fresh_status = "UNKNOWN"
                    fresh_reason = (
                        "E2-CR-05b P2 nonclaim: /fresh did not observe all four required observables "
                        "(status, local ID, path/transcript, and provider-reset marker); "
                        "ID equality alone is not reset proof"
                    )
                    fresh_limitation_type = "oracle"
                    fresh_missing = "provider reset marker tied to /fresh command"

                self.record(
                    "slash-fresh-retains-identity",
                    fresh_status,
                    fresh_capture,
                    CONVENTIONS["slash"],
                    acceptedStatusVisible=fresh_status_visible,
                    localIdRetained=fresh_local_id_retained,
                    pathRetained=fresh_path_retained,
                    transcriptPreserved=fresh_transcript_preserved,
                    providerResetMarker=provider_reset_marker_observed,
                    retainedLocalId=after_local_id,
                    afterFreshLocalId=after_fresh_local_id,
                    reason=fresh_reason,
                    limitationType=fresh_limitation_type,
                    missingObservable=fresh_missing,
                    limitation=(
                        "the product agent session prunes in-memory provider state but does not "
                        "persist a provider reset marker to the transcript; identity equality alone is UNKNOWN/P2"
                    ),
                )
            else:
                self.record(
                    "slash-fresh-retains-identity",
                    "UNKNOWN",
                    new_capture,
                    CONVENTIONS["slash"],
                    reason="/new did not expose a binding identity",
                    limitationType="oracle",
                    missingObservable="retained session identity after /new and /fresh",
                    limitation="no retained binding was available for the identity comparison",
                )
        except Exception as error:
            capture = self.capture("tools-slash-failure") if self.child is not None else None
            self.record(
                "tools-diff-and-slash-sequence",
                "UNKNOWN",
                capture,
                CONVENTIONS["tools"],
                error=str(error),
                reason=f"sequence aborted before all observables were available: {error}",
                limitationType="oracle",
                missingObservable="one or more retained tool/slash rows",
                limitation="the PTY run ended before the driver could collect the requested observable",
            )
        finally:
            self.close_session()

    def run(self) -> dict[str, Any]:
        step_specs = (
            ("compose-unicode", self.step_compose_unicode),
            ("bracketed-paste", self.step_bracketed_paste),
            ("history", self.step_history_and_focus),
            ("immediate-next-input", self.step_immediate_next_input),
            ("transcript-scroll", self.step_transcript_scroll),
            ("tools-slash", self.step_tools_and_slash),
        )
        for label, step in step_specs:
            if self.only and label not in self.only:
                continue
            step()
        row_groups = (
            ("compose-complex-edit-unicode", ("compose-multiline-unicode-grapheme-edit",)),
            ("compose-bracketed-paste-trailing-enter", ("compose-bracketed-paste-trailing-enter",)),
            (
                "history-and-focus-sequence",
                (
                    "history-up-edge-and-consecutive-dedup",
                    "history-pageup-does-not-load-history",
                    "history-ctrl-r-opens-search",
                    "history-search-esc-closes",
                ),
            ),
            ("streaming-immediate-next-input", ("streaming-immediate-next-input",)),
            (
                "navigate-long-transcript",
                (
                    "navigate-long-transcript-page-scroll",
                    "navigate-long-transcript-wheel-anchor",
                    "navigate-long-transcript-return-tail",
                    "navigate-long-transcript",
                ),
            ),
            (
                "tools-diff-and-slash-sequence",
                (
                    "approval-dialog-visible-actionable",
                    "approval-allow-tool-runs",
                    "approval-deny-no-execution",
                    "tools-diff-disclosure",
                    "tools-diff-collapsed-hint",
                    "tools-diff-ctrl-o-expand",
                    "slash-resume-missing-diagnostic",
                    "slash-new-clears-and-new-identity",
                    "slash-fresh-retains-identity",
                ),
            ),
        )
        rows: list[dict[str, Any]] = []
        for row, step_names in row_groups:
            evidence = [item for item in self.records if item["step"] in step_names]
            if self.only and not evidence:
                continue
            statuses = {item["status"] for item in evidence}
            status = "FAIL" if "FAIL" in statuses else "UNKNOWN" if "UNKNOWN" in statuses or not evidence else "PASS"
            rows.append(
                {
                    "row": row,
                    "status": status,
                    "captures": [item["capture"] for item in evidence if item["capture"] is not None],
                    "steps": [item["step"] for item in evidence],
                }
            )
        result = {
            "schemaVersion": "bb-ewnk.2.everyday-journey.v1",
            "candidate": str(self.options.bb),
            "dimension": {"rows": self.options.rows, "cols": self.options.cols, "name": self.dimension},
            "source": {
                "driver": self.driver_source,
                "driverSha256": self.driver_source_sha256,
                "worktreeHead": self.worktree_head,
            },
            "sessions": self.sessions,
            "rows": rows,
            "steps": self.records,
            "actions": self.actions,
            "counts": {status: sum(row["status"] == status for row in rows) for status in ("PASS", "FAIL", "UNKNOWN")},
            "stepCounts": {
                status: sum(step["status"] == status for step in self.records) for status in ("PASS", "FAIL", "UNKNOWN")
            },
        }
        write_json(self.output / "journey.json", result)
        return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bb", type=Path, required=True)
    parser.add_argument("--pi-natives", type=Path, required=True)
    parser.add_argument("--sdk-artifact", type=Path, required=True)
    parser.add_argument("--sdk-provenance", type=Path, required=True)
    parser.add_argument("--tui-source-commit", required=False, default="5ad33cc50d5bd796d6eccaee938f01cb11c90bdb")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rows", type=int, default=36)
    parser.add_argument("--cols", type=int, default=120)
    parser.add_argument("--startup-timeout", type=float, default=60.0)
    parser.add_argument("--dimension", default="120x36")
    parser.add_argument(
        "--only",
        action="append",
        choices=("compose-unicode", "bracketed-paste", "history", "immediate-next-input", "transcript-scroll", "tools-slash"),
        help="run only the named session (repeat for multiple sessions)",
    )
    parser.add_argument(
        "--launch-lock",
        type=Path,
        default=Path("/Users/kylemccleary/projects/breadboard-tui-excellence-artifacts/runs/20260908T202438Z_01a01244/tooling/installed_candidate_lock.py"),
    )
    options = parser.parse_args()
    for path in (options.bb, options.pi_natives, options.sdk_artifact, options.sdk_provenance, options.launch_lock):
        if not path.is_file():
            raise SystemExit(f"missing artifact: {path}")
    mkdir0700(options.output)
    journey = Journey(options, options.dimension, options.output)
    try:
        result = journey.run()
    finally:
        journey.close_session()
    print(json.dumps(result, sort_keys=True))
    required = CONTINUATION_P1_STEPS if not options.only or "tools-slash" in options.only else frozenset()
    return determine_journey_exit_code(journey.sessions, journey.records, required)


if __name__ == "__main__":
    raise SystemExit(main())
