"""Local OpenAI-compatible model gateway.

Why it exists
-------------
The desktop app must never hand the provider credential to the engine, the
renderer or the command line.  The engine (BabelDOC) only speaks plain
OpenAI, while the configured provider in this environment (OpenCode Zen)
requires an extra ``x-opencode-session`` routing header and is faster when
reasoning is disabled.  A tiny loopback gateway solves both, and doubles as

* the place where token usage is accounted per request,
* the ``fake`` provider used by fault-injection tests (no network, no cost),
* the single choke point that can reject undocumented payloads.

Security: binds 127.0.0.1 only, requires the locally generated token in the
``Authorization`` header (the engine is given a dummy key that is checked
here), never logs prompts or the upstream key.

Run::

    python -m moonlight.gateway --upstream https://opencode.ai/zen/go/v1 \\
        --model qwen3.8-flash --key-env OPENCODE_GO_API_KEY --port 0

It prints one JSON line ``{"event": "ready", "base_url": ...}`` on stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import socket
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import httpx

MAX_BODY = 8 * 1024 * 1024


class UsageLog:
    def __init__(self, path: str | Path | None):
        self.path = Path(path) if path else None
        self._lock = threading.Lock()
        if self.path:
            self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, record: dict[str, Any]) -> None:
        if not self.path:
            return
        with self._lock:
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record, ensure_ascii=False) + "\n")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


class Gateway:
    def __init__(
        self,
        upstream: str,
        model: str | None,
        key: str,
        provider: str = "openai",
        log: UsageLog | None = None,
        session_id: str | None = None,
        request_timeout: float = 600.0,
        fake_sleep: float = 0.0,
    ):
        self.upstream = upstream.rstrip("/")
        self.model = model
        self.key = key
        self.provider = provider
        self.log = log or UsageLog(None)
        self.session_id = session_id or str(uuid.uuid4())
        self.request_timeout = request_timeout
        self.fake_sleep = fake_sleep
        self.client = httpx.Client(timeout=request_timeout, follow_redirects=False)

    # -- upstream ---------------------------------------------------------
    def _headers(self, incoming: dict[str, str]) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json",
            "Accept": incoming.get("Accept", "application/json"),
            "User-Agent": "moonlight-gateway/0.1",
        }
        # OpenCode Zen routes requests by session; harmless elsewhere.
        if "opencode.ai" in self.upstream:
            headers["x-opencode-session"] = self.session_id
        return headers

    def forward_chat(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if self.provider == "fake":
            return self._fake(payload)
        if payload.get("stream"):
            return 400, {"error": {"message": "streaming is not supported by the gateway", "type": "unsupported"}}
        body = dict(payload)
        if self.model:
            body["model"] = self.model
        # BabelDOC sends {"reasoning": {"effort": "none"}.  OpenAI-compatible
        # providers (including the configured OpenCode Go endpoint) only honour
        # the flat ``reasoning_effort`` field; without the mapping every
        # paragraph pays for hidden reasoning tokens and gets slower by ~20x.
        reasoning = body.pop("reasoning", None)
        if isinstance(reasoning, dict) and reasoning.get("effort"):
            body.setdefault("reasoning_effort", reasoning["effort"])
        elif isinstance(reasoning, str) and reasoning:
            body.setdefault("reasoning_effort", reasoning)
        started = time.time()
        try:
            resp = self.client.post(
                f"{self.upstream}/chat/completions",
                headers=self._headers({"Accept": "application/json"}),
                json=body,
            )
        except httpx.HTTPError as exc:
            self.log.write(
                {
                    "ts": _now(),
                    "event": "upstream_error",
                    "error": type(exc).__name__,
                    "message": str(exc)[:300],
                    "status": None,
                }
            )
            return 502, {"error": {"message": f"upstream error: {type(exc).__name__}", "type": "upstream_error"}}
        try:
            data = resp.json()
        except ValueError:
            data = {"error": {"message": resp.text[:500], "type": "invalid_upstream_json"}}
        usage = data.get("usage") if isinstance(data, dict) else None
        self.log.write(
            {
                "ts": _now(),
                "event": "chat",
                "model": body.get("model"),
                "status": resp.status_code,
                "elapsed_ms": int((time.time() - started) * 1000),
                "messages": len(body.get("messages") or []),
                "reasoning_effort": body.get("reasoning_effort"),
                "usage": usage,
            }
        )
        return resp.status_code, data

    def _fake(self, payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        """Deterministic provider used by protocol/fault tests (never billed)."""
        if self.fake_sleep:
            time.sleep(self.fake_sleep)
        text = ""
        for msg in reversed(payload.get("messages") or []):
            if msg.get("role") == "user":
                text = msg.get("content") or ""
                break
        if os.environ.get("MOONLIGHT_FAKE_EMPTY") == "1":
            content = ""
        elif os.environ.get("MOONLIGHT_FAKE_INVALID_JSON") == "1":
            content = "{not json"
        else:
            # Preserve any {v1}/{v2} placeholders BabelDOC expects verbatim.
            content = "【模拟译文】" + "".join(text.split())[:400]
        self.log.write(
            {
                "ts": _now(),
                "event": "fake_chat",
                "model": payload.get("model"),
                "status": 200,
                "chars": len(content),
            }
        )
        return 200, {
            "id": "chatcmpl-fake",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": payload.get("model") or "fake",
            "choices": [
                {
                    "index": 0,
                    "finish_reason": "stop",
                    "message": {"role": "assistant", "content": content},
                }
            ],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        }


def build_handler(gateway: Gateway, auth_token: str):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "moonlight-gateway/0.1"

        def log_message(self, fmt: str, *args):  # pragma: no cover - noise
            return

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _authorized(self) -> bool:
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return False
            return secrets.compare_digest(header[7:].strip(), auth_token)

        def do_GET(self):  # noqa: N802
            if self.path in ("/healthz", "/health"):
                self._send(200, {"ok": True, "provider": gateway.provider, "model": gateway.model})
            elif self.path == "/v1/models":
                if not self._authorized():
                    self._send(401, {"error": {"message": "unauthorized", "type": "auth"}})
                    return
                self._send(200, {"object": "list", "data": [{"id": gateway.model or "moonlight", "object": "model"}]})
            else:
                self._send(404, {"error": {"message": "not found", "type": "not_found"}})

        def do_POST(self):  # noqa: N802
            if self.path not in ("/v1/chat/completions", "/chat/completions"):
                self._send(404, {"error": {"message": "not found", "type": "not_found"}})
                return
            if not self._authorized():
                self._send(401, {"error": {"message": "invalid local gateway token", "type": "auth"}})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length <= 0 or length > MAX_BODY:
                self._send(413, {"error": {"message": "bad content length", "type": "payload"}})
                return
            try:
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._send(400, {"error": {"message": "invalid JSON body", "type": "invalid_json"}})
                return
            status, data = gateway.forward_chat(payload)
            self._send(status, data)

    return Handler


def serve(gateway: Gateway, host: str = "127.0.0.1", port: int = 0) -> tuple[ThreadingHTTPServer, str]:
    token = secrets.token_urlsafe(24)
    httpd = ThreadingHTTPServer((host, port), build_handler(gateway, token))
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, name="moonlight-gateway", daemon=True)
    thread.start()
    base_url = f"http://{host}:{httpd.server_address[1]}/v1"
    return httpd, token, base_url  # type: ignore[return-value]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Moonlight local OpenAI-compatible gateway")
    parser.add_argument("--upstream", default=os.environ.get("MOONLIGHT_UPSTREAM", "https://opencode.ai/zen/go/v1"))
    parser.add_argument("--model", default=os.environ.get("MOONLIGHT_MODEL"))
    parser.add_argument("--key-env", default=os.environ.get("MOONLIGHT_KEY_ENV", "MOONLIGHT_UPSTREAM_KEY"))
    parser.add_argument("--provider", choices=["openai", "fake"], default=os.environ.get("MOONLIGHT_PROVIDER", "openai"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("MOONLIGHT_GATEWAY_PORT", "0")))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--log", default=os.environ.get("MOONLIGHT_GATEWAY_LOG"))
    parser.add_argument("--fake-sleep", type=float, default=float(os.environ.get("MOONLIGHT_FAKE_SLEEP", "0")))
    args = parser.parse_args(argv)

    key = os.environ.get(args.key_env, "") if args.provider != "fake" else "fake"
    if not key and args.provider != "fake":
        print(json.dumps({"event": "error", "message": f"missing env {args.key_env}"}), flush=True)
        return 2

    gateway = Gateway(
        upstream=args.upstream,
        model=args.model,
        key=key,
        provider=args.provider,
        log=UsageLog(args.log),
        fake_sleep=args.fake_sleep,
    )
    httpd, token, base_url = serve(gateway, args.host, args.port)
    print(
        json.dumps(
            {
                "event": "ready",
                "base_url": base_url,
                "token": token,
                "provider": args.provider,
                "model": args.model,
                "pid": os.getpid(),
            }
        ),
        flush=True,
    )
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
