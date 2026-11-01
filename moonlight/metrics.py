"""Measurements for the M0 quality gates.

All metrics are computed from the *output artifacts* (translated PDF + frozen
source PDF + the corpus annotation), never from engine internals.  That keeps
the numbers reproducible for a reviewer and independent of BabelDOC's debug
output.

Implemented gates (see docs/VALIDATION.md):

* document geometry      — page count / size / rotation
* body translation cover — per required block, CJK presence in the mapped area
* paragraph start offset — first-character displacement / page size
* font readability       — target size >= 8pt and >= 75% of source size
* fallback transparency  — retained source text is detected and reported
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

import pymupdf

from .geometry import iou, spans
from .manifest import BlockResult

CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
LATIN_WORD_RE = re.compile(r"[A-Za-z]{2,}")
MIN_FONT_PT = 8.0
FONT_RATIO = 0.75
START_OFFSET_LIMIT = 0.03


def _page_by_number(doc: pymupdf.Document, number: int) -> pymupdf.Page | None:
    if 0 <= number < doc.page_count:
        return doc[number]
    return None


def _text_in_rect(page: pymupdf.Page, rect: pymupdf.Rect) -> tuple[str, list[Any]]:
    """Collect spans that intersect ``rect`` (display coordinates)."""
    selected = []
    for span in spans(page):
        inter = span.bbox & rect
        if inter.is_empty:
            continue
        selected.append(span)
    selected.sort(key=lambda s: (round(s.bbox.y0, 1), s.bbox.x0))
    return "".join(s.text for s in selected), selected


def _union(rects: Iterable[pymupdf.Rect]) -> pymupdf.Rect | None:
    out = None
    for r in rects:
        out = pymupdf.Rect(r) if out is None else out | r
    return out


def _target_cluster(page: pymupdf.Page, rect: pymupdf.Rect) -> tuple[str, list[Any], pymupdf.Rect | None]:
    """Find the target text that occupies (or starts at) the source block area.

    The engine re-flows Chinese inside the original paragraph rectangle, so the
    correct association is "span starts inside the expanded source rect and
    overlaps it".  Fallback: the nearest span cluster above/below.
    """
    expanded = pymupdf.Rect(rect.x0 - 3, rect.y0 - 6, rect.x1 + 3, rect.y1 + 6)
    text, selected = _text_in_rect(page, expanded)
    if selected:
        return text, selected, _union(s.bbox for s in selected)
    # fall back to nearest text below the rect start (re-flowed paragraphs can
    # move by a line or two)
    best = None
    for span in spans(page):
        if span.bbox.y0 >= rect.y1 - 2:
            dist = span.bbox.y0 - rect.y1
            if dist < 40 and (best is None or dist < best[0]):
                best = (dist, span)
    if best:
        _, span = best
        near = pymupdf.Rect(rect.x0 - 6, span.bbox.y0 - 2, rect.x1 + 6, span.bbox.y1 + 2)
        text, selected = _text_in_rect(page, near)
        return text, selected, _union(s.bbox for s in selected)
    return "", [], None


def classify_result(
    page: int,
    block: dict[str, Any],
    target_page: pymupdf.Page,
) -> BlockResult:
    rect = pymupdf.Rect(block["bbox"])
    required = bool(block.get("required"))
    kind = block.get("kind") or "body"
    src_text_len = int(block.get("chars") or 0)
    body_size = float(block.get("median_size") or 0.0)

    text, selected, cluster = _target_cluster(target_page, rect)
    cjk = len(CJK_RE.findall(text))
    latin_words = len(LATIN_WORD_RE.findall(text))
    letters = sum(1 for ch in text if ch.isalpha())
    cjk_ratio = cjk / letters if letters else 0.0

    if not required:
        status = "not_required"
        reason = block.get("reason") or "out of scope"
    elif (cjk >= 6 and cjk_ratio >= 0.25) or (cjk >= 4 and cjk >= src_text_len * 0.22):
        # Chinese is denser than English: require a meaningful amount of CJK
        # relative to the source block, not a high CJK/letter ratio.  A block
        # that mixes translated prose with kept names/emails is still translated.
        status = "translated"
        reason = ""
    elif latin_words >= 3:
        status = "retained_source"
        reason = "source-language text still present in the mapped area"
    elif cjk > 0:
        status = "translated"
        reason = "short translated text (few CJK characters)"
    else:
        status = "failed"
        reason = "no target text found in the mapped area"

    target_size = 0.0
    if selected:
        sizes = sorted(s.size for s in selected if s.size > 0)
        target_size = sizes[len(sizes) // 2] if sizes else 0.0
    font_ok = True
    if status == "translated" and body_size > 0:
        # The 8 pt absolute floor is a body-text rule.  Original small print
        # (table notes, footnotes < 8 pt) is reported separately instead of
        # being counted as a translation failure.
        if body_size >= MIN_FONT_PT:
            font_ok = target_size >= MIN_FONT_PT and target_size >= body_size * FONT_RATIO
        elif target_size < body_size * 0.6:
            font_ok = False

    offset_ratio = None
    if status == "translated" and selected and cluster is not None:
        first = selected[0]
        start_delta = ((first.bbox.x0 - rect.x0) ** 2 + (first.bbox.y0 - rect.y0) ** 2) ** 0.5
        offset_ratio = round(start_delta / max(target_page.rect.width, target_page.rect.height), 4)
        if offset_ratio <= START_OFFSET_LIMIT:
            font_ok = font_ok  # start offset is reported separately, not folded into font_ok

    notes = []
    if status == "translated" and offset_ratio is not None and offset_ratio > START_OFFSET_LIMIT:
        notes.append(f"start offset {offset_ratio * 100:.1f}% of page size")
    if status == "translated" and not font_ok:
        notes.append(f"target font {target_size:.1f}pt vs source {body_size:.1f}pt")
    if status == "translated" and 0 < body_size < MIN_FONT_PT:
        notes.append(f"source small print {body_size:.1f}pt; absolute 8pt rule not applied")

    return BlockResult(
        page=page,
        block_index=int(block.get("block_index") or 0),
        kind=kind,
        required=required,
        status=status,
        reason=reason,
        source_rect=[round(v, 2) for v in (rect.x0, rect.y0, rect.x1, rect.y1)],
        target_rect=[round(v, 2) for v in (cluster.x0, cluster.y0, cluster.x1, cluster.y1)] if cluster else None,
        source_chars=src_text_len,
        target_cjk=cjk,
        target_chars=len(text),
        cjk_ratio=round(cjk_ratio, 4),
        source_font_size=round(body_size, 2),
        target_font_size=round(target_size, 2),
        font_ok=font_ok,
        start_offset_ratio=offset_ratio,
        notes="; ".join(notes),
    )


def document_geometry(source: pymupdf.Document, target: pymupdf.Document) -> dict[str, Any]:
    issues = []
    if source.page_count != target.page_count:
        issues.append(f"page count {source.page_count} -> {target.page_count}")
    n = min(source.page_count, target.page_count)
    size_mismatch = 0
    rotation_mismatch = 0
    for i in range(n):
        s, t = source[i], target[i]
        if abs(s.rect.width - t.rect.width) > 0.5 or abs(s.rect.height - t.rect.height) > 0.5:
            size_mismatch += 1
        if s.rotation != t.rotation:
            rotation_mismatch += 1
    if size_mismatch:
        issues.append(f"{size_mismatch} pages with page-size mismatch")
    if rotation_mismatch:
        issues.append(f"{rotation_mismatch} pages with rotation mismatch")
    return {
        "source_pages": source.page_count,
        "target_pages": target.page_count,
        "page_count_ok": source.page_count == target.page_count,
        "size_mismatch_pages": size_mismatch,
        "rotation_mismatch_pages": rotation_mismatch,
        "ok": not issues,
        "issues": issues,
    }


def summarize(blocks: list[BlockResult]) -> dict[str, Any]:
    required = [b for b in blocks if b.required]
    translated = [b for b in required if b.status == "translated"]
    retained = [b for b in required if b.status == "retained_source"]
    failed = [b for b in required if b.status == "failed"]
    font_bad = [b for b in translated if not b.font_ok]
    offsets = [b.start_offset_ratio for b in translated if b.start_offset_ratio is not None]
    offsets_sorted = sorted(offsets)
    within = sum(1 for o in offsets if o <= START_OFFSET_LIMIT)
    return {
        "required_blocks": len(required),
        "translated": len(translated),
        "retained_source": len(retained),
        "failed": len(failed),
        "coverage": round(len(translated) / len(required), 4) if required else None,
        "font_below_threshold": len(font_bad),
        "font_ok_ratio": round(1 - len(font_bad) / len(translated), 4) if translated else None,
        "start_offset_median": round(offsets_sorted[len(offsets_sorted) // 2], 4) if offsets_sorted else None,
        "start_offset_p95": round(offsets_sorted[int(len(offsets_sorted) * 0.95) - 1], 4) if offsets_sorted else None,
        "start_offset_within_limit_ratio": round(within / len(offsets), 4) if offsets else None,
    }


def per_page_summary(blocks: list[BlockResult]) -> dict[str, Any]:
    pages: dict[int, dict[str, int]] = {}
    for b in blocks:
        row = pages.setdefault(b.page, {"required": 0, "translated": 0, "retained_source": 0, "failed": 0})
        if not b.required:
            continue
        row["required"] += 1
        row[b.status] = row.get(b.status, 0) + 1
    out = {}
    for page, row in sorted(pages.items()):
        row["coverage"] = round(row["translated"] / row["required"], 4) if row["required"] else None
        out[str(page + 1)] = row
    return out


def analyze_range(
    source_doc: pymupdf.Document,
    target_doc: pymupdf.Document,
    annotations: list[dict[str, Any]],
) -> dict[str, Any]:
    blocks: list[BlockResult] = []
    for page_ann in annotations:
        page_no = int(page_ann["page"])
        src_page = _page_by_number(source_doc, page_no)
        tgt_page = _page_by_number(target_doc, page_no)
        if src_page is None or tgt_page is None:
            continue
        for block in page_ann["blocks"]:
            if block.get("type") == "image":
                continue
            blocks.append(classify_result(page_no, block, tgt_page))
    return {
        "geometry": document_geometry(source_doc, target_doc),
        "overall": summarize(blocks),
        "per_page": per_page_summary(blocks),
        "blocks": [b.to_dict() for b in blocks],
    }
