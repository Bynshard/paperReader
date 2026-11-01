"""JSONL sidecar protocol (M1 groundwork).

The desktop main process talks to this process over stdin/stdout, one JSON
object per line.  stderr carries logs only.  Documents themselves never travel
through the pipe: only paths that the caller has already authorized (inside
``--root``) and derived file IDs.

Line shapes (protocol 1)::

    -> {"protocol":1,"type":"ready","capabilities":["translate"],"version":"0.1.0"}
    <- {"protocol":1,"requestId":"r1","type":"translate","pdf":"/abs/x.pdf",
        "out":"/abs/out","pages":null,"model":"qwen3.8-flash"}
    -> {"protocol":1,"requestId":"r1","jobId":"j1","seq":1,"type":"event","phase":"parsing"}
    -> {"protocol":1,"requestId":"r1","jobId":"j1","seq":2,"type":"result","status":"completed",
        "outputs":["/abs/out/x.zh-CN.mono.pdf"]}
    <- {"protocol":1,"type":"cancel","jobId":"j1"}
    <- {"protocol":1,"type":"ping","requestId":"r2"}
    -> {"protocol":1,"type":"pong","requestId":"r2"}

Cancellation is cooperative, then escalates to terminating the engine's
process group; a cancelled job never publishes a result.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, TextIO

from . import PROTOCOL_VERSION, __version__
from .engine import BabelDocEngine, EngineConfig


def _emit(out: TextIO, obj: dict[str, Any]) -> None:
    out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    out.flush()


class Sidecar:
    def __init__(self, root: str | Path, model: str, upstream: str, key_env: str, out: TextIO):
        self.root = Path(root).resolve()
        self.model = model
        self.upstream = upstream
        self.key_env = key_env
        self.out = out
        self.jobs: dict[str, dict[str, Any]] = {}
        self._lock = threading.Lock()
        self._seq = 0

    def _next_seq(self) -> int:
        with self._lock:
            self._seq += 1
            return self._seq

    def _authorized(self, path: str) -> Path:
        p = Path(path).resolve()
        if self.root not in p.parents and p != self.root:
            raise PermissionError(f"path outside authorized root: {path}")
        return p

    def handle(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "ping":
            _emit(self.out, {"protocol": PROTOCOL_VERSION, "type": "pong", "requestId": msg.get("requestId")})
        elif kind == "translate":
            thread = threading.Thread(target=self._translate, args=(msg,), daemon=True)
            thread.start()
        elif kind == "cancel":
            job = self.jobs.get(msg.get("jobId") or "")
            if job:
                job["cancel"].set()
                _emit(self.out, {"protocol": PROTOCOL_VERSION, "type": "cancel_ack", "jobId": msg.get("jobId")})
        else:
            _emit(self.out, {"protocol": PROTOCOL_VERSION, "type": "error", "requestId": msg.get("requestId"), "message": f"unknown type {kind}"})

    def _translate(self, msg: dict[str, Any]) -> None:
        request_id = msg.get("requestId")
        job_id = msg.get("jobId") or f"j-{uuid.uuid4().hex[:8]}"
        cancel = threading.Event()
        self.jobs[job_id] = {"cancel": cancel}
        seq = 0

        def event(**kw: Any) -> None:
            nonlocal seq
            seq += 1
            _emit(
                self.out,
                {"protocol": PROTOCOL_VERSION, "requestId": request_id, "jobId": job_id, "seq": seq, "type": "event", **kw},
            )

        try:
            pdf = self._authorized(msg["pdf"])
            out_dir = self._authorized(msg["out"])
            if pdf.suffix.lower() != ".pdf" or not pdf.exists():
                raise FileNotFoundError(f"pdf not found: {pdf}")
            cfg = EngineConfig(model=msg.get("model") or self.model, upstream=self.upstream, key_env=self.key_env)
            engine = BabelDocEngine(cfg)
            event(phase="preparing")
            result = engine.translate(pdf, out_dir, pages=msg.get("pages"), cancel=cancel, progress=lambda e: event(**e))
            if cancel.is_set():
                _emit(self.out, {"protocol": PROTOCOL_VERSION, "requestId": request_id, "jobId": job_id, "type": "result", "status": "cancelled"})
                return
            _emit(
                self.out,
                {
                    "protocol": PROTOCOL_VERSION,
                    "requestId": request_id,
                    "jobId": job_id,
                    "type": "result",
                    "status": result["status"],
                    "outputs": result.get("outputs", []),
                    "elapsed_s": result.get("elapsed_s"),
                },
            )
        except Exception as exc:  # sidecar must survive any job failure
            _emit(self.out, {"protocol": PROTOCOL_VERSION, "requestId": request_id, "jobId": job_id, "type": "result", "status": "failed", "error": f"{type(exc).__name__}: {exc}"})
        finally:
            self.jobs.pop(job_id, None)


def main(argv: list[str] | None = None, stdin: TextIO | None = None, stdout: TextIO | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Moonlight sidecar (JSONL over stdio)")
    parser.add_argument("--root", default=os.environ.get("MOONLIGHT_AUTH_ROOT", os.getcwd()))
    parser.add_argument("--model", default=os.environ.get("MOONLIGHT_MODEL", "qwen3.8-flash"))
    parser.add_argument("--upstream", default=os.environ.get("MOONLIGHT_UPSTREAM", "https://opencode.ai/zen/go/v1"))
    parser.add_argument("--key-env", default="MOONLIGHT_UPSTREAM_KEY")
    args = parser.parse_args(argv)

    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    sidecar = Sidecar(args.root, args.model, args.upstream, args.key_env, stdout)
    _emit(stdout, {"protocol": PROTOCOL_VERSION, "type": "ready", "capabilities": ["translate", "cancel"], "version": __version__})
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            _emit(stdout, {"protocol": PROTOCOL_VERSION, "type": "error", "message": "invalid json"})
            continue
        sidecar.handle(msg)
    return 0
