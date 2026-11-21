"""Column-crop feasibility: how readable is a two-column paper page on a phone
when the viewport is fitted to ONE column instead of the whole page?

This is the cheapest mobile reading mode (no reflow, no layout analysis): pan
vertically inside a column, swipe to switch columns.  The script detects the
column split from the text-span x-histogram, then reports the resulting scale
and the effective body-text size in CSS px for common phone widths.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
FILES = {
    "attn_zh": ROOT / "artifacts/validation/m0-20261031T1005/outputs/arxiv-1706.03762/attn.no_watermark.zh-CN.mono.pdf",
    "hybridflow_zh": ROOT / "artifacts/validation/m0-20261031T1005/outputs/arxiv-2409.19256/hybridflow.no_watermark.zh-CN.mono.pdf",
}
PHONES = {"compact_360": 360, "pixel_412": 412}


def column_split(page: pymupdf.Page):
    """Return (left_col_bbox, right_col_bbox) or None for single column."""
    spans = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if len(span["text"].strip()) < 8:
                    continue
                x0, y0, x1, y1 = span["bbox"]
                if y1 - y0 > 30:  # skip rotated / display text
                    continue
                spans.append((x0, x1, y0, y1, span["size"]))
    if not spans:
        return None
    mid = page.rect.width / 2
    left = [s for s in spans if s[1] <= mid + 12]
    right = [s for s in spans if s[0] >= mid - 12]
    if len(left) < 20 or len(right) < 20:
        return None
    lb = (min(s[0] for s in left), min(s[2] for s in left), max(s[1] for s in left), max(s[3] for s in left))
    rb = (min(s[0] for s in right), min(s[2] for s in right), max(s[1] for s in right), max(s[3] for s in right))
    body = [s[4] for s in spans if 8 <= s[4] <= 12]
    return {"left": [round(v, 1) for v in lb], "right": [round(v, 1) for v in rb],
            "body_font_pt": round(statistics.median(body), 2) if body else None,
            "body_spans": len(body)}


def main() -> int:
    out = {"phones_dp": PHONES, "documents": {}}
    for name, path in FILES.items():
        if not path.exists():
            out["documents"][name] = {"error": f"missing {path}"}
            continue
        doc = pymupdf.open(path)
        per_page = []
        for index in (1, 2, 3, 4):
            if index >= doc.page_count:
                break
            page = doc[index]
            split = column_split(page)
            per_page.append({"page": index + 1, "split": split})
        doc.close()
        entry = {"file": str(path.relative_to(ROOT)), "pages": per_page}
        valid = [p["split"] for p in per_page if p["split"]]
        if not valid:
            # Single-column page: the useful crop is the text bounding box
            # (margins carry no reading value on a phone).
            doc = pymupdf.open(path)
            widths, fonts = [], []
            for index in (1, 2, 3, 4):
                if index >= doc.page_count:
                    break
                page = doc[index]
                xs0, xs1, sizes = [], [], []
                for block in page.get_text("dict")["blocks"]:
                    if block.get("type") != 0:
                        continue
                    for line in block["lines"]:
                        for span in line["spans"]:
                            if len(span["text"].strip()) < 8 or (span["bbox"][3] - span["bbox"][1]) > 30:
                                continue
                            xs0.append(span["bbox"][0])
                            xs1.append(span["bbox"][2])
                            if 8 <= span["size"] <= 12:
                                sizes.append(span["size"])
                if xs0:
                    widths.append(max(xs1) - min(xs0))
                    fonts.extend(sizes)
            doc.close()
            if widths:
                col_w = statistics.median(widths)
                font = statistics.median(fonts) if fonts else 10.0
                entry["layout"] = "single_column"
                entry["text_box_width_pt"] = round(col_w, 1)
                entry["scale_fit_textbox"] = {k: round((w - 12) / col_w, 2) for k, w in PHONES.items()}
                entry["effective_body_px"] = {k: round(font * (w - 12) / col_w, 1) for k, w in PHONES.items()}
                entry["body_font_pt"] = round(font, 2)
            out["documents"][name] = entry
        if valid:
            widths = [(s["left"][2] - s["left"][0], s["right"][2] - s["right"][0]) for s in valid]
            col_w = statistics.mean([sum(w) / 2 for w in widths])
            font = statistics.median([s["body_font_pt"] for s in valid if s["body_font_pt"]])
            # phone width minus 12dp side padding
            entry["layout"]="two_column"
            entry["column_detected_on_pages"] = f"{len(valid)}/{len(per_page)}"
            entry["mean_column_width_pt"] = round(col_w, 1)
            entry["scale_fit_column"] = {k: round((w - 12) / col_w, 2) for k, w in PHONES.items()}
            entry["effective_body_px"] = {k: round(font * (w - 12) / col_w, 1) for k, w in PHONES.items()}
            entry["body_font_pt"] = round(font, 2)
        out["documents"][name] = entry
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
