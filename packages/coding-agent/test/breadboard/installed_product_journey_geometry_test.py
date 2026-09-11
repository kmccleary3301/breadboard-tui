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
