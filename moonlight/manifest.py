"""Run/block status model and artifact manifest.

Status vocabulary is fixed by docs/DESIGN.md:

    translated | retained_source | unsupported | failed

``not_required`` is used for regions the annotation decided are out of scope
(bibliography items, page furniture, standalone formulas, images).  The
coverage metric never counts those in the denominator, and never counts a
retained/failed region as success.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

STATUSES = ("translated", "retained_source", "unsupported", "failed", "not_required")
RUN_STATES = (
    "queued",
    "preparing",
    "parsing",
    "translating",
    "typesetting",
    "validating",
    "completed",
    "completed_with_fallbacks",
    "cancelling",
    "cancelled",
    "failed",
)


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def new_run_id(prefix: str = "m0") -> str:
    return f"{prefix}-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}"


@dataclass
class BlockResult:
    page: int
    block_index: int
    kind: str
    required: bool
    status: str
    reason: str
    source_rect: list[float]
    target_rect: list[float] | None
    source_chars: int
    target_cjk: int
    target_chars: int
    cjk_ratio: float
    source_font_size: float
    target_font_size: float
    font_ok: bool
    start_offset_ratio: float | None
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TranslationRun:
    run_id: str
    sample_id: str
    source_sha256: str
    pages_requested: str
    status: str = "queued"
    started_at: str = now()
    finished_at: str | None = None
    engine: dict[str, Any] = field(default_factory=dict)
    model: dict[str, Any] = field(default_factory=dict)
    language: dict[str, Any] = field(default_factory=lambda: {"in": "en", "out": "zh-CN"})
    outputs: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, Any] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)

    def event(self, **kwargs: Any) -> None:
        self.events.append({"ts": now(), **kwargs})

    def finish(self, status: str) -> None:
        self.status = status
        self.finished_at = now()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class ArtifactWriter:
    """Writes run artifacts in a crash-safe order (files first, manifest last)."""

    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, *parts: str) -> Path:
        p = self.root.joinpath(*parts)
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def write_json(self, relative: str, payload: Any) -> Path:
        p = self.path(relative)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(p)
        return p

    def write_text(self, relative: str, text: str) -> Path:
        p = self.path(relative)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(p)
        return p

    def write_jsonl(self, relative: str, rows: Iterable[dict[str, Any]]) -> Path:
        p = self.path(relative)
        tmp = p.with_suffix(p.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        tmp.replace(p)
        return p


def review_rows(blocks: Iterable[BlockResult]) -> list[dict[str, Any]]:
    """Rows for review.csv: automatic measurement + empty human verdicts."""
    rows = []
    for b in blocks:
        rows.append(
            {
                "page": b.page + 1,
                "block": b.block_index,
                "kind": b.kind,
                "required": int(b.required),
                "status": b.status,
                "reason": b.reason,
                "source_chars": b.source_chars,
                "target_cjk": b.target_cjk,
                "cjk_ratio": b.cjk_ratio,
                "source_font": round(b.source_font_size, 2),
                "target_font": round(b.target_font_size, 2),
                "font_ok": int(b.font_ok),
                "start_offset_pct": None if b.start_offset_ratio is None else round(b.start_offset_ratio * 100, 2),
                "layout_ok": "",
                "semantic_ok": "",
                "reviewer": "",
                "review_notes": "",
            }
        )
    return rows


def write_review_csv(path: str | Path, rows: list[dict[str, Any]]) -> Path:
    import csv

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return path
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    return path
