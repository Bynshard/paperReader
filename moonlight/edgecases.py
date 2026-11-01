"""Controllable boundary samples (rotated/CropBox, overflow, scanned, broken).

These are *functional* probes, not quality samples.  Each one answers a
question the real-paper corpus cannot answer reliably:

* rotated/cropbox — does the coordinate protocol survive /Rotate + non-zero
  CropBox, and does the output keep the same display geometry?
* narrow column   — when Chinese needs more room than the source column, does
  the engine clip/shrink without bound, or does it fall back visibly?
* scanned page    — is a raster-only page detected instead of silently
  "translated" into nothing?
* encrypted/corrupt — is the input rejected with an explicit reason, without
  crashing the harness or the sidecar?

Everything is measured from the produced PDFs, so the report can be re-run
without the engine's internal debug output.
"""

from __future__ import annotations

import hashlib
import time
from pathlib import Path
from typing import Any

import pymupdf

from .engine import BabelDocEngine
from .geometry import spans
from .manifest import ArtifactWriter

CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))


def _is_cjk(ch: str) -> bool:
    o = ord(ch)
    return any(a <= o <= b for a, b in CJK_RANGES)


def probe_input(path: Path) -> dict[str, Any]:
    """Open an input defensively; never let a broken PDF hang the suite."""
    info: dict[str, Any] = {
        "file": path.name,
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "open": "ok",
        "pages": None,
        "encrypted": False,
        "text_chars": None,
        "geometry": [],
        "error": None,
    }
    data = path.read_bytes()
    if not data.lstrip().startswith(b"%PDF-") or b"%%EOF" not in data[-2048:]:
        info["open"] = "failed"
        info["error"] = "truncated or malformed PDF (missing %PDF header or %%EOF trailer)"
        return info
    try:
        doc = pymupdf.open(path)
    except Exception as exc:  # noqa: BLE001 - report the real error text
        info["open"] = "failed"
        info["error"] = f"{type(exc).__name__}: {exc}"
        return info
    try:
        info["encrypted"] = bool(doc.needs_pass or doc.is_encrypted)
        if doc.needs_pass:
            info["open"] = "needs_password"
            info["error"] = "password protected; reader must ask for a password, translation is refused"
            return info
        info["pages"] = doc.page_count
        if doc.page_count == 0:
            info["open"] = "failed"
            info["error"] = "PDF contains no pages (damaged cross-reference table)"
            return info
        info["text_chars"] = sum(len(doc[i].get_text()) for i in range(doc.page_count))
        for i in range(doc.page_count):
            p = doc[i]
            info["geometry"].append(
                {
                    "index": i,
                    "width": round(p.rect.width, 2),
                    "height": round(p.rect.height, 2),
                    "rotation": p.rotation,
                    "cropbox": [round(v, 2) for v in p.cropbox],
                    "mediabox": [round(v, 2) for v in p.mediabox],
                }
            )
    finally:
        doc.close()
    return info


def _page_text_stats(doc: pymupdf.Document) -> dict[str, Any]:
    text = "".join(doc[i].get_text() for i in range(doc.page_count))
    cjk = sum(1 for ch in text if _is_cjk(ch))
    return {"chars": len(text), "cjk": cjk, "cjk_ratio": round(cjk / len(text), 4) if text else 0.0}


def _overflow(doc: pymupdf.Document) -> dict[str, Any]:
    """Spans that leave the visible page or collapse to a degenerate box."""
    outside = 0
    clipped = 0
    for i in range(doc.page_count):
        page = doc[i]
        pr = page.rect
        for span in spans(page):
            b = span.bbox
            if b.x0 < pr.x0 - 1 or b.y0 < pr.y0 - 1 or b.x1 > pr.x1 + 1 or b.y1 > pr.y1 + 1:
                outside += 1
            if b.width <= 0.5 or b.height <= 0.5:
                clipped += 1
    return {"spans_outside_page": outside, "degenerate_spans": clipped}


def _column_bleed(doc: pymupdf.Document) -> int:
    """Count target lines that cross the page centre gutter by more than 2pt."""
    bleed = 0
    for i in range(doc.page_count):
        page = doc[i]
        if page.rotation % 180 != 0:
            # A rotated page has no stable left/right gutter in this coordinate
            # space; column bleed is checked by the manual review instead.
            continue
        mid = page.rect.width / 2
        for block in page.get_text("blocks"):
            x0, y0, x1, y1, text = block[0], block[1], block[2], block[3], block[4]
            if not text.strip():
                continue
            if x0 < mid - 2 and x1 > mid + 2 and (x1 - x0) < page.rect.width * 0.75:
                bleed += 1
    return bleed


def _geometry_equal(src: pymupdf.Document, tgt: pymupdf.Document) -> dict[str, Any]:
    issues = []
    if src.page_count != tgt.page_count:
        issues.append(f"page count {src.page_count} -> {tgt.page_count}")
    mismatches = []
    for i in range(min(src.page_count, tgt.page_count)):
        a, b = src[i], tgt[i]
        if abs(a.rect.width - b.rect.width) > 0.5 or abs(a.rect.height - b.rect.height) > 0.5:
            mismatches.append({"page": i + 1, "source": [a.rect.width, a.rect.height], "target": [b.rect.width, b.rect.height]})
        elif a.rotation != b.rotation:
            mismatches.append({"page": i + 1, "rotation": [a.rotation, b.rotation]})
    if mismatches:
        issues.append(f"{len(mismatches)} geometry mismatches")
    return {"ok": not issues, "issues": issues, "mismatches": mismatches}


def run_edge_case_suite(
    samples_dir: Path,
    root: Path,
    writer: ArtifactWriter,
    engine: BabelDocEngine,
    translate: bool = True,
    reuse: bool = False,
) -> list[dict[str, Any]]:
    """Run every generated boundary sample and record explicit outcomes."""
    output_root = root / "outputs" / "edge-cases"
    results: list[dict[str, Any]] = []
    for path in sorted(samples_dir.glob("*.pdf")):
        entry: dict[str, Any] = {"id": path.stem, "input": probe_input(path)}
        inp = entry["input"]
        started = time.time()
        if inp["open"] != "ok":
            entry["status"] = "rejected"
            entry["reason"] = inp["error"]
            entry["checks"] = {}
            results.append(entry)
            continue

        checks: dict[str, Any] = {}
        if inp["text_chars"] == 0:
            checks["text_layer"] = {"chars": 0, "scanned": True}

        if not translate:
            entry["status"] = "parsed_not_translated"
            entry["reason"] = "translation disabled (offline run)"
            entry["checks"] = checks
            results.append(entry)
            continue

        outdir = output_root / path.stem
        try:
            existing = sorted(outdir.glob("*.mono.pdf")) if reuse else []
            if existing:
                result = {"status": "completed", "outputs": [str(existing[-1])], "elapsed_s": 0}
            else:
                result = engine.translate(path, outdir, pages=None, log_path=outdir / "babeldoc.log")
        except Exception as exc:  # noqa: BLE001 - the suite must keep going
            entry["status"] = "failed"
            entry["reason"] = f"{type(exc).__name__}: {exc}"
            entry["checks"] = checks
            entry["elapsed_s"] = round(time.time() - started, 1)
            results.append(entry)
            continue

        entry["engine_status"] = result["status"]
        entry["elapsed_s"] = result.get("elapsed_s")
        entry["log"] = result.get("log")
        outputs = [Path(p) for p in result.get("outputs", [])]
        if result["status"] != "completed" or not outputs:
            entry["status"] = "unsupported" if inp["text_chars"] == 0 else "failed"
            entry["reason"] = "scanned page skipped by engine" if inp["text_chars"] == 0 else "engine produced no output"
            entry["checks"] = checks
            results.append(entry)
            continue

        out_pdf = outputs[0]
        try:
            entry["output"] = str(out_pdf.relative_to(root))
        except ValueError:
            entry["output"] = str(out_pdf)
        src = pymupdf.open(path)
        tgt = pymupdf.open(out_pdf)
        try:
            checks["geometry"] = _geometry_equal(src, tgt)
            checks["target_text"] = _page_text_stats(tgt)
            checks["overflow"] = _overflow(tgt)
            checks["column_bleed_blocks"] = _column_bleed(tgt)
            checks["text_layer_copyable"] = checks["target_text"]["chars"] > 0
            orig = _page_text_stats(src)
            checks["translated_ratio"] = round(checks["target_text"]["cjk"] / orig["chars"], 4) if orig["chars"] else None
        finally:
            src.close()
            tgt.close()

        if inp["text_chars"] == 0:
            entry["status"] = "unsupported" if checks["target_text"]["cjk"] == 0 else "translated"
            entry["reason"] = "raster-only page: no extractable text to translate"
        elif not checks["geometry"]["ok"]:
            entry["status"] = "failed"
            entry["reason"] = "page geometry changed"
        elif checks["overflow"]["spans_outside_page"] or checks["column_bleed_blocks"]:
            entry["status"] = "completed_with_fallbacks"
            entry["reason"] = "text left the page/column; inspect rendering and manifest"
        elif checks["target_text"]["cjk"] == 0:
            entry["status"] = "retained_source"
            entry["reason"] = "no Chinese text found in output"
        else:
            entry["status"] = "completed"
            entry["reason"] = ""
        entry["checks"] = checks
        results.append(entry)

    writer.write_json("edge-cases.json", results)
    return results


def run_range_probes(
    sample: dict[str, Any],
    root: Path,
    writer: ArtifactWriter,
    engine: BabelDocEngine,
    probes: list[dict[str, str]],
    reuse: bool = False,
) -> list[dict[str, Any]]:
    """Translate explicit page ranges and record the real page mapping."""
    results: list[dict[str, Any]] = []
    src = pymupdf.open(sample["file"])
    try:
        for probe in probes:
            name, pages = probe["id"], probe["pages"]
            outdir = root / "outputs" / "range-probes" / name
            existing = sorted(outdir.glob("*.mono.pdf")) if reuse else []
            if existing:
                result = {"status": "completed", "outputs": [str(existing[-1])], "elapsed_s": 0}
            else:
                result = engine.translate(sample["file"], outdir, pages=pages, log_path=outdir / "babeldoc.log")
            entry: dict[str, Any] = {"id": name, "requested": pages, "engine_status": result["status"], "elapsed_s": result.get("elapsed_s")}
            outputs = [Path(p) for p in result.get("outputs", [])]
            if result["status"] != "completed" or not outputs:
                entry["status"] = "failed"
                entry["reason"] = "engine produced no output"
                results.append(entry)
                continue
            out_pdf = outputs[0]
            try:
                entry["output"] = str(out_pdf.relative_to(root))
            except ValueError:
                entry["output"] = str(out_pdf)
            tgt = pymupdf.open(out_pdf)
            try:
                requested = parse_pages(pages, src.page_count)
                per_page = []
                for i in range(tgt.page_count):
                    text = tgt[i].get_text()
                    cjk = sum(1 for ch in text if _is_cjk(ch))
                    per_page.append({"pdf_page": i + 1, "cjk": cjk, "chars": len(text)})
                entry["output_pages"] = tgt.page_count
                entry["geometry_ok"] = tgt.page_count == src.page_count
                entry["translated_pages_detected"] = [p["pdf_page"] for p in per_page if p["cjk"] > 0]
                entry["requested_pages"] = [p + 1 for p in requested]
                entry["mapping_1to1"] = tgt.page_count == src.page_count
                entry["status"] = "completed" if entry["geometry_ok"] else "failed"
                entry["reason"] = "" if entry["geometry_ok"] else "output page count differs from source"
                entry["per_page"] = per_page
            finally:
                tgt.close()
            results.append(entry)
    finally:
        src.close()
    writer.write_json("range-probes.json", results)
    return results


def parse_pages(spec: str, page_count: int) -> list[int]:
    pages: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, _, b = part.partition("-")
            start, end = int(a), int(b or a)
            pages.extend(range(start - 1, end))
        else:
            pages.append(int(part) - 1)
    return [p for p in pages if 0 <= p < page_count]
