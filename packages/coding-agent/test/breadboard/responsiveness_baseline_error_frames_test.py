import base64
import importlib.util
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

HARNESS_PATH = Path(__file__).with_name("responsiveness-baseline.py")
HARNESS_SPEC = importlib.util.spec_from_file_location(
    "responsiveness_baseline", HARNESS_PATH
)
if HARNESS_SPEC is None or HARNESS_SPEC.loader is None:
    raise RuntimeError(f"cannot load harness module: {HARNESS_PATH}")
harness = importlib.util.module_from_spec(HARNESS_SPEC)
sys.modules[HARNESS_SPEC.name] = harness
HARNESS_SPEC.loader.exec_module(harness)


# Status rows exactly as the two products rendered them in the recorded E1
# baseline frames (120x36 and 80x24 geometries share the prefix).
OMP_STATUS_ROW = " π  > ⬢ no-model > 📁  …-cell-adverse-120x36-vl4oom9f/workspace > ◫ 393K/? ⟲ ▶───"
BB_STATUS_ROW = " bb > ⬢ mock/reference > 📁  …ll-complex-80x24-2c9a8e1f/workspace > ◫ 56K/? ⟲ ▶───"
COMPOSER_ROW = "╰────────────────────────────────────────────────────────────────────╯"

PROVIDER_FREE_REJECTION = "Error: No model selected."
# The four distinct product error strings recorded across the BB cells.
RECORDED_BB_ERRORS = (
    "Error: BreadBoard replay began mid-tool without the retained tool call",
    "Error: BreadBoard submission was already observed; its result is already in",
    "Error: BreadBoard submission was already observed; its result is already in the transcript",
    "Error: Session protocol error (sse_event_data_too_large)",
)
# Transcript lines carrying the exact status glyphs without being a status row.
TRANSCRIPT_DECOYS = (
    "│ the user typed ⬢ no-model > into the composer and pressed enter",
    "⬢ no-model > quoted at the start of a transcript line",
    "> ⬢ no-model > echoed by the assistant",
)


def _screen(*rows: str) -> str:
    return "\n".join((*rows, COMPOSER_ROW))


class ErrorFramesTests(unittest.TestCase):
    def test_aggregate_preserves_phases_and_rejects_cross_product_append(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "measurements.json"
            for phase in ("startup", "cells", "soak"):
                harness._write_aggregate(path, phase, {"product": "bb", "endpoint": harness.TIMING_ENDPOINT})
            retained = path.read_bytes()
            self.assertEqual(set(json.loads(retained)) & {"startup", "cells", "soak"}, {"startup", "cells", "soak"})
            with self.assertRaises(RuntimeError):
                harness._write_aggregate(path, "cells", {"product": "omp", "endpoint": harness.TIMING_ENDPOINT})
            self.assertEqual(path.read_bytes(), retained)

    def test_missing_product_cannot_bypass_nested_endpoint_checks(self) -> None:
        for section in ({"endpoint": "legacy PTY"}, {"endpoint": harness.TIMING_ENDPOINT}):
            with self.subTest(section=section):
                with self.assertRaises(ValueError):
                    harness._require_timing_endpoint(
                        {"product": "bb", "endpoint": harness.TIMING_ENDPOINT, "cells": section}, "BB"
                    )

    def test_provider_free_rejection_is_not_an_error_under_the_plain_omp_row(self) -> None:
        self.assertEqual(harness._error_frames(_screen(OMP_STATUS_ROW, PROVIDER_FREE_REJECTION)), 0)

    def test_provider_free_rejection_counts_under_mock_reference(self) -> None:
        self.assertEqual(harness._error_frames(_screen(BB_STATUS_ROW, PROVIDER_FREE_REJECTION)), 1)

    def test_recorded_bb_errors_count_under_mock_reference(self) -> None:
        for error in RECORDED_BB_ERRORS:
            with self.subTest(error=error):
                self.assertGreaterEqual(harness._error_frames(_screen(BB_STATUS_ROW, error)), 1)

    def test_only_the_exact_rejection_is_subtracted_under_the_plain_omp_row(self) -> None:
        for error in RECORDED_BB_ERRORS:
            with self.subTest(error=error):
                screen = _screen(OMP_STATUS_ROW, PROVIDER_FREE_REJECTION, error)
                self.assertEqual(harness._error_frames(screen), 1)

    def test_transcript_decoys_do_not_gate_the_exception(self) -> None:
        for decoy in TRANSCRIPT_DECOYS:
            with self.subTest(decoy=decoy):
                self.assertFalse(harness._has_provider_free_status_row(_screen(BB_STATUS_ROW, decoy)))
                screen = _screen(BB_STATUS_ROW, decoy, PROVIDER_FREE_REJECTION)
                self.assertEqual(harness._error_frames(screen), 1)

    def test_status_row_is_recognised_at_both_geometries(self) -> None:
        narrow = " π  > ⬢ no-model > 📁  …p-cell-adverse-80x24-lzsnxswf/workspace > ◫ 393K/? ⟲ ▶───"
        for row in (OMP_STATUS_ROW, narrow):
            with self.subTest(row=row):
                self.assertTrue(harness._has_provider_free_status_row(_screen(row)))
        self.assertFalse(harness._has_provider_free_status_row(_screen(BB_STATUS_ROW)))


    def test_frame_selection_requires_fresh_input_id_and_exact_payload(self) -> None:
        nonce = "0123456789abcdef0123456789abcdef"
        payload = b"\x1b[6~"

        def event(frame_id: int, input_id: int, data: bytes, screen: str) -> object:
            return harness.runner.FrameTimingEvent(
                nonce=nonce,
                metadata={
                    "version": 1,
                    "frameId": frame_id,
                    "inputId": input_id,
                    "inputData": base64.b64encode(data).decode("ascii"),
                    "inputAtMs": 1.0,
                    "writtenAtMs": float(frame_id),
                    "monotonicOriginMs": None,
                    "clockUncertaintyMs": None,
                },
                raw_metadata="{}",
                screen=screen,
            )

        selected = harness._select_frame_event(
            [
                event(2, 4, payload, "matching stale"),
                event(3, 5, b"wrong", "matching wrong-payload"),
                event(4, 5, payload, "matching fresh"),
                event(5, 5, payload, "matching later"),
            ],
            "before",
            payload,
            4,
            lambda before, after: after.startswith("matching"),
        )
        self.assertIsNotNone(selected)
        self.assertEqual(selected.screen, "matching fresh")

    def test_clock_mapping_uses_write_time_and_retains_uncertainty_not_observer_delay(self) -> None:
        child = SimpleNamespace(clock_mapping=harness.runner.MonotonicClockMapping(1000.0, 0.25))
        event = harness.runner.FrameTimingEvent(
            nonce="0123456789abcdef0123456789abcdef",
            metadata={
                "inputAtMs": 111.0,
                "writtenAtMs": 115.0,
                "monotonicOriginMs": 900.0,
                "clockUncertaintyMs": 0.5,
            },
            raw_metadata="",
            screen="ready",
            observed_at_monotonic=0.016,
        )
        details = harness._frame_clock_details(child, event, 0.010)
        delayed = harness._frame_clock_details(child, replace(event, observed_at_monotonic=0.216), 0.010)
        self.assertEqual(details["latencyUpperBoundMs"], 5.75)
        self.assertEqual(details["inputToWriteMs"], 4.0)
        self.assertEqual(delayed["latencyUpperBoundMs"], details["latencyUpperBoundMs"])
        missing = harness._frame_clock_details(SimpleNamespace(clock_mapping=None), event, 0.010)
        self.assertIsNone(missing["latencyUpperBoundMs"])

if __name__ == "__main__":
    unittest.main()
