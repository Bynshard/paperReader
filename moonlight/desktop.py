"""Local library + AI backend for the Moonlight desktop app (JSONL sidecar).

The Electron main process owns window creation and file dialogs; this process
owns the SQLite database, PDF files and model calls.  The renderer never sees a
filesystem path, a credential or a shell: it asks for papers, page bytes and
job events by id, and every file operation is resolved against the library
root here.

Protocol (one JSON object per line, both directions)::

    -> {"id":1,"method":"import_pdfs","params":{"paths":[...]}}
    <- {"id":1,"ok":true,"result":[...]}
    <- {"event":"job","jobId":"...","seq":3,"phase":"translating"}

Methods are documented in ``METHODS`` at the bottom of this file.

Storage layout::

    <root>/library.db
    <root>/files/<sha256>.pdf              # immutable source copies
    <root>/derived/<paper>-<version>.pdf   # translated versions
    <root>/tmp/                            # staging, atomically renamed

The original user file is never modified and is not deleted when a paper is
removed; only files this process created under ``root`` are cleaned up.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, TextIO

import pymupdf

from . import PROTOCOL_VERSION, __version__
from .engine import BabelDocEngine, EngineConfig

DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+\b")
YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
ARXIV_RE = re.compile(r"arXiv:\s*(\d{4}\.\d{4,5})(v\d+)?", re.I)

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    authors TEXT NOT NULL DEFAULT '',
    year TEXT,
    venue TEXT,
    doi TEXT,
    arxiv TEXT,
    abstract TEXT,
    imported_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    read_status TEXT NOT NULL DEFAULT 'unread',
    deleted_at INTEGER,
    notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_papers_deleted ON papers(deleted_at);
CREATE INDEX IF NOT EXISTS idx_papers_doi ON papers(doi);

CREATE TABLE IF NOT EXISTS versions (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,              -- source | translated
    sha256 TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    pages INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    lang TEXT NOT NULL DEFAULT '',
    engine TEXT,
    model TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_paper ON versions(paper_id);

CREATE TABLE IF NOT EXISTS blocks (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    version_id TEXT NOT NULL,
    page INTEGER NOT NULL,
    block_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    bbox TEXT NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_paper_page ON blocks(paper_id, page);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    text, block_id UNINDEXED, paper_id UNINDEXED, page UNINDEXED, tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS paper_categories (
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (paper_id, category_id)
);

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT
);
CREATE TABLE IF NOT EXISTS paper_tags (
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (paper_id, tag_id)
);

CREATE TABLE IF NOT EXISTS annotations (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    version_kind TEXT NOT NULL DEFAULT 'source',
    page INTEGER NOT NULL,
    rects TEXT NOT NULL,
    quote TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT 'yellow',
    comment TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_annotations_paper ON annotations(paper_id);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL,
    status TEXT NOT NULL,
    pages TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    error TEXT,
    output_version_id TEXT
);

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,               -- explain | ask | summary
    context TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    sources TEXT NOT NULL,
    model TEXT,
    created_at INTEGER NOT NULL
);
"""


def now_ms() -> int:
    return int(time.time() * 1000)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def json_dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False)


class Library:
    def __init__(self, root: str | Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "files").mkdir(exist_ok=True)
        (self.root / "derived").mkdir(exist_ok=True)
        (self.root / "tmp").mkdir(exist_ok=True)
        self.db = sqlite3.connect(self.root / "library.db", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        if not self.db.execute("SELECT 1 FROM sqlite_master WHERE name='blocks_fts_insert_v2'").fetchone():
            self.db.executescript(Path(__file__).with_name('block_fts.sql').read_text())
        if 'version_id' not in {row[1] for row in self.db.execute('PRAGMA table_info(annotations)')}:
            self.db.execute('ALTER TABLE annotations ADD COLUMN version_id TEXT')
        self.lock = threading.RLock()
        self.jobs: dict[str, dict[str, Any]] = {}
        self.emit = lambda obj: None
        self._seed_categories()

    # -- helpers ----------------------------------------------------------
    def _seed_categories(self) -> None:
        with self.lock, self.db:
            if self.db.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
                for i, name in enumerate(("待读", "精读", "已读", "方法", "实验")):
                    self.db.execute("INSERT INTO categories(id,name,sort_order) VALUES(?,?,?)", (uuid.uuid4().hex, name, i))

    def _row_paper(self, row: sqlite3.Row) -> dict[str, Any]:
        p = dict(row)
        cats = self.db.execute(
            "SELECT c.id,c.name,c.color FROM categories c JOIN paper_categories pc ON pc.category_id=c.id WHERE pc.paper_id=?",
            (p["id"],),
        ).fetchall()
        tags = self.db.execute(
            "SELECT t.id,t.name,t.color FROM tags t JOIN paper_tags pt ON pt.tag_id=t.id WHERE pt.paper_id=?",
            (p["id"],),
        ).fetchall()
        p["categories"] = [dict(c) for c in cats]
        p["tags"] = [dict(t) for t in tags]
        p["versions"] = [dict(v) for v in self.db.execute("SELECT * FROM versions WHERE paper_id=? ORDER BY created_at", (p["id"],))]
        p["deleted"] = bool(p.get("deleted_at"))
        p["favorite"] = bool(p.get("favorite"))
        return p

    # -- import -----------------------------------------------------------
    def _extract_metadata(self, doc: pymupdf.Document) -> dict[str, Any]:
        meta = doc.metadata or {}
        first = doc[0]
        page_h = first.rect.height
        data = first.get_text("dict")
        raw_blocks = []
        for block in data["blocks"]:
            lines = []
            for line in block.get("lines", []):
                text = "".join(span["text"] for span in line["spans"]).strip()
                if not text:
                    continue
                size = max(span["size"] for span in line["spans"])
                lines.append((text, size))
            if lines:
                raw_blocks.append({"bbox": block["bbox"], "lines": lines})

        # Title: metadata first, then the largest type on the upper page.
        title = (meta.get("title") or "").strip()
        title_block = None
        if not title:
            candidates = [b for b in raw_blocks if b["bbox"][1] < page_h * 0.45]
            candidates.sort(key=lambda b: max(s for _, s in b["lines"]), reverse=True)
            for b in candidates:
                text = " ".join(t for t, _ in b["lines"]).strip()
                if 6 < len(text) < 300 and not text.lower().startswith(("arxiv", "http")):
                    title = text
                    title_block = b
                    break
        if not title:
            title = "Untitled"

        # Abstract heading block, used both as an author-band boundary and as
        # the start of the abstract text.
        abstract_block = None
        for b in raw_blocks:
            text = " ".join(t for t, _ in b["lines"]).strip()
            if re.match(r"(?i)^abstract\b", text):
                abstract_block = b
                break

        author_names: list[str] = []
        affiliation_words = re.compile(
            r"(?i)univers|institut|google|research|brain|department|school|college|laborator|inc\.|corp|@|http|www\."
        )
        name_re = re.compile(r"^[A-ZÀ-Ž][\w.'\-]*(?:\s+[A-ZÀ-Ž][\w.'\-]*){1,3}[\s*∗†‡§¶]*$")
        band_bottom = (abstract_block["bbox"][1] if abstract_block else page_h * 0.55)
        top = title_block["bbox"][3] if title_block else 0
        for b in raw_blocks:
            if b["bbox"][1] <= top or b["bbox"][1] >= band_bottom:
                continue
            if b["bbox"][1] > page_h * 0.55:
                continue
            for text, size in b["lines"]:
                text = text.strip()
                if not text or len(text) > 70 or affiliation_words.search(text):
                    continue
                if re.search(r"\d{2,}", text):
                    continue
                if name_re.match(text) or (1 <= len(text.split()) <= 4 and text.istitle()):
                    author_names.append(re.sub(r"[\s*∗†‡§¶]+$", "", text))
        authors = (meta.get("author") or "").strip() or ", ".join(dict.fromkeys(author_names[:10]))

        arxiv = None
        m = ARXIV_RE.search(first.get_text())
        if m:
            arxiv = m.group(1)
        doi = None
        m = DOI_RE.search(first.get_text())
        if m:
            doi = m.group(0).rstrip(".,;)")

        year = None
        if arxiv and len(arxiv) >= 4 and arxiv[:2].isdigit():
            yy = int(arxiv[:2])
            year = str(2000 + yy if yy < 90 else 1900 + yy)
        if not year:
            head_text = "\n".join(first.get_text().splitlines()[:60])
            years = [int(y) for y in YEAR_RE.findall(head_text)]
            years = [y for y in years if 1990 <= y <= 2030]
            year = str(max(years)) if years else (meta.get("creationDate") or "")[:4] or None

        abstract = None
        if abstract_block:
            texts = []
            started = False
            for b in raw_blocks:
                text = " ".join(t for t, _ in b["lines"]).strip()
                if b is abstract_block:
                    started = True
                    text = re.sub(r"(?i)^abstract\b[.:\s]*", "", text)
                elif started and re.match(r"(?i)^(1\s+)?introduction\b", text):
                    break
                if started and text:
                    texts.append(text)
            abstract = re.sub(r"\s+", " ", " ".join(texts)).strip()[:1800] or None

        venue = (meta.get("subject") or "").strip()
        if not venue:
            m = re.search(r"(?i)(NIPS|NeurIPS|ICLR|ICML|ACL|EMNLP|CVPR|ICCV|AAAI|OSDI|SOSP|SIGCOMM)\s*'?\d{2,4}", first.get_text())
            if m:
                venue = m.group(0)
        return {"title": title, "authors": authors, "year": year, "doi": doi, "arxiv": arxiv, "abstract": abstract, "venue": venue}

    def import_paths(self, paths: list[str], copy: bool = True) -> list[dict[str, Any]]:
        out = []
        for raw in paths:
            path = Path(raw)
            try:
                out.append(self._import_one(path, copy=copy))
            except Exception as exc:  # noqa: BLE001 - per-file failure is data
                out.append({"path": str(path), "status": "failed", "error": f"{type(exc).__name__}: {exc}"})
        return out

    def _import_one(self, path: Path, copy: bool = True) -> dict[str, Any]:
        if not path.exists() or path.suffix.lower() != ".pdf":
            raise ValueError("not a PDF file")
        sha = sha256_file(path)
        with self.lock:
            row = self.db.execute(
                "SELECT p.id,p.title,p.deleted_at FROM versions v JOIN papers p ON p.id=v.paper_id WHERE v.sha256=? AND v.kind='source'",
                (sha,),
            ).fetchone()
            if row:
                if row["deleted_at"]:
                    self.db.execute("UPDATE papers SET deleted_at=NULL WHERE id=?", (row["id"],))
                    self.db.commit()
                return {"status": "duplicate", "paper_id": row["id"], "title": row["title"], "sha256": sha}

        doc = pymupdf.open(path)
        try:
            meta = self._extract_metadata(doc)
            pages = doc.page_count
            full_text = "\n".join(doc[i].get_text() for i in range(min(pages, 80)))
        finally:
            doc.close()

        paper_id = uuid.uuid4().hex
        version_id = uuid.uuid4().hex
        rel = f"files/{sha}.pdf"
        dest = self.root / rel
        if copy:
            tmp = self.root / "tmp" / f"{paper_id}.pdf"
            shutil.copy2(path, tmp)
            os.replace(tmp, dest)
        else:
            # external reference: keep the original path, never copy
            rel = str(path)
            dest = path

        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    paper_id,
                    meta["title"] or path.stem,
                    meta["authors"] or "",
                    meta["year"],
                    meta["venue"] or "",
                    meta["doi"],
                    meta["arxiv"],
                    meta["abstract"],
                    now_ms(),
                    now_ms(),
                ),
            )
            self.db.execute(
                "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (version_id, paper_id, "source", sha, rel, pages, dest.stat().st_size, "en", now_ms()),
            )
            self._index_blocks(paper_id, version_id, full_text, page_count=pages)
        return {"status": "imported", "paper_id": paper_id, "version_id": version_id, "title": meta["title"], "pages": pages, "sha256": sha}

    def _index_blocks(self, paper_id: str, version_id: str, text: str, page_count: int) -> None:
        # The search index uses a lightweight paragraph split; exact block
        # geometry is added lazily when a page is opened for AI/annotation.
        chunks = [c.strip() for c in re.split(r"\n\s*\n", text) if len(c.strip()) > 40]
        for i, chunk in enumerate(chunks[:4000]):
            bid = uuid.uuid4().hex
            self.db.execute(
                "INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,?,?,?,?,?)",
                (bid, paper_id, version_id, 0, i, "text", "[]", chunk),
            )

    def ensure_page_blocks(self, paper_id: str, version_id: str) -> None:
        """Replace the coarse text index with real page/block geometry (idempotent)."""
        row = self.db.execute("SELECT rel_path FROM versions WHERE id=? AND paper_id=?", (version_id, paper_id)).fetchone()
        if not row:
            raise KeyError("version not found")
        path = self.root / row["rel_path"] if not Path(row["rel_path"]).is_absolute() else Path(row["rel_path"])
        has_geometry = self.db.execute(
            "SELECT 1 FROM blocks WHERE paper_id=? AND version_id=? AND bbox!='[]' LIMIT 1", (paper_id, version_id)
        ).fetchone()
        if has_geometry:
            return
        doc = pymupdf.open(path)
        try:
            with self.lock, self.db:
                self.db.execute("DELETE FROM blocks WHERE paper_id=? AND version_id=?", (paper_id, version_id))
                for pno in range(doc.page_count):
                    for idx, block in enumerate(doc[pno].get_text("blocks")):
                        text = (block[4] or "").strip()
                        if not text:
                            continue
                        kind = "text"
                        bid = uuid.uuid4().hex
                        self.db.execute(
                            "INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,?,?,?,?,?)",
                            (bid, paper_id, version_id, pno, idx, kind, json_dumps([round(v, 2) for v in block[:4]]), text),
                        )
        finally:
            doc.close()

    # -- library queries --------------------------------------------------
    def list_papers(self, query: str = "", category: str | None = None, tag: str | None = None, trashed: bool = False, status: str | None = None) -> list[dict[str, Any]]:
        sql = "SELECT DISTINCT p.* FROM papers p"
        where = []
        args: list[Any] = []
        if category:
            sql += " JOIN paper_categories pc ON pc.paper_id=p.id"
            where.append("pc.category_id=?")
            args.append(category)
        if tag:
            sql += " JOIN paper_tags pt ON pt.paper_id=p.id JOIN tags t ON t.id=pt.tag_id"
            where.append("t.name=?")
            args.append(tag)
        if query:
            like = f"%{query}%"
            where.append(
                "(p.title LIKE ? OR p.authors LIKE ? OR p.doi LIKE ? OR p.abstract LIKE ? OR p.id IN (SELECT paper_id FROM blocks_fts WHERE blocks_fts MATCH ?))"
            )
            args += [like, like, like, like, f'"{query}"*']
        where.append("p.deleted_at IS NOT NULL" if trashed else "p.deleted_at IS NULL")
        if status:
            where.append("p.read_status=?")
            args.append(status)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY p.favorite DESC, p.imported_at DESC"
        with self.lock:
            rows = self.db.execute(sql, args).fetchall()
            return [self._row_paper(r) for r in rows]

    def get_paper(self, paper_id: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM papers WHERE id=?", (paper_id,)).fetchone()
        if not row:
            raise KeyError("paper not found")
        return self._row_paper(row)

    def update_paper(self, paper_id: str, fields: dict[str, Any]) -> dict[str, Any]:
        allowed = {"title", "authors", "year", "venue", "doi", "arxiv", "abstract", "read_status", "favorite", "notes"}
        sets = []
        args: list[Any] = []
        for k, v in fields.items():
            if k not in allowed:
                continue
            sets.append(f"{k}=?")
            args.append(int(v) if k == "favorite" else v)
        if sets:
            sets.append("updated_at=?")
            args.append(now_ms())
            args.append(paper_id)
            with self.lock, self.db:
                self.db.execute(f"UPDATE papers SET {', '.join(sets)} WHERE id=?", args)
        return self.get_paper(paper_id)

    def trash_paper(self, paper_id: str) -> None:
        with self.lock, self.db:
            self.db.execute("UPDATE papers SET deleted_at=? WHERE id=?", (now_ms(), paper_id))

    def restore_paper(self, paper_id: str) -> None:
        with self.lock, self.db:
            self.db.execute("UPDATE papers SET deleted_at=NULL WHERE id=?", (paper_id,))

    def purge_paper(self, paper_id: str) -> dict[str, Any]:
        """Remove DB rows and only the files this app owns."""
        with self.lock:
            versions = self.db.execute("SELECT rel_path FROM versions WHERE paper_id=?", (paper_id,)).fetchall()
            removed = []
            for v in versions:
                p = Path(v["rel_path"])
                full = p if p.is_absolute() else self.root / p
                if not p.is_absolute() and full.exists():
                    full.unlink()
                    removed.append(str(full))
            with self.db:
                self.db.execute("DELETE FROM papers WHERE id=?", (paper_id,))
            return {"removed_files": removed}

    # -- tags / categories ------------------------------------------------
    def list_taxonomy(self) -> dict[str, Any]:
        cats = [dict(r) for r in self.db.execute("SELECT * FROM categories ORDER BY sort_order,name")]
        tags = [dict(r) for r in self.db.execute("SELECT * FROM tags ORDER BY name")]
        return {"categories": cats, "tags": tags}

    def set_categories(self, paper_id: str, category_ids: list[str]) -> None:
        with self.lock, self.db:
            self.db.execute("DELETE FROM paper_categories WHERE paper_id=?", (paper_id,))
            for cid in category_ids:
                self.db.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)", (paper_id, cid))

    def set_tags(self, paper_id: str, names: list[str]) -> None:
        with self.lock, self.db:
            self.db.execute("DELETE FROM paper_tags WHERE paper_id=?", (paper_id,))
            for name in names:
                name = name.strip()
                if not name:
                    continue
                row = self.db.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()
                tid = row["id"] if row else uuid.uuid4().hex
                if not row:
                    self.db.execute("INSERT INTO tags(id,name) VALUES(?,?)", (tid, name))
                self.db.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) VALUES(?,?)", (paper_id, tid))

    def add_category(self, name: str) -> dict[str, Any]:
        cid = uuid.uuid4().hex
        with self.lock, self.db:
            self.db.execute("INSERT INTO categories(id,name,sort_order) VALUES(?,?,?)", (cid, name, now_ms()))
        return {"id": cid, "name": name}

    # -- annotations ------------------------------------------------------
    def add_annotation(self, paper_id: str, page: int, rects: list[dict[str, float]], quote: str, color: str = "yellow", comment: str = "", version_kind: str = "source", version_id: str | None = None) -> dict[str, Any]:
        aid = uuid.uuid4().hex
        with self.lock, self.db:
            if page < 0 or version_kind not in ("source", "translated"):
                raise ValueError("invalid annotation page or version kind")
            if version_id:
                version = self.db.execute("SELECT paper_id,kind,pages FROM versions WHERE id=?", (version_id,)).fetchone()
                if not version or version['paper_id'] != paper_id or version['kind'] != version_kind or page >= version['pages']:
                    raise ValueError("annotation does not belong to this paper version and page")
            self.db.execute(
                "INSERT INTO annotations(id,paper_id,version_kind,page,rects,quote,color,comment,created_at,updated_at,version_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (aid, paper_id, version_kind, page, json_dumps(rects), quote, color, comment, now_ms(), now_ms(), version_id),
            )
        return {"id": aid}

    def update_annotation(self, annotation_id: str, fields: dict[str, Any]) -> None:
        sets, args = [], []
        for k in ("comment", "color"):
            if k in fields:
                sets.append(f"{k}=?")
                args.append(fields[k])
        if not sets:
            return
        sets.append("updated_at=?")
        args += [now_ms(), annotation_id]
        with self.lock, self.db:
            self.db.execute(f"UPDATE annotations SET {', '.join(sets)} WHERE id=?", args)

    def delete_annotation(self, annotation_id: str) -> None:
        with self.lock, self.db:
            self.db.execute("DELETE FROM annotations WHERE id=?", (annotation_id,))

    def list_annotations(self, paper_id: str) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM annotations WHERE paper_id=? ORDER BY page,created_at", (paper_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["rects"] = json.loads(d["rects"])
            out.append(d)
        return out

    # -- exports ----------------------------------------------------------
    def export(self, paper_ids: list[str], fmt: str = "bibtex") -> str:
        rows = []
        for pid in paper_ids:
            row = self.db.execute("SELECT * FROM papers WHERE id=?", (pid,)).fetchone()
            if row:
                rows.append(dict(row))
        if fmt == "ris":
            return "\n".join(self._ris(r) for r in rows)
        return "\n\n".join(self._bibtex(r) for r in rows)

    @staticmethod
    def _bibtex(p: dict[str, Any]) -> str:
        key = re.sub(r"[^A-Za-z0-9]+", "", (p["authors"].split(",")[0] if p["authors"] else "anon"))[:20] or "anon"
        key += str(p["year"] or "")
        authors = " and ".join(a.strip() for a in re.split(r",|;| and ", p["authors"] or "") if a.strip())
        fields = [
            ("title", p["title"]),
            ("author", authors),
            ("year", p["year"]),
            ("journal", p["venue"]),
            ("doi", p["doi"]),
            ("eprint", p["arxiv"]),
        ]
        body = ",\n".join(f"  {k} = {{{v}}}" for k, v in fields if v)
        return f"@article{{{key},\n{body}\n}}"

    @staticmethod
    def _ris(p: dict[str, Any]) -> str:
        lines = ["TY  - JOUR", f"TI  - {p['title']}"]
        for a in re.split(r",|;| and ", p["authors"] or ""):
            if a.strip():
                lines.append(f"AU  - {a.strip()}")
        for tag, key in (("PY", "year"), ("JO", "venue"), ("DO", "doi")):
            if p[key]:
                lines.append(f"{tag}  - {p[key]}")
        lines.append("ER  - ")
        return "\n".join(lines)

    # -- AI ---------------------------------------------------------------
    def _model_client(self):
        from .gateway import Gateway, UsageLog, serve

        key = os.environ.get("MOONLIGHT_UPSTREAM_KEY") or ""
        if not key:
            raise RuntimeError("model credential is not configured")
        gateway = Gateway(
            upstream=os.environ.get("MOONLIGHT_UPSTREAM", "https://opencode.ai/zen/go/v1"),
            model=os.environ.get("MOONLIGHT_MODEL", "qwen3.8-flash"),
            key=key,
            provider="openai",
            log=UsageLog(self.root / "model-usage.jsonl"),
        )
        httpd, token, base_url = serve(gateway)
        import httpx

        return httpx.Client(base_url=base_url.rstrip("/"), headers={"Authorization": f"Bearer {token}"}, timeout=300), httpd

    def translate_text(self, text: str) -> dict[str, Any]:
        client, httpd = self._model_client()
        try:
            resp = client.post(
                "/chat/completions",
                json={
                    "model": os.environ.get("MOONLIGHT_MODEL", "qwen3.8-flash"),
                    "messages": [
                        {"role": "system", "content": "你是英文学术论文的翻译。只输出简体中文译文，保留公式、变量名和引用编号，不添加解释。"},
                        {"role": "user", "content": text},
                    ],
                    "temperature": 0.1,
                },
            )
            resp.raise_for_status()
            out = resp.json()["choices"][0]["message"].get("content") or ""
        finally:
            client.close()
            httpd.shutdown()
        return {"text": out.strip()}

    def explain(self, paper_id: str, question: str, block_ids: list[str] | None = None, page: int | None = None, kind: str = "explain") -> dict[str, Any]:
        self.ensure_page_blocks(paper_id, self._source_version(paper_id))
        evidence = self._evidence(paper_id, question, block_ids, page)
        context_lines = []
        for i, b in enumerate(evidence, 1):
            context_lines.append(f"[{i}] (p.{b['page'] + 1}) {b['text']}")
        context = "\n\n".join(context_lines) or "(no matching passage)"
        prompt = (
            "你是论文阅读助手。只依据给出的原文片段回答；如果片段不足以回答，明确说“原文信息不足”，"
            "不要编造实验、数字或引用。用简体中文回答，引用片段时写成 [1]、[2]。\n\n"
            f"原文片段：\n{context}\n\n问题：{question}"
        )
        client, httpd = self._model_client()
        try:
            resp = client.post(
                "/chat/completions",
                json={
                    "model": os.environ.get("MOONLIGHT_MODEL", "qwen3.8-flash"),
                    "messages": [
                        {"role": "system", "content": "你是严谨的科研阅读助手。"},
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.1,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            answer = data["choices"][0]["message"].get("content") or ""
        finally:
            client.close()
            httpd.shutdown()
        sources = [
            {"n": i + 1, "block_id": b["id"], "page": b["page"], "bbox": json.loads(b["bbox"]), "text": b["text"][:300]}
            for i, b in enumerate(evidence)
        ]
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO chats(id,paper_id,kind,context,question,answer,sources,model,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex, paper_id, kind, kind, question, answer, json_dumps(sources), os.environ.get("MOONLIGHT_MODEL"), now_ms()),
            )
        return {"answer": answer, "sources": sources}

    def _source_version(self, paper_id: str) -> str:
        row = self.db.execute("SELECT id FROM versions WHERE paper_id=? AND kind='source' LIMIT 1", (paper_id,)).fetchone()
        if not row:
            raise KeyError("no source version")
        return row["id"]

    def _evidence(self, paper_id: str, question: str, block_ids: list[str] | None, page: int | None) -> list[dict[str, Any]]:
        if block_ids:
            marks = ",".join("?" for _ in block_ids)
            rows = self.db.execute(f"SELECT * FROM blocks WHERE paper_id=? AND id IN ({marks})", [paper_id, *block_ids]).fetchall()
            return [dict(r) for r in rows]
        if page is not None:
            rows = self.db.execute("SELECT * FROM blocks WHERE paper_id=? AND page=? ORDER BY block_index", (paper_id, page)).fetchall()
            return [dict(r) for r in rows][:12]
        try:
            rows = self.db.execute(
                "SELECT b.* FROM blocks_fts f JOIN blocks b ON b.id=f.block_id WHERE blocks_fts MATCH ? AND b.paper_id=? LIMIT 8",
                (f'"{question}"', paper_id),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = []
        if not rows:
            rows = self.db.execute("SELECT * FROM blocks WHERE paper_id=? LIMIT 8", (paper_id,)).fetchall()
        return [dict(r) for r in rows]

    # -- translation jobs -------------------------------------------------
    def start_translation(self, paper_id: str, pages: str | None = None) -> dict[str, Any]:
        paper = self.get_paper(paper_id)
        source = next((v for v in paper["versions"] if v["kind"] == "source"), None)
        if not source:
            raise KeyError("paper has no source PDF")
        job_id = uuid.uuid4().hex
        self.jobs[job_id] = {"cancel": threading.Event(), "status": "queued"}
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO jobs(id,paper_id,status,pages,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (job_id, paper_id, "queued", pages, now_ms(), now_ms()),
            )
        thread = threading.Thread(target=self._run_translation, args=(job_id, paper_id, source, pages), daemon=True)
        thread.start()
        return {"job_id": job_id}

    def _job_event(self, job_id: str, **kw: Any) -> None:
        self.emit({"event": "job", "jobId": job_id, **kw})

    def _set_job(self, job_id: str, status: str, error: str | None = None, version_id: str | None = None) -> None:
        with self.lock, self.db:
            self.db.execute(
                "UPDATE jobs SET status=?,updated_at=?,error=?,output_version_id=COALESCE(?,output_version_id) WHERE id=?",
                (status, now_ms(), error, version_id, job_id),
            )
        self._job_event(job_id, status=status, error=error, outputVersionId=version_id)

    def _run_translation(self, job_id: str, paper_id: str, source: dict[str, Any], pages: str | None) -> None:
        cancel = self.jobs[job_id]["cancel"]
        src_path = Path(source["rel_path"]) if Path(source["rel_path"]).is_absolute() else self.root / source["rel_path"]
        run_dir = self.root / "tmp" / f"job-{job_id}"
        run_dir.mkdir(parents=True, exist_ok=True)
        try:
            self._set_job(job_id, "preparing")
            cfg = EngineConfig(
                model=os.environ.get("MOONLIGHT_MODEL", "qwen3.8-flash"),
                upstream=os.environ.get("MOONLIGHT_UPSTREAM", "https://opencode.ai/zen/go/v1"),
                key_env="MOONLIGHT_UPSTREAM_KEY",
            )
            engine = BabelDocEngine(cfg)
            self._set_job(job_id, "parsing")
            result = engine.translate(src_path, run_dir, pages=pages, cancel=cancel, progress=lambda ev: self._job_event(job_id, **{k: v for k, v in ev.items() if k != "ts"}))
            if cancel.is_set() or result["status"] == "cancelled":
                self._set_job(job_id, "cancelled")
                return
            if result["status"] != "completed" or not result.get("outputs"):
                self._set_job(job_id, "failed", error=f"engine status={result['status']}")
                return
            out_pdf = Path(result["outputs"][0])
            version_id = uuid.uuid4().hex
            dest_rel = f"derived/{paper_id}-{version_id}.pdf"
            dest = self.root / dest_rel
            tmp = dest.with_suffix(".tmp.pdf")
            shutil.copy2(out_pdf, tmp)
            os.replace(tmp, dest)
            doc = pymupdf.open(dest)
            try:
                pages_count = doc.page_count
            finally:
                doc.close()
            with self.lock, self.db:
                self.db.execute(
                    "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        version_id,
                        paper_id,
                        "translated",
                        sha256_file(dest),
                        dest_rel,
                        pages_count,
                        dest.stat().st_size,
                        "zh-CN",
                        json_dumps(engine.version_info()),
                        cfg.model,
                        now_ms(),
                    ),
                )
            self._set_job(job_id, "completed", version_id=version_id)
        except Exception as exc:  # noqa: BLE001 - job failure must be visible
            self._set_job(job_id, "failed", error=f"{type(exc).__name__}: {exc}")
        finally:
            self.jobs.pop(job_id, None)

    def cancel_job(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if job:
            job["cancel"].set()
            self._job_event(job_id, status="cancelling")

    # -- files ------------------------------------------------------------
    def version_path(self, version_id: str) -> Path:
        row = self.db.execute("SELECT rel_path FROM versions WHERE id=?", (version_id,)).fetchone()
        if not row:
            raise KeyError("version not found")
        p = Path(row["rel_path"])
        return p if p.is_absolute() else (self.root / p)

    def paper_pdf(self, paper_id: str, kind: str = "source") -> dict[str, Any]:
        row = self.db.execute(
            "SELECT * FROM versions WHERE paper_id=? AND kind=? ORDER BY created_at DESC LIMIT 1", (paper_id, kind)
        ).fetchone()
        if not row:
            raise KeyError(f"no {kind} version")
        path = self.version_path(row["id"])
        return {"version_id": row["id"], "path": str(path), "pages": row["pages"], "bytes": row["bytes"]}

    def search_blocks(self, paper_id: str, query: str, limit: int = 20) -> list[dict[str, Any]]:
        try:
            rows = self.db.execute(
                "SELECT b.* FROM blocks_fts f JOIN blocks b ON b.id=f.block_id WHERE blocks_fts MATCH ? AND b.paper_id=? LIMIT ?",
                (f'"{query}"', paper_id, limit),
            ).fetchall()
        except sqlite3.OperationalError:
            rows = self.db.execute(
                "SELECT * FROM blocks WHERE paper_id=? AND text LIKE ? LIMIT ?", (paper_id, f"%{query}%", limit)
            ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# JSONL dispatch
# ---------------------------------------------------------------------------

class Server:
    def __init__(self, lib: Library, out: TextIO):
        self.lib = lib
        self.out = out
        lib.emit = self._emit_event

    def _emit(self, obj: dict[str, Any]) -> None:
        self.out.write(json_dumps(obj) + "\n")
        self.out.flush()

    def _emit_event(self, obj: dict[str, Any]) -> None:
        self._emit({"protocol": PROTOCOL_VERSION, **obj})

    def _paper_or_fail(self, pid: str) -> dict[str, Any]:
        return self.lib.get_paper(pid)

    def handle(self, req: dict[str, Any]) -> None:
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        try:
            result = self.dispatch(method, params)
            self._emit({"protocol": PROTOCOL_VERSION, "id": rid, "ok": True, "result": result})
        except Exception as exc:  # noqa: BLE001 - errors are protocol data
            self._emit({"protocol": PROTOCOL_VERSION, "id": rid, "ok": False, "error": f"{type(exc).__name__}: {exc}"})

    def dispatch(self, method: str, p: dict[str, Any]) -> Any:
        lib = self.lib
        if method == "ping":
            return {"pong": True, "version": __version__}
        if method == "import_pdfs":
            return lib.import_paths(p["paths"], copy=p.get("copy", True))
        if method == "list_papers_page":
            from .paging import list_page
            with lib.lock:
                return list_page(lib.db, p)
        if method == "set_blocks":
            # This backend extracts its own exact geometry with PyMuPDF.
            lib.ensure_page_blocks(p["paper_id"], p["version_id"])
            return {"ok": True}
        if method == "list_papers":
            return lib.list_papers(p.get("query", ""), p.get("category"), p.get("tag"), p.get("trashed", False), p.get("status"))
        if method == "get_paper":
            return lib.get_paper(p["paper_id"])
        if method == "update_paper":
            return lib.update_paper(p["paper_id"], p.get("fields") or {})
        if method == "trash_paper":
            return lib.trash_paper(p["paper_id"]) or {"ok": True}
        if method == "restore_paper":
            return lib.restore_paper(p["paper_id"]) or {"ok": True}
        if method == "purge_paper":
            return lib.purge_paper(p["paper_id"])
        if method == "list_taxonomy":
            return lib.list_taxonomy()
        if method == "set_categories":
            return lib.set_categories(p["paper_id"], p.get("category_ids") or []) or {"ok": True}
        if method == "set_tags":
            return lib.set_tags(p["paper_id"], p.get("tags") or []) or {"ok": True}
        if method == "add_category":
            return lib.add_category(p["name"])
        if method == "list_annotations":
            return lib.list_annotations(p["paper_id"])
        if method == "add_annotation":
            return lib.add_annotation(
                p["paper_id"], int(p["page"]), p.get("rects") or [], p.get("quote", ""), p.get("color", "yellow"), p.get("comment", ""), p.get("version_kind", "source"), p.get("version_id")
            )
        if method == "update_annotation":
            return lib.update_annotation(p["annotation_id"], p.get("fields") or {}) or {"ok": True}
        if method == "delete_annotation":
            return lib.delete_annotation(p["annotation_id"]) or {"ok": True}
        if method == "export":
            return {"text": lib.export(p.get("paper_ids") or [], p.get("format", "bibtex"))}
        if method == "start_translate":
            return lib.start_translation(p["paper_id"], p.get("pages"))
        if method == "cancel_job":
            return lib.cancel_job(p["job_id"]) or {"ok": True}
        if method == "get_job":
            row = lib.db.execute("SELECT * FROM jobs WHERE id=?", (p["job_id"],)).fetchone()
            return dict(row) if row else None
        if method == "paper_pdf":
            return lib.paper_pdf(p["paper_id"], p.get("kind", "source"))
        if method == "version_path":
            return {"path": str(lib.version_path(p["version_id"]))}
        if method == "ensure_blocks":
            lib.ensure_page_blocks(p["paper_id"], p["version_id"])
            return {"ok": True}
        if method == "blocks":
            lib.ensure_page_blocks(p["paper_id"], p["version_id"])
            rows = lib.db.execute(
                "SELECT * FROM blocks WHERE paper_id=? AND version_id=? AND page=? ORDER BY block_index",
                (p["paper_id"], p["version_id"], int(p["page"])),
            ).fetchall()
            return [{**dict(r), "bbox": json.loads(r["bbox"])} for r in rows]
        if method == "translate_text":
            return lib.translate_text(p["text"])
        if method == "explain":
            return lib.explain(p["paper_id"], p.get("question", ""), p.get("block_ids"), p.get("page"), p.get("kind", "explain"))
        if method == "search_blocks":
            return lib.search_blocks(p["paper_id"], p["query"], int(p.get("limit", 20)))
        raise ValueError(f"unknown method {method}")


def main(argv: list[str] | None = None, stdin: TextIO | None = None, stdout: TextIO | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Moonlight desktop library sidecar")
    parser.add_argument("--root", default=os.environ.get("MOONLIGHT_LIBRARY", str(Path.home() / "MoonlightLibrary")))
    args = parser.parse_args(argv)
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    lib = Library(args.root)
    server = Server(lib, stdout)
    server._emit({"protocol": PROTOCOL_VERSION, "event": "ready", "version": __version__, "root": str(lib.root)})
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            server._emit({"protocol": PROTOCOL_VERSION, "event": "error", "message": "invalid json"})
            continue
        if req.get("method"):
            server.handle(req)
    return 0


if __name__ == "__main__":
    sys.exit(main())
