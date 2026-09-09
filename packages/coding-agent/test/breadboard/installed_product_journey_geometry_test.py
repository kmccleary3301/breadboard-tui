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


class InstalledProductJourneyGeometryTests(unittest.TestCase):
    def test_terminal_screen_resize_drops_grid_and_clamps_cursor(self) -> None:
        screen = runner.TerminalScreen(rows=2, columns=8)
        screen.feed(b"0123456789abcdef\x1b")
        self.assertEqual(screen.pending, "\x1b")
        self.assertEqual((screen.row, screen.column), (1, 8))

        screen.resize(2, 3)

        self.assertEqual(screen.rows, 2)
        self.assertEqual(screen.columns, 3)
        self.assertEqual((screen.row, screen.column), (1, 2))
        self.assertEqual(screen.grid, [[" "] * 3 for _ in range(2)])
        self.assertEqual(screen.pending, "\x1b")

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
