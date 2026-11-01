"""BabelDOC engine adapter.

The engine is treated as an external process with a *public* contract:

* input: one PDF, source/target language, page range, model gateway URL;
* output: a translated PDF (mono) with the same page geometry;
* side channel: stdout/stderr log, usage log from :mod:`moonlight.gateway`.

Everything else (paragraph callbacks, debug ids, internal JSON) is *not*
assumed to be stable.  ``docs/DESIGN.md`` requires the adapter to implement
progress and page mapping itself; this module is that thin layer.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

DEFAULT_MODEL = "qwen3.8-flash"
DEFAULT_UPSTREAM = "https://opencode.ai/zen/go/v1"

ProgressCb = Callable[[dict[str, Any]], None]


def _pkg_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


@dataclass
class EngineConfig:
    python: str = sys.executable
    babeldoc_bin: str | None = None
    model: str = DEFAULT_MODEL
    upstream: str = DEFAULT_UPSTREAM
    key_env: str = "MOONLIGHT_UPSTREAM_KEY"
    provider: str = "openai"
    lang_in: str = "en"
    lang_out: str = "zh-CN"
    qps: int = 4
    extra_args: list[str] = field(default_factory=list)
    timeout_s: int = 3600


class ModelGateway:
    """Child-process model gateway with a loopback-only bearer token."""

    def __init__(self, cfg: EngineConfig, log_path: str | Path):
        self.cfg = cfg
        self.log_path = Path(log_path)
        self.proc: subprocess.Popen | None = None
        self.base_url: str | None = None
        self.token: str | None = None
        self.info: dict[str, Any] = {}

    def start(self, wait_s: float = 30.0) -> "ModelGateway":
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            self.cfg.python,
            "-m",
            "moonlight.gateway",
            "--upstream",
            self.cfg.upstream,
            "--model",
            self.cfg.model,
            "--key-env",
            self.cfg.key_env,
            "--provider",
            self.cfg.provider,
            "--log",
            str(self.log_path),
        ]
        env = dict(os.environ)
        env.setdefault("PYTHONUNBUFFERED", "1")
        self.proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        deadline = time.time() + wait_s
        assert self.proc.stdout is not None
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                break
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            if msg.get("event") == "ready":
                self.base_url = msg["base_url"]
                self.token = msg["token"]
                self.info = msg
                return self
            if msg.get("event") == "error":
                raise RuntimeError(f"gateway failed: {msg.get('message')}")
        raise RuntimeError("model gateway did not become ready")

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def __enter__(self):
        return self.start()

    def __exit__(self, *exc):
        self.stop()


class BabelDocEngine:
    def __init__(self, cfg: EngineConfig):
        self.cfg = cfg

    def binary(self) -> str:
        """Resolve the CLI relative to the running interpreter's venv first."""
        if self.cfg.babeldoc_bin:
            return self.cfg.babeldoc_bin
        candidate = Path(self.cfg.python).parent / "babeldoc"
        if candidate.exists():
            return str(candidate)
        return shutil.which("babeldoc") or "babeldoc"

    # -- info -------------------------------------------------------------
    def version_info(self) -> dict[str, Any]:
        bin_path = self.cfg.babeldoc_bin or shutil.which("babeldoc") or (str(Path(self.cfg.python).parent / "babeldoc") if (Path(self.cfg.python).parent / "babeldoc").exists() else None)
        version = None
        if bin_path:
            try:
                version = subprocess.run(
                    [bin_path, "--version"], capture_output=True, text=True, timeout=60
                ).stdout.strip()
            except Exception:  # pragma: no cover - informational only
                version = None
        return {
            "babeldoc": _pkg_version("babeldoc"),
            "babeldoc_cli": version,
            "pymupdf": _pkg_version("pymupdf"),
            "python": sys.version.split()[0],
            "executable": bin_path,
        }

    # -- translation ------------------------------------------------------
    def build_command(self, pdf: str | Path, out_dir: str | Path, base_url: str, token: str, pages: str | None) -> list[str]:
        bin_path = self.binary()
        cmd = [
            bin_path,
            "--files",
            str(pdf),
            "--lang-in",
            self.cfg.lang_in,
            "--lang-out",
            self.cfg.lang_out,
            "--openai",
            "--openai-model",
            self.cfg.model,
            "--openai-base-url",
            base_url,
            "--openai-api-key",
            token,
            "--openai-reasoning",
            "none",
            "--openai-term-extraction-reasoning",
            "none",
            "--no-dual",
            "--watermark-output-mode",
            "no_watermark",
            "--qps",
            str(self.cfg.qps),
            "--output",
            str(out_dir),
            "--report-interval",
            "10",
        ]
        if pages:
            cmd += ["--pages", pages]
        cmd += self.cfg.extra_args
        return cmd

    def translate(
        self,
        pdf: str | Path,
        out_dir: str | Path,
        pages: str | None = None,
        log_path: str | Path | None = None,
        progress: ProgressCb | None = None,
        cancel: threading.Event | None = None,
    ) -> dict[str, Any]:
        pdf = Path(pdf)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        log_path = Path(log_path) if log_path else out_dir / f"{pdf.stem}.babeldoc.log"
        started = time.time()
        gw = ModelGateway(self.cfg, out_dir / "gateway-usage.jsonl").start()
        try:
            cmd = self.build_command(pdf, out_dir, gw.base_url or "", gw.token or "", pages)
            env = dict(os.environ)
            env["PYTHONUNBUFFERED"] = "1"
            # Do not leak the upstream key into the child environment.
            env.pop(self.cfg.key_env, None)
            self._emit(progress, {"phase": "preparing", "pdf": str(pdf), "pages": pages})
            with open(log_path, "w", encoding="utf-8") as logfh:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    env=env,
                    start_new_session=True,
                )
                assert proc.stdout is not None
                phase = "parsing"
                self._emit(progress, {"phase": phase})
                for line in proc.stdout:
                    logfh.write(line)
                    if "Translate Paragraphs" in line:
                        phase = "translating"
                    elif "Typesetting" in line:
                        phase = "typesetting"
                    elif "Save PDF" in line:
                        phase = "validating"
                    elif line.startswith("Parse PDF"):
                        phase = "parsing"
                    if phase != getattr(self, "_last_phase", None):
                        self._last_phase = phase
                        self._emit(progress, {"phase": phase})
                    if cancel is not None and cancel.is_set():
                        try:
                            os.killpg(proc.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                code = proc.wait()
            if cancel is not None and cancel.is_set():
                self._emit(progress, {"phase": "cancelled"})
                return {"status": "cancelled", "returncode": code, "elapsed_s": round(time.time() - started, 1), "log": str(log_path)}
            outputs = sorted(str(p) for p in out_dir.glob("*.mono.pdf"))
            if code != 0 or not outputs:
                self._emit(progress, {"phase": "failed", "returncode": code})
                return {
                    "status": "failed",
                    "returncode": code,
                    "elapsed_s": round(time.time() - started, 1),
                    "log": str(log_path),
                    "outputs": outputs,
                }
            self._emit(progress, {"phase": "completed"})
            return {
                "status": "completed",
                "returncode": code,
                "elapsed_s": round(time.time() - started, 1),
                "log": str(log_path),
                "outputs": outputs,
                "gateway": {"model": gw.info.get("model"), "provider": gw.info.get("provider")},
            }
        finally:
            gw.stop()

    @staticmethod
    def _emit(progress: ProgressCb | None, event: dict[str, Any]) -> None:
        if progress:
            event = {"ts": time.time(), **event}
            progress(event)


def gateway_usage_totals(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    totals = {"requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "errors": 0, "elapsed_ms": 0}
    if not path.exists():
        return totals
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("event") == "chat":
            totals["requests"] += 1
            totals["elapsed_ms"] += int(rec.get("elapsed_ms") or 0)
            usage = rec.get("usage") or {}
            totals["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
            totals["completion_tokens"] += int(usage.get("completion_tokens") or 0)
            if int(rec.get("status") or 500) >= 400:
                totals["errors"] += 1
    return totals
