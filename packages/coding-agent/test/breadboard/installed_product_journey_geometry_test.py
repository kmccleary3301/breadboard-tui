from __future__ import annotations

import base64
import importlib.util
import json
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


def _frame_trailer(
    nonce: str,
    frame_id: int,
    input_id: int,
    input_data: str = "",
    input_at: float | None = None,
) -> bytes:
    metadata = {
        "version": 1,
        "frameId": frame_id,
        "inputId": input_id,
        "inputData": input_data,
        "inputAtMs": input_at,
        "writtenAtMs": float(frame_id) + 10,
        "monotonicOriginMs": None,
        "clockUncertaintyMs": None,
    }
    encoded = base64.b64encode(json.dumps(metadata, separators=(",", ":")).encode()).decode()
    return f"\x1b]777;omp-frame-timing;{nonce};{encoded}\x07".encode()


class InstalledProductJourneyGeometryTests(unittest.TestCase):
    def test_malformed_timing_payload_does_not_abort_screen_parsing(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        malformed = (
            b"[" * 2000 + b"0" + b"]" * 2000,
            json.dumps({"version": 1, "frameId": 10 ** 400, "inputId": 0}).encode(),
        )
        for payload in malformed:
            with self.subTest(payload_bytes=len(payload)):
                screen = runner.TerminalScreen(rows=2, columns=8, timing_nonce=nonce)
                screen.feed(b"\x1b]777;omp-frame-timing;" + nonce.encode() + b";" + base64.b64encode(payload) + b"\x07ok")
                self.assertEqual(screen.drain_frame_events(), [])
                screen.feed(_frame_trailer(nonce, 0, 0))
                self.assertEqual([event.screen for event in screen.drain_frame_events()], ["ok\n"])

    def test_oversized_valid_timing_payload_is_not_retained(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        screen = runner.TerminalScreen(rows=2, columns=8, timing_nonce=nonce)
        screen.feed(_frame_trailer(nonce, 0, 0))
        screen.drain_frame_events()
        payload = base64.b64encode(b"x" * runner.MAX_FRAME_METADATA_BYTES).decode()
        screen.feed(_frame_trailer(nonce, 1, 1, payload, 1.0) + b"after")
        self.assertEqual(screen.drain_frame_events(), [])
        self.assertEqual(screen.text(), "after\n")

    def test_frame_trailer_snapshots_exact_screen_across_split_and_multiple_markers(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        screen = runner.TerminalScreen(rows=2, columns=8, timing_nonce=nonce)
        first = _frame_trailer(nonce, 0, 0)
        screen.feed(b"\x1b[2J\x1b[Hfirst" + first[: len(first) // 2])
        self.assertEqual(screen.drain_frame_events(), [])
        screen.feed(first[len(first) // 2 :] + b"\x1b[2J\x1b[Hsecond")
        second = _frame_trailer(nonce, 1, 1, "Yg==", 1.5)
        screen.feed(second)
        events = screen.drain_frame_events()
        self.assertEqual([event.metadata["frameId"] for event in events], [0, 1])
        self.assertEqual(events[0].screen, "first\n")
        self.assertEqual(events[1].screen, "second\n")

    def test_frame_trailer_rejects_wrong_nonce_and_invalid_metadata_without_rendering(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        screen = runner.TerminalScreen(rows=2, columns=8, timing_nonce=nonce)
        wrong = _frame_trailer("fedcba9876543210fedcba9876543210", 1, 0)
        screen.feed(b"\x1b[2J\x1b[Hok" + wrong)
        screen.feed(b"\x1b]777;omp-frame-timing;" + nonce.encode() + b";not-json\x07")
        self.assertEqual(screen.drain_frame_events(), [])
        self.assertEqual(screen.text(), "ok\n")
        self.assertEqual(screen.frame_rejections, {"wrong_nonce": 1, "invalid_json": 1})

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


if __name__ == "__main__":
    unittest.main()
