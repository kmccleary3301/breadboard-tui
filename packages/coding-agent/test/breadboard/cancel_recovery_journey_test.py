from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


_DRIVER_PATH = Path(__file__).with_name("cancel-recovery-journey.py")
_SPEC = importlib.util.spec_from_file_location("cancel_recovery_journey", _DRIVER_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"cannot load driver: {_DRIVER_PATH}")
_DRIVER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_DRIVER)


class CancelRecoveryJourneyTests(unittest.TestCase):
    def test_completed_turn_timeout_is_not_upgraded_by_passing_teardown(self) -> None:
        record = {"actionResult": "UNKNOWN", "verdict": "UNKNOWN"}

        _DRIVER.finalize_teardown(record, engine_exit_within_deadline=True, endpoint_closed=True)

        self.assertEqual(record["actionResult"], "UNKNOWN")
        self.assertEqual(record["teardownAssertion"]["pass"], True)
        self.assertEqual(record["verdict"], "UNKNOWN")
        self.assertNotEqual(record["verdict"], "pass")


if __name__ == "__main__":
    unittest.main()
