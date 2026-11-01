"""M0 orchestration: translate frozen samples, measure, render evidence, report.

The harness is deliberately boring: it only relies on the *public* engine
contract (one PDF in, one translated PDF out) and measures the artifacts.
Paragraph callbacks, debug ids and BabelDOC internals are never read.

Run::

    python -m moonlight run-m0 --corpus corpus/corpus.json \
        --out artifacts/validation --reuse
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import pymupdf

from . import __version__
from .corpus import load_manifest
from .edgecases import run_edge_case_suite, run_range_probes
from .engine import BabelDocEngine, EngineConfig, gateway_usage_totals
from .manifest import ArtifactWriter, TranslationRun, new_run_id, now, review_rows, write_review_csv
from .metrics import analyze_range
from .render import render_page, render_rect, save, side_by_side

GATES = {
    "coverage_overall": 0.95,
    "coverage_per_page": 0.90,
    "start_offset_within": 0.95,
}

RANGE_PROBES = [
    {"id": "middle-page", "pages": "5", "why": "middle page only: check offset mapping and untouched neighbours"},
    {"id": "non-contiguous", "pages": "3,9", "why": "two separated pages: check ordering and page numbers"},
    {"id": "first-page", "pages": "1", "why": "first page only: check the classic off-by-one in range output"},
]


def collect_environment(model: str, upstream: str, engine_info: dict[str, Any], lock_dir: Path | None = None) -> dict[str, Any]:
    cpu_model = ""
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.lower().startswith("model name"):
                cpu_model = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    mem_bytes = None
    try:
        for line in Path("/proc/meminfo").read_text(encoding="utf-8", errors="replace").splitlines():
            if line.startswith("MemTotal:"):
                mem_bytes = int(line.split()[1]) * 1024
                break
    except OSError:
        pass
    env = {
        "captured_at": now(),
        "moonlight_version": __version__,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_model": cpu_model,
        "cpu_count": os.cpu_count(),
        "memory_bytes": mem_bytes,
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "pymupdf": pymupdf.__version__,
        "node": _tool_version("node"),
        "engine": engine_info,
        "model": {
            "id": model,
            "provider": "openai-compatible",
            "endpoint_host": re.sub(r"^https?://([^/]+).*", r"\1", upstream),
            "temperature": "engine default (not overridden)",
            "prompt": "babeldoc builtin prompt v" + str(engine_info.get("babeldoc") or "?"),
        },
        "credentials": "configured_via_gateway_env (value not recorded)",
        "screen_scale": "not_applicable (off-screen rendering)",
        "timezone": time.strftime("%Z"),
    }
    if lock_dir:
        lock_dir.mkdir(parents=True, exist_ok=True)
        try:
            freeze = subprocess.run([sys.executable, "-m", "pip", "freeze", "--all"], capture_output=True, text=True, timeout=120)
            (lock_dir / "requirements-freeze.txt").write_text(freeze.stdout, encoding="utf-8")
        except Exception as exc:  # pragma: no cover - best effort
            (lock_dir / "requirements-freeze.txt").write_text(f"# failed: {exc}\n", encoding="utf-8")
        (lock_dir / "versions.json").write_text(
            json.dumps({"engine": engine_info, "python": sys.version, "model": model}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        try:
            import importlib.metadata as md

            dists = []
            for dist in md.distributions():
                dists.append({"name": dist.metadata["Name"], "version": dist.version})
            (lock_dir / "distributions.json").write_text(json.dumps(dists, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
    return env


def _tool_version(tool: str) -> str | None:
    exe = shutil.which(tool)
    if not exe:
        return None
    try:
        return subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=20).stdout.strip().splitlines()[0]
    except Exception:
        return None


def _existing_output(outdir: Path) -> Path | None:
    outs = sorted(outdir.glob("*.mono.pdf"), key=lambda p: p.stat().st_mtime)
    return outs[-1] if outs else None


def translate_sample(
    sample: dict[str, Any],
    outdir: Path,
    engine: BabelDocEngine,
    pages: str | None = None,
    reuse: bool = False,
    progress=None,
) -> tuple[dict[str, Any], TranslationRun]:
    outdir.mkdir(parents=True, exist_ok=True)
    run = TranslationRun(
        run_id=new_run_id(sample["id"]),
        sample_id=sample["id"],
        source_sha256=sample["source"]["sha256"],
        pages_requested=pages or "all",
        engine=engine.version_info(),
        model={"id": engine.cfg.model, "provider": engine.cfg.provider},
    )
    existing = _existing_output(outdir) if reuse else None
    if existing:
        run.event(phase="reused", output=str(existing))
        run.finish("completed")
        run.usage = gateway_usage_totals(outdir / "gateway-usage.jsonl")
        return {"status": "completed", "outputs": [str(existing)], "elapsed_s": 0, "reused": True, "log": str(outdir / "babeldoc.log")}, run
    result = engine.translate(
        sample["file"],
        outdir,
        pages=pages,
        log_path=outdir / "babeldoc.log",
        progress=progress,
    )
    run.usage = gateway_usage_totals(outdir / "gateway-usage.jsonl")
    if result["status"] == "completed":
        run.finish("completed")
        run.outputs = [{"path": p, "sha256": _sha256(Path(p))} for p in result.get("outputs", []) if Path(p).exists()]
    else:
        run.finish("failed")
        run.errors.append(f"engine returncode={result.get('returncode')}")
    return result, run


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def evaluate_sample(sample: dict[str, Any], translated: Path, writer: ArtifactWriter, dpi: int = 110) -> dict[str, Any]:
    src = pymupdf.open(sample["file"])
    try:
        tgt = pymupdf.open(translated)
        try:
            analysis = analyze_range(src, tgt, sample.get("annotations", []))
        finally:
            tgt.close()
    finally:
        src.close()

    shots = []
    src = pymupdf.open(sample["file"])
    tgt = pymupdf.open(translated)
    try:
        for page_no in sample.get("selected_pages", []):
            if not (0 <= page_no < src.page_count and 0 <= page_no < tgt.page_count):
                continue
            a = render_page(src, page_no, dpi=dpi)
            b = render_page(tgt, page_no, dpi=dpi)
            stem = f"{sample['id']}-p{page_no + 1:02d}"
            save(a, writer.path("screenshots", f"{stem}-source.png"))
            save(b, writer.path("screenshots", f"{stem}-target.png"))
            save(side_by_side([("source", a), ("translated", b)]), writer.path("screenshots", f"{stem}-side-by-side.png"))
            shots += [f"{stem}-source.png", f"{stem}-target.png", f"{stem}-side-by-side.png"]
            ann = next((x for x in sample.get("annotations", []) if x["page"] == page_no), None)
            if ann:
                block = next((b for b in ann["blocks"] if b.get("required") and b.get("kind") == "body" and b.get("chars", 0) > 80), None)
                if block:
                    ca = render_rect(src, page_no, block["bbox"], dpi=200)
                    cb = render_rect(tgt, page_no, block["bbox"], dpi=200)
                    save(ca, writer.path("screenshots", f"{stem}-crop-source.png"))
                    save(cb, writer.path("screenshots", f"{stem}-crop-target.png"))
                    save(side_by_side([("source crop", ca), ("translated crop", cb)], header=30), writer.path("screenshots", f"{stem}-crop-pair.png"))
                    shots += [f"{stem}-crop-pair.png"]
    finally:
        src.close()
        tgt.close()

    analysis["screenshots"] = shots
    analysis["output_sha256"] = _sha256(Path(translated))
    analysis["output_bytes"] = Path(translated).stat().st_size
    return analysis


def gate_table(
    results: list[dict[str, Any]],
    edge_results: list[dict[str, Any]] | None = None,
    range_results: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    gates = []
    geo_ok = all(r["analysis"]["geometry"]["ok"] for r in results if r.get("analysis"))
    gates.append(
        {
            "id": "document_geometry",
            "target": "page count, page size and rotation identical",
            "status": "pass" if geo_ok else "fail",
            "evidence": [r["sample_id"] for r in results if r.get("analysis") and not r["analysis"]["geometry"]["ok"]],
        }
    )

    coverages = [r["analysis"]["overall"]["coverage"] for r in results if r.get("analysis") and r["analysis"]["overall"]["coverage"] is not None]
    per_page_cov = []
    for r in results:
        if r.get("analysis"):
            per_page_cov += [v["coverage"] for v in r["analysis"]["per_page"].values() if v.get("coverage") is not None]
    overall = round(sum(coverages) / len(coverages), 4) if coverages else None
    worst_page = min(per_page_cov) if per_page_cov else None
    gates.append(
        {
            "id": "translation_coverage",
            "target": f"overall >= {GATES['coverage_overall']}, every page >= {GATES['coverage_per_page']}",
            "status": "not_run" if overall is None else ("pass" if overall >= GATES["coverage_overall"] and (worst_page or 0) >= GATES["coverage_per_page"] else "fail"),
            "overall": overall,
            "worst_page": worst_page,
            "method": "CJK span presence inside each required block rectangle (see metrics.py)",
        }
    )

    offsets = []
    for r in results:
        if r.get("analysis"):
            o = r["analysis"]["overall"].get("start_offset_within_limit_ratio")
            if o is not None:
                offsets.append(o)
    start_ratio = round(min(offsets), 4) if offsets else None
    gates.append(
        {
            "id": "paragraph_start_offset",
            "target": f">= {GATES['start_offset_within']} of translated blocks within 3% of page size",
            "status": "not_run" if start_ratio is None else ("pass" if start_ratio >= GATES["start_offset_within"] else "fail"),
            "value": start_ratio,
        }
    )

    font_ok = True
    font_ratio = None
    for r in results:
        if r.get("analysis"):
            ratio = r["analysis"]["overall"].get("font_ok_ratio")
            if ratio is not None:
                font_ok = font_ok and ratio == 1.0
                font_ratio = ratio if font_ratio is None else min(font_ratio, ratio)
    gates.append(
        {
            "id": "font_readability",
            "target": "translated body text >= 8pt and >= 75% of source size",
            "status": "not_run" if font_ratio is None else ("pass" if font_ok else "fail"),
            "value": font_ratio,
        }
    )

    fallbacks_visible = True
    for r in results:
        for b in r.get("analysis", {}).get("blocks", []):
            if b["required"] and b["status"] in ("retained_source", "failed") and not b.get("reason"):
                fallbacks_visible = False
    gates.append(
        {
            "id": "fallback_transparency",
            "target": "every retained/failed region carries a reason",
            "status": "pass" if fallbacks_visible else "fail",
        }
    )

    if edge_results is not None:
        rejected_ok = True
        for e in edge_results:
            if e["id"] in ("corrupt", "encrypted"):
                rejected_ok = rejected_ok and e["status"] in ("rejected", "unsupported")
        scanned = next((e for e in edge_results if e["id"] == "scanned-page"), None)
        scanned_ok = bool(scanned and scanned["status"] in ("unsupported", "rejected", "retained_source"))
        gates.append(
            {
                "id": "edge_cases",
                "target": "broken/encrypted inputs rejected explicitly; scanned page not counted as translated",
                "status": "pass" if rejected_ok and scanned_ok else "fail",
                "evidence": {e["id"]: e["status"] for e in edge_results},
            }
        )

    if range_results is not None:
        ok = all(r.get("status") == "completed" and r.get("geometry_ok") for r in range_results)
        gates.append(
            {
                "id": "page_range_mapping",
                "target": "range output keeps 1:1 page numbering; only requested pages translated",
                "status": "pass" if ok else "fail",
                "evidence": [
                    {"id": r["id"], "requested": r.get("requested_pages"), "detected": r.get("translated_pages_detected"), "pages": r.get("output_pages")}
                    for r in range_results
                ],
            }
        )

    for gid, target in (
        ("formula_numeric", "manual: >=30 key formulas/numbers checked"),
        ("semantic", "manual: >=50 review segments, >=90% correct, 0 critical errors"),
        ("severe_layout", "manual page inspection: no unannounced clipping/overlap/column bleed"),
    ):
        gates.append({"id": gid, "target": target, "status": "not_run", "note": "requires human review of rendered pages"})
    return gates


def overall_status(gates: list[dict[str, Any]]) -> str:
    if any(g["status"] == "fail" for g in gates):
        return "fail"
    if any(g["status"] == "not_run" for g in gates):
        return "not_run"
    return "pass"


def write_report(
    root: Path,
    run_id: str,
    status: str,
    gates: list[dict[str, Any]],
    results: list[dict[str, Any]],
    env: dict[str, Any],
    commands: list[str],
    started: float,
    edge_results: list[dict[str, Any]] | None = None,
    range_results: list[dict[str, Any]] | None = None,
) -> Path:
    lines = [f"# M0 validation report — {run_id}", ""]
    lines += [f"**status: {status}**", "", f"generated: {now()} · wall time: {int(time.time() - started)}s", ""]
    if status != "pass":
        lines += [
            "> `not_run` means the automated part produced evidence but a required gate "
            "(manual page/semantic review) has not been completed. It is not a pass.",
            "",
        ]
    lines += ["## Environment", ""]
    lines += [f"- {k}: `{v}`" for k, v in env.items() if k not in ("engine", "model")]
    lines += [f"- engine: `{json.dumps(env.get('engine'), ensure_ascii=False)}`"]
    lines += [f"- model: `{json.dumps(env.get('model'), ensure_ascii=False)}`", ""]

    lines += ["## Gates", "", "| gate | status | target | value |", "| --- | --- | --- | --- |"]
    for g in gates:
        value = g.get("overall", g.get("value", g.get("worst_page", "")))
        if isinstance(value, (dict, list)):
            value = json.dumps(value, ensure_ascii=False)
        if value is None:
            value = ""
        lines.append(f"| {g['id']} | {g['status']} | {g['target']} | {value} |")
    lines.append("")

    lines += ["## Samples", "", "| sample | pages | required blocks | translated | coverage | output |", "| --- | --- | --- | --- | --- | --- |"]
    for r in results:
        a = r.get("analysis")
        if not a:
            lines.append(f"| {r['sample_id']} | - | - | - | - | translation {r.get('status')} |")
            continue
        o = a["overall"]
        lines.append(
            f"| {r['sample_id']} | {r.get('selected_pages')} | {o['required_blocks']} | {o['translated']} | {o['coverage']} | {r.get('output_name')} |"
        )
    lines.append("")

    lines += ["## Per-page coverage", ""]
    for r in results:
        if not r.get("analysis"):
            continue
        lines.append(f"### {r['sample_id']}")
        lines.append("")
        lines.append("| page | required | translated | retained | failed | coverage |")
        lines.append("| --- | --- | --- | --- | --- | --- |")
        for page, v in r["analysis"]["per_page"].items():
            lines.append(f"| {page} | {v['required']} | {v['translated']} | {v.get('retained_source', 0)} | {v.get('failed', 0)} | {v['coverage']} |")
        lines.append("")

    if edge_results:
        lines += ["## Boundary samples", "", "| id | status | reason | geometry | cjk | overflow |", "| --- | --- | --- | --- | --- | --- |"]
        for e in edge_results:
            c = e.get("checks") or {}
            geo = c.get("geometry", {}).get("ok") if c.get("geometry") else ""
            txt = c.get("target_text") or {}
            ov = c.get("overflow") or {}
            lines.append(
                f"| {e['id']} | {e['status']} | {e.get('reason', '')} | {geo} | {txt.get('cjk', '')} | "
                f"{ov.get('spans_outside_page', '')}/{c.get('column_bleed_blocks', '')} |"
            )
        lines.append("")

    if range_results:
        lines += ["## Page-range mapping", "", "| probe | requested | output pages | detected translated pages |", "| --- | --- | --- | --- |"]
        for r in range_results:
            lines.append(f"| {r['id']} | {r.get('requested_pages')} | {r.get('output_pages')} | {r.get('translated_pages_detected')} |")
        lines.append("")

    lines += ["## Commands", "", "```bash"]
    lines += commands
    lines += ["```", ""]

    failures = [r for r in results if r.get("status") != "completed"]
    if failures:
        lines += ["## Failures", ""]
        for r in failures:
            lines.append(f"- {r['sample_id']}: {r.get('status')} (log: {r.get('log')})")
        lines.append("")

    lines += ["## Not run / next steps", ""]
    lines += [
        "- 人工版面与语义审查（50 段、30 项公式/数值、12 页截图）尚未完成，review.csv 中留空列待填。",
        "- 句级映射、阅读器 GUI、桌面底座构建属于 M1/M2，不在本报告范围。",
        "- 成本：服务端未返回账单，仅记录请求数与 token（见 gateway-usage.jsonl）。",
    ]
    path = root / "report.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def run_m0(
    corpus_path: str | Path,
    out_root: str | Path,
    engine_cfg: EngineConfig,
    sample_ids: Iterable[str] | None = None,
    pages: str | None = None,
    reuse: bool = False,
    dpi: int = 110,
    limit_pages: bool = False,
    run_id: str | None = None,
    edge_cases: bool = True,
) -> dict[str, Any]:
    started = time.time()
    corpus = load_manifest(corpus_path)
    run_id = run_id or new_run_id("m0")
    root = Path(out_root) / run_id
    writer = ArtifactWriter(root)
    engine = BabelDocEngine(engine_cfg)
    engine_info = engine.version_info()
    env = collect_environment(engine_cfg.model, engine_cfg.upstream, engine_info, lock_dir=root / "dependency-lock")
    commands: list[str] = []

    samples = [s for s in corpus["samples"] if not sample_ids or s["id"] in set(sample_ids)]
    results: list[dict[str, Any]] = []
    runs: list[dict[str, Any]] = []

    for sample in samples:
        outdir = root / "outputs" / sample["id"]
        selected = sample.get("selected_pages") or []
        run_pages = pages
        if run_pages is None and limit_pages and selected:
            run_pages = ",".join(str(p + 1) for p in selected)
        result, run = translate_sample(sample, outdir, engine, pages=run_pages, reuse=reuse)
        runs.append(run.to_dict())
        entry: dict[str, Any] = {
            "sample_id": sample["id"],
            "selected_pages": [p + 1 for p in selected],
            "status": result["status"],
            "elapsed_s": result.get("elapsed_s"),
            "log": result.get("log"),
            "usage": run.usage,
            "pages_requested": run.pages_requested,
        }
        commands.append(_redacted_command(engine, sample["file"], outdir, run_pages))
        if result["status"] != "completed" or not result.get("outputs"):
            writer.write_json(f"failures/{sample['id']}.json", {**entry, "returncode": result.get("returncode")})
            results.append(entry)
            continue
        output = Path(result["outputs"][0])
        entry["output_name"] = output.name
        entry["analysis"] = evaluate_sample(sample, output, writer, dpi=dpi)
        results.append(entry)

    # ---- boundary samples -------------------------------------------------
    edge_results: list[dict[str, Any]] = []
    edge_dir = Path("samples/generated")
    if edge_cases and edge_dir.exists():
        edge_results = run_edge_case_suite(edge_dir, root, writer, engine, translate=not limit_pages, reuse=reuse)
        commands.append("python -m moonlight run-m0 --corpus corpus/corpus.json --out artifacts/validation (edge suite)")
        for e in edge_results:
            if e["status"] in ("failed", "rejected"):
                writer.write_json(f"failures/edge-{e['id']}.json", e)

    # ---- page-range mapping ----------------------------------------------
    range_results: list[dict[str, Any]] = []
    probe_sample = next((s for s in samples if s["id"] == "arxiv-1706.03762"), samples[0] if samples else None)
    if probe_sample and not pages:
        range_results = run_range_probes(probe_sample, root, writer, engine, RANGE_PROBES, reuse=reuse)
        commands.append(
            "python -m moonlight translate --pdf corpus/raw/attn.pdf --pages 5|3,9|1 --out <range-probe>"
        )

    gates = gate_table([r for r in results if r.get("analysis")], edge_results, range_results)
    status = overall_status(gates)
    report = write_report(root, run_id, status, gates, results, env, commands, started, edge_results, range_results)

    writer.write_json("environment.json", env)
    writer.write_json("metrics.json", {"gates": gates, "samples": results, "edge_cases": edge_results, "range_probes": range_results, "status": status})
    writer.write_json("corpus.json", corpus)
    writer.write_jsonl("runs.jsonl", runs)
    blocks = [b for r in results if r.get("analysis") for b in r["analysis"]["blocks"]]
    from .manifest import BlockResult

    write_review_csv(root / "review.csv", review_rows([BlockResult(**b) for b in blocks]))
    (root / "logs").mkdir(exist_ok=True)
    for r in results:
        if r.get("log") and Path(r["log"]).exists():
            shutil.copy2(r["log"], root / "logs" / f"{r['sample_id']}.babeldoc.log")
    return {
        "run_id": run_id,
        "root": str(root),
        "status": status,
        "gates": gates,
        "edge_cases": edge_results,
        "range_probes": range_results,
        "report": str(report),
    }


def _redacted_command(engine: BabelDocEngine, pdf: str, outdir: Path, pages: str | None) -> str:
    cmd = engine.build_command(pdf, outdir, "http://127.0.0.1:<port>/v1", "<gateway-token>", pages)
    return " ".join(cmd)
