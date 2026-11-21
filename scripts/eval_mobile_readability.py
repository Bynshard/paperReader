"""Measure how a layout-preserved paper page reads on a phone-sized viewport.

Reads the two real corpus papers (source + BabelDOC Chinese output) and reports
page geometry, body-font statistics and the effective on-screen font size when
the page is fitted to a phone width.  Pure inspection: no app code involved.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
SOURCES = {
    "attn_en": ROOT / "corpus/raw/attn.pdf",
    "attn_zh": ROOT / "artifacts/validation/m0-20261031T1005/outputs/arxiv-1706.03762/attn.no_watermark.zh-CN.mono.pdf",
    "hybridflow_en": ROOT / "corpus/raw/hybridflow.pdf",
    "hybridflow_zh": ROOT / "artifacts/validation/m0-20261031T1005/outputs/arxiv-2409.19256/hybridflow.no_watermark.zh-CN.mono.pdf",
}
# CSS px widths of common Android phones in portrait (dp).
PHONES = {"compact_360": 360, "pixel_412": 412, "tablet_800": 800}


def span_stats(doc: pymupdf.Document, max_pages: int = 8):
    sizes: list[float] = []
    spans = 0
    cjk = 0
    chars = 0
    for page in doc[:max_pages]:
        data = page.get_text("dict")
        for block in data["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    text = span["text"].strip()
                    if not text:
                        continue
                    spans += 1
                    chars += len(text)
                    sizes.append(round(span["size"], 2))
                    if any("\u4e00" <= ch <= "\u9fff" for ch in text):
                        cjk += len(text)
    body = [s for s in sizes if s >= 6] or sizes
    return {
        "pages": doc.page_count,
        "spans_sampled": spans,
        "cjk_char_ratio": round(cjk / chars, 3) if chars else 0.0,
        "font_p50": round(statistics.median(body), 2) if body else None,
        "font_p10": round(statistics.quantiles(body, n=10)[0], 2) if len(body) > 10 else None,
        "font_p90": round(statistics.quantiles(body, n=10)[-1], 2) if len(body) > 10 else None,
        "distinct_sizes": len({s for s in sizes}),
    }


def main() -> int:
    report: dict = {"phones_dp": PHONES, "documents": {}}
    for name, path in SOURCES.items():
        if not path.exists():
            report["documents"][name] = {"error": f"missing {path}"}
            continue
        doc = pymupdf.open(path)
        page = doc[1] if doc.page_count > 1 else doc[0]
        rect = page.rect
        stats = span_stats(doc)
        # Body-text column width: widest text line in the middle of page 2 is a
        # reasonable proxy for a column; page width / 2 for two-column papers.
        lines = []
        for block in page.get_text("dict")["blocks"]:
            if block.get("type") != 0:
                continue
            for line in block["lines"]:
                if sum(len(s["text"].strip()) for s in line["spans"]) > 25:
                    lines.append((line["bbox"][2] - line["bbox"][0], line["bbox"]))
        col = statistics.median([w for w, _ in lines]) if lines else rect.width
        fit = {k: round(w / rect.width, 3) for k, w in PHONES.items()}
        p50 = stats["font_p50"]
        report["documents"][name] = {
            "file": str(path.relative_to(ROOT)),
            "page_pt": [round(rect.width, 1), round(rect.height, 1)],
            "text_columns_page2": 2 if col < rect.width * 0.52 else 1,
            "median_text_line_pt": round(col, 1),
            "stats": stats,
            "fit_width_scale": fit,
            "effective_px_at_fit_width": {
                k: round(p50 * s, 2) for k, s in fit.items()
            } if p50 else None,
            "columns_per_phone_view_at_100pct": {
                k: round(w / col, 2) for k, w in PHONES.items()
            },
        }
        doc.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
