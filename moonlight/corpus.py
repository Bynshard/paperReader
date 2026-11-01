"""Frozen corpus manifest for M0.

The validation plan requires: exact PDF version, source, SHA256, page count,
page geometry, and a pre-annotation of which regions *should* be translated.
Nothing here downloads anything; ``freeze`` only records what is already on
disk so that a run can be reproduced and audited.

The manifest deliberately stores no paper text — only statistics and block
geometry — so it can be committed without redistributing copyrighted PDFs.
"""

from __future__ import annotations

import hashlib
import json
import platform
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import pymupdf

from . import __version__
from .geometry import block_candidates, column_of, page_geometry

PROTOCOL = 1
CJK_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
MATH_RE = re.compile(r"[=+\-−×÷∑∫√≈≤≥∞αβγδεθλμσφψωΔΩ∂∇∈∉⊂⊆∪∩→←↔]")
WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]{1,}")
CAPTION_RE = re.compile(r"^\s*(Figure|Fig\.|Table|Algorithm|Listing)\s*\d+", re.I)
REF_ITEM_RE = re.compile(r"^\s*\[\d{1,3}\]")
PAGE_NUM_RE = re.compile(r"^\s*(\d{1,4}|[ivx]{1,6})\s*$", re.I)


def sha256_file(path: str | Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            data = fh.read(chunk)
            if not data:
                break
            h.update(data)
    return h.hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _text_stats(text: str) -> dict[str, Any]:
    cjk = len(CJK_RE.findall(text))
    words = len(WORD_RE.findall(text))
    math = len(MATH_RE.findall(text))
    letters = sum(1 for ch in text if ch.isalpha())
    return {
        "chars": len(text),
        "cjk": cjk,
        "words": words,
        "math_ratio": round(math / letters, 4) if letters else 0.0,
    }


def profile_page(page: pymupdf.Page) -> dict[str, Any]:
    text = page.get_text()
    stats = _text_stats(text)
    blocks = block_candidates(page, image_blocks=True)
    text_blocks = [b for b in blocks if b["type"] == "text"]
    columns = {"left": 0, "right": 0, "full": 0}
    for b in text_blocks:
        columns[b["column"]] += 1
    sizes = [b["median_size"] for b in text_blocks if b["median_size"]]
    sizes.sort()
    return {
        "index": page.number,
        "text": stats,
        "blocks": len(text_blocks),
        "images": len(page.get_images(full=True)),
        "image_blocks": sum(1 for b in blocks if b["type"] == "image"),
        "drawings": len(page.get_drawings()),
        "columns": columns,
        "median_font_size": round(sizes[len(sizes) // 2], 2) if sizes else 0.0,
    }


def classify_block(block: dict[str, Any], page_text: str, body_size: float) -> dict[str, Any]:
    text = block.get("text") or ""
    kind = "body"
    required = True
    reason = ""
    if block["type"] == "image":
        return {**block, "kind": "image", "required": False, "reason": "raster object kept as-is"}
    if PAGE_NUM_RE.match(text):
        kind, required, reason = "page_number", False, "page furniture"
    elif CAPTION_RE.match(text):
        kind = "caption"
    elif REF_ITEM_RE.match(text):
        kind, required, reason = "reference_item", False, "bibliography entry (pre-listed, not scored as body)"
    elif re.match(r"^\s*(References|REFERENCES|Bibliography)\s*$", text):
        kind, required, reason = "heading", False, "bibliography heading"
    elif stats_math(text) > 0.12 and len(text) < 160:
        kind, required, reason = "formula", False, "standalone formula: preserved as object"
    elif block.get("median_size", 0) and body_size and block["median_size"] < body_size * 0.82:
        kind = "footnote_or_small"
        reason = "small text (footnote/header): separate category"
    return {
        **block,
        "kind": kind,
        "required": required,
        "reason": reason,
        "text_hash": hashlib.sha256(text.encode("utf-8")).hexdigest()[:16] if text else None,
        "chars": len(text),
        "cjk": len(CJK_RE.findall(text)),
    }


def stats_math(text: str) -> float:
    letters = sum(1 for ch in text if ch.isalpha())
    return len(MATH_RE.findall(text)) / letters if letters else 0.0


def annotate_page(page: pymupdf.Page) -> dict[str, Any]:
    prof = profile_page(page)
    body_size = prof["median_font_size"]
    blocks = [classify_block(b, page.get_text(), body_size) for b in block_candidates(page)]
    body = [b for b in blocks if b["kind"] == "body" and b["chars"] >= 40]
    return {
        "page": page.number,
        "geometry": page_geometry(page).to_dict(),
        "blocks": blocks,
        "required_blocks": sum(1 for b in blocks if b["required"]),
        "body_blocks": len(body),
    }


def freeze_sample(
    path: str | Path,
    sample_id: str,
    title: str,
    source: dict[str, Any],
    kind: str = "core",
    selected_pages: Iterable[int] | None = None,
    notes: str = "",
    annotate: bool = True,
) -> dict[str, Any]:
    path = Path(path)
    doc = pymupdf.open(path)
    try:
        geometries = [page_geometry(p).to_dict() for p in doc]
        profiles = [profile_page(p) for p in doc]
        pages = list(selected_pages) if selected_pages is not None else []
        annotations = []
        if annotate:
            for idx in pages:
                if 0 <= idx < doc.page_count:
                    annotations.append(annotate_page(doc[idx]))
        return {
            "id": sample_id,
            "kind": kind,
            "title": title,
            "file": str(path),
            "source": {**source, "sha256": sha256_file(path), "bytes": path.stat().st_size},
            "pages_total": doc.page_count,
            "page_geometries": geometries,
            "page_profiles": profiles,
            "selected_pages": pages,
            "annotations": annotations,
            "notes": notes,
            "frozen_at": _now(),
        }
    finally:
        doc.close()


def build_manifest(samples: list[dict[str, Any]], output: str | Path) -> dict[str, Any]:
    manifest = {
        "protocol": PROTOCOL,
        "generator": {
            "moonlight": __version__,
            "python": sys.version.split()[0],
            "pymupdf": pymupdf.__version__,
            "platform": platform.platform(),
        },
        "created_at": _now(),
        "samples": samples,
    }
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def load_manifest(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def coverage_summary(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for s in manifest["samples"]:
        required = sum(p.get("required_blocks", 0) for p in s.get("annotations", []))
        rows.append(
            {
                "id": s["id"],
                "pages_total": s["pages_total"],
                "selected_pages": s["selected_pages"],
                "required_blocks": required,
                "sha256": s["source"]["sha256"],
            }
        )
    return rows
