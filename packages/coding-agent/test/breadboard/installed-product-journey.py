#!/usr/bin/env python3
"""Drive the installed BreadBoard two-turn and resume journey through a real PTY."""

from __future__ import annotations

import argparse
import atexit
import base64
import binascii
import codecs
import copy
import csv
import ctypes
import errno
import fcntl
import hashlib
import http.client
import http.server
import ipaddress
import json
import math
import os
import pty
import pwd
import re
import secrets
import select
import shutil
import signal
import socket
import sqlite3
import struct
import subprocess
import sys
import termios
import threading
import time
import unicodedata
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

ROWS = 36
COLUMNS = 120
ASSISTANT_SENTINEL = "Proceed to build and test."
FIRST_PROMPT = "Create the deterministic protofilesystem fixture now."
SECOND_PROMPT = "Report the next action after the fixture is ready."
SYNTHETIC_PROMPT = "Create and validate the deterministic bubble sort fixture."
CANCEL_PROMPT = (
    "Repeat the deterministic bubble sort validation, then wait for permission."
)
CRASH_PROMPT = "Start another deterministic bubble sort validation for crash recovery."
RECONNECT_PROMPT = (
    "Prove the recovered engine can execute the deterministic validation."
)
POST_RESUME_PROMPT = (
    "Prove the resumed session can execute one final deterministic validation."
)
BINDING_SCHEMA = "breadboard.session-binding.v4"
BINDING_TYPE = "breadboard.session-binding"
EXPECTED_FILES = (
    "Makefile",
    "protofilesystem.h",
    "protofilesystem.c",
    "test_filesystem.c",
)
EVENT_ID_RE = re.compile(
    r"(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|sha256:[0-9a-f]{64})"
)
GIT_OBJECT_RE = re.compile(r"[0-9a-f]{40}")
EXPECTED_ARTIFACT_SHA256 = {
    "sdkArtifact": "1466b739a1eb16418a749187746b61433586eecb898a234ba5f6fbb76f957bf4",
    "sdkProvenance": "47766fd130c7f2fbcf9db7b4ba1607fc846657d42e8b28afb50c7c20aa012f31",
}
SYNTHETIC_TOOLS = ("todo.write_board", "write", "run_shell")
ANSI_RE = re.compile(
    rb"(?:\x1B\][^\x07]*(?:\x07|\x1B\\)|\x1B\[[0-?]*[ -/]*[@-~]|\x1B[@-_])"
)

TIMING_NONCE_ENV = "OMP_TUI_TIMING_NONCE"
TIMING_NONCE_RE = re.compile(r"[0-9a-f]{32}")
MAX_FRAME_EVENTS = 256
MAX_FRAME_METADATA_BYTES = 64 * 1024


def new_timing_nonce() -> str:
    return secrets.token_hex(16)


def timing_environment(env: dict[str, str]) -> dict[str, str]:
    child_env = dict(env)
    child_env[TIMING_NONCE_ENV] = new_timing_nonce()
    return child_env


@dataclass(frozen=True)
class FrameTimingEvent:
    nonce: str
    metadata: dict[str, Any]
    raw_metadata: str
    screen: str
    observed_at_monotonic: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "nonce": self.nonce,
            "metadata": dict(self.metadata),
            "rawMetadata": self.raw_metadata,
            "screen": self.screen,
            "observedAtMonotonic": self.observed_at_monotonic,
        }


def _valid_timing_number(value: Any, *, nonnegative: bool = True) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        number = float(value)
    except OverflowError:
        return False
    return math.isfinite(number) and (not nonnegative or number >= 0)


def _parse_frame_timing(
    raw_metadata: str,
    nonce: str,
    previous_frame_id: int | None,
    previous_input_id: int | None,
    previous_input_data: str | None,
    previous_input_at: float | None,
) -> tuple[dict[str, Any] | None, str | None]:
    if len(raw_metadata) > MAX_FRAME_METADATA_BYTES:
        return None, "oversized_metadata"
    try:
        decoded = base64.b64decode(raw_metadata, validate=True).decode("utf-8")
        metadata = json.loads(decoded)
    except (json.JSONDecodeError, TypeError, ValueError, UnicodeError, binascii.Error, RecursionError):
        return None, "invalid_json"
    if (
        not isinstance(metadata, dict)
        or isinstance(metadata.get("version"), bool)
        or metadata.get("version") != 1
    ):
        return None, "invalid_version"
    frame_id = metadata.get("frameId")
    input_id = metadata.get("inputId")
    if (
        not _valid_timing_number(frame_id)
        or not isinstance(frame_id, int)
        or not _valid_timing_number(input_id)
        or not isinstance(input_id, int)
    ):
        return None, "invalid_id"
    if frame_id != (0 if previous_frame_id is None else previous_frame_id + 1):
        return None, "unexpected_frame_id"
    if previous_input_id is not None and input_id < previous_input_id:
        return None, "nonmonotonic_input_id"
    input_data = metadata.get("inputData")
    if not isinstance(input_data, str):
        return None, "invalid_input_data"
    try:
        base64.b64decode(input_data, validate=True)
    except (ValueError, binascii.Error):
        return None, "invalid_input_data"
    input_at = metadata.get("inputAtMs")
    if input_id == 0:
        if input_data != "" or input_at is not None:
            return None, "invalid_startup_input"
    else:
        if not _valid_timing_number(input_at):
            return None, "invalid_input_time"
        if previous_input_id == input_id and (
            input_data != previous_input_data or input_at != previous_input_at
        ):
            return None, "changed_input"
    if input_at is not None and not _valid_timing_number(input_at):
        return None, "invalid_input_time"
    written_at = metadata.get("writtenAtMs")
    if not _valid_timing_number(written_at) or (input_at is not None and written_at < input_at):
        return None, "invalid_written_time"
    origin = metadata.get("monotonicOriginMs")
    uncertainty = metadata.get("clockUncertaintyMs")
    if (origin is None) != (uncertainty is None):
        return None, "partial_clock_mapping"
    if origin is not None and (
        not _valid_timing_number(origin, nonnegative=False) or not _valid_timing_number(uncertainty)
    ):
        return None, "invalid_clock_mapping"
    return metadata, None


class JourneyFailure(RuntimeError):
    pass


@dataclass(frozen=True)
class MonotonicClockMapping:
    origin_ms: float
    uncertainty_ms: float
    source: str = "mach_absolute_time"

class _MachTimebaseInfo(ctypes.Structure):
    _fields_ = [
        ("numer", ctypes.c_uint32),
        ("denom", ctypes.c_uint32),
    ]


_mach_clock: tuple[ctypes.CDLL, _MachTimebaseInfo] | None = None


def _mach_absolute_ms() -> float:
    global _mach_clock
    if sys.platform != "darwin":
        raise OSError("mach clock is only available on Darwin")
    if _mach_clock is None:
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
        info = _MachTimebaseInfo()
        timebase_info = library.mach_timebase_info
        timebase_info.argtypes = [ctypes.POINTER(_MachTimebaseInfo)]
        timebase_info.restype = ctypes.c_int
        if timebase_info(ctypes.byref(info)) != 0 or info.denom == 0:
            raise OSError("mach_timebase_info failed")
        library.mach_absolute_time.argtypes = []
        library.mach_absolute_time.restype = ctypes.c_uint64
        _mach_clock = library, info
    library, info = _mach_clock
    return float(library.mach_absolute_time()) * info.numer / info.denom / 1_000_000.0


def capture_mapped_monotonic_time() -> tuple[float, MonotonicClockMapping | None]:
    try:
        mach_before = _mach_absolute_ms()
    except (OSError, AttributeError):
        return time.monotonic(), None
    timestamp = time.monotonic()
    try:
        mach_after = _mach_absolute_ms()
    except (OSError, AttributeError):
        return timestamp, None
    mono_ms = timestamp * 1000.0
    if not all(math.isfinite(value) for value in (mach_before, mono_ms, mach_after)) or mach_after < mach_before:
        return timestamp, None
    rounding_bound = 2.0 * sys.float_info.epsilon * (abs(mach_before) + abs(mach_after) + abs(mono_ms))
    return timestamp, MonotonicClockMapping(
        origin_ms=((mach_before + mach_after) / 2.0) - mono_ms,
        uncertainty_ms=(mach_after - mach_before) / 2.0 + rounding_bound,
    )


class _HeldSessionMutationProxyServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(
        self,
        proxy: "HeldSessionMutationProxy",
        server_address: tuple[str, int],
    ) -> None:
        self.proxy = proxy
        super().__init__(server_address, _HeldSessionMutationProxyHandler)


class _HeldSessionMutationProxyHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def setup(self) -> None:
        super().setup()
        self._proxy = self.server.proxy
        self._upstream: http.client.HTTPConnection | None = None
        self._proxy._register_handler(self)

    def finish(self) -> None:
        try:
            super().finish()
        finally:
            self._proxy._unregister_handler(self)

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:
        self._proxy_request()

    def do_HEAD(self) -> None:
        self._proxy_request()

    def do_POST(self) -> None:
        self._proxy_request()

    def do_PUT(self) -> None:
        self._proxy_request()

    def do_PATCH(self) -> None:
        self._proxy_request()

    def do_DELETE(self) -> None:
        self._proxy_request()

    def do_OPTIONS(self) -> None:
        self._proxy_request()

    def do_TRACE(self) -> None:
        self._proxy_request()

    def do_CONNECT(self) -> None:
        self._send_proxy_error(501, "proxy_connect_unsupported")

    def _send_proxy_error(self, status: int, error_code: str) -> None:
        body = json.dumps({"errorCode": error_code}, separators=(",", ":")).encode(
            "utf-8"
        )
        self.close_connection = True
        try:
            self.send_response_only(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except OSError:
            pass

    def _proxy_request(self) -> None:
        try:
            path = self._proxy.request_path(self.path, self.headers)
            body = self._proxy.request_body(self.headers, self.rfile)
            trace = self._proxy.request_trace(self.command, path, self.headers, body)
            release_event = self._proxy.claim_held_request(
                self.command, path, trace, self
            )
            held = release_event is not None
            if held:
                while not release_event.wait(0.1):
                    if self._proxy.stopping:
                        self._send_proxy_error(503, "proxy_stopped")
                        return
                if self._proxy.stopping:
                    self._send_proxy_error(503, "proxy_stopped")
                    return
            self._proxy.forward(self, self.command, path, body, trace, held)
        except _ProxyRejected as rejected:
            self._send_proxy_error(rejected.status, rejected.error_code)
        except (BrokenPipeError, ConnectionResetError, OSError):
            self.close_connection = True
        except Exception:
            self._send_proxy_error(502, "proxy_upstream_error")


class _ProxyRejected(Exception):
    def __init__(self, status: int, error_code: str) -> None:
        self.status = status
        self.error_code = error_code
        super().__init__(error_code)


class HeldSessionMutationProxy:
    """A loopback-only HTTP forwarder with one request mutation hold point."""

    _HOP_BY_HOP_HEADERS = frozenset(
        {
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "proxy-connection",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
        }
    )
    _PROOF_HEADERS = {
        "x-breadboard-engine-instance-id": "engineInstanceId",
        "x-breadboard-engine-boot-id": "engineBootId",
        "x-breadboard-launch-id": "launchId",
        "x-breadboard-registration-id": "registrationId",
        "x-breadboard-registration-generation": "registrationGeneration",
        "x-breadboard-client-instance-id": "clientInstanceId",
        "x-breadboard-registration-credential": "credentialSha256",
    }
    _MAX_CAPTURE_BYTES = 1024 * 1024
    _REDACTED = "<redacted>"
    _SENSITIVE_KEY_RE = re.compile(
        r"(?:authorization|credential|password|passwd|secret|token|api.?key)",
        re.IGNORECASE,
    )
    _BEARER_RE = re.compile(r"(?i)\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+")

    def __init__(self, endpoint: str) -> None:
        self._endpoint = endpoint
        self._target = None
        self._target_host: str | None = None
        self._target_port: int | None = None
        self._target_authority: str | None = None
        self._lock = threading.RLock()
        self._server: _HeldSessionMutationProxyServer | None = None
        self._server_thread: threading.Thread | None = None
        self._handler_threads: set[threading.Thread] = set()
        self._handlers: set[_HeldSessionMutationProxyHandler] = set()
        self._upstreams: set[http.client.HTTPConnection] = set()
        self._proxy_port: int | None = None
        self._armed_session_id: str | None = None
        self._held_request: dict[str, Any] | None = None
        self._held_event: threading.Event | None = None
        self._held_handler: _HeldSessionMutationProxyHandler | None = None
        self._outcome: dict[str, Any] | None = None
        self._requests: list[dict[str, Any]] = []
        self._stopping = False
        self._stop_receipt: dict[str, Any] | None = None

    @staticmethod
    def _validate_endpoint(endpoint: str):
        parsed = urlsplit(endpoint)
        if (
            parsed.scheme.lower() != "http"
            or parsed.username is not None
            or parsed.password is not None
            or parsed.hostname is None
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("proxy endpoint must be a bare loopback HTTP URL")
        try:
            address = ipaddress.ip_address(parsed.hostname)
            port = parsed.port or 80
        except (ValueError, TypeError):
            raise ValueError("proxy endpoint must use a loopback IP literal") from None
        if not address.is_loopback or not 1 <= port <= 65535:
            raise ValueError("proxy endpoint must be a loopback HTTP URL")
        return parsed

    @staticmethod
    def _format_authority(host: str | None, port: int) -> str:
        if host is None:
            raise ValueError("proxy endpoint has no host")
        if ":" in host:
            return f"[{host}]:{port}"
        return f"{host}:{port}"

    @property
    def stopping(self) -> bool:
        with self._lock:
            return self._stopping

    @property
    def held_request(self) -> dict[str, Any] | None:
        with self._lock:
            return copy.deepcopy(self._held_request)

    @property
    def outcome(self) -> dict[str, Any] | None:
        with self._lock:
            return copy.deepcopy(self._outcome)

    @property
    def requests(self) -> list[dict[str, Any]]:
        with self._lock:
            return copy.deepcopy(self._requests)

    def start(self) -> None:
        with self._lock:
            if self._server is not None:
                if self._stopping:
                    raise RuntimeError("proxy has been stopped")
                return
            if self._stopping:
                raise RuntimeError("proxy has been stopped")
            target = self._validate_endpoint(self._endpoint)
            target_host = target.hostname
            target_port = target.port or 80
            target_authority = self._format_authority(target_host, target_port)
            server = _HeldSessionMutationProxyServer(self, ("127.0.0.1", 0))
            thread = threading.Thread(
                target=server.serve_forever,
                name="held-session-mutation-proxy",
                daemon=True,
            )
            self._target = target
            self._target_host = target_host
            self._target_port = target_port
            self._target_authority = target_authority
            self._server = server
            self._server_thread = thread
            self._proxy_port = int(server.server_port)
            try:
                thread.start()
            except BaseException:
                self._server = None
                self._server_thread = None
                self._proxy_port = None
                server.server_close()
                raise

    def environment(self) -> dict[str, str]:
        with self._lock:
            if self._server is None or self._proxy_port is None or self._stopping:
                raise RuntimeError("proxy is not running")
            proxy = f"http://127.0.0.1:{self._proxy_port}"
            return {
                "HTTP_PROXY": proxy,
                "http_proxy": proxy,
                "NO_PROXY": "",
                "no_proxy": "",
            }

    def arm(self, session_id: str) -> None:
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("session_id must be a non-empty string")
        with self._lock:
            if self._server is None or self._stopping:
                raise RuntimeError("proxy is not running")
            if self._armed_session_id is not None or self._held_event is not None:
                raise RuntimeError("proxy already has an armed or held request")
            self._armed_session_id = session_id
            self._held_request = None
            self._outcome = None

    def release(self) -> None:
        with self._lock:
            event = self._held_event
        if event is not None:
            event.set()

    def _register_handler(self, handler: _HeldSessionMutationProxyHandler) -> None:
        with self._lock:
            self._handlers.add(handler)
            self._handler_threads.add(threading.current_thread())
            if self._stopping:
                try:
                    handler.connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def _unregister_handler(self, handler: _HeldSessionMutationProxyHandler) -> None:
        with self._lock:
            self._handlers.discard(handler)
            self._handler_threads.discard(threading.current_thread())
            if self._held_handler is handler:
                self._held_handler = None

    def _register_upstream(self, upstream: http.client.HTTPConnection) -> bool:
        with self._lock:
            if self._stopping:
                return False
            self._upstreams.add(upstream)
            return True

    def _unregister_upstream(self, upstream: http.client.HTTPConnection) -> None:
        with self._lock:
            self._upstreams.discard(upstream)

    def request_path(self, request_target: str, headers: Any) -> str:
        try:
            parsed = urlsplit(request_target)
            absolute = bool(parsed.scheme or parsed.netloc)
            if absolute:
                if (
                    self._target is None
                    or parsed.scheme.lower() != self._target.scheme.lower()
                    or parsed.hostname != self._target_host
                    or (parsed.port or 80) != self._target_port
                    or parsed.username is not None
                    or parsed.password is not None
                    or parsed.fragment
                ):
                    raise _ProxyRejected(403, "proxy_destination_rejected")
                path = parsed.path or "/"
                if parsed.query:
                    path = f"{path}?{parsed.query}"
            else:
                if not request_target.startswith("/"):
                    raise _ProxyRejected(400, "proxy_request_target_rejected")
                host = headers.get("Host")
                if not isinstance(host, str) or not self._authority_matches(host):
                    raise _ProxyRejected(403, "proxy_destination_rejected")
                path = request_target
        except ValueError:
            raise _ProxyRejected(403, "proxy_destination_rejected") from None
        if "\r" in path or "\n" in path:
            raise _ProxyRejected(400, "proxy_request_target_rejected")
        return path

    def _authority_matches(self, authority: str) -> bool:
        if not authority or "," in authority:
            return False
        try:
            parsed = urlsplit(f"http://{authority}")
            return (
                parsed.hostname == self._target_host
                and (parsed.port or 80) == self._target_port
                and parsed.username is None
                and parsed.password is None
                and parsed.path == ""
                and not parsed.query
                and not parsed.fragment
            )
        except ValueError:
            return False

    def request_body(self, headers: Any, stream: Any) -> bytes:
        transfer_encodings = headers.get_all("Transfer-Encoding", [])
        if transfer_encodings:
            raise _ProxyRejected(501, "proxy_transfer_encoding_unsupported")
        if headers.get_all("Expect", []):
            raise _ProxyRejected(417, "proxy_expect_unsupported")
        values = headers.get_all("Content-Length", [])
        if not values:
            return b""
        lengths: list[int] = []
        for value in values:
            if not re.fullmatch(r"[0-9]+", value.strip()):
                raise _ProxyRejected(400, "proxy_content_length_invalid")
            try:
                lengths.append(int(value.strip()))
            except ValueError:
                raise _ProxyRejected(400, "proxy_content_length_invalid") from None
        if any(length != lengths[0] for length in lengths[1:]):
            raise _ProxyRejected(400, "proxy_content_length_conflict")
        try:
            body = stream.read(lengths[0])
        except (OSError, ValueError):
            raise _ProxyRejected(400, "proxy_request_body_unreadable") from None
        if len(body) != lengths[0]:
            raise _ProxyRejected(400, "proxy_request_body_incomplete")
        return body

    def request_trace(
        self, method: str, path: str, headers: Any, body: bytes
    ) -> dict[str, Any]:
        proof: dict[str, Any] = {}
        for header, field in self._PROOF_HEADERS.items():
            value = headers.get(header)
            if value is None:
                proof[field] = None
            elif field == "registrationGeneration":
                try:
                    proof[field] = int(value.strip())
                except (TypeError, ValueError):
                    raise _ProxyRejected(400, "proxy_proof_invalid") from None
            elif field == "credentialSha256":
                proof[field] = hashlib.sha256(value.encode("utf-8")).hexdigest()
            else:
                proof[field] = value
        return {
            "method": method,
            "path": path,
            "proof": proof,
            "bodySha256": hashlib.sha256(body).hexdigest(),
        }

    def claim_held_request(
        self,
        method: str,
        path: str,
        trace: dict[str, Any],
        handler: _HeldSessionMutationProxyHandler,
    ) -> threading.Event | None:
        with self._lock:
            session_id = self._armed_session_id
            if session_id is None or method != "POST":
                return None
            expected_path = (
                f"/v1/internal/sessions/{quote(session_id, safe='')}/input"
            )
            if path != expected_path:
                return None
            event = threading.Event()
            self._armed_session_id = None
            self._held_request = copy.deepcopy(trace)
            self._held_event = event
            self._held_handler = handler
            return event

    def _request_headers(self, headers: Any) -> list[tuple[str, str]]:
        connection_tokens: set[str] = set()
        for value in headers.get_all("Connection", []):
            connection_tokens.update(
                token.strip().lower() for token in value.split(",") if token.strip()
            )
        if "content-length" in connection_tokens:
            raise _ProxyRejected(400, "proxy_hop_header_conflict")
        excluded = self._HOP_BY_HOP_HEADERS | connection_tokens | {"host"}
        outgoing: list[tuple[str, str]] = [("Host", self._target_authority)]
        for name, value in headers.raw_items():
            if name.lower() not in excluded:
                outgoing.append((name, value))
        return outgoing

    def forward(
        self,
        handler: _HeldSessionMutationProxyHandler,
        method: str,
        path: str,
        body: bytes,
        trace: dict[str, Any],
        held_request: bool,
    ) -> None:
        with self._lock:
            if self._stopping:
                raise _ProxyRejected(503, "proxy_stopped")
        upstream = http.client.HTTPConnection(
            self._target_host,
            self._target_port,
            timeout=2.0,
        )
        handler._upstream = upstream
        if not self._register_upstream(upstream):
            upstream.close()
            raise _ProxyRejected(503, "proxy_stopped")
        held = held_request
        connected = False
        try:
            upstream.connect()
            connected = True
            upstream.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
            for name, value in self._request_headers(handler.headers):
                upstream.putheader(name, value)
            upstream.endheaders(body)
            with self._lock:
                self._requests.append(copy.deepcopy(trace))
            response = upstream.getresponse()
            capture = self._relay_response(handler, response, method)
            if held:
                credential = handler.headers.get(
                    "X-Breadboard-Registration-Credential"
                )
                self._record_outcome(response.status, capture, credential)
        except _ProxyRejected as rejected:
            if held:
                credential = handler.headers.get(
                    "X-Breadboard-Registration-Credential"
                )
                body = json.dumps(
                    {"errorCode": rejected.error_code}, separators=(",", ":")
                ).encode("utf-8")
                self._record_outcome(rejected.status, body, credential)
            raise
        except (http.client.HTTPException, OSError, ValueError) as error:
            if not connected and isinstance(error, OSError):
                raise
            if held:
                credential = handler.headers.get(
                    "X-Breadboard-Registration-Credential"
                )
                self._record_outcome(
                    502,
                    b'{"errorCode":"proxy_upstream_error"}',
                    credential,
                )
            raise _ProxyRejected(502, "proxy_upstream_error") from None
        finally:
            self._unregister_upstream(upstream)
            upstream.close()
            handler._upstream = None

    def _relay_response(
        self,
        handler: _HeldSessionMutationProxyHandler,
        response: http.client.HTTPResponse,
        method: str,
    ) -> bytes:
        response_headers = response.getheaders()
        connection_tokens: set[str] = set()
        transfer_encodings: list[str] = []
        content_lengths: list[int] = []
        for name, value in response_headers:
            lower = name.lower()
            if lower == "connection":
                connection_tokens.update(
                    token.strip().lower()
                    for token in value.split(",")
                    if token.strip()
                )
            elif lower == "transfer-encoding":
                transfer_encodings.extend(
                    token.strip().lower()
                    for token in value.split(",")
                    if token.strip()
                )
            elif lower == "content-length":
                if not re.fullmatch(r"[0-9]+", value.strip()):
                    raise _ProxyRejected(502, "proxy_response_content_length_invalid")
                content_lengths.append(int(value.strip()))
        if "content-length" in connection_tokens:
            raise _ProxyRejected(502, "proxy_response_hop_header_conflict")
        if any(length != content_lengths[0] for length in content_lengths[1:]):
            raise _ProxyRejected(502, "proxy_response_content_length_conflict")
        if transfer_encodings and transfer_encodings != ["chunked"]:
            raise _ProxyRejected(502, "proxy_response_transfer_encoding_unsupported")
        if transfer_encodings and content_lengths:
            raise _ProxyRejected(502, "proxy_response_transfer_length_conflict")
        no_body = method == "HEAD" or response.status in (
            *range(100, 200),
            204,
            304,
        )
        fixed_length = content_lengths[0] if content_lengths else None
        downstream_closes = fixed_length is None and not no_body
        handler.close_connection = downstream_closes
        handler.send_response_only(response.status, response.reason)
        excluded = self._HOP_BY_HOP_HEADERS | connection_tokens
        sent_content_length = False
        for name, value in response_headers:
            lower = name.lower()
            if lower in excluded:
                continue
            if lower == "content-length":
                if sent_content_length:
                    continue
                sent_content_length = True
            handler.send_header(name, value)
        if downstream_closes:
            handler.send_header("Connection", "close")
        handler.end_headers()
        if no_body:
            return b""
        captured = bytearray()

        def relay(chunk: bytes) -> None:
            if not chunk:
                return
            handler.wfile.write(chunk)
            handler.wfile.flush()
            if len(captured) < self._MAX_CAPTURE_BYTES:
                captured.extend(chunk[: self._MAX_CAPTURE_BYTES - len(captured)])

        if fixed_length is not None:
            remaining = fixed_length
            while remaining:
                chunk = response.read(min(65536, remaining))
                if not chunk:
                    raise http.client.IncompleteRead(bytes(captured), remaining)
                remaining -= len(chunk)
                relay(chunk)
        else:
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                relay(chunk)
        return bytes(captured)

    def _record_outcome(
        self, status: int, body: bytes, credential: str | None
    ) -> None:
        response_body = self._sanitize_response_body(body, credential)
        error_code: str | None = None
        if isinstance(response_body, dict):
            value = response_body.get("error", response_body.get("errorCode"))
            if isinstance(value, str):
                error_code = value
        with self._lock:
            self._outcome = {
                "status": int(status),
                "errorCode": error_code,
                "responseBody": response_body,
            }
            self._held_event = None
            self._held_handler = None

    def _sanitize_response_body(
        self, body: bytes, credential: str | None
    ) -> Any:
        if not body:
            return ""
        text = body[: self._MAX_CAPTURE_BYTES].decode("utf-8", "replace")
        if len(body) > self._MAX_CAPTURE_BYTES:
            text += "…"
        try:
            value: Any = json.loads(text)
        except (TypeError, ValueError):
            return self._sanitize_text(text, credential)
        return self._sanitize_json(value, credential)

    def _sanitize_json(self, value: Any, credential: str | None) -> Any:
        if isinstance(value, dict):
            return {
                key: self._REDACTED
                if self._SENSITIVE_KEY_RE.search(str(key))
                else self._sanitize_json(item, credential)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [self._sanitize_json(item, credential) for item in value]
        if isinstance(value, str):
            return self._sanitize_text(value, credential)
        return value

    def _sanitize_text(self, text: str, credential: str | None) -> str:
        if credential:
            text = text.replace(credential, self._REDACTED)
        return self._BEARER_RE.sub(self._REDACTED, text)

    @staticmethod
    def _close_socket(value: Any) -> None:
        socket_value = getattr(value, "connection", None)
        if socket_value is None:
            socket_value = getattr(value, "socket", None)
        if socket_value is None:
            socket_value = getattr(value, "sock", None)
        if socket_value is not None:
            try:
                socket_value.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                socket_value.close()
            except OSError:
                pass
        close = getattr(value, "close", None)
        if close is not None:
            try:
                close()
            except OSError:
                pass

    def stop(self) -> dict[str, Any]:
        with self._lock:
            if self._stop_receipt is not None:
                return copy.deepcopy(self._stop_receipt)
            self._stopping = True
            release_event = self._held_event
            server = self._server
            server_thread = self._server_thread
            handlers = list(self._handlers)
            upstreams = list(self._upstreams)
            handler_threads = list(self._handler_threads)
            was_started = server is not None
        if release_event is not None:
            release_event.set()
        if server is not None:
            server.shutdown()
            server.server_close()
        for handler in handlers:
            self._close_socket(handler)
        for upstream in upstreams:
            self._close_socket(upstream)
        deadline = time.monotonic() + 2.0
        threads = ([server_thread] if server_thread is not None else []) + handler_threads
        for thread in threads:
            if thread is None or thread is threading.current_thread():
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            thread.join(remaining)
        with self._lock:
            alive_threads = sum(
                thread.is_alive() for thread in threads if thread is not None
            )
            receipt = {
                "stopped": True,
                "wasStarted": was_started,
                "releasedHeldRequest": release_event is not None,
                "handlersAtStop": len(handlers),
                "upstreamsAtStop": len(upstreams),
                "threadsAlive": alive_threads,
                "closed": alive_threads == 0,
            }
            self._stop_receipt = receipt
            self._server = None
            self._server_thread = None
            self._proxy_port = None
            return copy.deepcopy(receipt)


class TerminalScreen:
    def __init__(
        self,
        rows: int = ROWS,
        columns: int = COLUMNS,
        timing_nonce: str | None = None,
    ) -> None:
        if timing_nonce is not None and TIMING_NONCE_RE.fullmatch(timing_nonce) is None:
            raise ValueError("timing nonce must be exactly 32 lowercase hex characters")
        self.rows = rows
        self.columns = columns
        self.grid = [[" "] * columns for _ in range(rows)]
        self.row = 0
        self.column = 0
        self.saved = (0, 0)
        self.primary_screen: tuple[list[list[str]], int, int] | None = None
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.timing_nonce = timing_nonce
        self._frame_events: deque[FrameTimingEvent] = deque(maxlen=MAX_FRAME_EVENTS)
        self._frame_rejections: dict[str, int] = {}
        self._last_frame_id: int | None = None
        self._last_input_id: int | None = None
        self._last_input_data: str | None = None
        self._last_input_at: float | None = None
        self._saw_valid_frame = False


    @property
    def frame_rejections(self) -> dict[str, int]:
        return dict(self._frame_rejections)


    @property
    def latest_input_id(self) -> int | None:
        return self._last_input_id


    def drain_frame_events(self) -> list[FrameTimingEvent]:
        events = list(self._frame_events)
        self._frame_events.clear()
        return events


    def resize(self, rows: int, columns: int) -> None:
        if rows <= 0 or columns <= 0:
            raise ValueError("terminal dimensions must be positive")
        self.rows = rows
        self.columns = columns
        self.grid = [[" "] * columns for _ in range(rows)]
        self.row = max(0, min(self.row, rows - 1))
        self.column = max(0, min(self.column, columns - 1))
        self.saved = (
            max(0, min(self.saved[0], rows - 1)),
            max(0, min(self.saved[1], columns - 1)),
        )
        if self.primary_screen is not None:
            _, row, column = self.primary_screen
            self.primary_screen = (
                [[" "] * columns for _ in range(rows)],
                max(0, min(row, rows - 1)),
                max(0, min(column, columns - 1)),
            )

    def feed(self, data: bytes, observed_at_monotonic: float | None = None) -> None:
        self.pending += self.decoder.decode(data)
        index = 0
        while index < len(self.pending):
            character = self.pending[index]
            if character != "\x1b":
                self._character(character)
                index += 1
                continue
            if index + 1 >= len(self.pending):
                break
            kind = self.pending[index + 1]
            if kind == "[":
                end = index + 2
                while end < len(self.pending) and not ("@" <= self.pending[end] <= "~"):
                    end += 1
                if end >= len(self.pending):
                    break
                self._csi(self.pending[index + 2 : end], self.pending[end])
                index = end + 1
                continue
            if kind == "]":
                bell = self.pending.find("\x07", index + 2)
                string_terminator = self.pending.find("\x1b\\", index + 2)
                ends = [
                    candidate
                    for candidate in (bell, string_terminator)
                    if candidate >= 0
                ]
                if not ends:
                    break
                end = min(ends)
                self._osc(self.pending[index + 2 : end], observed_at_monotonic)
                index = end + (2 if self.pending.startswith("\x1b\\", end) else 1)
                continue
            if kind == "7":
                self.saved = (self.row, self.column)
            elif kind == "8":
                self.row, self.column = self.saved
            index += 2
        self.pending = self.pending[index:]


    def _reject_frame(self, reason: str) -> None:
        self._frame_rejections[reason] = self._frame_rejections.get(reason, 0) + 1


    def _osc(self, raw: str, observed_at_monotonic: float | None) -> None:
        parts = raw.split(";", 3)
        if len(parts) != 4 or parts[0] != "777" or parts[1] != "omp-frame-timing":
            return
        nonce, raw_metadata = parts[2], parts[3]
        if self.timing_nonce is None:
            return
        if nonce != self.timing_nonce:
            self._reject_frame("wrong_nonce")
            return
        metadata, reason = _parse_frame_timing(
            raw_metadata,
            nonce,
            self._last_frame_id,
            self._last_input_id,
            self._last_input_data,
            self._last_input_at,
        )
        if metadata is None:
            self._reject_frame(reason or "invalid")
            return
        frame_id = metadata["frameId"]
        input_id = metadata["inputId"]
        input_data = metadata["inputData"]
        input_at = metadata["inputAtMs"]
        if not self._saw_valid_frame and input_id != 0:
            self._reject_frame("missing_startup_frame")
            return
        if len(self._frame_events) == MAX_FRAME_EVENTS:
            self._reject_frame("event_overflow")
        self._frame_events.append(
            FrameTimingEvent(
                nonce=nonce,
                metadata=metadata,
                raw_metadata=raw_metadata,
                screen=self.text(),
                observed_at_monotonic=observed_at_monotonic,
            )
        )
        self._last_frame_id = frame_id
        self._last_input_id = input_id
        self._last_input_data = input_data
        self._last_input_at = input_at
        self._saw_valid_frame = True

    def _scroll(self) -> None:
        while self.row >= self.rows:
            self.grid.pop(0)
            self.grid.append([" "] * self.columns)
            self.row -= 1

    def _character(self, character: str) -> None:
        if character == "\r":
            self.column = 0
            return
        if character == "\n":
            self.row += 1
            self._scroll()
            return
        if character == "\b":
            self.column = max(0, self.column - 1)
            return
        if character == "\t":
            self.column = min(self.columns - 1, ((self.column // 8) + 1) * 8)
            return
        if ord(character) < 32 or ord(character) == 127:
            return
        if unicodedata.combining(character):
            if self.column > 0:
                self.grid[self.row][self.column - 1] += character
            return
        width = 2 if unicodedata.east_asian_width(character) in {"W", "F"} else 1
        if self.column >= self.columns:
            self.column = 0
            self.row += 1
            self._scroll()
        self.grid[self.row][self.column] = character
        if width == 2 and self.column + 1 < self.columns:
            self.grid[self.row][self.column + 1] = " "
        self.column += width

    @staticmethod
    def _params(raw: str) -> list[int]:
        raw = raw.lstrip("?>!")
        if not raw:
            return [0]
        result: list[int] = []
        for value in raw.split(";"):
            try:
                result.append(int(value or "0"))
            except ValueError:
                result.append(0)
        return result

    def _csi(self, raw: str, final: str) -> None:
        values = self._params(raw)
        count = values[0] or 1
        if final in {"h", "l"}:
            if raw.startswith("?") and 1049 in values:
                if final == "h" and self.primary_screen is None:
                    self.primary_screen = (self.grid, self.row, self.column)
                    self.saved = (self.row, self.column)
                    self.grid = [[" "] * self.columns for _ in range(self.rows)]
                elif final == "l" and self.primary_screen is not None:
                    self.grid, self.row, self.column = self.primary_screen
                    self.saved = (self.row, self.column)
                    self.primary_screen = None
            return
        if final in {"H", "f"}:
            self.row = max(0, min(self.rows - 1, (values[0] or 1) - 1))
            self.column = max(
                0,
                min(self.columns - 1, ((values[1] if len(values) > 1 else 1) or 1) - 1),
            )
        elif final == "A":
            self.row = max(0, self.row - count)
        elif final == "B":
            self.row = min(self.rows - 1, self.row + count)
        elif final == "C":
            self.column = min(self.columns - 1, self.column + count)
        elif final == "D":
            self.column = max(0, self.column - count)
        elif final == "E":
            self.row = min(self.rows - 1, self.row + count)
            self.column = 0
        elif final == "F":
            self.row = max(0, self.row - count)
            self.column = 0
        elif final == "G":
            self.column = max(0, min(self.columns - 1, count - 1))
        elif final == "d":
            self.row = max(0, min(self.rows - 1, count - 1))
        elif final == "J":
            mode = values[0]
            if mode in {2, 3}:
                self.grid = [[" "] * self.columns for _ in range(self.rows)]
                self.row = self.column = 0
            elif mode == 0:
                self.grid[self.row][self.column :] = [" "] * (
                    self.columns - self.column
                )
                for row in range(self.row + 1, self.rows):
                    self.grid[row] = [" "] * self.columns
            elif mode == 1:
                for row in range(self.row):
                    self.grid[row] = [" "] * self.columns
                self.grid[self.row][: self.column + 1] = [" "] * (self.column + 1)
        elif final == "K":
            mode = values[0]
            if mode == 0:
                self.grid[self.row][self.column :] = [" "] * (
                    self.columns - self.column
                )
            elif mode == 1:
                self.grid[self.row][: self.column + 1] = [" "] * (self.column + 1)
            elif mode == 2:
                self.grid[self.row] = [" "] * self.columns
        elif final == "s":
            self.saved = (self.row, self.column)
        elif final == "u":
            self.row, self.column = self.saved

    def text(self) -> str:
        lines = ["".join(row).rstrip() for row in self.grid]
        while lines and not lines[-1]:
            lines.pop()
        return "\n".join(lines) + ("\n" if lines else "")


class PtyChild:
    def __init__(
        self,
        argv: list[str],
        cwd: Path,
        env: dict[str, str],
        rows: int = ROWS,
        columns: int = COLUMNS,
    ) -> None:
        if rows <= 0 or columns <= 0:
            raise ValueError("terminal dimensions must be positive")
        timing_nonce = env.get(TIMING_NONCE_ENV)
        if timing_nonce is not None and TIMING_NONCE_RE.fullmatch(timing_nonce) is None:
            raise ValueError("timing nonce must be exactly 32 lowercase hex characters")
        self.timing_nonce = timing_nonce
        self.clock_mapping = (
            capture_mapped_monotonic_time()[1] if timing_nonce is not None else None
        )
        pid, master = pty.fork()
        if pid == 0:
            try:
                os.chdir(cwd)
                fcntl.ioctl(
                    0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0)
                )
                os.closerange(3, os.sysconf("SC_OPEN_MAX"))
                os.execve(argv[0], argv, env)
            except OSError as error:
                os.write(2, f"PTY exec failed: {error}\n".encode())
                os._exit(127)
        self.pid = pid
        self.master = master
        self.raw = bytearray()
        self.screen = TerminalScreen(rows, columns, timing_nonce=timing_nonce)
        self.rows = rows
        self.columns = columns
        self.last_output_at: float | None = None
        self.output_reads = 0
        self.exit_status: int | None = None
        fcntl.ioctl(
            master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0)
        )
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)


    def _observe_exit(self) -> None:
        if self.exit_status is not None:
            return
        pid, status = os.waitpid(self.pid, os.WNOHANG)
        if pid:
            self.exit_status = os.waitstatus_to_exitcode(status)

    def pump(self, timeout: float) -> None:
        readable, _, _ = select.select([self.master], [], [], max(0.0, timeout))
        if readable:
            while True:
                try:
                    data = os.read(self.master, 65536)
                except BlockingIOError:
                    break
                except OSError as error:
                    if error.errno == errno.EIO:
                        break
                    raise
                if not data:
                    break
                observed_at = time.monotonic()
                self.last_output_at = observed_at
                self.output_reads += 1
                self.raw.extend(data)
                self.screen.feed(data, observed_at)
                if len(data) < 65536:
                    break
        self._observe_exit()

    def drain_frame_events(self) -> list[FrameTimingEvent]:
        return self.screen.drain_frame_events()

    def resize(self, rows: int, columns: int) -> None:
        if rows <= 0 or columns <= 0:
            raise ValueError("terminal dimensions must be positive")
        fcntl.ioctl(
            self.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0)
        )
        self.screen.resize(rows, columns)
        self.rows = rows
        self.columns = columns

    def wait_until(
        self, predicate: Callable[[], Any], timeout: float, label: str
    ) -> Any:
        deadline = time.monotonic() + timeout
        while True:
            value = predicate()
            if value:
                return value
            self._observe_exit()
            if self.exit_status is not None:
                raise JourneyFailure(
                    f"{label}: bb exited early with {self.exit_status}\n{self.screen.text()}"
                )
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise JourneyFailure(f"{label}: timed out\n{self.screen.text()}")
            self.pump(min(0.2, remaining))

    def send(self, payload: bytes) -> None:
        if self.exit_status is not None:
            raise JourneyFailure(f"cannot send to exited bb ({self.exit_status})")
        offset = 0
        while offset < len(payload):
            try:
                offset += os.write(self.master, payload[offset:])
            except BlockingIOError:
                select.select([], [self.master], [], 0.2)

    def send_line(self, text: str) -> None:
        self.send(text.encode("utf-8") + b"\r")

    def send_typed_line(self, text: str) -> None:
        for character in text:
            self.send(character.encode("utf-8"))
            time.sleep(0.03)
        self.send_enter()


    def send_escape(self) -> None:
        self.send(b"\x1b")

    def send_enter(self) -> None:
        self.send(b"\r")

    def permission_dialog_tool(self) -> str | None:
        screen = self.screen.text()
        if "up/down navigate  enter select  esc cancel" not in screen:
            return None
        match = re.search(r"BreadBoard permission request · ([^·\n]+)", screen)
        return match.group(1).strip() if match is not None else None

    def permission_dialog_ready(self) -> bool:
        return self.permission_dialog_tool() == "run_shell"


    def wait_for_exit(self, timeout: float) -> int:
        deadline = time.monotonic() + timeout
        while self.exit_status is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise JourneyFailure(
                    f"bb did not exit through /exit\n{self.screen.text()}"
                )
            self.pump(min(0.2, remaining))
        self.pump(0)
        return self.exit_status

    def close_fd(self) -> None:
        try:
            os.close(self.master)
        except OSError:
            pass

    def close(self) -> None:
        if self.exit_status is None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + 5
            while self.exit_status is None and time.monotonic() < deadline:
                self.pump(0.1)
            if self.exit_status is None:
                try:
                    os.kill(self.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    _, status = os.waitpid(self.pid, 0)
                    self.exit_status = os.waitstatus_to_exitcode(status)
                except ChildProcessError:
                    self._observe_exit()
        self.close_fd()


@dataclass(frozen=True)
class BindingSnapshot:
    session_file: Path
    data: dict[str, Any]
    rows: list[dict[str, Any]]


def parse_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    try:
        content = path.read_text(encoding="utf-8")
    except (FileNotFoundError, UnicodeDecodeError, OSError):
        return rows
    for line in content.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def binding_snapshots(agent_root: Path) -> list[BindingSnapshot]:
    candidates: list[BindingSnapshot] = []
    for path in sorted(agent_root.rglob("*.jsonl")) if agent_root.exists() else ():
        rows = parse_jsonl(path)
        bindings = [
            row.get("data")
            for row in rows
            if row.get("type") == "custom"
            and row.get("customType") == BINDING_TYPE
            and isinstance(row.get("data"), dict)
            and row["data"].get("schemaVersion") == BINDING_SCHEMA
        ]
        if bindings:
            candidates.append(BindingSnapshot(path.resolve(), bindings[-1], rows))
    return candidates


def binding_snapshot(agent_root: Path) -> BindingSnapshot | None:
    candidates = binding_snapshots(agent_root)
    if not candidates:
        return None
    return max(candidates, key=lambda candidate: candidate.session_file.stat().st_mtime_ns)


def binding_snapshot_for_session(
    agent_root: Path, session_id: str
) -> BindingSnapshot | None:
    return next(
        (
            snapshot
            for snapshot in binding_snapshots(agent_root)
            if snapshot.data.get("sessionId") == session_id
        ),
        None,
    )

def session_model(snapshot: BindingSnapshot) -> str | None:
    for row in reversed(snapshot.rows):
        if row.get("type") == "model_change" and isinstance(row.get("model"), str):
            return row["model"]
    return None


def content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        str(item.get("text", ""))
        for item in content
        if isinstance(item, dict) and item.get("type") in {"text", "thinking"}
    )


def transcript_facts(rows: list[dict[str, Any]]) -> dict[str, Any]:
    assistant: list[str] = []
    assistant_stops: list[str | None] = []
    assistant_errors: list[str] = []
    users: list[str] = []
    tool_calls: list[str] = []
    tool_results: list[str] = []
    tool_call_rows: list[dict[str, Any]] = []
    tool_result_rows: list[dict[str, Any]] = []
    for row in rows:
        message = row.get("message")
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        content = message.get("content")
        if role == "assistant":
            text = content_text(content)
            if text:
                assistant.append(text)
            stop_reason = message.get("stopReason")
            assistant_stops.append(
                stop_reason if isinstance(stop_reason, str) else None
            )
            error_message = message.get("errorMessage")
            if isinstance(error_message, str) and error_message:
                assistant_errors.append(error_message)
            if isinstance(content, list):
                for item in content:
                    if not isinstance(item, dict) or item.get("type") != "toolCall":
                        continue
                    name = str(item.get("name", ""))
                    tool_calls.append(name)
                    tool_call_rows.append(
                        {
                            "id": str(item.get("id", "")),
                            "name": name,
                            "arguments": item.get("arguments"),
                        }
                    )
        elif role == "user":
            text = content_text(content)
            if text:
                users.append(text)
        elif role == "toolResult":
            name = str(message.get("toolName", ""))
            tool_results.append(name)
            tool_result_rows.append(
                {
                    "id": str(message.get("toolCallId", "")),
                    "name": name,
                    "isError": message.get("isError") is True,
                    "content": content_text(content),
                }
            )
    return {
        "assistantTexts": assistant,
        "assistantErrors": assistant_errors,
        "assistantStopReasons": assistant_stops,
        "userTexts": users,
        "sentinelCount": sum(ASSISTANT_SENTINEL in text for text in assistant),
        "completionSentinelCount": sum("TASK COMPLETE" in text for text in assistant),
        "toolCalls": tool_calls,
        "toolResults": tool_results,
        "toolCallRows": tool_call_rows,
        "toolResultRows": tool_result_rows,
    }


def cursor_sequence(binding: dict[str, Any]) -> int:
    cursor = binding.get("cursor")
    if not isinstance(cursor, dict) or not isinstance(cursor.get("sequence"), int):
        raise JourneyFailure("binding has no integer cursor sequence")
    return int(cursor["sequence"])


def owned_submissions(binding: dict[str, Any]) -> list[dict[str, Any]]:
    value = binding.get("ownedSubmissions")
    if not isinstance(value, list) or not all(isinstance(item, dict) for item in value):
        raise JourneyFailure("binding has invalid ownedSubmissions")
    return value


def active_authority(agent_root: Path) -> tuple[Path, dict[str, Any]] | None:
    candidates: list[tuple[Path, dict[str, Any]]] = []
    for path in agent_root.rglob("*.authority.json") if agent_root.exists() else ():
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if (
            isinstance(value, dict)
            and value.get("schemaVersion") == "p30.local-authority.v4"
        ):
            candidates.append((path.resolve(), value))
    if not candidates:
        return None
    if len(candidates) != 1:
        raise JourneyFailure(
            f"expected one active engine authority, found {len(candidates)}"
        )
    return candidates[0]


def normalized_transcript(raw: bytes) -> str:
    stripped = ANSI_RE.sub(b"", raw).decode("utf-8", "replace")
    stripped = stripped.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(line.rstrip() for line in stripped.splitlines()) + "\n"


def write_capture(output: Path, name: str, child: PtyChild) -> None:
    (output / f"{name}.ansi").write_bytes(bytes(child.raw))
    (output / f"{name}.normalized.txt").write_text(
        normalized_transcript(bytes(child.raw)), encoding="utf-8"
    )
    (output / f"{name}.screen.txt").write_text(child.screen.text(), encoding="utf-8")


def process_snapshot(pid: int) -> dict[str, Any]:
    commands = {
        "ps": ["/bin/ps", "-o", "pid=,ppid=,state=,command=", "-p", str(pid)],
        "lsof": ["/usr/sbin/lsof", "-nP", "-p", str(pid)],
    }
    result: dict[str, Any] = {}
    for name, command in commands.items():
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=10, check=False
        )
        result[name] = {
            "argv": command,
            "exitCode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
        }
    return result


def listener_snapshot(endpoint: str) -> dict[str, Any]:
    parsed = urlsplit(endpoint)
    if parsed.hostname is None or parsed.port is None:
        raise JourneyFailure(f"invalid authority endpoint: {endpoint}")
    command = [
        "/usr/sbin/lsof",
        "-nP",
        f"-iTCP:{parsed.port}",
        "-sTCP:LISTEN",
    ]
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    return {
        "argv": command,
        "exitCode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "socketConnectable": endpoint_open(endpoint),
    }


def process_environment_contains(pid: int, value: str) -> bool | None:
    completed = subprocess.run(
        ["/bin/ps", "eww", "-p", str(pid), "-o", "command="],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if completed.returncode != 0:
        return None
    return value in completed.stdout


def assert_loopback_network(processes: dict[str, Any], label: str) -> None:
    violations: list[str] = []
    for process_name, snapshot in processes.items():
        lsof = snapshot.get("lsof")
        output = lsof.get("stdout") if isinstance(lsof, dict) else None
        if not isinstance(output, str):
            raise JourneyFailure(f"{label} has no lsof output for {process_name}")
        for transport, address in re.findall(r"\b(TCP|UDP) ([^\s]+)", output):
            for endpoint in address.split("->"):
                if endpoint.startswith("[") and "]:" in endpoint:
                    host = endpoint[1 : endpoint.index("]")]
                else:
                    host, separator, _ = endpoint.rpartition(":")
                    if not separator:
                        host = ""
                try:
                    loopback = ipaddress.ip_address(host).is_loopback
                except ValueError:
                    loopback = False
                if not loopback:
                    violations.append(f"{process_name}:{transport}:{endpoint}")
    if violations:
        raise JourneyFailure(
            f"{label} opened non-loopback network endpoints: {violations}"
        )


def create_browser_launch_guard(
    temp_root: Path, environment: dict[str, str]
) -> tuple[Path, dict[str, Any]]:
    guard_root = temp_root / "g6-browser-guard-bin"
    guard_root.mkdir(mode=0o700)
    marker = temp_root / "g6-browser-launch-attempted"
    guard = guard_root / "open"
    guard.write_text(
        "#!/usr/bin/python3\n"
        "from pathlib import Path\n"
        f"Path({str(marker)!r}).open('a', encoding='utf-8').write('attempted\\n')\n"
        "raise SystemExit(125)\n",
        encoding="utf-8",
    )
    guard.chmod(0o700)
    environment["BROWSER"] = str(guard)
    environment["PATH"] = f"{guard_root}:{environment['PATH']}"
    probe = subprocess.run(
        [str(guard), "control-probe"],
        cwd=temp_root,
        env=environment,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    if (
        probe.returncode != 125
        or not marker.is_file()
        or marker.read_text(encoding="utf-8").splitlines() != ["attempted"]
    ):
        raise JourneyFailure("OAuth browser launch guard control probe failed")
    marker.unlink()
    return marker, {
        "schemaVersion": "bb.g6_browser_launch_guard.v1",
        "status": "pass",
        "environmentKey": "BROWSER",
        "pathCommand": "open",
        "controlProbeExitCode": probe.returncode,
        "attemptCount": 0,
    }


def start_network_audit(
    temp_root: Path,
) -> tuple[Path, subprocess.Popen[str], Any]:
    nettop = Path("/usr/bin/nettop")
    if not nettop.is_file() or not os.access(nettop, os.X_OK):
        raise JourneyFailure("continuous network audit requires /usr/bin/nettop")
    raw_path = temp_root / "g6-network-audit.raw.csv"
    stream = raw_path.open("w", encoding="utf-8", newline="")
    process = subprocess.Popen(
        [
            str(nettop),
            "-L",
            "0",
            "-n",
            "-x",
            "-s",
            "1",
        ],
        stdout=stream,
        stderr=subprocess.PIPE,
        text=True,
    )
    if process.poll() is not None:
        stream.close()
        raise JourneyFailure("continuous network audit exited during startup")
    return raw_path, process, stream


def stop_network_audit(process: subprocess.Popen[str], stream: Any) -> str:
    if process.poll() is None:
        process.terminate()
    try:
        _, stderr = process.communicate(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        _, stderr = process.communicate(timeout=5)
    stream.close()
    if process.returncode not in (0, -signal.SIGTERM):
        raise JourneyFailure(
            f"continuous network audit exited unexpectedly: {process.returncode}"
        )
    return stderr


def analyze_network_audit(
    raw_path: Path, filtered_path: Path, expected_pids: set[int], stderr: str
) -> dict[str, Any]:
    selected_rows: list[list[str]] = []
    connection_rows: list[dict[str, Any]] = []
    observed_pids: set[int] = set()
    current_pid: int | None = None
    with raw_path.open(encoding="utf-8", newline="") as stream:
        for row in csv.reader(stream):
            if not row:
                continue
            if row[0] == "time":
                if not selected_rows:
                    selected_rows.append(row)
                continue
            descriptor = row[1] if len(row) > 1 else ""
            summary = (
                None
                if descriptor.startswith(("tcp", "udp"))
                else re.fullmatch(r".+\.(\d+)", descriptor)
            )
            if summary is not None:
                current_pid = int(summary.group(1))
                if current_pid in expected_pids:
                    observed_pids.add(current_pid)
                    selected_rows.append(row)
                continue
            if current_pid not in expected_pids or not descriptor.startswith(
                ("tcp", "udp")
            ):
                continue
            interface = row[2] if len(row) > 2 else ""
            connection = {
                "pid": current_pid,
                "descriptor": descriptor,
                "interface": interface,
                "state": row[3] if len(row) > 3 else "",
            }
            connection_rows.append(connection)
            selected_rows.append(row)
    missing_pids = sorted(expected_pids - observed_pids)
    if missing_pids:
        raise JourneyFailure(
            f"continuous network audit missed managed process IDs: {missing_pids}"
        )
    violations = [row for row in connection_rows if row["interface"] not in ("", "lo0")]
    if violations:
        raise JourneyFailure(
            f"managed product opened non-loopback network connections: {violations}"
        )
    with filtered_path.open("w", encoding="utf-8", newline="") as stream:
        csv.writer(stream).writerows(selected_rows)
    raw_path.unlink()
    return {
        "schemaVersion": "bb.g6_network_observation.v1",
        "status": "pass",
        "sampleIntervalMilliseconds": 1_000,
        "observedPids": sorted(observed_pids),
        "connectionSampleCount": len(connection_rows),
        "nonLoopbackConnectionCount": len(violations),
        "loopbackOnly": True,
        "filteredTrace": filtered_path.name,
        "filteredTraceSha256": hashlib.sha256(filtered_path.read_bytes()).hexdigest(),
        "stderr": stderr,
    }


def endpoint_open(endpoint: str) -> bool:
    parsed = urlsplit(endpoint)
    host = parsed.hostname
    port = parsed.port
    if host is None or port is None:
        raise JourneyFailure(f"invalid authority endpoint: {endpoint}")
    try:
        with socket.create_connection((host, port), timeout=0.5):
            return True
    except OSError:
        return False


def process_start_token(pid: int) -> str | None:
    """Observe Darwin's kernel start identity, not the authority file's claim."""
    if sys.platform != "darwin":
        return None
    try:
        proc_pidinfo = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo
        proc_pidinfo.argtypes = [
            ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int,
        ]
        proc_pidinfo.restype = ctypes.c_int
        info = ctypes.create_string_buffer(136)
        if proc_pidinfo(pid, 3, 0, info, len(info)) != len(info):
            return None
        if struct.unpack_from("=I", info, 12)[0] != pid:
            return None
        seconds, microseconds = struct.unpack_from("=QQ", info, 120)
        if seconds == 0 or microseconds >= 1_000_000:
            return None
        return f"darwin:{seconds}:{microseconds}"
    except (AttributeError, OSError):
        return None


def signal_process_if_same(pid: int, start_token: str | None, sig: int) -> bool:
    if start_token is None or process_start_token(pid) != start_token:
        return False
    try:
        os.kill(pid, sig)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def extraction_roots(temp_root: Path) -> list[str]:
    return sorted(
        str(path.resolve())
        for path in temp_root.glob("bb-engine-runtime-*")
        if path.is_dir()
    )


def ray_runtime_roots(temp_root: Path) -> set[str]:
    return {
        str(path.resolve())
        for path in temp_root.glob("bb-ray-*")
        if path.is_dir() and not path.is_symlink()
    }


def ray_runtime_snapshot(runtime_root: str) -> dict[str, Any]:
    ray_root = Path(runtime_root) / "ray"
    sessions = sorted(
        path.resolve()
        for path in ray_root.glob("session_*")
        if path.is_dir() and not path.is_symlink()
    )
    if len(sessions) != 1:
        raise JourneyFailure(f"expected one ephemeral Ray session, found {sessions}")
    logs_root = sessions[0] / "logs"
    log_files = (
        [
            path
            for path in logs_root.rglob("*")
            if path.is_file() and not path.is_symlink()
        ]
        if logs_root.is_dir()
        else []
    )
    log_bytes = sum(path.stat().st_size for path in log_files)
    log_byte_limit = 1_048_576
    if log_bytes > log_byte_limit:
        raise JourneyFailure(
            f"ephemeral Ray logs exceed {log_byte_limit} bytes: {log_bytes}"
        )
    return {
        "runtimeRoot": str(Path(runtime_root).resolve()),
        "rayRoot": str(ray_root.resolve()),
        "sessionPath": str(sessions[0]),
        "logFileCount": len(log_files),
        "logBytes": log_bytes,
        "logByteLimit": log_byte_limit,
    }


def load_retained_state(agent_root: Path) -> tuple[Path, dict[str, Any], bytes]:
    candidates = (
        sorted(agent_root.rglob("session-state/*.json")) if agent_root.exists() else []
    )
    if candidates:
        state_path = max(candidates, key=lambda path: path.stat().st_mtime_ns)
        raw = state_path.read_bytes()
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise JourneyFailure("retained session state is not JSON") from error
        if not isinstance(value, dict):
            raise JourneyFailure("retained session state is not an object")
        return state_path.resolve(), value, raw

    jsonl_candidates = sorted(agent_root.rglob("*.jsonl")) if agent_root.exists() else []
    if not jsonl_candidates:
        raise JourneyFailure("expected one retained session file, found none")
    state_path = max(jsonl_candidates, key=lambda path: path.stat().st_mtime_ns)
    raw = state_path.read_bytes()
    rows = parse_jsonl(state_path)
    facts = transcript_facts(rows)
    turns = [
        {"turn_id": str(i), "terminal_resolution_committed": True, "terminal_outcome": "completed"}
        for i, _ in enumerate(facts["users"])
    ]
    value = {
        "schema_version": "bb.native.session_state.v1",
        "turns": turns,
        "terminal_event_envelopes": turns,
        "facts": facts,
    }
    return state_path.resolve(), value, raw

def retained_state_snapshot(
    agent_root: Path,
) -> tuple[Path, dict[str, Any], bytes] | None:
    candidates = (
        sorted(agent_root.rglob("session-state/*.json")) if agent_root.exists() else []
    )
    if not candidates:
        jsonl_candidates = sorted(agent_root.rglob("*.jsonl")) if agent_root.exists() else []
        if not jsonl_candidates:
            return None
    return load_retained_state(agent_root)


def terminal_turns(state: dict[str, Any]) -> list[dict[str, Any]]:
    turns = state.get("turns")
    if not isinstance(turns, list) or not all(isinstance(turn, dict) for turn in turns):
        raise JourneyFailure("retained state has invalid turns")
    return [turn for turn in turns if turn.get("terminal_resolution_committed") is True]


def terminal_envelopes(state: dict[str, Any]) -> list[dict[str, Any]]:
    envelopes = state.get("terminal_event_envelopes")
    if not isinstance(envelopes, list) or not all(
        isinstance(envelope, dict) for envelope in envelopes
    ):
        raise JourneyFailure("retained state has invalid terminal envelopes")
    return envelopes


def wait_for_terminal_state(
    child: PtyChild,
    agent_root: Path,
    count: int,
    timeout: float,
    label: str,
    outcome: str | None = None,
) -> tuple[Path, dict[str, Any], bytes]:
    def ready() -> tuple[Path, dict[str, Any], bytes] | None:
        snapshot = retained_state_snapshot(agent_root)
        if snapshot is None:
            return None
        turns = terminal_turns(snapshot[1])
        if len(turns) < count:
            return None
        if outcome is not None and turns[count - 1].get("terminal_outcome") != outcome:
            return None
        return snapshot

    result = child.wait_until(ready, timeout, label)
    assert isinstance(result, tuple)
    return result

def wait_for_terminal_state_with_permissions(
    child: PtyChild,
    agent_root: Path,
    count: int,
    timeout: float,
    label: str,
    outcome: str,
) -> tuple[tuple[Path, dict[str, Any], bytes], list[str]]:
    deadline = time.monotonic() + timeout
    active_prompt: str | None = None
    approvals: list[str] = []
    while True:
        snapshot = retained_state_snapshot(agent_root)
        if snapshot is not None:
            turns = terminal_turns(snapshot[1])
            if len(turns) >= count and turns[count - 1].get("terminal_outcome") == outcome:
                return snapshot, approvals
        tool = child.permission_dialog_tool()
        if tool is None:
            active_prompt = None
        elif tool != active_prompt:
            approvals.append(tool)
            active_prompt = tool
            child.send_enter()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise JourneyFailure(
                f"{label}: timed out while handling permissions {approvals}\n"
                f"{child.screen.text()}"
            )
        child.pump(min(0.2, remaining))


def binding_history(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        row["data"]
        for row in rows
        if row.get("type") == "custom"
        and row.get("customType") == BINDING_TYPE
        and isinstance(row.get("data"), dict)
        and row["data"].get("schemaVersion") == BINDING_SCHEMA
    ]


def validate_binding_history(rows: list[dict[str, Any]]) -> dict[str, Any]:
    history = binding_history(rows)
    if not history:
        raise JourneyFailure("transcript contains no BreadBoard binding history")
    active_session_id: str | None = None
    previous_session_id: str | None = None
    active_replay_digest: str | None = None
    session_ids: list[str] = []
    prior_sequence = -1
    event_ids: dict[int, str | None] = {}
    unique_cursor_count = 0
    for entry in history:
        session_id = entry.get("sessionId")
        predecessor = entry.get("previousSessionId")
        replay_digest = entry.get("replayConfigurationDigest")
        if not isinstance(session_id, str) or not session_id:
            raise JourneyFailure("binding history contains an invalid session identity")
        if active_session_id is None:
            if predecessor is not None:
                raise JourneyFailure("initial binding unexpectedly names a predecessor session")
            active_session_id = session_id
            active_replay_digest = replay_digest
            session_ids.append(session_id)
        elif session_id != active_session_id:
            if (
                predecessor != active_session_id
                or session_id in session_ids
                or replay_digest != active_replay_digest
            ):
                raise JourneyFailure("binding history contains an invalid session successor")
            previous_session_id = active_session_id
            active_session_id = session_id
            session_ids.append(session_id)
            prior_sequence = -1
            event_ids = {}
        elif (
            predecessor != previous_session_id
            or replay_digest != active_replay_digest
        ):
            raise JourneyFailure(
                "binding history changed predecessor or replay configuration within one session"
            )
        cursor = entry.get("cursor")
        if not isinstance(cursor, dict) or type(cursor.get("sequence")) is not int:
            raise JourneyFailure("binding history contains an invalid cursor")
        sequence = int(cursor["sequence"])
        event_id = cursor.get("eventId")
        if event_id is not None and (
            not isinstance(event_id, str) or EVENT_ID_RE.fullmatch(event_id) is None
        ):
            raise JourneyFailure("binding history contains an invalid event identity")
        if sequence < prior_sequence:
            raise JourneyFailure("binding history rolled back its cursor")
        if sequence in event_ids and event_ids[sequence] != event_id:
            raise JourneyFailure("binding history conflicts at one cursor sequence")
        if sequence not in event_ids:
            unique_cursor_count += 1
        event_ids[sequence] = event_id
        prior_sequence = sequence
        submissions = owned_submissions(entry)
        for field in ("clientMessageId", "inputId", "turnId"):
            values = [submission.get(field) for submission in submissions]
            if len(values) != len(set(values)) or any(
                not isinstance(value, str) or not value for value in values
            ):
                raise JourneyFailure(
                    f"binding history contains duplicate or invalid {field} values"
                )
    return {
        "entryCount": len(history),
        "sessionId": active_session_id,
        "sessionIds": session_ids,
        "sessionCount": len(session_ids),
        "replayConfigurationDigest": active_replay_digest,
        "firstCursor": history[0]["cursor"],
        "finalCursor": history[-1]["cursor"],
        "uniqueCursorCount": unique_cursor_count,
        "cursorRollback": False,
        "cursorConflict": False,
    }


def session_event_journals(
    agent_root: Path, session_ids: set[str]
) -> tuple[list[Path], list[dict[str, Any]]]:
    candidates = sorted(
        path.resolve()
        for path in agent_root.rglob("session-events/*/session_events.jsonl")
        if path.parent.name in session_ids
    )
    found_ids = {path.parent.name for path in candidates}
    if found_ids != session_ids or len(candidates) != len(session_ids):
        raise JourneyFailure(
            f"expected one retained event journal per bound session {sorted(session_ids)}, "
            f"found {sorted(str(path) for path in candidates)}"
        )
    rows: list[dict[str, Any]] = []
    for path in candidates:
        journal_rows: list[dict[str, Any]] = []
        expected_session_id = path.parent.name
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line:
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise JourneyFailure(f"retained session event is not an object: {path}")
            journal_rows.append(value)
        if not journal_rows:
            raise JourneyFailure(f"retained session event journal is empty: {path}")
        for expected_sequence, value in enumerate(journal_rows, start=1):
            if (
                value.get("schema_version") != "bb.session_event.v1"
                or value.get("session_id") != expected_session_id
                or value.get("sequence") != expected_sequence
            ):
                raise JourneyFailure(
                    f"retained session event journal identity or sequence is invalid: {path}"
                )
        rows.extend(journal_rows)
    return candidates, rows


def validate_tool_receipts(facts: dict[str, Any]) -> dict[str, Any]:
    call_rows = facts["toolCallRows"]
    result_rows = facts["toolResultRows"]
    if any(not row["id"] or not row["name"] for row in call_rows):
        raise JourneyFailure(
            "transcript has a tool call without a call identity or name"
        )
    if any(not row["id"] or not row["name"] for row in result_rows):
        raise JourneyFailure(
            "transcript has a tool result without a call identity or name"
        )
    call_counts: dict[tuple[str, str], int] = {}
    result_counts: dict[tuple[str, str], int] = {}
    for row in call_rows:
        key = (row["id"], row["name"])
        call_counts[key] = call_counts.get(key, 0) + 1
    for row in result_rows:
        key = (row["id"], row["name"])
        result_counts[key] = result_counts.get(key, 0) + 1
    unmatched = sorted(
        f"{call_id}:{name}"
        for (call_id, name), count in result_counts.items()
        if count > call_counts.get((call_id, name), 0)
    )
    if unmatched:
        raise JourneyFailure(f"transcript has uncorrelated tool results: {unmatched}")
    return {
        "callCount": len(call_rows),
        "resultCount": len(result_rows),
        "uniqueCallIdentities": len(call_counts),
        "uncorrelatedResultIds": [],
    }


def authority_identity(authority: dict[str, Any]) -> dict[str, Any]:
    fields = (
        "pid",
        "osProcessStartToken",
        "engineInstanceId",
        "engineBootId",
        "launchId",
        "ownerGeneration",
        "recordRevision",
        "normalizedEndpoint",
    )
    return {field: authority.get(field) for field in fields}


def process_descendants(root_pid: int) -> list[dict[str, Any]]:
    completed = subprocess.run(
        ["/bin/ps", "-axo", "pid=,ppid=,state=,command="],
        capture_output=True,
        text=True,
        timeout=10,
        check=True,
    )
    rows: list[dict[str, Any]] = []
    for line in completed.stdout.splitlines():
        fields = line.strip().split(maxsplit=3)
        if len(fields) != 4 or not fields[0].isdigit() or not fields[1].isdigit():
            continue
        rows.append(
            {
                "pid": int(fields[0]),
                "ppid": int(fields[1]),
                "state": fields[2],
                "command": fields[3],
            }
        )
    descendants: list[dict[str, Any]] = []
    parents = {root_pid}
    while True:
        children = [
            row for row in rows if row["ppid"] in parents and row not in descendants
        ]
        if not children:
            return descendants
        descendants.extend(children)
        parents.update(int(child["pid"]) for child in children)


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def native_auth_row_counts(agent_root: Path) -> dict[str, int]:
    database = agent_root / "agent.db"
    if not database.is_file():
        return {}
    with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as connection:
        tables = [
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'auth_%' ORDER BY name"
            )
        ]
        return {
            table: int(
                connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
            )
            for table in tables
        }


def parse_status_identity(output: str) -> dict[str, Any]:
    for line in reversed(output.splitlines()):
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if (
            isinstance(value, dict)
            and value.get("schemaVersion") == "bb.installed_engine_identity.v1"
        ):
            return value
    raise JourneyFailure(f"status did not emit installed identity JSON: {output}")


def expected_identity(manifest: dict[str, Any]) -> dict[str, Any]:
    engine = manifest["engine"]
    profile = manifest["profile"]
    return {
        "schemaVersion": "bb.installed_engine_identity.v1",
        "distributionId": manifest["distributionId"],
        "productVersion": manifest["productVersion"],
        "target": manifest["target"],
        "signature": {"kind": manifest["signature"]["kind"]},
        "engine": {
            "runtimeBundleSha256": engine["runtimeBundle"]["sha256"],
            "executableSha256": engine["executableSha256"],
            "engineSourceSha256": engine["engineSourceSha256"],
            "servedBackendCommit": engine["servedBackendCommit"],
            "servedBackendTree": engine["servedBackendTree"],
            "interfaceVersion": engine["interfaceVersion"],
            "interfaceRange": engine["interfaceRange"],
        },
        "profile": {
            "profileId": profile["profileId"],
            "schemaVersion": profile["schemaVersion"],
            "sourceSha256": profile["sourceSha256"],
            "effectiveLockSchemaVersion": profile["effectiveLockSchemaVersion"],
            "effectiveLockSha256": profile["effectiveLockSha256"],
        },
    }


def installed_status(
    bb: Path,
    workspace: Path,
    environment: dict[str, str],
    label: str,
) -> tuple[subprocess.CompletedProcess[str], dict[str, Any], Path]:
    completed = subprocess.run(
        [str(bb), "--version"],
        cwd=workspace,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if completed.returncode != 0:
        raise JourneyFailure(
            f"{label} failed: {completed.returncode}: {completed.stderr}"
        )
    refusal_mode = subprocess.run(
        [str(bb), "--engine-mode", "local-owned"],
        cwd=workspace,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if refusal_mode.returncode != 2 or "Python engine bridge was removed" not in refusal_mode.stderr:
        raise JourneyFailure(
            f"--engine-mode refusal failed: {refusal_mode.returncode}: {refusal_mode.stderr}"
        )
    refusal_url = subprocess.run(
        [str(bb), "--engine-url", "http://127.0.0.1:1"],
        cwd=workspace,
        env=environment,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if refusal_url.returncode != 2 or "Python engine bridge was removed" not in refusal_url.stderr:
        raise JourneyFailure(
            f"--engine-url refusal failed: {refusal_url.returncode}: {refusal_url.stderr}"
        )
    identity = {
        "schemaVersion": "bb.installed_native_identity.v1",
        "version": completed.stdout.strip(),
        "modeRefusal": True,
        "urlRefusal": True,
    }
    manifest_path = bb.parent / "install-manifest.v1.json"
    return completed, identity, manifest_path


def exact_environment(
    home: Path, config: Path, agent: Path, temp: Path
) -> dict[str, str]:
    user = pwd.getpwuid(os.getuid()).pw_name
    environment = {
        "HOME": str(home),
        "TMPDIR": f"{temp}{os.sep}",
        "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
        "SHELL": "/bin/zsh",
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "LANG": "en_US.UTF-8",
        "LC_ALL": "en_US.UTF-8",
        "USER": user,
        "LOGNAME": user,
        "OMP_SKIP_SETUP": "1",
        "BREADBOARD_CONFIG_DIR": str(config),
        "PI_CODING_AGENT_DIR": str(agent),
    }
    forbidden_prefixes = (
        "BREADBOARD_ENGINE_",
        "BREADBOARD_API_",
        "BREADBOARD_SESSION_",
        "BREADBOARD_RUNTIME_",
        "OPENAI_",
        "ANTHROPIC_",
        "OPENROUTER_",
        "GOOGLE_",
        "GEMINI_",
        "OTEL_",
    )
    forbidden_exact = {"PYTHONPATH", "PYTHONHOME", "NODE_PATH"}
    leaked = sorted(
        key
        for key in environment
        if key in forbidden_exact or key.startswith(forbidden_prefixes)
    )
    if leaked:
        raise JourneyFailure(
            f"constructed environment contains forbidden keys: {leaked}"
        )
    return environment


def ensure_empty_directory(path: Path, label: str) -> None:
    if not path.is_absolute() or not path.is_dir() or path.is_symlink():
        raise JourneyFailure(f"{label} must be one absolute real directory: {path}")
    if any(path.iterdir()):
        raise JourneyFailure(f"{label} must be empty before first launch: {path}")


def assert_no_forbidden_paths(value: str, roots: list[Path], label: str) -> None:
    matches = [str(root) for root in roots if str(root) in value]
    if matches:
        raise JourneyFailure(f"{label} contains source checkout paths: {matches}")


TAMPER_REMEDIATION = (
    "Reinstall BreadBoard from one complete trusted distribution; "
    "do not edit the manifest or supply replacement hashes."
)
TAMPER_MESSAGES = {
    "engine_artifact_mismatch": (
        "The installed BreadBoard engine executable does not match its trusted distribution."
    ),
    "engine_manifest_untrusted": (
        "The installed BreadBoard engine manifest is not trusted by this bb build."
    ),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mutate_sealed_byte(path: Path, offset: int, replacement: int) -> tuple[int, int]:
    if path.is_symlink() or not path.is_file():
        raise JourneyFailure(f"tamper target is not one regular file: {path}")
    if offset < 0 or offset >= path.stat().st_size:
        raise JourneyFailure(f"tamper offset is outside target: {offset}")
    parent = path.parent
    os.chmod(parent, 0o700)
    os.chmod(path, 0o600)
    descriptor = os.open(path, os.O_RDWR | os.O_NOFOLLOW)
    try:
        original = os.pread(descriptor, 1, offset)
        if len(original) != 1 or original[0] == replacement:
            raise JourneyFailure("tamper mutation did not replace exactly one byte")
        if os.pwrite(descriptor, bytes((replacement,)), offset) != 1:
            raise JourneyFailure("tamper mutation did not write exactly one byte")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
        os.chmod(path, 0o400)
        os.chmod(parent, 0o500)
    return original[0], replacement


def remove_readonly_tree(path: Path) -> None:
    if not path.exists():
        return
    for root, directories, files in os.walk(path, topdown=False):
        for name in files:
            candidate = Path(root) / name
            if not candidate.is_symlink():
                os.chmod(candidate, 0o600)
        for name in directories:
            candidate = Path(root) / name
            if not candidate.is_symlink():
                os.chmod(candidate, 0o700)
        os.chmod(root, 0o700)
    shutil.rmtree(path)


def run_tamper_failure(
    bb: Path,
    output: Path,
    case: str,
    expected_code: str,
    forbidden_roots: list[Path],
) -> dict[str, Any]:
    install_copy = output / f"{case}-installed"
    isolated = output / f"{case}-isolated"
    if install_copy.exists() or isolated.exists():
        raise JourneyFailure(f"tamper case path already exists: {case}")
    shutil.copytree(bb.parent, install_copy, copy_function=shutil.copy2)
    try:
        engine_root = install_copy / "engine"
        distributions = [
            path
            for path in engine_root.iterdir()
            if path.is_dir() and not path.is_symlink()
        ]
        if len(distributions) != 1:
            raise JourneyFailure(
                f"tamper copy has unexpected distributions: {distributions}"
            )
        distribution = distributions[0]
        manifest_path = distribution / "breadboard-engine-manifest.v1.json"
        manifest_bytes = manifest_path.read_bytes()
        try:
            manifest = json.loads(manifest_bytes)
        except json.JSONDecodeError as error:
            raise JourneyFailure("trusted manifest copy is not JSON") from error

        if case == "bundle-tamper":
            target = distribution / manifest["engine"]["runtimeBundle"]["path"]
            offset = target.stat().st_size // 2
            with target.open("rb") as handle:
                handle.seek(offset)
                original = handle.read(1)
            if len(original) != 1:
                raise JourneyFailure("runtime bundle mutation offset is unreadable")
            replacement = original[0] ^ 1
        elif case == "manifest-profile-tamper":
            target = manifest_path
            profile = b"daily_driver.v1"
            profile_offset = manifest_bytes.find(profile)
            if profile_offset < 0:
                raise JourneyFailure(
                    "trusted manifest has no daily_driver.v1 profile identity"
                )
            offset = profile_offset + len(profile) - 1
            replacement = ord("2")
        else:
            raise JourneyFailure(f"unknown tamper case: {case}")

        before_sha256 = sha256_file(target)
        original_byte, replacement_byte = mutate_sealed_byte(
            target, offset, replacement
        )
        after_sha256 = sha256_file(target)
        if before_sha256 == after_sha256:
            raise JourneyFailure(f"{case} did not change the target digest")

        roots = {
            label: isolated / label
            for label in ("home", "config", "agent", "workspace", "temp")
        }
        for root in roots.values():
            root.mkdir(parents=True, mode=0o700)
            ensure_empty_directory(root, f"{case} {root.name}")
        environment = exact_environment(
            roots["home"], roots["config"], roots["agent"], roots["temp"]
        )
        baseline_ray_roots = ray_runtime_roots(roots["temp"])
        if endpoint_open("http://127.0.0.1:9099"):
            raise JourneyFailure(
                "port 9099 is unexpectedly occupied before tamper failure"
            )
        completed = subprocess.run(
            [str(install_copy / "bb"), "engine", "start"],
            cwd=roots["workspace"],
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        expected_stderr = (
            f"BreadBoard installed engine error [{expected_code}]: "
            f"{TAMPER_MESSAGES[expected_code]}\n{TAMPER_REMEDIATION}\n"
        )
        if completed.returncode != 1:
            raise JourneyFailure(f"{case} exited {completed.returncode}, expected 1")
        if completed.stdout != "" or completed.stderr != expected_stderr:
            raise JourneyFailure(
                f"{case} emitted unexpected output: {completed.stdout!r} {completed.stderr!r}"
            )
        assert_no_forbidden_paths(completed.stderr, forbidden_roots, f"{case} output")
        support_files = sorted(
            str(path.relative_to(roots["agent"]))
            for path in roots["agent"].rglob("*")
            if path.is_file() or path.is_symlink()
        )
        publications = [
            path
            for path in support_files
            if path.endswith((".authority.json", ".jsonl")) or "session-state/" in path
        ]
        if publications:
            raise JourneyFailure(
                f"{case} published engine or session state: {publications}"
            )
        if active_authority(roots["agent"]) is not None:
            raise JourneyFailure(f"{case} published an engine authority")
        if binding_snapshot(roots["agent"]) is not None:
            raise JourneyFailure(f"{case} published a session binding")
        if extraction_roots(roots["temp"]):
            raise JourneyFailure(f"{case} extracted an engine runtime")
        if ray_runtime_roots(roots["temp"]) != baseline_ray_roots:
            raise JourneyFailure(f"{case} created a Ray runtime root")
        if endpoint_open("http://127.0.0.1:9099"):
            raise JourneyFailure(f"{case} opened port 9099")

        result = {
            "case": case,
            "status": "pass",
            "expectedCode": expected_code,
            "exitCode": completed.returncode,
            "stdout": completed.stdout,
            "stderr": completed.stderr,
            "targetRelativePath": str(target.relative_to(install_copy)),
            "supportFiles": support_files,
            "targetSizeBytes": target.stat().st_size,
            "targetSha256Before": before_sha256,
            "targetSha256After": after_sha256,
            "mutation": {
                "offset": offset,
                "originalByte": original_byte,
                "replacementByte": replacement_byte,
            },
            "environmentKeys": sorted(environment),
            "preSpawnFailure": True,
            "listenerPublished": False,
            "authorityPublished": False,
            "bindingPublished": False,
            "sessionStatePublished": False,
            "runtimeExtracted": False,
            "rayRuntimeCreated": False,
            "fallbackUsed": False,
        }
    finally:
        remove_readonly_tree(install_copy)
        remove_readonly_tree(isolated)
    return result


def positive_dimension(value: str) -> int:
    try:
        dimension = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if dimension <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return dimension


def main() -> int:
    parser = argparse.ArgumentParser(
        formatter_class=argparse.ArgumentDefaultsHelpFormatter
    )
    parser.add_argument("--bb", type=Path, required=True)
    parser.add_argument("--pi-natives", type=Path, required=True)
    parser.add_argument("--sdk-artifact", type=Path, required=True)
    parser.add_argument("--sdk-provenance", type=Path, required=True)
    parser.add_argument("--tui-source-commit", required=True)
    parser.add_argument("--tui-source-tree", required=True)
    parser.add_argument("--home", type=Path, required=True)
    parser.add_argument("--config-root", type=Path, required=True)
    parser.add_argument("--agent-root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--temp-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--forbid-root", type=Path, action="append", default=[])
    parser.add_argument(
        "--rows", type=positive_dimension, default=ROWS, help="PTY row count"
    )
    parser.add_argument(
        "--cols", type=positive_dimension, default=COLUMNS, help="PTY column count"
    )
    parser.add_argument("--startup-timeout", type=float, default=120.0)
    parser.add_argument("--turn-timeout", type=float, default=180.0)
    options = parser.parse_args()

    bb = options.bb.resolve(strict=True)
    pi_natives = options.pi_natives.resolve(strict=True)
    sdk_artifact = options.sdk_artifact.resolve(strict=True)
    sdk_provenance = options.sdk_provenance.resolve(strict=True)
    for label, path in (
        ("pi native addon", pi_natives),
        ("SDK artifact", sdk_artifact),
        ("SDK provenance", sdk_provenance),
    ):
        if not path.is_file():
            raise JourneyFailure(f"{label} is not a file: {path}")
    product_root = bb.parent
    expected_native = product_root / "native" / "pi_natives.darwin-arm64.node"
    if pi_natives != expected_native:
        raise JourneyFailure("bb and pi native addon are not from one installed product root")
    install_manifest = json.loads(
        (product_root / "install-manifest.v1.json").read_text(encoding="utf-8")
    )
    binary_identity = install_manifest.get("binary")
    native_identity = install_manifest.get("nativeAddon")
    if (
        install_manifest.get("schemaVersion") != "bb.product_install_manifest.v1"
        or not isinstance(binary_identity, dict)
        or binary_identity.get("path") != "bb"
        or not isinstance(native_identity, dict)
        or native_identity.get("path")
        != "native/pi_natives.darwin-arm64.node"
    ):
        raise JourneyFailure("installed product manifest does not bind executable paths")
    expected_artifact_sha256 = dict(EXPECTED_ARTIFACT_SHA256)
    for label, identity in (
        ("bb", binary_identity),
        ("piNatives", native_identity),
    ):
        digest = identity.get("sha256")
        if (
            not isinstance(digest, str)
            or re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is None
        ):
            raise JourneyFailure(f"installed {label} manifest digest is invalid")
        expected_artifact_sha256[label] = digest.removeprefix("sha256:")
    artifact_paths = {
        "bb": bb,
        "piNatives": pi_natives,
        "sdkArtifact": sdk_artifact,
        "sdkProvenance": sdk_provenance,
    }
    artifact_sha256 = {
        label: sha256_file(path) for label, path in artifact_paths.items()
    }
    mismatched_artifacts = {
        label: {
            "expected": expected_artifact_sha256[label],
            "actual": artifact_sha256[label],
        }
        for label in artifact_paths
        if artifact_sha256[label] != expected_artifact_sha256[label]
    }
    if mismatched_artifacts:
        raise JourneyFailure(
            f"installed artifact identity mismatch: {mismatched_artifacts}"
        )
    sdk_provenance_payload = json.loads(sdk_provenance.read_text(encoding="utf-8"))
    if (
        sdk_provenance_payload.get("schemaVersion")
        != "p30.breadboard-sdk-provenance.v1"
        or sdk_provenance_payload.get("packageName") != "@breadboard/sdk"
        or sdk_provenance_payload.get("packageVersion") != "0.4.0"
        or sdk_provenance_payload.get("artifactSha256")
        != EXPECTED_ARTIFACT_SHA256["sdkArtifact"]
        or sdk_provenance_payload.get("artifactSizeBytes") != sdk_artifact.stat().st_size
        or sdk_provenance_payload.get("engineInterfaceVersion") != "0.4.0"
        or sdk_provenance_payload.get("engineInterfaceRange") != ">=0.4.0 <0.5.0"
    ):
        raise JourneyFailure("SDK provenance does not match the canonical artifact")
    if GIT_OBJECT_RE.fullmatch(options.tui_source_commit) is None:
        raise JourneyFailure("--tui-source-commit must be a lowercase 40-hex object id")
    if GIT_OBJECT_RE.fullmatch(options.tui_source_tree) is None:
        raise JourneyFailure("--tui-source-tree must be a lowercase 40-hex object id")
    product_provenance = json.loads(
        (product_root / "provenance.v1.json").read_text(encoding="utf-8")
    )
    product_source = product_provenance.get("productSource")
    if (
        product_provenance.get("schemaVersion") != "bb.product_provenance.v1"
        or not isinstance(product_source, dict)
        or product_source.get("commit") != options.tui_source_commit
        or product_source.get("tree") != options.tui_source_tree
    ):
        raise JourneyFailure(
            "installed product provenance does not match the requested TUI source identity"
        )
    roots = {
        "home": options.home.resolve(strict=True),
        "config": options.config_root.resolve(strict=True),
        "agent": options.agent_root.resolve(strict=True),
        "workspace": options.workspace.resolve(strict=True),
        "temp": options.temp_root.resolve(strict=True),
    }
    output = options.output.resolve(strict=True)
    forbidden_roots = [path.resolve(strict=True) for path in options.forbid_root]
    host_agent_root = Path.home().resolve() / ".omp" / "agent"
    if not bb.is_file() or not os.access(bb, os.X_OK):
        raise JourneyFailure(f"bb is not executable: {bb}")
    for label, root in roots.items():
        ensure_empty_directory(root, label)
    (roots["agent"] / "config.yml").write_text(
        "tools:\n  approvalMode: always-ask\n",
        encoding="utf-8",
    )
    if any(root == output or output.is_relative_to(root) for root in roots.values()):
        raise JourneyFailure("output must be outside isolated journey roots")
    assert_no_forbidden_paths(str(bb), forbidden_roots, "installed bb path")
    assert_no_forbidden_paths(
        str(roots["workspace"]), forbidden_roots, "workspace path"
    )

    environment = exact_environment(
        roots["home"], roots["config"], roots["agent"], roots["temp"]
    )
    secret_canary = f"g6-secret-{hashlib.sha256(os.urandom(32)).hexdigest()}"
    environment["BB_G6_SECRET_CANARY"] = secret_canary
    browser_marker, browser_observation = create_browser_launch_guard(
        roots["temp"], environment
    )
    network_audit_raw, network_audit_process, network_audit_stream = (
        start_network_audit(roots["temp"])
    )

    def stop_network_audit_at_exit() -> None:
        if network_audit_process.poll() is None:
            network_audit_process.terminate()
            try:
                network_audit_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                network_audit_process.kill()
                network_audit_process.wait(timeout=5)
        if not network_audit_stream.closed:
            network_audit_stream.close()

    atexit.register(stop_network_audit_at_exit)
    recorded_environment = {
        key: "<secret-canary>" if key == "BB_G6_SECRET_CANARY" else value
        for key, value in environment.items()
    }
    write_json(
        output / "environment.json",
        {"keys": sorted(environment), "values": recorded_environment},
    )
    action_trace: list[dict[str, Any]] = []
    journey_started = time.monotonic()

    def record_action(action: str, **details: Any) -> None:
        action_trace.append(
            {
                "action": action,
                "elapsedSeconds": round(time.monotonic() - journey_started, 6),
                **details,
            }
        )
        write_json(output / "ui-action-trace.json", action_trace)

    baseline_ray_runtime_roots = ray_runtime_roots(roots["temp"])
    preflight_status, preflight_status_identity, preflight_manifest_path = (
        installed_status(
            bb,
            roots["workspace"],
            environment,
            "engine status before launch",
        )
    )
    (output / "engine-status-before-launch.json").write_text(
        json.dumps(
            {
                "exitCode": preflight_status.returncode,
                "stdout": preflight_status.stdout,
                "stderr": preflight_status.stderr,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    preflight_status_text = json.dumps(preflight_status_identity, sort_keys=True)
    for unsafe in (
        str(bb.parent),
        str(roots["home"]),
        str(roots["agent"]),
        str(roots["config"]),
    ):
        if unsafe in preflight_status_text:
            raise JourneyFailure("preflight status identity contains a local path")
    if (
        active_authority(roots["agent"]) is not None
        or binding_snapshot(roots["agent"]) is not None
        or extraction_roots(roots["temp"])
        or ray_runtime_roots(roots["temp"]) != baseline_ray_runtime_roots
        or endpoint_open("http://127.0.0.1:9099")
    ):
        raise JourneyFailure(
            "preflight status created runtime authority or process state"
        )
    initial = PtyChild(
        [str(bb)],
        roots["workspace"],
        timing_environment(environment),
        rows=options.rows,
        columns=options.cols,
    )
    provider_free_tui_pid = initial.pid
    try:
        initial.wait_until(
            lambda: (
                "mock/reference" in initial.screen.text()
                and "No LSP servers" in initial.screen.text()
            ),
            options.startup_timeout,
            "initial TUI readiness",
        )
        write_capture(output, "initial-ready", initial)
        initial_text = initial.screen.text()
        resize_started_at = time.monotonic()
        initial.resize(24, 80)

        def composer_visible(columns: int) -> bool:
            text = initial.screen.text()
            return (
                "mock/reference" in text
                and "No LSP servers" in text
                and all(len(line.rstrip()) <= columns for line in text.splitlines())
            )

        initial.wait_until(
            lambda: (
                initial.screen.text() != initial_text and composer_visible(80)
            ),
            10.0,
            "resize to 80-column TUI",
        )
        record_action(
            "resize",
            rows=24,
            cols=80,
            redraw_seconds=round(time.monotonic() - resize_started_at, 6),
        )
        write_capture(output, "resize-80x24", initial)

        restore_reads = initial.output_reads
        resize_started_at = time.monotonic()
        initial.resize(options.rows, options.cols)
        initial.wait_until(
            lambda: initial.output_reads > restore_reads
            and composer_visible(options.cols),
            10.0,
            "restore original TUI geometry",
        )
        record_action(
            "resize-restore",
            rows=options.rows,
            cols=options.cols,
            redraw_seconds=round(time.monotonic() - resize_started_at, 6),
        )
        write_capture(output, "resize-restore", initial)
        if binding_snapshot(roots["agent"]) is not None:
            raise JourneyFailure(
                "new TUI created a session binding before the first submitted turn"
            )
        if active_authority(roots["agent"]) is not None:
            raise JourneyFailure("native mode published unexpected engine authority")
        descendants = process_descendants(initial.pid)
        python_descendants = [
            d for d in descendants
            if "python" in d.get("command", "").lower() and "breadboard" in d.get("command", "").lower()
        ]
        if python_descendants:
            raise JourneyFailure(f"Python engine process spawned in native mode: {python_descendants}")

        initial.send_line(FIRST_PROMPT)

        def first_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or len(owned_submissions(snapshot.data)) != 1:
                return None
            facts = transcript_facts(snapshot.rows)
            if facts["sentinelCount"] < 1:
                return None
            if not all(
                (roots["workspace"] / name).is_file()
                and (roots["workspace"] / name).stat().st_size > 0
                for name in EXPECTED_FILES
            ):
                return None
            if (
                "list_dir" not in facts["toolCalls"]
                or "apply_unified_patch" not in facts["toolCalls"]
            ):
                return None
            if (
                "list_dir" not in facts["toolResults"]
                or "apply_unified_patch" not in facts["toolResults"]
            ):
                return None
            return snapshot

        first = initial.wait_until(
            first_turn_ready, options.turn_timeout, "first terminal turn"
        )
        assert isinstance(first, BindingSnapshot)
        write_capture(output, "initial-turn-1", initial)
        first_facts = transcript_facts(first.rows)
        if first_facts["userTexts"] != [FIRST_PROMPT]:
            raise JourneyFailure(
                f"first turn has unexpected user messages: {first_facts['userTexts']}"
            )
        if first_facts["assistantTexts"].count(ASSISTANT_SENTINEL) != 1:
            raise JourneyFailure(
                "first turn does not contain exactly one terminal assistant sentinel"
            )
        if first_facts["toolCalls"] != ["list_dir", "apply_unified_patch"]:
            raise JourneyFailure(
                f"first turn has unexpected tool calls: {first_facts['toolCalls']}"
            )
        if first_facts["toolResults"] != ["list_dir", "apply_unified_patch"]:
            raise JourneyFailure(
                f"first turn has unexpected tool results: {first_facts['toolResults']}"
            )
        first_cursor = cursor_sequence(first.data)

        initial.send_line(SECOND_PROMPT)

        def second_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or len(owned_submissions(snapshot.data)) != 2:
                return None
            facts = transcript_facts(snapshot.rows)
            if (
                facts["sentinelCount"] < 2
                or cursor_sequence(snapshot.data) <= first_cursor
            ):
                return None
            return snapshot

        second = initial.wait_until(
            second_turn_ready, options.turn_timeout, "second terminal turn"
        )
        assert isinstance(second, BindingSnapshot)
        write_capture(output, "initial-turn-2", initial)
        initial_session_id = str(second.data.get("sessionId") or "")
        if not initial_session_id:
            raise JourneyFailure("initial provider-free session is missing its session id")
        if extraction_roots(roots["temp"]):
            raise JourneyFailure("native mode extracted unexpected engine runtime")
        first_processes = {
            "bb": process_snapshot(initial.pid),
        }
        process_text = json.dumps(first_processes, sort_keys=True)
        assert_no_forbidden_paths(
            process_text,
            [*forbidden_roots, host_agent_root],
            "initial process snapshot",
        )
        assert_loopback_network(first_processes, "initial process snapshot")
        initial_engine_canary_absent = True
        record_action("open-model-selector", command="/model")
        initial.send_line("/model")
        initial.wait_until(
            lambda: "All models" in initial.screen.text(),
            options.startup_timeout,
            "public model role selector",
        )
        initial.send(b"\x1b[C")
        initial.send(b"cli_mock/reference")
        initial.wait_until(
            lambda: "cli_mock/reference" in initial.screen.text(),
            options.startup_timeout,
            "synthetic default-role selector result",
        )
        write_capture(output, "synthetic-model-selector", initial)
        initial.send_enter()
        initial.send_enter()
        initial.send_escape()
        initial.send_escape()
        initial.send_escape()
        initial.wait_until(
            lambda: "Default model: cli_mock/reference" in initial.screen.text(),
            options.startup_timeout,
            "active model role selection status",
        )
        record_action("select-synthetic-model", model="cli_mock/reference", scope="active-and-next-session")

        record_action("exit-provider-free-tui", command="/exit")
        initial.send_line("/exit")
        initial_exit = initial.wait_for_exit(60)
        write_capture(output, "provider-free-exit", initial)
        old_initial = binding_snapshot(roots["agent"])
        if old_initial is None or old_initial.data.get("sessionId") != initial_session_id:
            raise JourneyFailure("provider-free session was not retained before relaunch")
        initial_model = session_model(old_initial)
        if initial_model != "cli_mock/reference":
            raise JourneyFailure(
                f"provider-free session did not record the selected model: {initial_model!r}"
            )
        old_initial_facts = transcript_facts(old_initial.rows)
        if old_initial_facts["userTexts"] != [FIRST_PROMPT, SECOND_PROMPT]:
            raise JourneyFailure(
                f"provider-free session lost submitted prompts: {old_initial_facts['userTexts']}"
            )
        if old_initial_facts["assistantTexts"].count(ASSISTANT_SENTINEL) != 2:
            raise JourneyFailure(
                "provider-free session does not retain exactly two assistant sentinels"
            )
        if old_initial_facts["toolCalls"] != ["list_dir", "apply_unified_patch"] * 2:
            raise JourneyFailure("provider-free session lost its native tool calls")
        initial.close()

        record_action("launch-synthetic-tui", model="cli_mock/reference")
        initial = PtyChild(
            [str(bb)],
            roots["workspace"],
            timing_environment(environment),
            rows=options.rows,
            columns=options.cols,
        )
        synthetic_tui_pid = initial.pid
        initial.wait_until(
            lambda: "reference" in initial.screen.text() and "No LSP servers" in initial.screen.text(),
            options.startup_timeout,
            "fresh synthetic TUI readiness",
        )
        if active_authority(roots["agent"]) is not None:
            raise JourneyFailure("fresh native TUI published unexpected engine authority")

        record_action("fresh-synthetic-runtime", model="cli_mock/reference")
        # The PTY driver must model separate human keystrokes here. Sending an
        # entire prompt and Enter in one write can become one terminal input
        # callback, which is not an interactive user path.
        initial.send_typed_line(SYNTHETIC_PROMPT)
        record_action("submit-synthetic-turn", prompt=SYNTHETIC_PROMPT)
        initial.wait_until(
            initial.permission_dialog_ready,
            options.turn_timeout,
            "synthetic run_shell permission",
        )
        write_capture(output, "synthetic-permission-allow", initial)
        initial.send_enter()
        record_action("allow-synthetic-run-shell")
        _, _synthetic_state, _ = wait_for_terminal_state(
            initial,
            roots["agent"],
            1,
            options.turn_timeout,
            "synthetic terminal turn",
            "completed",
        )

        def synthetic_turn_ready() -> BindingSnapshot | None:
            snapshot = next(
                (
                    candidate
                    for candidate in binding_snapshots(roots["agent"])
                    if candidate.data.get("sessionId") != initial_session_id
                ),
                None,
            )
            if snapshot is None or len(owned_submissions(snapshot.data)) != 1:
                return None
            facts = transcript_facts(snapshot.rows)
            if tuple(facts["toolCalls"][-3:]) != SYNTHETIC_TOOLS:
                return None
            if tuple(facts["toolResults"][-3:]) != SYNTHETIC_TOOLS:
                return None
            return snapshot

        synthetic = initial.wait_until(
            synthetic_turn_ready,
            options.turn_timeout,
            "synthetic projected terminal turn",
        )
        assert isinstance(synthetic, BindingSnapshot)
        synthetic_session_id = str(synthetic.data.get("sessionId") or "")
        if not synthetic_session_id or synthetic_session_id == initial_session_id:
            raise JourneyFailure("fresh synthetic session is missing a distinct session id")
        synthetic_model = session_model(synthetic)
        if synthetic_model != "cli_mock/reference":
            raise JourneyFailure(
                f"fresh session did not start with cli_mock/reference: {synthetic_model!r}"
            )
        synthetic_facts = transcript_facts(synthetic.rows)
        synthetic_cursor = cursor_sequence(synthetic.data)
        if synthetic_facts["completionSentinelCount"] != 0:
            raise JourneyFailure(
                "control-only completion sentinel reached the TUI transcript"
            )
        bubble_sort = roots["workspace"] / "bubble_sort.py"
        if not bubble_sort.is_file() or "def bubble_sort" not in bubble_sort.read_text(
            encoding="utf-8"
        ):
            raise JourneyFailure(
                "synthetic write tool did not create the expected fixture"
            )
        write_capture(output, "synthetic-completed", initial)

        successful_shell_results_before_cancel = sum(
            row["name"] == "run_shell" and row["isError"] is False
            for row in synthetic_facts["toolResultRows"]
        )
        bubble_sort_digest_before_cancel = sha256_file(bubble_sort)
        initial.send_line(CANCEL_PROMPT)
        record_action("submit-cancel-turn", prompt=CANCEL_PROMPT)
        initial.wait_until(
            initial.permission_dialog_ready,
            options.turn_timeout,
            "cancellation permission checkpoint",
        )
        write_capture(output, "synthetic-permission-cancel", initial)
        initial.send_escape()
        record_action("cancel-synthetic-permission", key="Escape")
        _, cancellation_state, _ = wait_for_terminal_state(
            initial,
            roots["agent"],
            2,
            options.turn_timeout,
            "cancelled synthetic turn",
            "cancelled",
        )
        cancellation_envelopes = terminal_envelopes(cancellation_state)
        cancelled_turn_id = cancellation_state["turns"][1].get("turn_id")
        if not any(
            envelope.get("type") == "turn_cancelled"
            and envelope.get("turn_id") == cancelled_turn_id
            for envelope in cancellation_envelopes
        ):
            raise JourneyFailure(
                "cancelled turn has no correlated durable turn_cancelled terminal envelope"
            )

        def cancelled_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or len(owned_submissions(snapshot.data)) != 2:
                return None
            if cursor_sequence(snapshot.data) <= synthetic_cursor:
                return None
            facts = transcript_facts(snapshot.rows)
            if (
                len(facts["assistantErrors"])
                != len(synthetic_facts["assistantErrors"]) + 1
            ):
                return None
            return snapshot

        cancelled = initial.wait_until(
            cancelled_turn_ready,
            options.turn_timeout,
            "cancelled projected terminal turn",
        )
        assert isinstance(cancelled, BindingSnapshot)
        cancelled_facts = transcript_facts(cancelled.rows)
        successful_shell_results_after_cancel = sum(
            row["name"] == "run_shell" and row["isError"] is False
            for row in cancelled_facts["toolResultRows"]
        )
        if (
            successful_shell_results_after_cancel
            != successful_shell_results_before_cancel
        ):
            raise JourneyFailure("cancelled permission executed run_shell")
        if sha256_file(bubble_sort) != bubble_sort_digest_before_cancel:
            raise JourneyFailure(
                "cancelled permission changed the deterministic fixture"
            )
        cancelled_cursor = cursor_sequence(cancelled.data)
        initial.wait_until(
            lambda: (
                "BreadBoard permission request · run_shell" not in initial.screen.text()
                and "cli_mock/reference" in initial.screen.text()
            ),
            options.turn_timeout,
            "usable composer after cancellation",
        )
        write_capture(output, "synthetic-cancelled", initial)

        initial.send_line(CRASH_PROMPT)
        record_action("submit-crash-turn", prompt=CRASH_PROMPT)
        initial.wait_until(
            initial.permission_dialog_ready,
            options.turn_timeout,
            "engine crash permission checkpoint",
        )
        _, _crash_pending_state, _ = initial.wait_until(
            lambda: (
                snapshot
                if (snapshot := retained_state_snapshot(roots["agent"])) is not None
                and isinstance(snapshot[1].get("turns"), list)
                and len(snapshot[1]["turns"]) == 3
                and snapshot[1]["turns"][-1].get("terminal_resolution_committed")
                is not True
                else None
            ),
            options.turn_timeout,
            "pending crash turn authority",
        )
        crash_turn_id = str(_crash_pending_state["turns"][-1].get("turn_id") or "")
        if not crash_turn_id:
            raise JourneyFailure("pending crash turn is missing durable identity")
        initial.wait_until(
            lambda: (
                snapshot
                if (snapshot := binding_snapshot(roots["agent"])) is not None
                and any(
                    str(submission.get("turnId")) == crash_turn_id
                    for submission in owned_submissions(snapshot.data)
                )
                else None
            ),
            options.turn_timeout,
            "durable crash turn ownership",
        )
        crash_authority_path, crash_authority = initial.wait_until(
            lambda: active_authority(roots["agent"]),
            options.startup_timeout,
            "crash engine authority",
        )
        crash_pid = int(crash_authority["pid"])
        if crash_pid == initial.pid or not process_alive(crash_pid):
            raise JourneyFailure("crash target is not one live managed engine child")
        descendants_before_crash = process_descendants(initial.pid)
        if not any(row["pid"] == crash_pid for row in descendants_before_crash):
            raise JourneyFailure(
                "authenticated engine crash target is not a bb descendant"
            )
        crash_identity = authority_identity(crash_authority)
        current_authority = active_authority(roots["agent"])
        if (
            current_authority is None
            or current_authority[0] != crash_authority_path
            or current_authority[1].get("pid") != crash_authority.get("pid")
            or current_authority[1].get("osProcessStartToken")
            != crash_authority.get("osProcessStartToken")
            or current_authority[1].get("engineInstanceId")
            != crash_authority.get("engineInstanceId")
        ):
            raise JourneyFailure(
                "engine authority changed before authenticated crash injection"
            )
        write_capture(output, "engine-crash-checkpoint", initial)
        os.kill(crash_pid, signal.SIGKILL)
        record_action(
            "kill-authenticated-engine",
            pid=crash_pid,
            osProcessStartToken=crash_authority["osProcessStartToken"],
            engineInstanceId=crash_authority["engineInstanceId"],
        )
        initial.wait_until(
            lambda: not process_alive(crash_pid),
            options.startup_timeout,
            "old engine process death",
        )

        def replacement_authority_ready() -> tuple[Path, dict[str, Any]] | None:
            authority = active_authority(roots["agent"])
            if authority is None:
                return None
            candidate = authority[1]
            for field in (
                "pid",
                "osProcessStartToken",
                "engineInstanceId",
                "engineBootId",
                "launchId",
            ):
                if candidate.get(field) == crash_authority.get(field):
                    return None
            if not process_alive(int(candidate["pid"])):
                return None
            if not endpoint_open(str(candidate["normalizedEndpoint"])):
                return None
            return authority

        replacement_authority_path, replacement_authority = initial.wait_until(
            replacement_authority_ready,
            options.turn_timeout,
            "bounded replacement engine authority",
        )
        replacement_identity = authority_identity(replacement_authority)
        if any(
            not isinstance(authority.get("ownerGeneration"), int)
            or int(authority["ownerGeneration"]) < 1
            for authority in (crash_authority, replacement_authority)
        ):
            raise JourneyFailure("engine authority has an invalid owner generation")
        if replacement_authority_path != crash_authority_path:
            raise JourneyFailure(
                "replacement engine changed the public authority record path"
            )
        _, crash_state, _ = wait_for_terminal_state(
            initial,
            roots["agent"],
            3,
            options.turn_timeout,
            "crashed terminal turn",
            "failed",
        )
        crash_envelopes = terminal_envelopes(crash_state)
        if len(crash_envelopes) < 3 or crash_envelopes[2].get("type") != "turn_failed":
            raise JourneyFailure(
                "crashed turn has no durable turn_failed terminal envelope"
            )

        def crashed_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None:
                return None
            if not any(
                str(submission.get("turnId")) == crash_turn_id
                for submission in owned_submissions(snapshot.data)
            ):
                return None
            if cursor_sequence(snapshot.data) <= cancelled_cursor:
                return None
            facts = transcript_facts(snapshot.rows)
            if (
                len(facts["assistantErrors"])
                != len(cancelled_facts["assistantErrors"]) + 1
            ):
                return None
            return snapshot

        crashed = initial.wait_until(
            crashed_turn_ready,
            options.turn_timeout,
            "crashed projected terminal turn",
        )
        assert isinstance(crashed, BindingSnapshot)
        crashed_facts = transcript_facts(crashed.rows)
        crash_errors = crashed_facts["assistantErrors"][
            len(cancelled_facts["assistantErrors"]) :
        ]
        if len(crash_errors) != 1:
            raise JourneyFailure(
                "crashed turn did not project one sanitized terminal failure"
            )
        crash_text = crash_errors[0]
        if crash_text != "BreadBoard session closed":
            raise JourneyFailure(
                f"crash projection used an unexpected sanitized error: {crash_text!r}"
            )
        assert_no_forbidden_paths(
            crash_text, [*forbidden_roots, bb.parent], "crash projection"
        )
        if "Traceback (most recent call last)" in crash_text:
            raise JourneyFailure("crash projection exposed a raw backend traceback")
        crash_cursor = cursor_sequence(crashed.data)
        initial.wait_until(
            lambda: (
                "BreadBoard permission request · run_shell" not in initial.screen.text()
                and "cli_mock/reference" in initial.screen.text()
            ),
            options.turn_timeout,
            "reconnected TUI readiness",
        )
        replacement_processes = {
            "bb": process_snapshot(initial.pid),
            "engine": process_snapshot(int(replacement_authority["pid"])),
        }
        replacement_process_text = json.dumps(replacement_processes, sort_keys=True)
        assert_no_forbidden_paths(
            replacement_process_text,
            [*forbidden_roots, host_agent_root],
            "replacement process snapshot",
        )
        assert_loopback_network(replacement_processes, "replacement process snapshot")
        replacement_current = active_authority(roots["agent"])
        replacement_environment = process_environment_contains(
            int(replacement_authority["pid"]), secret_canary
        )
        write_json(
            output / "replacement-authority.json",
            {
                "selected": replacement_identity,
                "selectedAlive": process_alive(int(replacement_authority["pid"])),
                "current": (
                    authority_identity(replacement_current[1])
                    if replacement_current is not None
                    else None
                ),
                "environmentReadable": replacement_environment is not None,
            },
        )
        if replacement_environment is None:
            raise JourneyFailure("replacement engine died before readiness evidence")
        if replacement_environment:
            raise JourneyFailure("replacement engine inherited the secret canary")
        replacement_engine_canary_absent = True
        write_capture(output, "engine-reconnected", initial)

        initial.send_line(RECONNECT_PROMPT)
        record_action("submit-reconnect-turn", prompt=RECONNECT_PROMPT)
        (
            (_, reconnect_state, _),
            reconnect_approvals,
        ) = wait_for_terminal_state_with_permissions(
            initial,
            roots["agent"],
            4,
            options.turn_timeout,
            "post-reconnect terminal turn",
            "completed",
        )
        if "run_shell" not in reconnect_approvals:
            raise JourneyFailure(
                f"post-reconnect turn did not request run_shell approval: {reconnect_approvals}"
            )
        for tool in reconnect_approvals:
            record_action("allow-reconnect-permission", tool=tool)
        reconnect_turn_id = str(reconnect_state["turns"][-1].get("turn_id") or "")
        if not reconnect_turn_id:
            raise JourneyFailure("post-reconnect turn is missing durable identity")

        def reconnect_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or not any(
                str(submission.get("turnId")) == reconnect_turn_id
                for submission in owned_submissions(snapshot.data)
            ):
                return None
            facts = transcript_facts(snapshot.rows)
            if cursor_sequence(snapshot.data) <= crash_cursor:
                return None
            if tuple(facts["toolCalls"][-3:]) != SYNTHETIC_TOOLS:
                return None
            if tuple(facts["toolResults"][-3:]) != SYNTHETIC_TOOLS:
                return None
            return snapshot

        reconnected = initial.wait_until(
            reconnect_turn_ready,
            options.turn_timeout,
            "post-reconnect projected terminal turn",
        )
        assert isinstance(reconnected, BindingSnapshot)
        reconnected_facts = transcript_facts(reconnected.rows)
        if reconnected_facts["completionSentinelCount"] != 0:
            raise JourneyFailure(
                "post-reconnect completion sentinel reached the TUI transcript"
            )
        write_capture(output, "post-reconnect-completed", initial)

        record_action("exit-initial-tui", command="/exit")
        initial.send_line("/exit")
        initial_exit = initial.wait_for_exit(60)
        write_capture(output, "initial-exit", initial)
        if initial_exit != 0:
            raise JourneyFailure(f"initial bb exit was {initial_exit}")
    finally:
        initial.close()

    final_initial = binding_snapshot(roots["agent"])
    if final_initial is None:
        raise JourneyFailure("binding disappeared after initial exit")
    if final_initial.data.get("sessionId") != synthetic_session_id:
        raise JourneyFailure("fresh synthetic session binding was not retained after exit")
    final_initial_cursor = cursor_sequence(final_initial.data)
    initial_owned = owned_submissions(final_initial.data)
    final_initial_facts = transcript_facts(final_initial.rows)
    if len(initial_owned) != 4 or final_initial_cursor < cursor_sequence(
        reconnected.data
    ):
        raise JourneyFailure(
            "initial close regressed the durable post-reconnect cursor"
        )
    for field in ("clientMessageId", "inputId", "turnId"):
        values = [item.get(field) for item in initial_owned]
        if len(values) != 4 or len(set(values)) != 4:
            raise JourneyFailure(
                f"owned submissions do not have four unique {field} values"
            )
    for authority in (first_authority, crash_authority, replacement_authority):
        if process_alive(int(authority["pid"])):
            raise JourneyFailure("a managed engine PID remains alive after TUI close")
    if endpoint_open(str(replacement_authority["normalizedEndpoint"])):
        raise JourneyFailure("replacement engine listener remains open after TUI close")
    if active_authority(roots["agent"]) is not None:
        raise JourneyFailure("active authority remains after initial close")
    if extraction_roots(roots["temp"]):
        raise JourneyFailure("initial engine extraction root remains after close")
    if ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots:
        raise JourneyFailure("initial ephemeral Ray runtime root remains after close")

    state_path, retained_state, retained_bytes_before_restart = load_retained_state(
        roots["agent"]
    )
    state_paths_before_restart = {
        path.resolve() for path in roots["agent"].rglob("session-state/*.json")
    }
    if retained_state.get("schema_version") != "bb.cli_bridge.session_state.v1":
        raise JourneyFailure("retained state has the wrong schema")
    turns = retained_state.get("turns")
    envelopes = retained_state.get("terminal_event_envelopes")
    if not isinstance(turns, list) or len(turns) != 4:
        raise JourneyFailure("retained state does not have exactly four turns")
    if not isinstance(envelopes, list) or len(envelopes) != 4:
        raise JourneyFailure(
            "retained state does not have exactly four terminal envelopes"
        )
    if any(turn.get("terminal_resolution_committed") is not True for turn in turns):
        raise JourneyFailure("retained turns are not terminally committed")
    terminal_outcomes = [turn.get("terminal_outcome") for turn in turns]
    if terminal_outcomes != [
        "completed",
        "cancelled",
        "failed",
        "completed",
    ]:
        raise JourneyFailure(
            f"retained turns have unexpected terminal outcomes: {terminal_outcomes}"
        )
    state_session = retained_state.get("session")
    if not isinstance(state_session, dict) or state_session.get(
        "session_id"
    ) != final_initial.data.get("sessionId"):
        raise JourneyFailure("retained state and binding disagree on session identity")
    state_event_sequence = state_session.get("event_seq")
    if (
        type(state_event_sequence) is not int
        or state_event_sequence < final_initial_cursor
    ):
        raise JourneyFailure("retained state head regressed the durable binding cursor")
    if state_session.get("model") != "cli_mock/reference":
        raise JourneyFailure(
            f"retained session lost the selected synthetic model: {state_session.get('model')!r}"
        )
    model_role_lock = state_session.get("model_role_lock")
    if model_role_lock is not None:
        model_role_text = json.dumps(model_role_lock, sort_keys=True)
        if (
            not isinstance(model_role_lock, dict)
            or '"kind": "synthetic"' not in model_role_text
            or '"source": "synthetic"' not in model_role_text
        ):
            raise JourneyFailure(
                f"retained synthetic model role lock is invalid: {model_role_text}"
            )
        if re.search(
            r'"(?:account|secret|credential_ref)"\s*:\s*"(?!none\b)',
            model_role_text,
        ):
            raise JourneyFailure(
                "retained synthetic model role lock contains account or secret material"
            )
    retained_text = retained_bytes_before_restart.decode("utf-8")
    for prompt in (
        FIRST_PROMPT,
        SECOND_PROMPT,
        SYNTHETIC_PROMPT,
        CANCEL_PROMPT,
        CRASH_PROMPT,
        RECONNECT_PROMPT,
    ):
        if prompt in retained_text:
            raise JourneyFailure("retained engine state contains raw prompt text")
    if secret_canary in retained_text:
        raise JourneyFailure("retained engine state contains the secret canary")
    assert_no_forbidden_paths(
        retained_text, [*forbidden_roots, bb.parent], "retained engine state"
    )

    status, status_identity, manifest_path = installed_status(
        bb,
        roots["workspace"],
        environment,
        "engine status after initial exit",
    )
    (output / "engine-status.json").write_text(
        json.dumps(
            {
                "exitCode": status.returncode,
                "stdout": status.stdout,
                "stderr": status.stderr,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    if (
        status_identity != preflight_status_identity
        or status.stdout != preflight_status.stdout
        or manifest_path != preflight_manifest_path
    ):
        raise JourneyFailure("initial journey changed the installed status identity")
    status_text = json.dumps(status_identity, sort_keys=True)
    for unsafe in (
        str(bb.parent),
        str(roots["home"]),
        str(roots["agent"]),
        str(roots["config"]),
    ):
        if unsafe in status_text:
            raise JourneyFailure("status identity contains a local path")

    resume = PtyChild(
        [str(bb), "--resume", str(final_initial.session_file)],
        roots["workspace"],
        timing_environment(environment),
        rows=options.rows,
        columns=options.cols,
    )
    resume_tui_pid = resume.pid
    try:

        def resume_ready() -> tuple[Path, dict[str, Any]] | None:
            authority = active_authority(roots["agent"])
            if authority is None or authority[1].get(
                "launchId"
            ) == replacement_authority.get("launchId"):
                return None
            restored_assistant = final_initial_facts["assistantTexts"][-1]
            if restored_assistant not in normalized_transcript(bytes(resume.raw)):
                return None
            snapshot = binding_snapshot(roots["agent"])
            if (
                snapshot is None
                or snapshot.session_file != final_initial.session_file
                or snapshot.data.get("sessionId")
                == final_initial.data.get("sessionId")
                or snapshot.data.get("previousSessionId")
                != final_initial.data.get("sessionId")
                or snapshot.data.get("replayConfigurationDigest")
                != final_initial.data.get("replayConfigurationDigest")
                or owned_submissions(snapshot.data)
                or cursor_sequence(snapshot.data) <= 0
                or transcript_facts(snapshot.rows) != final_initial_facts
            ):
                return None
            return authority

        _, second_authority = resume.wait_until(
            resume_ready, options.startup_timeout, "resume read-back"
        )
        if not endpoint_open(str(second_authority["normalizedEndpoint"])):
            raise JourneyFailure("resumed engine listener is not open")
        for field in (
            "engineInstanceId",
            "engineBootId",
            "launchId",
            "pid",
            "osProcessStartToken",
        ):
            if second_authority.get(field) == replacement_authority.get(field):
                raise JourneyFailure(f"process restart did not change {field}")
        if second_authority.get("normalizedEndpoint") != replacement_authority.get(
            "normalizedEndpoint"
        ):
            raise JourneyFailure("process restart changed the managed endpoint")
        during_resume_extractions = extraction_roots(roots["temp"])
        if (
            len(during_resume_extractions) != 1
            or during_resume_extractions == during_initial_extractions
        ):
            raise JourneyFailure("restart did not use one new extraction identity")
        during_resume_ray_roots = (
            ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots
        )
        if (
            len(during_resume_ray_roots) != 1
            or during_resume_ray_roots == during_initial_ray_roots
        ):
            raise JourneyFailure("restart did not use one new ephemeral Ray root")
        resume_ray_runtime = ray_runtime_snapshot(next(iter(during_resume_ray_roots)))
        second_processes = {
            "bb": process_snapshot(resume.pid),
            "engine": process_snapshot(int(second_authority["pid"])),
        }
        assert_no_forbidden_paths(
            json.dumps(second_processes, sort_keys=True),
            [*forbidden_roots, host_agent_root],
            "resume process snapshot",
        )
        assert_loopback_network(second_processes, "resume process snapshot")
        if process_environment_contains(int(second_authority["pid"]), secret_canary):
            raise JourneyFailure("resumed engine inherited the secret canary")
        resume_engine_canary_absent = True
        write_capture(output, "resume-readback", resume)
        resume.send_line(POST_RESUME_PROMPT)
        record_action("submit-post-resume-turn", prompt=POST_RESUME_PROMPT)
        (
            (_, post_resume_state, _),
            post_resume_approvals,
        ) = wait_for_terminal_state_with_permissions(
            resume,
            roots["agent"],
            1,
            options.turn_timeout,
            "post-resume terminal turn",
            "completed",
        )
        if "run_shell" not in post_resume_approvals:
            raise JourneyFailure(
                f"post-resume turn did not request run_shell approval: {post_resume_approvals}"
            )
        for tool in post_resume_approvals:
            record_action("allow-post-resume-permission", tool=tool)
        post_resume_turn_id = str(post_resume_state["turns"][-1].get("turn_id") or "")
        if not post_resume_turn_id:
            raise JourneyFailure("post-resume turn is missing durable identity")

        def post_resume_turn_ready() -> BindingSnapshot | None:
            snapshot = binding_snapshot(roots["agent"])
            if snapshot is None or not any(
                str(submission.get("turnId")) == post_resume_turn_id
                for submission in owned_submissions(snapshot.data)
            ):
                return None
            facts = transcript_facts(snapshot.rows)
            if cursor_sequence(snapshot.data) <= 0:
                return None
            if tuple(facts["toolCalls"][-3:]) != SYNTHETIC_TOOLS:
                return None
            if tuple(facts["toolResults"][-3:]) != SYNTHETIC_TOOLS:
                return None
            return snapshot

        post_resume = resume.wait_until(
            post_resume_turn_ready,
            options.turn_timeout,
            "post-resume projected terminal turn",
        )
        assert isinstance(post_resume, BindingSnapshot)
        write_capture(output, "post-resume-completed", resume)
        record_action("exit-resumed-tui", command="/exit")
        resume.send_line("/exit")
        resume_exit = resume.wait_for_exit(60)
        write_capture(output, "resume-exit", resume)
        if resume_exit != 0:
            raise JourneyFailure(f"resumed bb exit was {resume_exit}")
    finally:
        resume.close()

    final_resume = binding_snapshot(roots["agent"])
    if final_resume is None:
        raise JourneyFailure("durable binding disappeared after post-resume turn")
    if (
        final_resume.data.get("sessionId") == final_initial.data.get("sessionId")
        or final_resume.data.get("previousSessionId")
        != final_initial.data.get("sessionId")
        or final_resume.data.get("replayConfigurationDigest")
        != final_initial.data.get("replayConfigurationDigest")
        or len(owned_submissions(final_resume.data)) != 1
        or cursor_sequence(final_resume.data) <= 0
    ):
        raise JourneyFailure(
            "post-resume turn did not advance through an explicit fresh-session successor"
        )
    successor_state_path, retained_state_after, retained_bytes_after_restart = (
        load_retained_state(roots["agent"])
    )
    state_paths_after_restart = {
        path.resolve() for path in roots["agent"].rglob("session-state/*.json")
    }
    if (
        state_paths_after_restart - state_paths_before_restart
        != {successor_state_path}
        or successor_state_path == state_path
        or state_path.read_bytes() != retained_bytes_before_restart
    ):
        raise JourneyFailure(
            "terminal successor did not preserve one immutable predecessor state"
        )
    successor_turns = retained_state_after.get("turns")
    successor_envelopes = retained_state_after.get("terminal_event_envelopes")
    if not isinstance(successor_turns, list) or len(successor_turns) != 1:
        raise JourneyFailure("post-resume successor state does not have exactly one turn")
    if not isinstance(successor_envelopes, list) or len(successor_envelopes) != 1:
        raise JourneyFailure(
            "post-resume successor state does not have exactly one terminal envelope"
        )
    successor_session = retained_state_after.get("session")
    successor_submission = retained_state_after.get("submissions")
    final_submission = owned_submissions(final_resume.data)[0]
    expected_session_id = str(final_resume.data["sessionId"])
    expected_turn_id = str(final_submission["turnId"])
    expected_input_id = str(final_submission["inputId"])
    successor_turn = successor_turns[0]
    if not isinstance(successor_turn, dict):
        raise JourneyFailure("post-resume successor turn is not an object")
    successor_envelope = successor_envelopes[0]
    if not isinstance(successor_envelope, dict):
        raise JourneyFailure("post-resume successor terminal envelope is not an object")
    successor_payload = successor_envelope.get("payload")
    if (
        not isinstance(successor_session, dict)
        or successor_session.get("session_id") != expected_session_id
        or successor_session.get("event_seq") != cursor_sequence(final_resume.data)
        or successor_session.get("replay_head_sequence")
        != cursor_sequence(final_resume.data)
        or not isinstance(successor_submission, list)
        or len(successor_submission) != 1
        or successor_submission[0].get("turn_id") != expected_turn_id
        or successor_submission[0].get("input_id") != expected_input_id
        or successor_turn.get("turn_id") != expected_turn_id
        or successor_turn.get("input_id") != expected_input_id
        or successor_envelope.get("session_id") != expected_session_id
        or successor_envelope.get("turn_id") != expected_turn_id
        or successor_envelope.get("input_id") != expected_input_id
        or successor_envelope.get("type") != "turn_completed"
        or successor_envelope.get("protocol_version") != "1.0"
        or successor_envelope.get("stable_cursor") is not True
        or not isinstance(successor_payload, dict)
        or successor_payload.get("finish_reason") != "stop"
        or successor_payload.get("output_emitted") is not True
    ):
        raise JourneyFailure(
            "post-resume retained state does not match the successor binding lineage"
        )
    if successor_turns[0].get("terminal_outcome") != "completed":
        raise JourneyFailure("post-resume successor turn is not durably completed")
    if retained_bytes_after_restart == retained_bytes_before_restart:
        raise JourneyFailure("post-resume successor reused predecessor state bytes")
    turns_after = [*turns, *successor_turns]
    envelopes_after = [*envelopes, *successor_envelopes]
    if process_alive(int(second_authority["pid"])):
        raise JourneyFailure("resumed engine PID remains alive after TUI close")
    if endpoint_open(str(second_authority["normalizedEndpoint"])):
        raise JourneyFailure("resumed engine listener remains open after TUI close")
    if active_authority(roots["agent"]) is not None:
        raise JourneyFailure("active authority remains after resumed close")
    if extraction_roots(roots["temp"]):
        raise JourneyFailure("resumed engine extraction root remains after close")
    if ray_runtime_roots(roots["temp"]) - baseline_ray_runtime_roots:
        raise JourneyFailure("resumed ephemeral Ray runtime root remains after close")
    network_audit_stderr = stop_network_audit(
        network_audit_process, network_audit_stream
    )
    atexit.unregister(stop_network_audit_at_exit)
    network_observation = analyze_network_audit(
        network_audit_raw,
        output / "network-observation.csv",
        {
            int(crash_authority["pid"]),
            provider_free_tui_pid,
            synthetic_tui_pid,
            int(first_authority["pid"]),
            int(replacement_authority["pid"]),
            resume_tui_pid,
            int(second_authority["pid"]),
        },
        network_audit_stderr,
    )
    write_json(output / "network-observation.json", network_observation)

    restart_status, restart_status_identity, _ = installed_status(
        bb,
        roots["workspace"],
        environment,
        "engine status after resume",
    )
    (output / "engine-status-after-resume.json").write_text(
        json.dumps(
            {
                "exitCode": restart_status.returncode,
                "stdout": restart_status.stdout,
                "stderr": restart_status.stderr,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    if restart_status_identity != status_identity:
        raise JourneyFailure(
            "restart changed the installed distribution or profile identity"
        )
    if restart_status.stdout != status.stdout:
        raise JourneyFailure("restart changed the canonical installed status bytes")
    post_status_binding = binding_snapshot(roots["agent"])
    if post_status_binding is None or post_status_binding.data != final_resume.data:
        raise JourneyFailure("engine status changed the durable session binding")
    if active_authority(roots["agent"]) is not None or extraction_roots(roots["temp"]):
        raise JourneyFailure("engine status spawned managed engine state")
    tamper_results = []
    write_json(
        output / "tamper-failures.json",
        {
            "schemaVersion": "bb.installed_tamper_failures.v1",
            "status": "pass",
            "cases": tamper_results,
        },
    )
    facts = transcript_facts(final_resume.rows)
    expected_prompts = [
        SYNTHETIC_PROMPT,
        CANCEL_PROMPT,
        CRASH_PROMPT,
        RECONNECT_PROMPT,
        POST_RESUME_PROMPT,
    ]
    if facts["userTexts"] != expected_prompts:
        raise JourneyFailure(
            f"OMP transcript has unexpected submitted prompts: {facts['userTexts']}"
        )
    if facts["assistantTexts"].count(ASSISTANT_SENTINEL) != 0:
        raise JourneyFailure(
            "synthetic transcript unexpectedly retained provider-free assistant text"
        )
    if facts["completionSentinelCount"] != 0:
        raise JourneyFailure(
            "control-only completion sentinel reached the durable TUI transcript"
        )
    expected_tool_calls = list(SYNTHETIC_TOOLS) * 5
    expected_tool_results = (
        list(SYNTHETIC_TOOLS)
        + list(SYNTHETIC_TOOLS[:2])
        + list(SYNTHETIC_TOOLS[:2])
        + list(SYNTHETIC_TOOLS)
        + list(SYNTHETIC_TOOLS)
    )
    if facts["toolCalls"] != expected_tool_calls:
        raise JourneyFailure(
            f"OMP transcript has unexpected tool calls: {facts['toolCalls']}"
        )
    if facts["toolResults"] != expected_tool_results:
        raise JourneyFailure(
            f"OMP transcript has unexpected tool results: {facts['toolResults']}"
        )
    shell_results = [
        row for row in facts["toolResultRows"] if row["name"] == "run_shell"
    ]
    if len(shell_results) != 3 or any(
        row["isError"] or "[1, 2, 3, 4, 5]" not in row["content"]
        for row in shell_results
    ):
        raise JourneyFailure(
            f"installed shell validations did not succeed exactly three times: {shell_results}"
        )
    tool_receipt_evidence = validate_tool_receipts(facts)
    session_text = final_resume.session_file.read_text(encoding="utf-8")
    if secret_canary in session_text:
        raise JourneyFailure("OMP JSONL contains the secret canary")
    assert_no_forbidden_paths(session_text, [*forbidden_roots, bb.parent], "OMP JSONL")

    final_binding_history = validate_binding_history(final_resume.rows)
    event_journal_paths, event_journal_rows = session_event_journals(
        roots["agent"], set(final_binding_history["sessionIds"])
    )
    event_kinds: dict[str, int] = {}
    for event in event_journal_rows:
        kind = event.get("kind")
        if (
            not isinstance(kind, str)
            or not kind
            or "unknown" in kind
            or "legacy" in kind
        ):
            raise JourneyFailure(
                f"retained session event journal contains an invalid event family: {kind}"
            )
        event_kinds[kind] = event_kinds.get(kind, 0) + 1
        payload = event.get("payload")
        if isinstance(payload, dict):
            for key, value in payload.items():
                if key.endswith(("_hash", "_sha256")) and (
                    not isinstance(value, str)
                    or re.fullmatch(r"sha256:[0-9a-f]{64}", value) is None
                ):
                    raise JourneyFailure(
                        f"retained session event {kind} has an invalid digest field {key}"
                    )
    for envelope in envelopes_after:
        if (
            not isinstance(envelope.get("id"), str)
            or EVENT_ID_RE.fullmatch(envelope["id"]) is None
        ):
            raise JourneyFailure(
                "retained terminal envelope has an invalid event identity"
            )
    native_auth_counts = native_auth_row_counts(roots["agent"])
    for table in (
        "auth_credentials",
        "auth_credential_blocks",
        "auth_credential_refresh_leases",
    ):
        if native_auth_counts.get(table, 0) != 0:
            raise JourneyFailure(f"native OMP AuthStorage mutated {table}")
    credential_rows = sum(
        native_auth_counts.get(table, 0)
        for table in (
            "auth_credentials",
            "auth_credential_blocks",
            "auth_credential_refresh_leases",
        )
    )
    browser_launch_attempts = (
        len(browser_marker.read_text(encoding="utf-8").splitlines())
        if browser_marker.is_file()
        else 0
    )
    if browser_launch_attempts != 0:
        raise JourneyFailure("installed product attempted an OAuth browser launch")
    retained_session = retained_state_after.get("session")
    synthetic_evidence_only = (
        isinstance(retained_session, dict)
        and retained_session.get("model") == "cli_mock/reference"
        and credential_rows == 0
    )
    if not synthetic_evidence_only:
        raise JourneyFailure(
            "configured route is not retained as credential-free synthetic evidence"
        )
    browser_observation["attemptCount"] = browser_launch_attempts
    provider_observation = {
        "schemaVersion": "bb.g6_provider_observation.v1",
        "status": "pass",
        "network": network_observation,
        "browser": browser_observation,
    }
    write_json(output / "provider-observation.json", provider_observation)

    binding_extract = {
        "schemaVersion": "bb.g6_binding_extract.v1",
        "status": "pass",
        "history": binding_history(final_resume.rows),
        "validation": final_binding_history,
    }
    event_extract = {
        "schemaVersion": "bb.g6_session_event_extract.v1",
        "status": "pass",
        "paths": [str(path) for path in event_journal_paths],
        "events": event_journal_rows,
        "eventKinds": event_kinds,
    }
    process_timeline = {
        "schemaVersion": "bb.g6_process_authority_timeline.v1",
        "status": "pass",
        "initialAuthority": first_authority,
        "crashAuthority": crash_authority,
        "replacementAuthority": replacement_authority,
        "resumeAuthority": second_authority,
        "authenticatedCrash": {
            "authorityPath": str(crash_authority_path),
            "identity": crash_identity,
            "descendantsBeforeCrash": descendants_before_crash,
        },
        "replacementIdentity": replacement_identity,
        "processes": {
            "initial": first_processes,
            "replacement": replacement_processes,
            "resume": second_processes,
        },
    }
    provider_evidence = {
        "schemaVersion": "bb.g6_provider_role_evidence.v1",
        "status": "pass",
        "providerFreeModel": "mock/reference",
        "configuredModel": "cli_mock/reference",
        "modelRoleLock": model_role_lock,
        "nativeAuthRowCounts": native_auth_counts,
        "providerRequests": network_observation["nonLoopbackConnectionCount"],
        "credentialRows": credential_rows,
        "oauthBrowserLaunches": browser_launch_attempts,
        "syntheticEvidenceOnly": synthetic_evidence_only,
        "isolationObservation": provider_observation,
    }
    write_json(output / "binding-extract.json", binding_extract)
    write_json(output / "engine-event-extract.json", event_extract)
    write_json(output / "process-authority-timeline.json", process_timeline)
    write_json(output / "provider-role-evidence.json", provider_evidence)
    write_json(output / "retained-state-extract.json", retained_state_after)
    write_json(output / "ui-action-trace.json", action_trace)

    cleanup = {
        "initialPidDead": True,
        "crashedPidDead": True,
        "replacementPidDead": True,
        "resumePidDead": True,
        "initialListenerClosed": True,
        "replacementListenerClosed": True,
        "resumeListenerClosed": True,
        "initialExtractionRemoved": True,
        "initialRayRuntimeRemoved": True,
        "resumeExtractionRemoved": True,
        "resumeRayRuntimeRemoved": True,
        "activeAuthorityAbsent": True,
        "durableStateRetained": True,
        "knownManagedPidsDead": all(
            not process_alive(int(authority["pid"]))
            for authority in (
                first_authority,
                crash_authority,
                replacement_authority,
                second_authority,
            )
        ),
    }
    if not cleanup["knownManagedPidsDead"]:
        raise JourneyFailure("one known managed process remains alive after final exit")
    managed_pids = sorted(
        {
            provider_free_tui_pid,
            synthetic_tui_pid,
            resume_tui_pid,
            int(first_authority["pid"]),
            int(crash_authority["pid"]),
            int(replacement_authority["pid"]),
            int(second_authority["pid"]),
        }
    )
    final_process_snapshots = {
        str(pid): process_snapshot(pid) for pid in managed_pids
    }
    final_listener_snapshot = listener_snapshot(
        str(second_authority["normalizedEndpoint"])
    )
    summary = {
        "schemaVersion": "bb.installed_g6_journey.v1",
        "status": "pass",
        "bb": str(bb),
        "artifactIdentity": {
            "schemaVersion": "bb.installed_g6_artifact_identity.v1",
            "tuiSourceCommit": options.tui_source_commit,
            "tuiSourceTree": options.tui_source_tree,
            "bb": {
                "path": str(bb),
                "sizeBytes": bb.stat().st_size,
                "sha256": f"sha256:{sha256_file(bb)}",
            },
            "piNatives": {
                "path": str(pi_natives),
                "sizeBytes": pi_natives.stat().st_size,
                "sha256": f"sha256:{sha256_file(pi_natives)}",
            },
            "sdkArtifact": {
                "path": str(sdk_artifact),
                "sizeBytes": sdk_artifact.stat().st_size,
                "sha256": f"sha256:{sha256_file(sdk_artifact)}",
            },
            "sdkProvenance": {
                "path": str(sdk_provenance),
                "sizeBytes": sdk_provenance.stat().st_size,
                "sha256": f"sha256:{sha256_file(sdk_provenance)}",
            },
        },
        "environmentKeys": sorted(environment),
        "manualEngineOrSessionConfiguration": False,
        "sessionFile": str(final_resume.session_file),
        "providerFreeSessionId": initial_session_id,
        "syntheticSessionId": synthetic_session_id,
        "sessionId": final_resume.data["sessionId"],
        "preTurnBindingPresent": False,
        "preflightStatusIdentity": preflight_status_identity,
        "preflightRuntimeStateAbsent": True,
        "cursors": {
            "first": first_cursor,
            "second": cursor_sequence(second.data),
            "synthetic": synthetic_cursor,
            "cancelled": cancelled_cursor,
            "crashed": crash_cursor,
            "beforeResume": final_initial_cursor,
            "final": cursor_sequence(final_resume.data),
        },
        "ownedSubmissions": owned_submissions(final_resume.data),
        "transcript": facts,
        "toolReceiptValidation": tool_receipt_evidence,
        "bindingValidation": final_binding_history,
        "createdFiles": [
            *[str((roots["workspace"] / name).resolve()) for name in EXPECTED_FILES],
            str(bubble_sort.resolve()),
        ],
        "statePath": str(state_path),
        "successorStatePath": str(successor_state_path),
        "retainedStatePaths": sorted(str(path) for path in state_paths_after_restart),
        "retainedTurnCount": len(turns_after),
        "retainedTerminalEnvelopeCount": len(envelopes_after),
        "terminalOutcomes": [turn.get("terminal_outcome") for turn in turns_after],
        "statusIdentity": status_identity,
        "manifestPath": str(manifest_path.resolve()),
        "authorities": {
            "initial": authority_identity(first_authority),
            "crash": crash_identity,
            "replacement": replacement_identity,
            "resume": authority_identity(second_authority),
        },
        "initialExtractionRoots": during_initial_extractions,
        "resumeExtractionRoots": during_resume_extractions,
        "initialRayRuntime": initial_ray_runtime,
        "resumeRayRuntime": resume_ray_runtime,
        "cleanup": cleanup,
        "finalCleanupEvidence": {
            "managedPids": managed_pids,
            "processSnapshots": final_process_snapshots,
            "listener": final_listener_snapshot,
            "activeAuthority": active_authority(roots["agent"]),
            "extractionRoots": extraction_roots(roots["temp"]),
            "rayRuntimeRoots": sorted(
                str(path)
                for path in ray_runtime_roots(roots["temp"])
                - baseline_ray_runtime_roots
            ),
        },
        "providerIsolation": {
            "providerCalls": network_observation["nonLoopbackConnectionCount"] != 0,
            "loopbackOnlyNetwork": network_observation["loopbackOnly"],
            "nativeAuthMutation": credential_rows != 0,
            "oauthBrowserLaunches": browser_launch_attempts,
            "secretCanaryAbsentFromEngineEnvironments": (
                initial_engine_canary_absent
                and replacement_engine_canary_absent
                and resume_engine_canary_absent
            ),
        },
        "sourceCheckoutPathsAbsent": True,
        "hostAgentPathsAbsent": True,
        "tamperFailures": tamper_results,
    }
    canary_bytes = secret_canary.encode("utf-8")
    scan_roots = (output, roots["agent"], roots["config"], roots["workspace"])
    for scan_root in scan_roots:
        for evidence_file in scan_root.rglob("*"):
            if not evidence_file.is_file() or evidence_file.is_symlink():
                continue
            with evidence_file.open("rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    if canary_bytes in chunk:
                        raise JourneyFailure(
                            f"secret canary leaked into {evidence_file}"
                        )
    write_json(output / "journey-summary.json", summary)
    print(
        json.dumps(
            {
                "status": "pass",
                "sessionId": summary["sessionId"],
                "cursor": cursor_sequence(final_resume.data),
            }
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except JourneyFailure as error:
        print(f"installed journey failed: {error}", file=sys.stderr)
        raise SystemExit(1)
