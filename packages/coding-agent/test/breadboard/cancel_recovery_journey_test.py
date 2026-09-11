from __future__ import annotations

import http.client
import http.server
import importlib.util
import json
import socket
import sys
import threading
import unittest
from pathlib import Path
from urllib.parse import urlsplit


_DRIVER_PATH = Path(__file__).with_name("cancel-recovery-journey.py")
_SPEC = importlib.util.spec_from_file_location("cancel_recovery_journey", _DRIVER_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"cannot load driver: {_DRIVER_PATH}")
_DRIVER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_DRIVER)

_RUNNER_PATH = Path(__file__).with_name("installed-product-journey.py")
_RUNNER_SPEC = importlib.util.spec_from_file_location(
    "installed_product_journey", _RUNNER_PATH
)
if _RUNNER_SPEC is None or _RUNNER_SPEC.loader is None:
    raise RuntimeError(f"cannot load runner: {_RUNNER_PATH}")
_RUNNER = importlib.util.module_from_spec(_RUNNER_SPEC)
sys.modules[_RUNNER_SPEC.name] = _RUNNER
_RUNNER_SPEC.loader.exec_module(_RUNNER)


class CancelRecoveryJourneyTests(unittest.TestCase):
    def test_completed_turn_timeout_is_not_upgraded_by_passing_teardown(self) -> None:
        record = {"actionResult": "UNKNOWN", "verdict": "UNKNOWN"}

        _DRIVER.finalize_teardown(record, engine_exit_within_deadline=True, endpoint_closed=True)

        self.assertEqual(record["actionResult"], "UNKNOWN")
        self.assertEqual(record["teardownAssertion"]["pass"], True)
        self.assertEqual(record["verdict"], "UNKNOWN")
        self.assertNotEqual(record["verdict"], "pass")

    def test_replay_accepts_canonical_stream_open_and_finite_watermark(self) -> None:
        opening = {"type": "stream.open", "payload": {"headSequence": 2}}
        first = {"type": "session.event", "seq": 1, "stable_cursor": True}
        watermark = {"type": "session.event", "seq": 2, "stable_cursor": True}
        body = b"".join(
            f"data: {json.dumps(event)}\n\n".encode("utf-8")
            for event in (opening, first, watermark)
        )

        class ReplayHandler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def do_GET(self) -> None:
                self.close_connection = True
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Connection", "close")
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()

            def log_message(self, _format: str, *_args: object) -> None:
                return

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ReplayHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = _DRIVER.stream_events(
                f"http://127.0.0.1:{server.server_port}", "session"
            )
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

        self.assertEqual(result["status"], 200)
        self.assertEqual(result["headSequence"], 2)
        self.assertEqual(result["events"], [first, watermark])

    def test_proxy_preserves_pre_response_connection_refusal(self) -> None:
        target_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        target_socket.bind(("127.0.0.1", 0))
        target_port = target_socket.getsockname()[1]
        self.addCleanup(target_socket.close)

        target = f"http://127.0.0.1:{target_port}"
        proxy = _RUNNER.HeldSessionMutationProxy(target)
        proxy.start()
        target_socket.close()
        connection: http.client.HTTPConnection | None = None
        try:
            proxy_address = urlsplit(proxy.environment()["http_proxy"])
            if proxy_address.hostname is None or proxy_address.port is None:
                self.fail("proxy did not expose a loopback endpoint")
            connection = http.client.HTTPConnection(
                proxy_address.hostname, proxy_address.port, timeout=2
            )
            with self.assertRaises(http.client.RemoteDisconnected):
                connection.request(
                    "GET",
                    f"{target}/health",
                    headers={"Host": f"127.0.0.1:{target_port}"},
                )
                connection.getresponse()
        finally:
            if connection is not None:
                connection.close()
            proxy.stop()


if __name__ == "__main__":
    unittest.main()
