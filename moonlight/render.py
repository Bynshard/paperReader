"""Rendering helpers for visual evidence (off-screen, no GUI required)."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Sequence

import pymupdf
from PIL import Image, ImageDraw, ImageFont


def render_page(doc: pymupdf.Document, index: int, dpi: int = 110) -> Image.Image:
    page = doc[index]
    pix = page.get_pixmap(dpi=dpi, alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def render_rect(doc: pymupdf.Document, index: int, rect: Sequence[float], dpi: int = 200, pad: float = 4.0) -> Image.Image:
    page = doc[index]
    clip = pymupdf.Rect(rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad) & page.rect
    pix = page.get_pixmap(dpi=dpi, clip=clip, alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples)


def _font(size: int = 18) -> ImageFont.ImageFont:
    for name in ("DejaVuSans.ttf", "NotoSansCJK-Regular.ttc", "msyh.ttc"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def side_by_side(images: Iterable[tuple[str, Image.Image]], gap: int = 12, header: int = 34) -> Image.Image:
    items = list(images)
    if not items:
        raise ValueError("no images")
    width = sum(img.width for _, img in items) + gap * (len(items) + 1)
    height = max(img.height for _, img in items) + header + gap * 2
    canvas = Image.new("RGB", (width, height), (245, 245, 245))
    draw = ImageDraw.Draw(canvas)
    x = gap
    font = _font(18)
    for label, img in items:
        draw.rectangle([x - 2, header + gap - 2, x + img.width + 2, header + gap + img.height + 2], outline=(180, 180, 180))
        canvas.paste(img, (x, header + gap))
        draw.text((x + 4, 8), label, fill=(20, 20, 20), font=font)
        x += img.width + gap
    return canvas


def save(img: Image.Image, path: str | Path, max_width: int | None = 2400) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if max_width and img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)
    img.save(path, optimize=True)
    return path


def page_thumbnail(doc: pymupdf.Document, index: int, dpi: int = 60) -> Image.Image:
    return render_page(doc, index, dpi=dpi)
