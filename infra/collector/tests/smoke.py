"""End-to-end check of infra/collector/config.yaml with the pinned collector image (ADR-184).

Substitute test for LAUNCH.md E: no Grafana Cloud or R2 account is needed. Two local fakes
stand in for them, and the real collector runs the real config exactly as Railway starts it
(`--entrypoint /otelcol-contrib`, `--config=env:OTELCOL_CONFIG`):

- a fake Grafana OTLP gateway that accepts only `Authorization: Basic base64(id:token)`;
- a fake S3 endpoint (path-style, like R2) that stores every PUT.

The check proves: `validate` accepts the config and rejects a broken one; the health check
answers on /healthz; traces, metrics and logs reach "Grafana" with basic auth and the
environment attribute; only logs reach the archive, gzip-compressed OTLP JSON under
<environment>/logs/year=.../; and the scrubbed headers never leave the collector.

Usage: python3 infra/collector/tests/smoke.py <collector image@sha256:...>
Needs Docker. Uses only the Python standard library.
"""

from __future__ import annotations

import base64
import gzip
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

CONFIG = Path(__file__).resolve().parent.parent / "config.yaml"
CONTAINER = f"ws9-collector-{uuid.uuid4().hex[:8]}"
INSTANCE_ID = "123456"
TOKEN = "ci-only-token"
BUCKET = "rampsmith-logs-ci"
ENVIRONMENT = "ci"
HEALTH_URL = "http://127.0.0.1:13133/healthz"
OTLP_URL = "http://127.0.0.1:4318"

received_otlp: list[tuple[str, str, bytes]] = []  # (path, authorization, body)
received_objects: dict[str, bytes] = {}
lock = threading.Lock()


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def maybe_gunzip(body: bytes, encoding: str | None) -> bytes:
    if encoding == "gzip" or body[:2] == b"\x1f\x8b":
        return gzip.decompress(body)
    return body


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        sys.stderr.write("fake: " + (format % args) + "\n")

    def read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def reply(self, status: int, body: bytes = b"", content_type: str = "text/plain") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if status == 200 and self.command == "PUT":
            self.send_header("ETag", '"' + uuid.uuid4().hex + '"')
        self.end_headers()
        if body:
            self.wfile.write(body)


class FakeGrafana(Handler):
    def do_POST(self) -> None:
        body = maybe_gunzip(self.read_body(), self.headers.get("Content-Encoding"))
        authorization = self.headers.get("Authorization") or ""
        with lock:
            received_otlp.append((self.path, authorization, body))
        expected = "Basic " + base64.b64encode(f"{INSTANCE_ID}:{TOKEN}".encode()).decode()
        if authorization != expected:
            self.reply(401, b"bad credentials")
            return
        # An empty protobuf Export*ServiceResponse is a full success.
        self.reply(200, b"", "application/x-protobuf")


class FakeS3(Handler):
    def do_PUT(self) -> None:
        body = self.read_body()
        prefix = f"/{BUCKET}/"
        if not self.path.startswith(prefix):
            self.reply(404, b"NoSuchBucket")
            return
        with lock:
            received_objects[self.path[len(prefix) :]] = body
        self.reply(200)

    def do_POST(self) -> None:
        self.read_body()
        self.reply(501, b"multipart uploads are not expected for small batches")


def serve(handler: type[Handler]) -> tuple[ThreadingHTTPServer, int]:
    port = free_port()
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


def docker(*args: str, check: bool = True, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=False, env=env
    )
    if check and result.returncode != 0:
        raise SystemExit(f"docker {args[0]} failed:\n{result.stdout}\n{result.stderr}")
    return result.stdout + result.stderr


def env_args(values: dict[str, str]) -> list[str]:
    args: list[str] = []
    for key in values:
        # Values travel through the environment, never the command line.
        args += ["--env", key]
    return args


def wait_for(description: str, predicate: Any, timeout: float = 60.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(1)
    raise AssertionError(f"timed out waiting for {description}")


def post_json(path: str, payload: dict[str, Any]) -> None:
    request = urllib.request.Request(
        OTLP_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        if response.status != 200:
            raise AssertionError(f"collector answered {response.status} for {path}")


def resource(service: str) -> dict[str, Any]:
    return {"attributes": [{"key": "service.name", "value": {"stringValue": service}}]}


def main() -> int:
    if len(sys.argv) != 2 or "@sha256:" not in sys.argv[1]:
        print("usage: smoke.py <collector image pinned by digest>", file=sys.stderr)
        return 2
    image = sys.argv[1]
    config = CONFIG.read_text(encoding="utf-8")
    _, grafana_port = serve(FakeGrafana)
    _, s3_port = serve(FakeS3)
    values = {
        "OTELCOL_CONFIG": config,
        "GRAFANA_CLOUD_OTLP_ENDPOINT": f"http://127.0.0.1:{grafana_port}/otlp",
        "GRAFANA_CLOUD_OTLP_INSTANCE_ID": INSTANCE_ID,
        "GRAFANA_CLOUD_OTLP_TOKEN": TOKEN,
        "R2_ENDPOINT": f"http://127.0.0.1:{s3_port}",
        "R2_BUCKET_LOGS": BUCKET,
        "AWS_ACCESS_KEY_ID": "ci-access-key",
        "AWS_SECRET_ACCESS_KEY": "ci-secret-key",
        "AWS_REQUEST_CHECKSUM_CALCULATION": "when_required",
        "AWS_RESPONSE_CHECKSUM_VALIDATION": "when_required",
        "RAILWAY_ENVIRONMENT_NAME": ENVIRONMENT,
    }
    child_env = {**os.environ, **values}

    # 1. The pinned binary validates the real config and rejects a broken copy.
    print(docker("run", "--rm", *env_args(values), "--entrypoint", "/otelcol-contrib", image,
                 "validate", "--config=env:OTELCOL_CONFIG", env=child_env))
    broken = {**values, "OTELCOL_CONFIG": config.replace("s3_force_path_style", "s3_force_path")}
    result = subprocess.run(
        ["docker", "run", "--rm", *env_args(broken), "--entrypoint", "/otelcol-contrib", image,
         "validate", "--config=env:OTELCOL_CONFIG"],
        capture_output=True, text=True, check=False, env={**os.environ, **broken},
    )
    if result.returncode == 0:
        raise AssertionError("validate accepted a config with an unknown awss3 field")
    print("validate rejects an unknown field, as expected")

    # 2. Run it the way Railway does.
    docker("run", "-d", "--name", CONTAINER, "--network", "host", *env_args(values),
           "--entrypoint", "/otelcol-contrib", image, "--config=env:OTELCOL_CONFIG",
           env=child_env)
    try:
        def healthy() -> bool:
            try:
                with urllib.request.urlopen(HEALTH_URL, timeout=2) as response:
                    return bool(response.status == 200)
            except (urllib.error.URLError, OSError):
                return False

        wait_for("the health check on /healthz", healthy)
        print("health check answers 200 on /healthz")

        marker = uuid.uuid4().hex
        now = str(time.time_ns())
        post_json("/v1/logs", {"resourceLogs": [{
            "resource": resource("api"),
            "scopeLogs": [{"logRecords": [
                {"timeUnixNano": now, "severityText": "INFO",
                 "body": {"stringValue": f"log-{marker}"},
                 "attributes": [{"key": "http.request.header.authorization",
                                 "value": {"stringValue": f"Bearer secret-{marker}"}}]},
            ]}],
        }]})
        post_json("/v1/traces", {"resourceSpans": [{
            "resource": resource("api"),
            "scopeSpans": [{"spans": [{
                "traceId": uuid.uuid4().hex, "spanId": uuid.uuid4().hex[:16],
                "name": f"span-{marker}", "kind": 2,
                "startTimeUnixNano": now, "endTimeUnixNano": now,
                "attributes": [{"key": "http.request.header.cookie",
                                "value": {"stringValue": f"session=secret-{marker}"}}],
            }]}],
        }]})
        post_json("/v1/metrics", {"resourceMetrics": [{
            "resource": resource("api"),
            "scopeMetrics": [{"metrics": [{
                "name": f"metric_{marker}",
                "sum": {"aggregationTemporality": 2, "isMonotonic": True,
                        "dataPoints": [{"asInt": "1", "timeUnixNano": now}]},
            }]}],
        }]})

        def grafana_has(path: str, needle: str) -> bool:
            with lock:
                return any(p == path and needle.encode() in body for p, _, body in received_otlp)

        for path, needle in (("/otlp/v1/logs", f"log-{marker}"),
                             ("/otlp/v1/traces", f"span-{marker}"),
                             ("/otlp/v1/metrics", f"metric_{marker}")):
            wait_for(f"{path} at the fake Grafana", lambda p=path, n=needle: grafana_has(p, n))
            print(f"{path} reached Grafana")

        def archived() -> list[tuple[str, bytes]]:
            with lock:
                items = list(received_objects.items())
            return [(key, gzip.decompress(body)) for key, body in items]

        wait_for("a log object in the archive",
                 lambda: any(f"log-{marker}".encode() in body for _, body in archived()))
        with lock:
            authorizations = {auth for _, auth, _ in received_otlp}
            grafana_bodies = [body for _, _, body in received_otlp]
        objects = archived()

        expected_auth = "Basic " + base64.b64encode(f"{INSTANCE_ID}:{TOKEN}".encode()).decode()
        assert authorizations == {expected_auth}, "every export must carry the basic credentials"
        for key, body in objects:
            assert key.startswith(f"{ENVIRONMENT}/logs/year="), f"unexpected archive key {key}"
            json.loads(body)  # otlp_json
            assert f"span-{marker}".encode() not in body, "traces must not be archived"
            assert f"metric_{marker}".encode() not in body, "metrics must not be archived"
        for body in grafana_bodies + [body for _, body in objects]:
            assert f"secret-{marker}".encode() not in body, "a scrubbed header left the collector"
        assert any(b"deployment.environment.name" in body and ENVIRONMENT.encode() in body
                   for _, body in objects), "the environment attribute is missing"
        print(f"archive holds {len(objects)} gzip OTLP JSON object(s) under {ENVIRONMENT}/logs/")
        print("collector smoke test: PASS")
        return 0
    except BaseException:
        print(docker("logs", CONTAINER, check=False), file=sys.stderr)
        raise
    finally:
        docker("rm", "-f", CONTAINER, check=False)


if __name__ == "__main__":
    sys.exit(main())
