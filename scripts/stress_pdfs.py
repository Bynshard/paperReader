"""Deterministic long, scanned and dense-vector PDF fixtures (no model)."""
from pathlib import Path
import pymupdf


def create(directory: Path, source: Path):
    directory.mkdir(parents=True,exist_ok=True)
    result=[]
    long=directory/'long-300.pdf'
    if not long.exists():
        with pymupdf.open() as doc:
            doc.set_metadata(dict(title='Stress fixture: 300 pages'))
            for n in range(300):
                page=doc.new_page()
                page.insert_textbox((40,40,550,780),f'Page {n+1}. '+('Long document reading benchmark. '*50),fontsize=10)
            doc.save(long,deflate=True)
    result.append(('long_300_pages',long))
    scan=directory/'scanned-12.pdf'
    if not scan.exists():
        with pymupdf.open(source) as original, pymupdf.open() as doc:
            doc.set_metadata(dict(title='Stress fixture: scanned pages'))
            for n in range(12):
                raster=original[n%len(original)].get_pixmap(dpi=150)
                page=doc.new_page()
                page.insert_image(page.rect,stream=raster.tobytes('jpeg'))
            doc.save(scan,deflate=True)
    result.append(('scanned_12_pages',scan))
    vector=directory/'vectors-6.pdf'
    if not vector.exists():
        with pymupdf.open() as doc:
            doc.set_metadata(dict(title='Stress fixture: dense vector diagrams'))
            for n in range(6):
                page=doc.new_page()
                page.insert_text((40,40),f'Dense vector page {n+1}')
                shape=page.new_shape()
                for k in range(12000):
                    x=40+(k*17)%500;y=70+(k*31)%680
                    shape.draw_line((x,y),(40+(k*43)%500,70+(k*53)%680))
                shape.finish(color=(.2,.4,.6),width=.2)
                shape.commit()
            doc.save(vector,deflate=True)
    result.append(('dense_vector_6_pages',vector))
    return result
