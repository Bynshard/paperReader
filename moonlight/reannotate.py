"""Re-derive annotation scope (required / not required) for the frozen corpus.

Rationale: the first annotation pass marked every text block as required body
text.  That inflates the denominator with regions the design explicitly keeps
out of scope — reference continuations, author/affiliation metadata on page 1,
figure-internal labels, footnotes and page furniture.  The rendered outputs are
not changed here; only the "should this region be translated" decision is
corrected, with the rules written down so a reviewer can re-check them.

Rules (applied to every selected page, before looking at any new output):

* page 1, between title and the "Abstract" heading -> ``metadata``, not required
* everything after a "References" heading, or on a page dominated by ``[n]``
  entries -> ``reference_item``, not required
* block centre inside a large vector drawing and short text -> ``figure_label``
* smaller type near the bottom of the page -> ``footnote``
* arXiv/venue furniture -> ``furniture``
* everything else keeps its previous kind and ``required`` flag

Run: python -m moonlight.reannotate --corpus corpus/corpus.json
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pymupdf

REF_HEAD = re.compile(r"(?i)^\s*(references|bibliography)\s*$")
REF_ITEM = re.compile(r"^\s*\[\d+\]")
FURNITURE = re.compile(r"(?i)(arXiv:\d|conference on neural information|EuroSys|USENIX|Proceedings of the|Permission to make digital|ACM ISBN|Copyright)")
TITLE_SIZE_RATIO = 1.25


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


FORMULA_ONLY = re.compile(r"^[\s\d\.\(\)\[\]\{\}\+\-−=×·,;:/|]+$")
MATH_FONT = re.compile(r"(?i)(cmmi|cmsy|cmex|cmr|math|stix|symbol|libertinemath|latinmodern-math)")
ALGO_LINE = re.compile(r"(?m)^\s*(\d+:|Input:|Output:|Procedure|return\b|for all\b|if\b|while\b|for\b)")
ALGO_CAPTION = re.compile(r"(?i)^\s*Algorithm\s+\d+")
CITATION = re.compile(r"(?i)^(ACM Reference Format|Cite this article|©|Copyright)")


def page_images(page: pymupdf.Page) -> list[pymupdf.Rect]:
    rects = []
    try:
        for info in page.get_image_info():
            r = pymupdf.Rect(info["bbox"])
            if r.width > 80 and r.height > 60:
                rects.append(r)
    except Exception:
        pass
    return rects


def _short_lines(text: str) -> bool:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    if len(lines) < 2:
        return False
    short = sum(1 for l in lines if len(l) <= 32)
    return short / len(lines) >= 0.6 and not re.search(r"[.!?]\s*$", lines[-1])


def _is_formula_block(page: pymupdf.Page, rect: pymupdf.Rect, text: str) -> bool:
    """Formula detection by font class and symbol density (not by output)."""
    if len(text) > 400:
        return False
    math_chars = sum(1 for ch in text if ch in "=+−×·√∑∫≈≤≥∈←→∂∇±")
    letters = sum(1 for ch in text if ch.isalpha())
    if letters and math_chars / max(1, letters) > 0.25:
        return True
    try:
        info = page.get_text("dict", clip=rect)
    except Exception:
        return False
    total = 0
    math = 0
    for block in info.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                n = len(span.get("text") or "")
                total += n
                if MATH_FONT.search(span.get("font") or ""):
                    math += n
    return total > 0 and math / total >= 0.5


def _covered(rect: pymupdf.Rect, regions: list[pymupdf.Rect], ratio: float) -> bool:
    """True when most of the block area falls inside a figure region.

    A block can straddle a vector drawing's bounding box without being figure
    content (body text next to a figure).  Requiring an area ratio avoids both
    false positives (body next to a drawing) and the earlier false negatives
    (a text block slightly larger than its drawing).
    """
    area = abs(rect.get_area())
    if area <= 0:
        return False
    for region in regions:
        inter = rect & region
        if not inter.is_empty and abs(inter.get_area()) / area >= ratio:
            return True
    return False


def page_drawings(page: pymupdf.Page) -> list[pymupdf.Rect]:
    rects = []
    try:
        for d in page.get_drawings():
            r = pymupdf.Rect(d["rect"])
            if r.width > 80 and r.height > 40 and r.get_area() > 4000:
                rects.append(r)
    except Exception:
        pass
    return rects


def annotate(page: pymupdf.Page, page_index: int, blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    height = page.rect.height
    drawings = page_drawings(page)
    images = page_images(page)
    tables = []
    cells = []
    try:
        for t in page.find_tables().tables:
            tables.append(pymupdf.Rect(t.bbox))
            for c in t.cells:
                if c is not None:
                    cells.append(pymupdf.Rect(c))
    except Exception:
        pass
    fig_caption = [b for b in blocks if re.match(r"(?i)^\s*Figure\s+\d", b.get("text") or "")]
    fig_bottom = 0.0
    if fig_caption:
        fig_bottom = max([b["bbox"][3] for b in fig_caption] + [r.y1 for r in drawings] + [r.y1 for r in images])
        fig_bottom = min(page.rect.height * 0.7, fig_bottom + 6)
    body_size = max((b.get("median_size") or 0 for b in blocks if b.get("chars", 0) > 200), default=0)

    # locate structural headings
    ref_start = None
    abstract_start = None
    title_index = max(range(len(blocks)), key=lambda i: blocks[i].get("median_size") or 0) if blocks else None
    ref_dominated = sum(1 for b in blocks if REF_ITEM.match(b["text"])) >= 3
    for i, b in enumerate(blocks):
        if ref_start is None and REF_HEAD.match(b["text"]):
            ref_start = i
        if abstract_start is None and re.match(r"(?i)^\s*abstract\b", b["text"]):
            abstract_start = i

    out = []
    algo_caption = any(ALGO_CAPTION.match(b.get("text") or "") for b in blocks)
    for i, b in enumerate(blocks):
        kind = b.get("kind") or "body"
        required = bool(b.get("required", True))
        reason = b.get("reason") or ""
        text = b.get("text") or ""
        rect = pymupdf.Rect(b["bbox"])
        size = float(b.get("median_size") or 0)
        chars = int(b.get("chars") or len(text))

        if FURNITURE.search(text[:120]):
            kind, required, reason = "furniture", False, "page header/footer, not body text"
        elif ref_dominated or (ref_start is not None and i >= ref_start):
            kind, required, reason = "reference_item", False, "reference entry: kept in source form"
        elif page_index == 0 and abstract_start is not None and i < abstract_start and i != title_index:
            kind, required, reason = "metadata", False, "author/affiliation metadata, not body prose"
        elif cells and any(c.contains(pymupdf.Point((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2)) for c in cells):
            kind, required, reason = "table_cell", False, "table cell: structure preserved, not body prose"
        elif (
            _covered(rect, drawings + images, 0.6)
            and not re.match(r"(?i)^\s*(figure|table|algorithm)\b", text)
        ):
            kind, required, reason = "figure_label", False, "text inside a figure (kept as part of the original artwork)"
        elif algo_caption and (ALGO_LINE.search(text) or (chars <= 12 and any(ch in text for ch in "𝑈∈←×"))) and chars < 400:
            kind, required, reason = "algorithm_line", False, "algorithm listing: kept as formal structure"
        elif _is_formula_block(page, rect, text):
            kind, required, reason = "formula_label", False, "formula object: preserved, not body prose"
        elif CITATION.match(text) or "ACM Reference Format" in text[:80]:
            kind, required, reason = "citation", False, "citation/metadata block, kept as source"
        elif chars <= 20 and FORMULA_ONLY.match(text):
            kind, required, reason = "formula_label", False, "equation number / numeric label"
        elif re.fullmatch(r"(\d+\s*\n?)+", text.strip()) and chars <= 20:
            kind, required, reason = "line_number", False, "algorithm/table line numbers"
        elif body_size and size < body_size * 0.88 and rect.y0 > height * 0.72 and chars < 400:
            kind, required, reason = "footnote", False, "footnote / small print"
        elif kind in ("reference_item",):
            required = False

        nb = dict(b)
        nb["kind"] = kind
        nb["required"] = required
        nb["reason"] = reason
        out.append(nb)
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default="corpus/corpus.json")
    parser.add_argument("--out", default=None)
    args = parser.parse_args(argv)
    path = Path(args.corpus)
    data = json.loads(path.read_text(encoding="utf-8"))
    backup = path.with_suffix(".v1.json")
    if not backup.exists():
        shutil.copy2(path, backup)
    for sample in data["samples"]:
        doc = pymupdf.open(sample["file"])
        try:
            for ann in sample.get("annotations", []):
                page = doc[ann["page"]]
                ann["blocks"] = annotate(page, ann["page"], ann["blocks"])
                ann["required_blocks"] = sum(1 for b in ann["blocks"] if b.get("required"))
                ann["body_blocks"] = sum(1 for b in ann["blocks"] if b.get("kind") == "body" and b.get("required"))
        finally:
            doc.close()
    data["annotation_revision"] = 2
    data["annotation_rules"] = "metadata/reference/figure-label/footnote/furniture excluded from required coverage"
    data["reannotated_at"] = now()
    out = Path(args.out) if args.out else path
    out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(a["required_blocks"] for s in data["samples"] for a in s.get("annotations", []))
    print(f"annotations updated: {total} required blocks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
