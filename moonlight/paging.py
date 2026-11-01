"""Bounded list protocol for the optional Python compatibility backend.

The Rust backend owns the measured performance path. If its trigram indexes
already exist in a shared library, use them; otherwise retain token search.
"""
from __future__ import annotations
import sqlite3
from typing import Any

def list_page(db: sqlite3.Connection, options: dict[str, Any]) -> dict[str, Any]:
    offset = max(0, int(options.get("offset") or 0))
    limit = min(200, max(1, int(options.get("limit") or 100)))
    where = ["p.deleted_at IS NOT NULL" if options.get("trashed") else "p.deleted_at IS NULL"]
    args: list[Any] = []
    if options.get("favorite"):
        where.append("p.favorite=1")
    for key, sql in (
        ("status", "p.read_status=?"),
        ("category", "p.id IN (SELECT paper_id FROM paper_categories WHERE category_id=?)"),
        ("tag", "p.id IN (SELECT r.paper_id FROM paper_tags r JOIN tags t ON t.id=r.tag_id WHERE t.name=?)"),
    ):
        if options.get(key):
            where.append(sql)
            args.append(options[key])
    query = str(options.get("query") or "").strip()[:256]
    if query:
        quoted = '"' + query.replace('"', '""') + '"'
        indexed = db.execute("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('papers_search','blocks_search')").fetchone()[0] == 2
        if indexed and len(query) >= 3:
            where.append("p.rowid IN (SELECT rowid FROM papers_search WHERE papers_search MATCH ? UNION SELECT p2.rowid FROM papers p2 JOIN blocks b ON b.paper_id=p2.id WHERE b.rowid IN (SELECT rowid FROM blocks_search WHERE blocks_search MATCH ?))")
            args += [quoted, quoted]
        else:
            literal = query.replace('!', '!!').replace('%', '!%').replace('_', '!_')
            where.append("(p.title LIKE ? ESCAPE '!' OR p.authors LIKE ? ESCAPE '!' OR p.doi LIKE ? ESCAPE '!' OR p.id IN (SELECT paper_id FROM blocks_fts WHERE blocks_fts MATCH ?))")
            args += [f"%{literal}%"] * 3 + [quoted + '*']
    predicate = ' AND '.join(where)
    total = db.execute(f"SELECT COUNT(*) FROM papers p WHERE {predicate}", args).fetchone()[0]
    order = {"title": "p.title COLLATE NOCASE,p.id", "year": "p.year DESC,p.id DESC"}.get(options.get('sort'), "p.imported_at DESC,p.id DESC")
    rows = db.execute(f"SELECT p.id,p.title,p.authors,p.year,p.venue,p.doi,p.arxiv,p.imported_at,p.updated_at,p.favorite,p.read_status,p.deleted_at IS NOT NULL AS deleted,EXISTS(SELECT 1 FROM versions v WHERE v.paper_id=p.id AND v.kind='translated') AS has_translation FROM papers p WHERE {predicate} ORDER BY {order} LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        for key in ('favorite', 'deleted', 'has_translation'):
            item[key] = bool(item[key])
        item.update(categories=[], tags=[])
        items.append(item)
    positions = {item['id']: item for item in items}
    if positions:
        placeholders = ','.join('?' for _ in positions)
        for field, relation, entity, fk in (('categories','paper_categories','categories','category_id'),('tags','paper_tags','tags','tag_id')):
            for row in db.execute(f"SELECT r.paper_id,e.id,e.name,e.color FROM {relation} r JOIN {entity} e ON e.id=r.{fk} WHERE r.paper_id IN ({placeholders}) ORDER BY e.name,e.id", list(positions)):
                positions[row['paper_id']][field].append({key:row[key] for key in ('id','name','color')})
    return dict(items=items,total=total,offset=offset,limit=limit)
