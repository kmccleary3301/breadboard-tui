import importlib.util
import sys
import unittest
from pathlib import Path


RUNNER_PATH = Path(__file__).with_name("installed-product-journey.py")
RUNNER_SPEC = importlib.util.spec_from_file_location(
    "installed_product_journey", RUNNER_PATH
)
if RUNNER_SPEC is None or RUNNER_SPEC.loader is None:
    raise RuntimeError(f"cannot load runner module: {RUNNER_PATH}")
runner = importlib.util.module_from_spec(RUNNER_SPEC)
sys.modules[RUNNER_SPEC.name] = runner
RUNNER_SPEC.loader.exec_module(runner)

EVERYDAY_PATH = Path(__file__).with_name("everyday-interactions-journey.py")
EVERYDAY_SPEC = importlib.util.spec_from_file_location(
    "everyday_interactions_journey", EVERYDAY_PATH
)
if EVERYDAY_SPEC is None or EVERYDAY_SPEC.loader is None:
    raise RuntimeError(f"cannot load everyday journey module: {EVERYDAY_PATH}")
everyday = importlib.util.module_from_spec(EVERYDAY_SPEC)
sys.modules[EVERYDAY_SPEC.name] = everyday
EVERYDAY_SPEC.loader.exec_module(everyday)


class InstalledProductJourneyGeometryTests(unittest.TestCase):
    def test_terminal_screen_resize_clears_and_clamps_with_split_escape(self) -> None:
        screen = runner.TerminalScreen(rows=2, columns=8)
        screen.feed(b"0123456789abcdef")
        screen.resize(2, 3)
        self.assertEqual(screen.text(), "")
        screen.feed(b"Z\x1b")
        screen.feed(b"[HX")
        self.assertEqual(screen.text(), "X\n  Z\n")

    def test_alternate_screen_restores_primary_content_and_saved_cursor(self) -> None:
        screen = runner.TerminalScreen(rows=3, columns=16)
        screen.feed(b"PRIMARY\x1b7\x1b[2;3H\x1b[?104")
        screen.feed(b"9h\x1b[HPANEL\x1b7\x1b[3;1Hother")
        self.assertEqual(screen.text(), "PANEL\n\nother\n")
        screen.feed(b"\x1b[?1049l!\x1b[H\x1b8?")
        self.assertEqual(screen.text(), "PRIMARY\n  ?\n")

    def test_alternate_screen_switches_are_private_and_repeat_safe(self) -> None:
        screen = runner.TerminalScreen(rows=3, columns=16)
        screen.feed(b"MAIN\x1b[1049h?")
        self.assertEqual(screen.text(), "MAIN?\n")
        screen.feed(b"\x1b[?1049h\x1b[HALT\x1b[?1049h")
        self.assertEqual(screen.text(), "ALT\n")
        screen.feed(b"\x1b[?1049l!\x1b[?1049l?")
        self.assertEqual(screen.text(), "MAIN?!?\n")
        screen.feed(b"\x1b[?1049h")
        self.assertEqual(screen.text(), "")
        screen.feed(b"\x1b[?1049l")
        self.assertEqual(screen.text(), "MAIN?!?\n")

    def test_resize_in_alternate_screen_does_not_restore_obsolete_geometry(self) -> None:
        screen = runner.TerminalScreen(rows=3, columns=16)
        screen.feed(b"PRIMARY\x1b[3;16H\x1b[?1049h\x1b[HPANEL")
        screen.resize(2, 3)
        screen.feed(b"\x1b[?1049lX")
        self.assertEqual(screen.text(), "\n  X\n")

    def test_pty_resize_updates_child_and_parser(self) -> None:
        child = runner.PtyChild(
            ["/bin/sh", "-c", "stty size; read line; stty size; read line2"],
            Path.cwd(),
            {"PATH": "/usr/bin:/bin", "TERM": "xterm-256color", "LC_ALL": "C"},
            rows=30,
            columns=100,
        )
        try:
            child.wait_until(
                lambda: "30 100" in child.screen.text(),
                5.0,
                "initial stty size",
            )
            self.assertEqual((child.rows, child.columns), (30, 100))

            child.resize(24, 80)
            child.send_line("resized")
            child.wait_until(
                lambda: "24 80" in child.screen.text(),
                5.0,
                "resized stty size",
            )

            self.assertEqual((child.screen.rows, child.screen.columns), (24, 80))
            self.assertIsNotNone(child.last_output_at)
            self.assertGreaterEqual(child.output_reads, 2)
        finally:
            child.close()

    def test_return_tail_metadata_uses_return_capture_key(self) -> None:
        details = everyday.return_tail_details(
            Path("/tmp/transcript-tail-return.screen.txt"),
            "transcript turn 07\n",
            "transcript turn 07",
        )
        self.assertEqual(details["returnCapture"], "/tmp/transcript-tail-return.screen.txt")
        self.assertNotIn("capture", details)
        self.assertTrue(details["tailReached"])

    def test_terminal_facts_read_retained_binding_rows(self) -> None:
        snapshot = runner.BindingSnapshot(
            Path("/tmp/session.jsonl"),
            {"sessionId": "session-1"},
            [
                {
                    "type": "message",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": "retained terminal input"}],
                    },
                }
            ],
        )
        facts = everyday.retained_binding_facts(snapshot)
        self.assertEqual(facts["userTexts"], ["retained terminal input"])

    def test_local_session_id_extracts_from_session_header_not_engine_binding(self) -> None:
        rows = [
            {"type": "title", "v": 1, "title": "initial"},
            {"type": "session", "version": 3, "id": "01a08bd5-local-uuid", "cwd": "/workspace"},
            {
                "type": "custom",
                "customType": "breadboard.session-binding",
                "data": {
                    "schemaVersion": "breadboard.session-binding.v4",
                    "sessionId": "e1dfe8e0-engine-uuid",
                },
            },
        ]
        snapshot = runner.BindingSnapshot(
            Path("/workspace/agent/sessions/test.jsonl"),
            rows[2]["data"],
            rows,
        )
        self.assertEqual(everyday.extract_local_session_id(rows), "01a08bd5-local-uuid")
        self.assertEqual(everyday.extract_engine_session_id(snapshot), "e1dfe8e0-engine-uuid")
        self.assertNotEqual(
            everyday.extract_local_session_id(rows),
            snapshot.data.get("sessionId"),
        )

    def test_determine_journey_exit_code_propagates_child_failures_and_signals(self) -> None:
        clean_sessions = [{"label": "s1", "tuiExitCode": 0}]
        passing_records = [
            {"step": "approval-allow-tool-runs", "status": "PASS"},
            {"step": "slash-new-clears-and-new-identity", "status": "PASS"},
        ]
        self.assertEqual(everyday.determine_journey_exit_code(clean_sessions, passing_records), 0)

        crash_sessions = [{"label": "s1", "tuiExitCode": 1}]
        self.assertEqual(everyday.determine_journey_exit_code(crash_sessions, passing_records), 1)

        signal_sessions = [{"label": "s1", "tuiExitCode": -15}]
        self.assertEqual(everyday.determine_journey_exit_code(signal_sessions, passing_records), 143)

    def test_determine_journey_exit_code_enforces_continuation_p1_and_preserves_nonclaims(self) -> None:
        clean_sessions = [{"label": "s1", "tuiExitCode": 0}]

        p1_unknown_records = [
            {"step": "approval-allow-tool-runs", "status": "UNKNOWN"},
            {"step": "slash-new-clears-and-new-identity", "status": "PASS"},
        ]
        self.assertEqual(everyday.determine_journey_exit_code(clean_sessions, p1_unknown_records), 1)

        p1_fail_records = [
            {"step": "approval-allow-tool-runs", "status": "PASS"},
            {"step": "slash-new-clears-and-new-identity", "status": "FAIL"},
        ]
        self.assertEqual(everyday.determine_journey_exit_code(clean_sessions, p1_fail_records), 1)

        inherited_nonclaim_records = [
            {"step": "approval-allow-tool-runs", "status": "PASS"},
            {"step": "slash-new-clears-and-new-identity", "status": "PASS"},
            {"step": "streaming-immediate-next-input", "status": "UNKNOWN"},
            {"step": "navigate-long-transcript-page-scroll", "status": "UNKNOWN"},
            {"step": "slash-fresh-retains-identity", "status": "UNKNOWN"},
        ]
        self.assertEqual(everyday.determine_journey_exit_code(clean_sessions, inherited_nonclaim_records), 0)


if __name__ == "__main__":
    unittest.main()
