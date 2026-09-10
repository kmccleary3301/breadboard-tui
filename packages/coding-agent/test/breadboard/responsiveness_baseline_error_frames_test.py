import importlib.util
import sys
import unittest
from pathlib import Path


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


if __name__ == "__main__":
    unittest.main()
