"""Render the measured phone-reading comparison for the Android evaluation.

Left  : whole page fitted to a 412 dp phone  -> body text ~6.7 px (unreadable)
Right : one column cropped and fitted       -> body text ~15.9 px (readable)

Both panels use the real BabelDOC Chinese output for HybridFlow (p.3), so the
picture is the actual product output, not a mock.
"""
from __future__ import annotations

from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "artifacts/validation/m0-20261031T1005/outputs/arxiv-2409.19256/hybridflow.no_watermark.zh-CN.mono.pdf"
OUT = ROOT / "docs/assets/android-reading-fit.png"
PHONE_W = 412
HEADER = 56
GAP = 28


def fit_rect(page: pymupdf.Page, rect: pymupdf.Rect, width: int) -> Image.Image:
    zoom = width / rect.width
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=rect, alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def column_bbox(page: pymupdf.Page) -> pymupdf.Rect:
    mid = page.rect.width / 2
    left_spans = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if len(span["text"].strip()) < 8 or (span["bbox"][3] - span["bbox"][1]) > 30:
                    continue
                if span["bbox"][2] <= mid + 12:
                    left_spans.append(span["bbox"])
    xs0 = min(s[0] for s in left_spans)
    xs1 = max(s[2] for s in left_spans)
    ys0 = min(s[1] for s in left_spans)
    ys1 = max(s[3] for s in left_spans)
    pad = 6
    return pymupdf.Rect(xs0 - pad, max(page.rect.y0, ys0 - pad), xs1 + pad, min(page.rect.y1, ys1 + pad))


def main() -> int:
    doc = pymupdf.open(SRC)
    page = doc[2]
    whole = fit_rect(page, page.rect, PHONE_W)
    col = fit_rect(page, column_bbox(page), PHONE_W)
    doc.close()

    height = HEADER + max(whole.height, col.height) + 16
    canvas = Image.new("RGB", (PHONE_W * 2 + GAP, height), "#f6f4ef")
    canvas.paste(whole, (0, HEADER))
    canvas.paste(col, (PHONE_W + GAP, HEADER))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 20)
        small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 15)
    except OSError:
        font = small = ImageFont.load_default()
    draw.text((0, 8), "fit page: 6.7 px body", fill="#7a2626", font=font)
    draw.text((PHONE_W + GAP, 8), "fit one column: 15.9 px body", fill="#1d5c47", font=font)
    draw.text((0, 34), "412 dp phone, real BabelDOC output (HybridFlow p.3)", fill="#5b5b5b", font=small)
    for x, color in ((0, "#c9c4b8"), (PHONE_W + GAP, "#c9c4b8")):
        draw.rectangle([x, HEADER - 1, x + PHONE_W - 1, height - 1], outline=color)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(OUT)
    print(f"wrote {OUT} ({canvas.width}x{canvas.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
