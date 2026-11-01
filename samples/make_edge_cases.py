"""Generate controllable boundary samples with known content.

These do not substitute for real papers; they exercise specific failure modes:

* ``rotated-cropbox.pdf`` — page with /Rotate 90 and a non-zero CropBox;
* ``narrow-column.pdf``  — long English text in a very narrow column, the
  classic "translation does not fit" case;
* ``scanned-page.pdf``   — raster-only page (no text layer);
* ``encrypted.pdf``      — password protected, must fail explicitly not crash;
* ``corrupt.pdf``        — truncated PDF header (must be rejected).

Run: python -m samples.make_edge_cases --out samples/generated
"""

from __future__ import annotations

import argparse
from pathlib import Path

import pymupdf

BODY = (
    "Layout-preserving translation must keep the page geometry, the reading order and the "
    "relationship between figures, captions and equations. A paragraph that cannot be placed "
    "back into its original region must be shown as untranslated with a visible reason, and its "
    "translation offered in a side panel instead of being clipped or shrunk without bound."
)


def rotated_cropbox(out: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_textbox(pymupdf.Rect(72, 72, 540, 300), BODY, fontsize=11, fontname="helv")
    page.set_cropbox(pymupdf.Rect(40, 50, 580, 742))
    page.set_rotation(90)
    out.mkdir(parents=True, exist_ok=True)
    path = out / "rotated-cropbox.pdf"
    doc.save(path)
    doc.close()
    return path


def narrow_column(out: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    rect = pymupdf.Rect(72, 72, 150, 700)
    page.insert_textbox(rect, BODY * 2, fontsize=9, fontname="helv")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "narrow-column.pdf"
    doc.save(path)
    doc.close()
    return path


def scanned_page(out: Path) -> Path:
    tmp = pymupdf.open()
    page = tmp.new_page(width=612, height=792)
    page.insert_textbox(pymupdf.Rect(72, 72, 540, 300), BODY, fontsize=12, fontname="helv")
    pix = page.get_pixmap(dpi=200)
    scan = pymupdf.open()
    p2 = scan.new_page(width=612, height=792)
    p2.insert_image(p2.rect, stream=pix.tobytes("png"))
    out.mkdir(parents=True, exist_ok=True)
    path = out / "scanned-page.pdf"
    scan.save(path)
    scan.close()
    tmp.close()
    return path


def encrypted(out: Path) -> Path:
    doc = pymupdf.open()
    page = doc.new_page(width=612, height=792)
    page.insert_textbox(pymupdf.Rect(72, 72, 540, 300), BODY, fontsize=11, fontname="helv")
    out.mkdir(parents=True, exist_ok=True)
    path = out / "encrypted.pdf"
    doc.save(path, encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="moonlight", owner_pw="moonlight")
    doc.close()
    return path


def corrupt(out: Path) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    path = out / "corrupt.pdf"
    data = b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"
    path.write_bytes(data[: max(10, len(data) - 8)])
    return path


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="samples/generated")
    args = parser.parse_args(argv)
    out = Path(args.out)
    for fn in (rotated_cropbox, narrow_column, scanned_page, encrypted, corrupt):
        print(fn(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
