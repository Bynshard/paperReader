//! Library organization: folder hierarchy, additive bulk assignments and short notes.
use crate::library::{Library,now_ms};
use anyhow::{Result,anyhow,ensure};
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};
use std::collections::{HashMap,HashSet};
pub fn initialize(conn:&rusqlite::Connection)->Result<()> {
    for (table,column,definition) in [
        ("categories","parent_id","TEXT"),("papers","short_note","TEXT NOT NULL DEFAULT ''"),
        ("papers","citation_count","INTEGER"),("papers","citation_source","TEXT"),
        ("papers","citation_updated_at","INTEGER"),("papers","citation_url","TEXT"),
    ] {
        let exists=conn.prepare(&format!("PRAGMA table_info({table})"))?.query_map([],|r|r.get::<_,String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?.iter().any(|name|name==column);
        if !exists{conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))?;}
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_category_parent ON categories(parent_id,sort_order,name); CREATE INDEX IF NOT EXISTS idx_papers_citations ON papers(deleted_at,citation_count DESC,imported_at DESC,id DESC); CREATE TRIGGER IF NOT EXISTS citation_identity_changed AFTER UPDATE OF doi,arxiv ON papers WHEN OLD.doi IS NOT NEW.doi OR OLD.arxiv IS NOT NEW.arxiv BEGIN UPDATE papers SET citation_count=NULL,citation_source=NULL,citation_updated_at=NULL,citation_url=NULL WHERE id=NEW.id; END;")?;
    Ok(())
}
pub fn folder_save(lib:&Library,p:&Value)->Result<Value> {
    let name=p["name"].as_str().unwrap_or("").trim();ensure!(!name.is_empty()&&name.chars().count()<=100,"目录名应为 1–100 字");
    let id=p["id"].as_str().map(str::to_string).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    let parent=p["parent_id"].as_str().filter(|s|!s.is_empty());
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    if p["id"].is_string(){ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id=?)",[&id],|r|r.get::<_,bool>(0))?,"目录不存在");}
    let mut seen=HashSet::from([id.clone()]);let mut cursor=parent.map(str::to_string);
    while let Some(ancestor)=cursor {
        ensure!(seen.insert(ancestor.clone()),"不能把目录移到自己或其子目录下面");ensure!(seen.len()<=32,"目录最多支持 32 层");
        cursor=tx.query_row("SELECT parent_id FROM categories WHERE id=?",[&ancestor],|r|r.get::<_,Option<String>>(0)).optional()?.ok_or_else(||anyhow!("上级目录不存在"))?;
    }
    let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id!=?)",params![parent,name,id],|r|r.get(0))?;
    ensure!(!duplicate,"同一目录下已有这个名称");
    tx.execute("INSERT INTO categories(id,name,parent_id,sort_order) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id",params![id,name,parent,now_ms()])?;
    validate_tree(&tx)?;tx.commit()?;Ok(json!({"id":id,"name":name,"parent_id":parent}))
}
// Folder deletion never deletes papers: children are lifted one level, which
// keeps every remaining path valid, and only the folder links are removed.
pub fn folder_delete(lib:&Library,p:&Value)->Result<Value> {
    let id=category_param(p,"请选择要删除的目录")?;
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    let parent:Option<String>=tx.query_row("SELECT parent_id FROM categories WHERE id=?",[&id],|r|r.get(0)).optional()?.ok_or_else(||anyhow!("目录不存在"))?;
    let children=tx.execute("UPDATE categories SET parent_id=? WHERE parent_id=?",params![parent,id])?;
    let papers=tx.execute("DELETE FROM paper_categories WHERE category_id=?",[&id])?;
    tx.execute("DELETE FROM categories WHERE id=?",[&id])?;
    validate_tree(&tx)?;tx.commit()?;
    Ok(json!({"ok":true,"deleted":id,"parent_id":parent,"reparented":children,"papers_unassigned":papers}))
}
pub fn folder_move(lib:&Library,p:&Value)->Result<Value> {
    let id=category_param(p,"请选择要移动的目录")?;
    let name:String={let conn=lib.conn();conn.query_row("SELECT name FROM categories WHERE id=?",[&id],|r|r.get(0)).optional()?.ok_or_else(||anyhow!("目录不存在"))?};
    let mut saved=folder_save(lib,&json!({"id":id,"name":name,"parent_id":p["parent_id"].clone()}))?;
    saved["ok"]=json!(true);Ok(saved)
}
// Merging keeps the target: its papers absorb the source's papers, the source
// disappears and its children are lifted to the source's old parent.
pub fn folder_merge(lib:&Library,p:&Value)->Result<Value> {
    let source=p["source_id"].as_str().or_else(||p["category_id"].as_str()).filter(|s|!s.is_empty()).ok_or_else(||anyhow!("请选择要合并的目录"))?;
    let target=p["target_id"].as_str().filter(|s|!s.is_empty()).ok_or_else(||anyhow!("请选择合并到的目录"))?;
    ensure!(source!=target,"不能把目录合并到自身");
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    let parent:Option<String>=tx.query_row("SELECT parent_id FROM categories WHERE id=?",[source],|r|r.get(0)).optional()?.ok_or_else(||anyhow!("目录不存在"))?;
    ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id=?)",[target],|r|r.get::<_,bool>(0))?,"目标目录不存在");
    let papers=tx.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) SELECT paper_id,? FROM paper_categories WHERE category_id=?",params![target,source])?;
    let children=tx.execute("UPDATE categories SET parent_id=? WHERE parent_id=?",params![parent,source])?;
    tx.execute("DELETE FROM paper_categories WHERE category_id=?",[source])?;
    tx.execute("DELETE FROM categories WHERE id=?",[source])?;
    validate_tree(&tx)?;tx.commit()?;
    Ok(json!({"ok":true,"merged":source,"into":target,"papers_moved":papers,"reparented":children}))
}
fn category_param(p:&Value,missing:&str)->Result<String> {
    p["category_id"].as_str().or_else(||p["id"].as_str()).filter(|s|!s.is_empty()).map(str::to_string).ok_or_else(||anyhow!("{missing}"))
}
pub fn bulk_assign(lib:&Library,p:&Value)->Result<Value> {
    let ids=p["paper_ids"].as_array().ok_or_else(||anyhow!("请选择论文"))?;ensure!(!ids.is_empty()&&ids.len()<=200,"一次最多操作 200 篇论文");
    let folder=p["category_id"].as_str().filter(|s|!s.is_empty());
    let tags=p["tags"].as_array().cloned().unwrap_or_default();ensure!(tags.len()<=50,"一次最多添加 50 个标签");
    ensure!(folder.is_some()||!tags.is_empty(),"请选择目录或填写标签");
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    if let Some(folder)=folder{ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id=?)",[folder],|r|r.get::<_,bool>(0))?,"目录不存在");}
    let mut tag_ids=vec![];
    for tag in tags {let name=tag.as_str().unwrap_or("").trim();ensure!(!name.is_empty()&&name.chars().count()<=100,"标签应为 1–100 字");let id=uuid::Uuid::new_v4().to_string();tx.execute("INSERT OR IGNORE INTO tags(id,name) VALUES(?,?)",params![id,name])?;tag_ids.push(tx.query_row("SELECT id FROM tags WHERE name=?",[name],|r|r.get::<_,String>(0))?);}
    let unique:HashSet<&str>=ids.iter().map(|id|id.as_str().ok_or_else(||anyhow!("无效论文 ID"))).collect::<Result<_>>()?;
    for id in &unique {
        ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM papers WHERE id=? AND deleted_at IS NULL)",[id],|r|r.get::<_,bool>(0))?,"论文不存在或已移入回收站");
        if let Some(folder)=folder{tx.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)",params![id,folder])?;}
        for tag in &tag_ids {tx.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) VALUES(?,?)",params![id,tag])?;}
        tx.execute("UPDATE papers SET updated_at=max(updated_at+1,?) WHERE id=?",params![now_ms(),id])?;
    }
    tx.commit()?;Ok(json!({"updated":unique.len()}))
}
// The mirror image of bulk_assign: same validation, but only existing links are
// removed. Unknown tag names are simply nothing to remove, never created here.
pub fn bulk_unassign(lib:&Library,p:&Value)->Result<Value> {
    let ids=p["paper_ids"].as_array().ok_or_else(||anyhow!("请选择论文"))?;ensure!(!ids.is_empty()&&ids.len()<=200,"一次最多操作 200 篇论文");
    let folder=p["category_id"].as_str().filter(|s|!s.is_empty());
    let tags=p["tags"].as_array().cloned().unwrap_or_default();ensure!(tags.len()<=50,"一次最多移除 50 个标签");
    ensure!(folder.is_some()||!tags.is_empty(),"请选择目录或填写标签");
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    if let Some(folder)=folder{ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id=?)",[folder],|r|r.get::<_,bool>(0))?,"目录不存在");}
    let mut tag_ids=vec![];
    for tag in tags {
        let name=tag.as_str().unwrap_or("").trim();if name.is_empty(){continue;}
        if let Some(id)=tx.query_row("SELECT id FROM tags WHERE name=? COLLATE NOCASE",[name],|r|r.get::<_,String>(0)).optional()?{tag_ids.push(id);}
    }
    let unique:HashSet<&str>=ids.iter().map(|id|id.as_str().ok_or_else(||anyhow!("无效论文 ID"))).collect::<Result<_>>()?;
    let mut removed=0usize;
    for id in &unique {
        ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM papers WHERE id=? AND deleted_at IS NULL)",[id],|r|r.get::<_,bool>(0))?,"论文不存在或已移入回收站");
        if let Some(folder)=folder{removed+=tx.execute("DELETE FROM paper_categories WHERE paper_id=? AND category_id=?",params![id,folder])?;}
        for tag in &tag_ids{removed+=tx.execute("DELETE FROM paper_tags WHERE paper_id=? AND tag_id=?",params![id,tag])?;}
        tx.execute("UPDATE papers SET updated_at=max(updated_at+1,?) WHERE id=?",params![now_ms(),id])?;
    }
    tx.commit()?;Ok(json!({"updated":unique.len(),"removed":removed}))
}
// Tags are addressed by id (what the taxonomy returns) or by their current
// name, so both sidebar clicks and typed commands work.
fn tag_lookup(tx:&rusqlite::Transaction,p:&Value)->Result<(String,String)> {
    if let Some(id)=p["tag_id"].as_str().filter(|s|!s.is_empty()){
        let name:String=tx.query_row("SELECT name FROM tags WHERE id=?",[id],|r|r.get(0)).optional()?.ok_or_else(||anyhow!("标签不存在"))?;
        return Ok((id.to_string(),name));
    }
    let name=p["name"].as_str().or_else(||p["tag"].as_str()).map(str::trim).filter(|s|!s.is_empty()).ok_or_else(||anyhow!("请提供 tag_id 或标签名"))?;
    let id:String=tx.query_row("SELECT id FROM tags WHERE name=? COLLATE NOCASE",[name],|r|r.get(0)).optional()?.ok_or_else(||anyhow!("标签不存在：{name}"))?;
    Ok((id,name.to_string()))
}
pub fn tag_rename(lib:&Library,p:&Value)->Result<Value> {
    let name=p["new_name"].as_str().or_else(||p["to"].as_str()).map(str::trim).filter(|s|!s.is_empty()).ok_or_else(||anyhow!("请填写新的标签名"))?;
    ensure!(name.chars().count()<=100,"标签应为 1–100 字");
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    let (id,previous)=tag_lookup(&tx,p)?;
    let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM tags WHERE name=? COLLATE NOCASE AND id!=?)",params![name,id],|r|r.get(0))?;
    ensure!(!duplicate,"已有同名标签，请先合并或换一个名称");
    tx.execute("UPDATE tags SET name=? WHERE id=?",params![name,id])?;
    tx.commit()?;Ok(json!({"ok":true,"id":id,"name":name,"previous":previous}))
}
pub fn tag_set_color(lib:&Library,p:&Value)->Result<Value> {
    let raw=p["color"].as_str().unwrap_or("").trim();
    let color=if raw.is_empty(){None}else{
        let valid=raw.strip_prefix('#').map(|hex|matches!(hex.len(),3|6)&&hex.chars().all(|c|c.is_ascii_hexdigit()))
            .unwrap_or_else(||raw.len()<=20&&raw.chars().all(|c|c.is_ascii_alphabetic()));
        ensure!(valid,"颜色应为 #RRGGBB 或英文颜色名");
        Some(raw.to_ascii_lowercase())
    };
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    let (id,name)=tag_lookup(&tx,p)?;
    tx.execute("UPDATE tags SET color=? WHERE id=?",params![color,id])?;
    tx.commit()?;Ok(json!({"ok":true,"id":id,"name":name,"color":color}))
}
pub fn tag_delete(lib:&Library,p:&Value)->Result<Value> {
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    let (id,name)=tag_lookup(&tx,p)?;
    let papers=tx.execute("DELETE FROM paper_tags WHERE tag_id=?",[&id])?;
    tx.execute("DELETE FROM tags WHERE id=?",[&id])?;
    tx.commit()?;Ok(json!({"ok":true,"deleted":id,"name":name,"papers_unassigned":papers}))
}
pub fn short_note(lib:&Library,p:&Value)->Result<Value> {
    let id=p["paper_id"].as_str().ok_or_else(||anyhow!("paper_id required"))?;
    let text=p["text"].as_str().unwrap_or("").trim();ensure!(text.chars().count()<=300,"一句话速记最多 300 字");
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    let updated:i64=tx.query_row("SELECT updated_at FROM papers WHERE id=? AND deleted_at IS NULL",[id],|r|r.get(0))?;
    if let Some(expected)=p["expected_updated_at"].as_i64(){ensure!(expected==updated,"资料已修改，请刷新后重试");}
    tx.execute("UPDATE papers SET short_note=?,updated_at=max(updated_at+1,?) WHERE id=?",params![text,now_ms(),id])?;
    tx.commit()?;Ok(json!({"saved":true}))
}
// Safe flattening also tolerates malformed/orphaned parent links from older synced libraries.
pub fn validate_tree(conn:&rusqlite::Connection)->Result<()> {
    let mut stmt=conn.prepare("SELECT id,parent_id FROM categories")?;
    let parents=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<rusqlite::Result<HashMap<_,_>>>()?;
    for start in parents.keys(){let mut cursor=Some(start.clone());let mut seen=HashSet::new();while let Some(id)=cursor{ensure!(seen.insert(id.clone()),"目录同步产生循环，请先调整目录层级");ensure!(seen.len()<=32,"目录层级超过限制");cursor=parents.get(&id).cloned().flatten();}}
    Ok(())
}
// On-demand duplicate view (module 二.4): identical DOI, identical arXiv id
// (vN stripped) or an identical normalized title. Nothing is merged here; the
// user decides which record to keep.
pub fn list_duplicates(lib:&Library,_p:&Value)->Result<Value> {
    let rows:Vec<(String,String,Option<String>,Option<String>)>={
        let conn=lib.conn();let mut stmt=conn.prepare("SELECT id,title,doi,arxiv FROM papers WHERE deleted_at IS NULL")?;
        let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;rows
    };
    let (mut by_doi,mut by_arxiv,mut by_title)=(HashMap::<String,Vec<String>>::new(),HashMap::<String,Vec<String>>::new(),HashMap::<String,Vec<String>>::new());
    for (id,title,doi,arxiv) in rows {
        if let Some(identifier)=doi.as_deref().map(crate::citations::doi).filter(|v|crate::citations::valid_doi(v)){by_doi.entry(identifier).or_default().push(id.clone());}
        if let Some(identifier)=arxiv.as_deref().map(crate::citations::arxiv).filter(|v|crate::citations::valid_arxiv(v)){by_arxiv.entry(identifier).or_default().push(id.clone());}
        let normalized=crate::pdfmeta::normalize_title(&title);
        if normalized.chars().count()>=10{by_title.entry(normalized).or_default().push(id);}
    }
    let mut groups:Vec<Value>=Vec::new();
    for (kind,map) in [("doi",by_doi),("arxiv",by_arxiv),("title",by_title)] {
        let mut keys:Vec<(String,Vec<String>)>=map.into_iter().filter(|(_,ids)|ids.len()>1).collect();
        keys.sort_by(|a,b|a.0.cmp(&b.0));
        for (key,mut paper_ids) in keys {
            if groups.len()>=200{break;}
            paper_ids.sort();
            let count=paper_ids.len();
            groups.push(json!({"kind":kind,"key":key,"paper_ids":paper_ids,"count":count}));
        }
    }
    let total=groups.len();Ok(json!({"groups":groups,"count":total}))
}

/// Read status ordering used by the merge: `read > reading > unread`.
fn status_rank(status: &str) -> u8 {
    match status {
        "read" => 2,
        "reading" => 1,
        _ => 0,
    }
}

fn blank(value: &Option<String>) -> bool {
    value.as_deref().map(str::trim).unwrap_or("").is_empty()
}

/// Copy a non-empty secondary value into an empty primary column.
fn fill_blank(target: &mut Option<String>, candidate: &Option<String>) {
    if blank(target) {
        if let Some(value) = candidate.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
            *target = Some(value.to_string());
        }
    }
}

/// Append note segments without losing formatting; identical segments (the
/// common "same Zotero note imported twice" case) are kept once.
fn merge_notes(existing: &str, incoming: &str) -> String {
    let mut segments: Vec<String> = existing
        .split("\n\n")
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(str::to_string)
        .collect();
    let mut seen: HashSet<String> = segments.iter().cloned().collect();
    for segment in incoming.split("\n\n").map(str::trim).filter(|segment| !segment.is_empty()) {
        if seen.insert(segment.to_string()) {
            segments.push(segment.to_string());
        }
    }
    segments.join("\n\n")
}

struct MergeRow {
    authors: String,
    year: Option<String>,
    venue: Option<String>,
    doi: Option<String>,
    arxiv: Option<String>,
    abstract_text: Option<String>,
    short_note: String,
    notes: String,
    favorite: i64,
    read_status: String,
}

fn read_merge_row(conn: &rusqlite::Connection, paper_id: &str) -> Result<MergeRow> {
    conn.query_row(
        "SELECT authors,year,venue,doi,arxiv,abstract,short_note,notes,favorite,read_status FROM papers WHERE id=? AND deleted_at IS NULL",
        [paper_id],
        |row| {
            Ok(MergeRow {
                authors: row.get(0)?,
                year: row.get(1)?,
                venue: row.get(2)?,
                doi: row.get(3)?,
                arxiv: row.get(4)?,
                abstract_text: row.get(5)?,
                short_note: row.get(6)?,
                notes: row.get(7)?,
                favorite: row.get(8)?,
                read_status: row.get(9)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| anyhow!("论文不存在或已移入回收站：{paper_id}"))
}

/// FEAT-UX-02: losslessly merge duplicate paper rows into `primary_id`.
///
/// One transaction migrates metadata (only into empty primary fields), notes,
/// favourite/read status, versions (identical `sha256` PDFs are skipped),
/// blocks, annotations, chats, jobs, Zotero rows, categories and tags, then
/// deletes the secondary rows.  Foreign-key cascade therefore never deletes
/// migrated data.  Returns `{merged, primary}`.
pub fn merge_papers(lib: &Library, p: &Value) -> Result<Value> {
    let primary_id = p["primary_id"].as_str().map(str::trim).filter(|id| !id.is_empty()).ok_or_else(|| anyhow!("请选择保留的主条目"))?;
    let raw = p["secondary_ids"].as_array().ok_or_else(|| anyhow!("请选择要合并的重复论文"))?;
    ensure!(!raw.is_empty() && raw.len() <= 50, "一次可合并 1–50 篇重复论文");
    let mut seen = HashSet::new();
    let mut secondary_ids: Vec<String> = Vec::new();
    for value in raw {
        let id = value.as_str().ok_or_else(|| anyhow!("无效论文 ID"))?.trim();
        if id.is_empty() || id == primary_id || !seen.insert(id.to_string()) {
            continue;
        }
        secondary_ids.push(id.to_string());
    }
    ensure!(!secondary_ids.is_empty(), "请至少选择一篇要与主条目合并的其他论文");
    let merged_count = secondary_ids.len();
    {
        let conn = lib.conn();
        let tx = conn.unchecked_transaction()?;
        let mut primary = read_merge_row(&tx, primary_id)?;
        for secondary_id in &secondary_ids {
            let secondary = read_merge_row(&tx, secondary_id)?;
            // A running translation owns files and a job row bound to the
            // secondary id; merging underneath it would corrupt both papers.
            let active: i64 = tx.query_row(
                "SELECT count(*) FROM jobs WHERE paper_id=? AND status NOT IN ('completed','failed','cancelled')",
                [secondary_id],
                |r| r.get(0),
            )?;
            ensure!(active == 0, "请等待论文 {secondary_id} 的翻译任务停止后再合并");

            // 1. Fill only empty metadata, secondary order wins (the UI lists
            //    the record the user prefers first).
            if primary.authors.trim().is_empty() && !secondary.authors.trim().is_empty() {
                primary.authors = secondary.authors.trim().to_string();
            }
            fill_blank(&mut primary.year, &secondary.year);
            fill_blank(&mut primary.venue, &secondary.venue);
            fill_blank(&mut primary.doi, &secondary.doi);
            fill_blank(&mut primary.arxiv, &secondary.arxiv);
            fill_blank(&mut primary.abstract_text, &secondary.abstract_text);
            if primary.short_note.trim().is_empty() {
                primary.short_note = secondary.short_note.trim().to_string();
            }
            primary.notes = merge_notes(&primary.notes, &secondary.notes);
            primary.favorite = primary.favorite.max(secondary.favorite);
            if status_rank(&secondary.read_status) > status_rank(&primary.read_status) {
                primary.read_status = secondary.read_status.clone();
            }

            // 2. Versions: identical PDFs (same sha256 + kind) already exist on
            //    the primary, so keep the primary row and re-point annotations.
            let versions: Vec<(String, String, String)> = {
                let mut stmt = tx.prepare("SELECT id,sha256,kind FROM versions WHERE paper_id=?")?;
                let rows = stmt.query_map([secondary_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
                rows.filter_map(std::result::Result::ok).collect()
            };
            let mut skipped_versions: Vec<(String, String)> = Vec::new();
            for (version_id, sha, kind) in versions {
                let existing: Option<String> = tx
                    .query_row(
                        "SELECT id FROM versions WHERE paper_id=? AND sha256=? AND kind=? LIMIT 1",
                        params![primary_id, sha, kind],
                        |row| row.get(0),
                    )
                    .optional()?;
                match existing {
                    Some(existing_id) => skipped_versions.push((version_id, existing_id)),
                    None => {
                        tx.execute("UPDATE versions SET paper_id=? WHERE id=?", params![primary_id, version_id])?;
                    }
                }
            }
            // Blocks follow their migrated version; a skipped duplicate's
            // blocks would otherwise survive under a re-pointed paper_id.
            tx.execute("UPDATE blocks SET paper_id=? WHERE paper_id=?", params![primary_id, secondary_id])?;
            let _ = tx.execute("UPDATE blocks_fts SET paper_id=? WHERE paper_id=?", params![primary_id, secondary_id]);
            for (skipped_id, _) in &skipped_versions {
                tx.execute("DELETE FROM blocks WHERE paper_id=? AND version_id=?", params![primary_id, skipped_id])?;
            }
            for (skipped_id, existing_id) in &skipped_versions {
                tx.execute(
                    "UPDATE annotations SET version_id=? WHERE paper_id=? AND version_id=?",
                    params![existing_id, secondary_id, skipped_id],
                )?;
                // Anything else that named the dropped version must follow the
                // retained one instead of dangling after the cascade delete.
                tx.execute(
                    "UPDATE versions SET source_version_id=? WHERE paper_id=? AND source_version_id=?",
                    params![existing_id, primary_id, skipped_id],
                )?;
                tx.execute(
                    "UPDATE zotero_files SET version_id=? WHERE paper_id=? AND version_id=?",
                    params![existing_id, secondary_id, skipped_id],
                )?;
                tx.execute(
                    "UPDATE jobs SET output_version_id=? WHERE paper_id=? AND output_version_id=?",
                    params![existing_id, secondary_id, skipped_id],
                )?;
                tx.execute(
                    "UPDATE jobs SET source_version_id=? WHERE paper_id=? AND source_version_id=?",
                    params![existing_id, secondary_id, skipped_id],
                )?;
            }
            tx.execute("UPDATE annotations SET paper_id=? WHERE paper_id=?", params![primary_id, secondary_id])?;
            tx.execute("UPDATE chats SET paper_id=? WHERE paper_id=?", params![primary_id, secondary_id])?;
            tx.execute("UPDATE jobs SET paper_id=? WHERE paper_id=?", params![primary_id, secondary_id])?;

            // 3. Zotero projection rows (composite keys need OR IGNORE first).
            tx.execute("UPDATE OR IGNORE zotero_files SET paper_id=? WHERE paper_id=?", params![primary_id, secondary_id])?;
            tx.execute("UPDATE OR IGNORE zotero_items SET paper_id=? WHERE paper_id=?", params![primary_id, secondary_id])?;
            tx.execute("DELETE FROM zotero_items WHERE paper_id=?", [secondary_id])?;
            tx.execute("UPDATE OR IGNORE zotero_map SET paper_id=? WHERE paper_id=?", params![primary_id, secondary_id])?;
            tx.execute("DELETE FROM zotero_map WHERE paper_id=?", [secondary_id])?;

            // 4. Link tables: copy first, then drop the secondary links.
            tx.execute(
                "INSERT OR IGNORE INTO paper_categories(paper_id,category_id) SELECT ?,category_id FROM paper_categories WHERE paper_id=?",
                params![primary_id, secondary_id],
            )?;
            tx.execute("DELETE FROM paper_categories WHERE paper_id=?", [secondary_id])?;
            tx.execute(
                "INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) SELECT ?,tag_id FROM paper_tags WHERE paper_id=?",
                params![primary_id, secondary_id],
            )?;
            tx.execute("DELETE FROM paper_tags WHERE paper_id=?", [secondary_id])?;

            // 5. Only now is it safe to delete the secondary row (cascade).
            tx.execute("DELETE FROM papers WHERE id=?", [secondary_id])?;
        }
        tx.execute(
            "UPDATE papers SET authors=?,year=?,venue=?,doi=?,arxiv=?,abstract=?,short_note=?,notes=?,favorite=?,read_status=?,updated_at=max(updated_at+1,?) WHERE id=?",
            params![
                primary.authors.trim(),
                primary.year,
                primary.venue,
                primary.doi,
                primary.arxiv,
                primary.abstract_text,
                primary.short_note.trim(),
                primary.notes,
                primary.favorite,
                primary.read_status,
                now_ms(),
                primary_id,
            ],
        )?;
        tx.commit()?;
    }
    Ok(json!({"merged": merged_count, "primary": lib.get_paper(primary_id)?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folders_bulk_tags_notes_and_citation_sort_are_persistent_and_transactional(){
        let root=std::env::temp_dir().join(format!("moonlight-organization-{}",uuid::Uuid::new_v4()));let lib=Library::new(&root).unwrap();
        for id in ["a","b","c"] {lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,'',0,0)",params![id,id]).unwrap();}
        let parent=folder_save(&lib,&json!({"name":"My research"})).unwrap();let parent_id=parent["id"].as_str().unwrap();
        let child=folder_save(&lib,&json!({"name":"RLHF","parent_id":parent_id})).unwrap();let child_id=child["id"].as_str().unwrap();
        assert!(folder_save(&lib,&json!({"id":parent_id,"name":"My research","parent_id":child_id})).is_err());
        assert!(folder_save(&lib,&json!({"name":"RLHF","parent_id":parent_id})).is_err());
        bulk_assign(&lib,&json!({"paper_ids":["a","b"],"category_id":child_id,"tags":["reading","RL"]})).unwrap();
        let page=crate::search::list_page(&lib.conn(),&json!({"category":parent_id})).unwrap();assert_eq!(page["total"],2);
        assert!(bulk_assign(&lib,&json!({"paper_ids":["a","missing"],"tags":["must-rollback"]})).is_err());
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"tag":"must-rollback"})).unwrap()["total"],0);
        let fresh=lib.get_paper("a").unwrap();short_note(&lib,&json!({"paper_id":"a","text":"解决强化学习吞吐瓶颈","expected_updated_at":fresh["updated_at"]})).unwrap();
        assert!(short_note(&lib,&json!({"paper_id":"a","text":"stale edit","expected_updated_at":0})).is_err());
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"query":"吞吐瓶颈"})).unwrap()["total"],1);
        lib.conn().execute("UPDATE papers SET citation_count=0 WHERE id='a'",[]).unwrap();lib.conn().execute("UPDATE papers SET citation_count=100 WHERE id='b'",[]).unwrap();
        let page=crate::search::list_page(&lib.conn(),&json!({"sort":"citations"})).unwrap();assert_eq!(page["items"][0]["id"],"b");assert_eq!(page["items"][2]["id"],"c");
        drop(lib);let reopened=Library::new(&root).unwrap();assert_eq!(reopened.get_paper("a").unwrap()["short_note"],"解决强化学习吞吐瓶颈");assert_eq!(reopened.taxonomy().unwrap()["categories"].as_array().unwrap().iter().find(|c|c["id"]==child_id).unwrap()["parent_id"],parent_id);
        drop(reopened);std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn folder_and_tag_management_never_delete_papers_and_stays_consistent(){
        let root=std::env::temp_dir().join(format!("moonlight-organization-manage-{}",uuid::Uuid::new_v4()));let lib=Library::new(&root).unwrap();
        let insert=|id:&str,title:&str,doi:Option<&str>,arxiv:Option<&str>|{lib.conn().execute("INSERT INTO papers(id,title,authors,doi,arxiv,imported_at,updated_at) VALUES(?,?,'',?,?,0,0)",params![id,title,doi,arxiv]).unwrap();};
        insert("a","A Study of Throughput",None,None);insert("b","B",None,None);insert("c","C",None,None);
        insert("d","Queues",Some("https://doi.org/10.1000/ABC"),None);insert("e","queues",Some("10.1000/abc"),None);
        insert("f","Some Other Long Title",None,Some("2409.19256v1"));insert("g","some-other long title",None,Some("2409.19256"));
        insert("h","A study of throughput",None,None);
        let folder=||->String{folder_save(&lib,&json!({"name":"Top"})).unwrap()["id"].as_str().unwrap().to_string()};
        let top=folder();
        let mid=folder_save(&lib,&json!({"name":"Mid","parent_id":top})).unwrap()["id"].as_str().unwrap().to_string();
        let deep=folder_save(&lib,&json!({"name":"Deep","parent_id":mid})).unwrap()["id"].as_str().unwrap().to_string();
        let other=folder_save(&lib,&json!({"name":"Other","parent_id":top})).unwrap()["id"].as_str().unwrap().to_string();
        bulk_assign(&lib,&json!({"paper_ids":["a","b"],"category_id":mid,"tags":["reading","RL"]})).unwrap();
        bulk_assign(&lib,&json!({"paper_ids":["c"],"category_id":deep,"tags":["RL"]})).unwrap();

        // Deleting a folder lifts its children one level and only unlinks papers.
        let deleted=folder_delete(&lib,&json!({"category_id":mid})).unwrap();
        assert_eq!(deleted["ok"],true);assert_eq!(deleted["parent_id"],top);assert_eq!(deleted["reparented"],1);assert_eq!(deleted["papers_unassigned"],2);
        let taxonomy=lib.taxonomy().unwrap();let categories=taxonomy["categories"].as_array().unwrap();
        assert!(!categories.iter().any(|c|c["id"]==mid));assert_eq!(categories.iter().find(|c|c["id"]==deep.as_str()).unwrap()["parent_id"],top);
        assert!(lib.get_paper("a").unwrap()["categories"].as_array().unwrap().is_empty());
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"category":top})).unwrap()["total"],1);
        assert!(folder_delete(&lib,&json!({"category_id":mid})).is_err());
        assert!(folder_delete(&lib,&json!({})).is_err());

        // Moving a folder keeps the tree acyclic; merging absorbs papers.
        folder_move(&lib,&json!({"category_id":deep,"parent_id":other})).unwrap();
        assert_eq!(lib.taxonomy().unwrap()["categories"].as_array().unwrap().iter().find(|c|c["id"]==deep.as_str()).unwrap()["parent_id"],other);
        assert!(folder_move(&lib,&json!({"category_id":other,"parent_id":deep})).is_err());
        bulk_assign(&lib,&json!({"paper_ids":["a"],"category_id":other})).unwrap();
        let merged=folder_merge(&lib,&json!({"source_id":other,"target_id":top})).unwrap();
        assert_eq!(merged["papers_moved"],1);assert_eq!(merged["reparented"],1);
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"category":top})).unwrap()["total"],2);
        assert!(lib.taxonomy().unwrap()["categories"].as_array().unwrap().iter().all(|c|c["id"]!=other.as_str()));
        assert!(folder_merge(&lib,&json!({"source_id":top,"target_id":top})).is_err());
        assert!(folder_merge(&lib,&json!({"source_id":top,"target_id":"missing"})).is_err());

        // Tag rename / colour / delete touch links only, never papers.
        let tag_id=lib.taxonomy().unwrap()["tags"].as_array().unwrap().iter().find(|t|t["name"]=="reading").unwrap()["id"].as_str().unwrap().to_string();
        assert_eq!(tag_rename(&lib,&json!({"tag_id":tag_id,"new_name":"在读"})).unwrap()["previous"],"reading");
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"tag":"在读"})).unwrap()["total"],2);
        assert!(tag_rename(&lib,&json!({"tag_id":tag_id,"new_name":"RL"})).is_err());
        assert!(tag_rename(&lib,&json!({"tag_id":"missing","new_name":"X"})).is_err());
        let colored=tag_set_color(&lib,&json!({"tag_id":tag_id,"color":"#FfCC00"})).unwrap();
        assert_eq!(colored["color"],"#ffcc00");
        assert!(tag_set_color(&lib,&json!({"tag_id":tag_id,"color":"not a colour"})).is_err());
        assert_eq!(tag_set_color(&lib,&json!({"name":"在读","color":""})).unwrap()["color"],serde_json::Value::Null);
        assert_eq!(tag_delete(&lib,&json!({"tag_id":tag_id})).unwrap()["papers_unassigned"],2);
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"tag":"在读"})).unwrap()["total"],0);
        assert!(lib.taxonomy().unwrap()["tags"].as_array().unwrap().iter().all(|t|t["id"]!=tag_id.as_str()));
        assert!(lib.get_paper("a").is_ok()&&lib.get_paper("b").is_ok());
        assert!(tag_delete(&lib,&json!({"tag_id":tag_id})).is_err());

        // bulk_unassign mirrors bulk_assign and rolls back as a whole.
        bulk_assign(&lib,&json!({"paper_ids":["a","b"],"category_id":top,"tags":["temp"]})).unwrap();
        let unassigned=bulk_unassign(&lib,&json!({"paper_ids":["a","b"],"tags":["temp"]})).unwrap();
        assert_eq!(unassigned["updated"],2);assert_eq!(unassigned["removed"],2);
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"tag":"temp"})).unwrap()["total"],0);
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"category":top})).unwrap()["total"],3);
        assert_eq!(bulk_unassign(&lib,&json!({"paper_ids":["b"],"category_id":top})).unwrap()["removed"],1);
        assert_eq!(bulk_unassign(&lib,&json!({"paper_ids":["a"],"tags":["never-used"]})).unwrap()["removed"],0);
        assert!(bulk_unassign(&lib,&json!({"paper_ids":["a","missing"],"tags":["temp"]})).is_err());
        assert!(bulk_unassign(&lib,&json!({"paper_ids":["a"]})).is_err());
        assert!(bulk_unassign(&lib,&json!({"paper_ids":[],"tags":["temp"]})).is_err());
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"category":top})).unwrap()["total"],2);

        // Duplicate view groups by DOI, arXiv (vN stripped) and normalized title.
        let duplicates=list_duplicates(&lib,&json!({})).unwrap();
        let groups=duplicates["groups"].as_array().unwrap();
        let members=|kind:&str,key:&str|->Option<Vec<String>>{groups.iter().find(|g|g["kind"]==kind&&g["key"]==key).map(|g|{let mut ids=g["paper_ids"].as_array().unwrap().iter().map(|id|id.as_str().unwrap().to_string()).collect::<Vec<_>>();ids.sort();ids})};
        assert_eq!(members("doi","10.1000/abc"),Some(vec!["d".to_string(),"e".to_string()]));
        assert_eq!(members("arxiv","2409.19256"),Some(vec!["f".to_string(),"g".to_string()]));
        assert_eq!(members("title","a study of throughput"),Some(vec!["a".to_string(),"h".to_string()]));
        assert_eq!(members("title","queues"),None);
        assert_eq!(duplicates["count"],4);
        for id in ["a","b","c","d","e","f","g","h"]{assert!(lib.get_paper(id).is_ok());}
        drop(lib);let reopened=Library::new(&root).unwrap();
        assert_eq!(reopened.taxonomy().unwrap()["categories"].as_array().unwrap().iter().find(|c|c["id"]==deep.as_str()).unwrap()["parent_id"],top);
        drop(reopened);std::fs::remove_dir_all(root).unwrap();
    }

    /// FEAT-UX-02: merging must move every related row before deleting the
    /// secondary paper (so `ON DELETE CASCADE` cannot eat migrated data), fill
    /// only empty metadata, and stay transactional on active jobs.
    #[test]
    fn merge_papers_moves_versions_blocks_annotations_and_links() {
        let root=std::env::temp_dir().join(format!("moonlight-merge-{}",uuid::Uuid::new_v4()));
        let lib=Library::new(&root).unwrap();
        let conn=lib.conn();
        conn.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at,notes,read_status) VALUES('p','Merged Paper','',0,0,'primary note\n\nshared','unread')",[]).unwrap();
        conn.execute("INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,imported_at,updated_at,short_note,notes,favorite,read_status) VALUES('s','Merged Paper preprint','Alice, Bob','2024','arXiv','10.1000/abc','2401.00001','Secondary abstract',0,0,'快速笔记','shared\n\nsecondary note',1,'reading')",[]).unwrap();
        conn.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at,read_status) VALUES('r','Reader Copy','',0,0,'read')",[]).unwrap();
        conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('vp-src','p','source','shared','files/shared.pdf',1,1,0)",[]).unwrap();
        conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('vp-t','p','translated','hash-t','derived/t.pdf',1,1,0)",[]).unwrap();
        conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('vs-shared','s','source','shared','files/shared.pdf',1,1,0)",[]).unwrap();
        conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('vs-other','s','source','hash-other','files/other.pdf',2,1,0)",[]).unwrap();
        conn.execute("INSERT INTO chats(id,paper_id,kind,question,answer,sources,model,created_at) VALUES('c1','s','ask','q','a','[]','m',0)",[]).unwrap();
        conn.execute("INSERT INTO jobs(id,paper_id,status,created_at,updated_at) VALUES('j1','s','completed',0,0)",[]).unwrap();
        conn.execute("INSERT INTO zotero_files(id,paper_id,attachment_key,title,content_type,rel_path,status) VALUES('zf1','s','att','PDF','application/pdf','files/other.pdf','copied')",[]).unwrap();
        conn.execute("INSERT INTO zotero_items(source_id,library_id,item_key,paper_id,metadata,notes_html) VALUES('zot',1,'K1','s','{}','[]')",[]).unwrap();
        conn.execute("INSERT INTO zotero_map(item_key,paper_id,imported_at) VALUES('K1','s',0)",[]).unwrap();
        drop(conn);
        let folder=folder_save(&lib,&json!({"name":"Merged folder"})).unwrap()["id"].as_str().unwrap().to_string();
        bulk_assign(&lib,&json!({"paper_ids":["p","s"],"category_id":folder,"tags":["shared-tag"]})).unwrap();
        bulk_assign(&lib,&json!({"paper_ids":["s"],"tags":["secondary-tag"]})).unwrap();
        drop(lib.conn());
        lib.set_blocks("p","vp-src",0,vec![json!({"text":"primary block","bbox":[1,1,10,10]})]).unwrap();
        lib.set_blocks("s","vs-shared",0,vec![json!({"text":"duplicate block","bbox":[1,1,10,10]})]).unwrap();
        lib.set_blocks("s","vs-other",1,vec![json!({"text":"secondary block","bbox":[1,1,10,10]})]).unwrap();
        lib.add_annotation("p",0,json!([[1,1,10,10]]),"primary","yellow","","source",Some("vp-src")).unwrap();
        let duplicate_annotation=lib.add_annotation("s",0,json!([[1,1,10,10]]),"dup annotation","yellow","","source",Some("vs-shared")).unwrap()["id"].as_str().unwrap().to_string();
        lib.add_annotation("s",1,json!([[1,1,10,10]]),"other annotation","yellow","","source",Some("vs-other")).unwrap();

        // The UI repeats the primary and may include the same secondary twice.
        let merged=merge_papers(&lib,&json!({"primary_id":"p","secondary_ids":["s","s","p","r"]})).unwrap();
        assert_eq!(merged["merged"],2);
        assert_eq!(merged["primary"]["id"],json!("p"));
        assert_eq!(merged["primary"]["title"],json!("Merged Paper"),"the primary title is never replaced");
        assert_eq!(merged["primary"]["authors"],json!("Alice, Bob"));
        assert_eq!(merged["primary"]["year"],json!("2024"));
        assert_eq!(merged["primary"]["venue"],json!("arXiv"));
        assert_eq!(merged["primary"]["doi"],json!("10.1000/abc"));
        assert_eq!(merged["primary"]["arxiv"],json!("2401.00001"));
        assert_eq!(merged["primary"]["abstract"],json!("Secondary abstract"));
        assert_eq!(merged["primary"]["short_note"],json!("快速笔记"));
        assert_eq!(merged["primary"]["favorite"],json!(true));
        assert_eq!(merged["primary"]["read_status"],json!("read"),"read > reading > unread");
        let notes=merged["primary"]["notes"].as_str().unwrap();
        assert_eq!(notes,"primary note\n\nshared\n\nsecondary note","notes are appended and deduplicated: {notes:?}");
        assert_eq!(notes.matches("shared").count(),1);

        let version_ids=|lib:&Library|->Vec<String>{let conn=lib.conn();let mut stmt=conn.prepare("SELECT id FROM versions WHERE paper_id='p' ORDER BY id").unwrap();stmt.query_map([],|r|r.get(0)).unwrap().filter_map(Result::ok).collect()};
        assert_eq!(version_ids(&lib),vec!["vp-src","vp-t","vs-other"],"the duplicate sha256 PDF is skipped, the rest migrates");
        assert!(lib.get_paper("s").is_err());assert!(lib.get_paper("r").is_err());
        let block_texts:Vec<String>={let conn=lib.conn();let mut stmt=conn.prepare("SELECT text FROM blocks WHERE paper_id='p' ORDER BY text").unwrap();stmt.query_map([],|r|r.get(0)).unwrap().filter_map(Result::ok).collect()};
        assert_eq!(block_texts,vec!["primary block","secondary block"],"migrated blocks survive; skipped-duplicate blocks are removed");
        let annotation_version:String=lib.conn().query_row("SELECT version_id FROM annotations WHERE id=?",[&duplicate_annotation],|r|r.get(0)).unwrap();
        assert_eq!(annotation_version,"vp-src","an annotation on a duplicate PDF follows the retained version");
        assert_eq!(lib.list_annotations("p").unwrap().len(),3);
        assert_eq!(lib.conn().query_row("SELECT COUNT(*) FROM chats WHERE paper_id='p'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(lib.conn().query_row("SELECT COUNT(*) FROM jobs WHERE paper_id='p'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(lib.conn().query_row("SELECT COUNT(*) FROM zotero_files WHERE paper_id='p'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(lib.conn().query_row("SELECT COUNT(*) FROM zotero_items WHERE paper_id='p'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(lib.conn().query_row("SELECT COUNT(*) FROM zotero_map WHERE paper_id='p'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(lib.conn().query_row("SELECT COUNT(*) FROM paper_categories WHERE paper_id='p' AND category_id=?",[&folder],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(lib.conn().query_row("SELECT COUNT(*) FROM paper_tags WHERE paper_id='p'",[],|r|r.get::<_,i64>(0)).unwrap(),2);

        // Validation: missing secondaries, unknown ids and active jobs roll back.
        assert!(merge_papers(&lib,&json!({"primary_id":"p","secondary_ids":[]})).is_err());
        assert!(merge_papers(&lib,&json!({"primary_id":"missing","secondary_ids":["p"]})).is_err());
        assert!(merge_papers(&lib,&json!({"primary_id":"p","secondary_ids":["does-not-exist"]})).is_err());
        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('x','Active','',0,0)",[]).unwrap();
        lib.conn().execute("INSERT INTO jobs(id,paper_id,status,created_at,updated_at) VALUES('jx','x','queued',0,0)",[]).unwrap();
        let error=merge_papers(&lib,&json!({"primary_id":"p","secondary_ids":["x"]})).unwrap_err().to_string();
        assert!(error.contains("翻译任务"),"{error}");
        assert!(lib.get_paper("x").is_ok(),"a refused merge must not delete anything");
        lib.conn().execute("UPDATE jobs SET status='completed' WHERE id='jx'",[]).unwrap();
        assert_eq!(merge_papers(&lib,&json!({"primary_id":"p","secondary_ids":["x"]})).unwrap()["merged"],1);
        assert!(lib.get_paper("x").is_err());

        drop(lib);std::fs::remove_dir_all(root).unwrap();
    }
}
