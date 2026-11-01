"""Page geometry helpers.

Coordinate protocol (see docs/DESIGN.md, section "原文与译文对应关系"):

* All coordinates exposed by this module are *display* coordinates: PDF points,
  origin at the top-left of the rotated, cropped page, y growing downwards.
  This is exactly what ``page.rect`` reports and what a reader sees.
* The persisted form is ``{"page": i, "rect": [...], "page_size": [w, h],
  "rotation": r, "cropbox": [...], "mediabox": [...], "protocol": 1}``.
* Conversion from raw PDF user space to display space uses PyMuPDF's
  ``page.rotation_matrix``; ``from_display`` uses its inverse.  Both are
  checked in ``tests/test_geometry.py`` against ``page.rect``.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any, Iterable, Sequence

import pymupdf

PROTOCOL = 1
EPS = 1e-6


def _r(value: float) -> float:
    return round(float(value), 4)


@dataclass(frozen=True)
class PageGeometry:
    index: int
    width: float
    height: float
    rotation: int
    cropbox: tuple[float, float, float, float]
    mediabox: tuple[float, float, float, float]

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["protocol"] = PROTOCOL
        return d


def page_geometry(page: pymupdf.Page, index: int | None = None) -> PageGeometry:
    rect = page.rect
    crop = page.cropbox
    media = page.mediabox
    return PageGeometry(
        index=int(page.number if index is None else index),
        width=_r(rect.width),
        height=_r(rect.height),
        rotation=int(page.rotation or 0),
        cropbox=tuple(_r(v) for v in (crop.x0, crop.y0, crop.x1, crop.y1)),
        mediabox=tuple(_r(v) for v in (media.x0, media.y0, media.x1, media.y1)),
    )


def to_display(page: pymupdf.Page, rect: Sequence[float]) -> pymupdf.Rect:
    """Map a rect from (possibly rotated) user space to display space."""
    return pymupdf.Rect(rect) * page.rotation_matrix


def from_display(page: pymupdf.Page, rect: Sequence[float]) -> pymupdf.Rect:
    """Map a display-space rect back to user space."""
    return pymupdf.Rect(rect) * page.derotation_matrix


def display_rect_to_fractions(page: pymupdf.Page, rect: pymupdf.Rect) -> dict[str, float]:
    r = page.rect
    return {
        "x0": (rect.x0 - r.x0) / r.width,
        "y0": (rect.y0 - r.y0) / r.height,
        "x1": (rect.x1 - r.x0) / r.width,
        "y1": (rect.y1 - r.y0) / r.height,
    }


def iou(a: pymupdf.Rect, b: pymupdf.Rect) -> float:
    inter = a & b
    if inter.is_empty:
        return 0.0
    ia = inter.width * inter.height
    union = a.width * a.height + b.width * b.height - ia
    return ia / union if union > 0 else 0.0


def column_of(page: pymupdf.Page, rect: pymupdf.Rect, gutter: float | None = None) -> str:
    """Classify a block as left/right/full column using the page mid-line."""
    mid = page.rect.x0 + page.rect.width / 2
    g = gutter if gutter is not None else max(6.0, page.rect.width * 0.01)
    if rect.x1 <= mid - g * 0.25:
        return "left"
    if rect.x0 >= mid + g * 0.25:
        return "right"
    return "full"


@dataclass
class TextSpan:
    text: str
    bbox: pymupdf.Rect
    size: float
    font: str
    color: int


def spans(page: pymupdf.Page) -> list[TextSpan]:
    out: list[TextSpan] = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                text = span.get("text") or ""
                if not text.strip():
                    continue
                out.append(
                    TextSpan(
                        text=text,
                        bbox=pymupdf.Rect(span["bbox"]),
                        size=float(span.get("size") or 0.0),
                        font=str(span.get("font") or ""),
                        color=int(span.get("color") or 0),
                    )
                )
    return out


def block_candidates(page: pymupdf.Page, image_blocks: bool = False) -> list[dict[str, Any]]:
    """Extract source text blocks / image blocks in display coordinates.

    These are *candidates*: the annotation step in M0 decides which ones are
    required to be translated (``not_required`` covers references, page
    numbers, or already-Chinese content).
    """
    out: list[dict[str, Any]] = []
    for bi, block in enumerate(page.get_text("dict")["blocks"]):
        btype = block.get("type")
        if btype == 1 and not image_blocks:
            continue
        bbox = pymupdf.Rect(block["bbox"])
        text = ""
        sizes: list[float] = []
        fonts: list[str] = []
        if btype == 0:
            for line in block.get("lines", []):
                parts = [s.get("text", "") for s in line.get("spans", [])]
                text += "".join(parts) + "\n"
                for s in line.get("spans", []):
                    if s.get("text", "").strip():
                        sizes.append(float(s.get("size") or 0))
                        fonts.append(str(s.get("font") or ""))
        out.append(
            {
                "block_index": bi,
                "type": "text" if btype == 0 else "image",
                "bbox": [bbox.x0, bbox.y0, bbox.x1, bbox.y1],
                "column": column_of(page, bbox),
                "text": text.strip(),
                "line_count": len(block.get("lines", []) or []),
                "median_size": sorted(sizes)[len(sizes) // 2] if sizes else 0.0,
                "font": fonts[0] if fonts else "",
            }
        )
    return out
