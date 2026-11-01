//! SQLite library, filenames, annotations, jobs and translation versions.

use crate::engine::{self, Gateway};
use crate::pdfmeta;
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SCHEMA: &str = r#"
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '',
  year TEXT, venue TEXT, doi TEXT, arxiv TEXT, abstract TEXT,
  imported_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0, read_status TEXT NOT NULL DEFAULT 'unread',
  deleted_at INTEGER, notes TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, sha256 TEXT NOT NULL, rel_path TEXT NOT NULL,
  pages INTEGER NOT NULL, bytes INTEGER NOT NULL, lang TEXT NOT NULL DEFAULT '',
  engine TEXT, model TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL, page INTEGER NOT NULL, block_index INTEGER NOT NULL,
  kind TEXT NOT NULL, bbox TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(paper_id, version_id, page);
CREATE INDEX IF NOT EXISTS idx_versions_kind ON versions(paper_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_hash ON versions(sha256, kind);
CREATE INDEX IF NOT EXISTS idx_papers_recent ON papers(imported_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_papers_title ON papers(deleted_at, title COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(deleted_at, year DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_papers_trash ON papers(deleted_at, imported_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_papers_favorite ON papers(favorite, imported_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(read_status, imported_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(text, block_id UNINDEXED, paper_id UNINDEXED, page UNINDEXED, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS paper_categories (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, category_id)
);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
CREATE TABLE IF NOT EXISTS paper_tags (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, tag_id)
);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  version_kind TEXT NOT NULL DEFAULT 'source', page INTEGER NOT NULL,
  rects TEXT NOT NULL, quote TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'yellow',
  comment TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, status TEXT NOT NULL, pages TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, output_version_id TEXT
);
CREATE TABLE IF NOT EXISTS zotero_map (
  item_key TEXT PRIMARY KEY, paper_id TEXT NOT NULL, imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, sources TEXT NOT NULL,
  model TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_paper ON paper_categories(category_id, paper_id);
CREATE INDEX IF NOT EXISTS idx_tags_paper ON paper_tags(tag_id, paper_id);
CREATE INDEX IF NOT EXISTS idx_annotations_paper ON annotations(paper_id, page);
CREATE INDEX IF NOT EXISTS idx_chats_paper_time ON chats(paper_id, created_at DESC);
"#;

pub type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

pub struct Library {
    pub(crate) sync: crate::sync::Manager,
    root: PathBuf,
    _lock: fs::File,
    pub(crate) maintenance: Mutex<()>,
    translation_tx: std::sync::mpsc::SyncSender<(String,String,PathBuf,Option<String>)>,
    conn: Mutex<Connection>,
    emitter: Mutex<Option<Emitter>>,
    gateway: Mutex<Option<Gateway>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

impl Library {
    pub fn new(root: &Path) -> Result<Arc<Self>> {
        fs::create_dir_all(root.join("files"))?;
        fs::create_dir_all(root.join("derived"))?;
        fs::create_dir_all(root.join("tmp"))?;
        let lock=fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(root.join(".moonlight.lock"))?;
        lock.try_lock().map_err(|_|anyhow!("论文库已被另一个 Moonlight 进程使用"))?;
        let conn = Connection::open(root.join("library.db"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        let has_version: bool = conn.prepare("PRAGMA table_info(annotations)")?
            .query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?
            .iter().any(|name| name == "version_id");
        if !has_version {
            conn.execute_batch("ALTER TABLE annotations ADD COLUMN version_id TEXT;")?;
        }
        conn.execute_batch(crate::zotero_local::SCHEMA)?;
        crate::organization::initialize(&conn)?;
        crate::sync::initialize(&conn)?;
        crate::search::initialize(&conn)?;
        conn.execute("UPDATE jobs SET status='failed',error='应用上次异常退出，任务已中断；可重试',updated_at=? WHERE status NOT IN ('completed','failed','cancelled')",[now_ms()])?;
        conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_paper ON jobs(paper_id) WHERE status NOT IN ('completed','failed','cancelled'); CREATE INDEX IF NOT EXISTS idx_jobs_recent ON jobs(created_at DESC,id);")?;
        let (translation_tx,translation_rx)=std::sync::mpsc::sync_channel::<(String,String,PathBuf,Option<String>)>(32);
        let lib = Arc::new(Self {
            sync: crate::sync::Manager::default(),
            root: root.to_path_buf(),
            _lock: lock,
            maintenance: Mutex::new(()),
            translation_tx,
            conn: Mutex::new(conn),
            emitter: Mutex::new(None),
            gateway: Mutex::new(None),
            cancels: Mutex::new(HashMap::new()),
        });
        let weak=Arc::downgrade(&lib);
        std::thread::Builder::new().name("translation-queue".into()).spawn(move||{
            while let Ok((job,paper,source,pages))=translation_rx.recv(){
                let Some(lib)=weak.upgrade() else {break};
                engine::run_translation(lib,job,paper,source,pages);
            }
        })?;
        lib.seed_categories()?;
        Ok(lib)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn set_emitter(&self, emitter: Emitter) {
        *self.emitter.lock().unwrap() = Some(emitter);
    }

    pub fn emit(&self, value: Value) {
        if let Some(cb) = self.emitter.lock().unwrap().as_ref() {
            cb(value);
        }
    }

    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    fn seed_categories(&self) -> Result<()> {
        let conn = self.conn();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))?;
        if count == 0 {
            for (i, name) in ["待读", "精读", "已读", "方法", "实验"].iter().enumerate() {
                conn.execute(
                    "INSERT INTO categories(id,name,sort_order) VALUES(?,?,?)",
                    params![crate::sync::digest(&format!("default-category:{name}")), name, i as i64],
                )?;
            }
        }
        Ok(())
    }

    // ---- papers ---------------------------------------------------------
    pub fn import_paths(&self, paths: Vec<String>) -> Vec<Value> {
        paths
            .iter()
            .map(|raw| match self.import_one(Path::new(raw)) {
                Ok(v) => v,
                Err(err) => json!({"path": raw, "status": "failed", "error": err.to_string()}),
            })
            .collect()
    }

    fn import_one(&self, path: &Path) -> Result<Value> {
        if !path.exists() || path.extension().map(|e| e != "pdf").unwrap_or(true) {
            return Err(anyhow!("not a PDF file"));
        }
        let sha = sha256_file(path)?;
        {
            let conn = self.conn();
            if let Some((id, title, deleted)) = conn
                .query_row(
                    "SELECT p.id,p.title,p.deleted_at FROM versions v JOIN papers p ON p.id=v.paper_id WHERE v.sha256=? AND v.kind='source'",
                    params![sha],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?)),
                )
                .optional()?
            {
                if deleted.is_some() {
                    conn.execute("UPDATE papers SET deleted_at=NULL WHERE id=?", params![id])?;
                }
                return Ok(json!({"status": "duplicate", "paper_id": id, "title": title, "sha256": sha}));
            }
        }
        let (meta, text) = pdfmeta::inspect(path)?;
        let paper_id = Uuid::new_v4().to_string();
        let version_id = Uuid::new_v4().to_string();
        let rel = format!("files/{sha}.pdf");
        let dest = self.root.join(&rel);
        let tmp = self.root.join("tmp").join(format!("{paper_id}.pdf"));
        fs::copy(path, &tmp)?;
        fs::rename(&tmp, &dest)?;
        let bytes = dest.metadata()?.len() as i64;
        {
            let conn = self.conn();
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                params![
                    paper_id,
                    meta.title.clone(),
                    meta.authors.clone(),
                    meta.year.clone(),
                    meta.venue.clone(),
                    meta.doi.clone(),
                    meta.arxiv.clone(),
                    meta.abstract_text.clone(),
                    now_ms(),
                    now_ms()
                ],
            )?;
            tx.execute(
                "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                params![version_id, paper_id, "source", sha, rel, meta.pages, bytes, "en", now_ms()],
            )?;
            Self::index_coarse_text(&tx, &paper_id, &version_id, &text)?;
            tx.commit()?;
        }
        Ok(json!({
            "status": "imported", "paper_id": paper_id, "version_id": version_id,
            "title": meta.title, "pages": meta.pages, "sha256": sha
        }))
    }

    fn index_coarse_text(tx: &Connection, paper_id: &str, version_id: &str, text: &str) -> Result<()> {
        for (page, page_text) in text.split('\u{000c}').enumerate() {
          for (i, chunk) in page_text.split("\n\n").map(str::trim).filter(|c| c.len()>20).take(2000).enumerate() {
            let id = format!("{:x}", Sha256::digest(format!("{version_id}:{page}:{i}:{chunk}")));
            tx.execute(
                "INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,?,?,?,?,?)",
                params![id, paper_id, version_id, page as i64, i as i64, "text", "[]", chunk],
            )?;
          }
        }
        Ok(())
    }

    fn paper_json(&self, paper_id: &str) -> Result<Value> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM papers WHERE id=?")?;
        let mut rows = stmt.query(params![paper_id])?;
        let row = rows.next()?.ok_or_else(|| anyhow!("paper not found"))?;
        let mut value = json!({
            "id": row.get::<_, String>("id")?,
            "title": row.get::<_, String>("title")?,
            "authors": row.get::<_, String>("authors")?,
            "year": row.get::<_, Option<String>>("year")?,
            "venue": row.get::<_, Option<String>>("venue")?,
            "doi": row.get::<_, Option<String>>("doi")?,
            "arxiv": row.get::<_, Option<String>>("arxiv")?,
            "abstract": row.get::<_, Option<String>>("abstract")?,
            "imported_at": row.get::<_, i64>("imported_at")?,
            "updated_at": row.get::<_, i64>("updated_at")?,
            "favorite": row.get::<_, i64>("favorite")? != 0,
            "read_status": row.get::<_, String>("read_status")?,
            "deleted": row.get::<_, Option<i64>>("deleted_at")?.is_some(),
            "notes": row.get::<_, String>("notes")?,
            "short_note":row.get::<_,String>("short_note")?,"citation_count":row.get::<_,Option<i64>>("citation_count")?,"citation_source":row.get::<_,Option<String>>("citation_source")?,"citation_updated_at":row.get::<_,Option<i64>>("citation_updated_at")?,"citation_url":row.get::<_,Option<String>>("citation_url")?,
        });
        drop(rows);
        drop(stmt);

        let versions: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at FROM versions WHERE paper_id=? ORDER BY created_at")?;
            let rows = stmt.query_map(params![paper_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "paper_id": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?,
                    "sha256": r.get::<_, String>(3)?, "rel_path": r.get::<_, String>(4)?, "pages": r.get::<_, i64>(5)?,
                    "bytes": r.get::<_, i64>(6)?, "lang": r.get::<_, String>(7)?, "engine": r.get::<_, Option<String>>(8)?,
                    "model": r.get::<_, Option<String>>(9)?, "created_at": r.get::<_, i64>(10)?
                }))
            })?;
            rows.filter_map(Result::ok).collect()
        };
        let categories: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT c.id,c.name,c.color,c.parent_id FROM categories c JOIN paper_categories pc ON pc.category_id=c.id WHERE pc.paper_id=?")?;
            let rows = stmt.query_map(params![paper_id], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<String>>(2)?,"parent_id":r.get::<_,Option<String>>(3)?})))?;
            rows.filter_map(Result::ok).collect()
        };
        let tags: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT t.id,t.name,t.color FROM tags t JOIN paper_tags pt ON pt.tag_id=t.id WHERE pt.paper_id=?")?;
            let rows = stmt.query_map(params![paper_id], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<String>>(2)?})))?;
            rows.filter_map(Result::ok).collect()
        };
        value["versions"] = Value::Array(versions);
        value["categories"] = Value::Array(categories);
        value["tags"] = Value::Array(tags);
        Ok(value)
    }

    pub fn get_paper(&self, paper_id: &str) -> Result<Value> {
        self.paper_json(paper_id)
    }

    pub fn list_papers(&self, query: &str, category: Option<&str>, tag: Option<&str>, trashed: bool, status: Option<&str>) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut sql = String::from("SELECT DISTINCT p.id FROM papers p");
        let mut where_parts: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(cat) = category {
            sql.push_str(" JOIN paper_categories pc ON pc.paper_id=p.id");
            where_parts.push("pc.category_id=?".into());
            args.push(Box::new(cat.to_string()));
        }
        if let Some(t) = tag {
            sql.push_str(" JOIN paper_tags pt ON pt.paper_id=p.id JOIN tags tg ON tg.id=pt.tag_id");
            where_parts.push("tg.name=?".into());
            args.push(Box::new(t.to_string()));
        }
        if !query.trim().is_empty() {
            where_parts.push("(p.title LIKE ? OR p.authors LIKE ? OR p.doi LIKE ? OR p.abstract LIKE ? OR EXISTS(SELECT 1 FROM blocks b WHERE b.paper_id=p.id AND b.text LIKE ?))".into());
            let like = format!("%{}%", query.trim());
            for _ in 0..5 {
                args.push(Box::new(like.clone()));
            }
        }
        where_parts.push(if trashed { "p.deleted_at IS NOT NULL".into() } else { "p.deleted_at IS NULL".into() });
        if let Some(s) = status {
            where_parts.push("p.read_status=?".into());
            args.push(Box::new(s.to_string()));
        }
        if !where_parts.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_parts.join(" AND "));
        }
        sql.push_str(" ORDER BY p.favorite DESC, p.imported_at DESC");
        let mut stmt = conn.prepare(&sql)?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let ids: Vec<String> = stmt
            .query_map(params_vec.as_slice(), |r| r.get::<_, String>(0))?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        drop(conn);
        ids.iter().map(|id| self.paper_json(id)).collect()
    }

    pub fn update_paper(&self, paper_id: &str, fields: &Value) -> Result<Value> {
        let allowed = ["title", "authors", "year", "venue", "doi", "arxiv", "abstract", "read_status", "notes", "short_note"];
        let mut sets: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Value::Object(map) = fields {
            for key in allowed {
                if let Some(v) = map.get(key) {
                    if key=="short_note"{anyhow::ensure!(v.as_str().unwrap_or("").chars().count()<=300,"一句话速记最多 300 字");}
                    sets.push(format!("{key}=?"));
                    args.push(Box::new(v.as_str().unwrap_or_default().to_string()));
                }
            }
            if let Some(fav) = map.get("favorite") {
                sets.push("favorite=?".into());
                args.push(Box::new(if fav.as_bool().unwrap_or(false) { 1i64 } else { 0i64 }));
            }
        }
        if sets.is_empty() {
            return self.get_paper(paper_id);
        }
        sets.push("updated_at=?".into());
        args.push(Box::new(now_ms()));
        args.push(Box::new(paper_id.to_string()));
        {
            let conn = self.conn();
            let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
            conn.execute(&format!("UPDATE papers SET {} WHERE id=?", sets.join(",")), refs.as_slice())?;
        }
        self.get_paper(paper_id)
    }

    pub fn save_paper(&self,p:&Value)->Result<Value>{
        let id=p["paper_id"].as_str().ok_or_else(||anyhow!("paper_id required"))?;
        let fields=&p["fields"];
        anyhow::ensure!(fields["title"].as_str().is_some_and(|s|!s.trim().is_empty()),"标题不能为空");
        let status=fields["read_status"].as_str().unwrap_or("unread");
        anyhow::ensure!(matches!(status,"read"|"reading"|"unread"),"无效阅读状态");
        {
            let conn=self.conn();let tx=conn.unchecked_transaction()?;
            let current:i64=tx.query_row("SELECT updated_at FROM papers WHERE id=?",[id],|r|r.get(0))?;
            if let Some(expected)=p["expected_updated_at"].as_i64(){anyhow::ensure!(expected==current,"资料已在其他位置修改，请重新打开编辑窗口");}
            let names=["title","authors","year","venue","doi","arxiv","abstract","notes","read_status","short_note"];
            let mut args=Vec::<rusqlite::types::Value>::new();
            let mut sets=Vec::new();
            for key in names {if let Some(value)=fields.get(key){let text=value.as_str().ok_or_else(||anyhow!("字段必须是文本"))?;if key=="short_note"{anyhow::ensure!(text.chars().count()<=300,"一句话速记最多 300 字");}anyhow::ensure!(text.len()<=1_000_000,"字段过长");sets.push(format!("{key}=?"));args.push(text.to_string().into());}}
            sets.push("updated_at=?".into());args.push(now_ms().max(current+1).into());args.push(id.to_string().into());
            tx.execute(&format!("UPDATE papers SET {} WHERE id=?",sets.join(",")),rusqlite::params_from_iter(args))?;
            if let Some(ids)=p["category_ids"].as_array(){
                tx.execute("DELETE FROM paper_categories WHERE paper_id=?",[id])?;
                for category in ids {tx.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)",params![id,category.as_str().ok_or_else(||anyhow!("无效分类"))?])?;}
            }
            if let Some(tags)=p["tags"].as_array(){
                tx.execute("DELETE FROM paper_tags WHERE paper_id=?",[id])?;
                anyhow::ensure!(tags.len()<=200,"标签过多");
                for tag in tags{
                    let name=tag.as_str().ok_or_else(||anyhow!("无效标签"))?.trim();if name.is_empty(){continue;}
                    anyhow::ensure!(name.len()<=200,"标签过长");
                    let new_id=Uuid::new_v4().to_string();
                    tx.execute("INSERT OR IGNORE INTO tags(id,name) VALUES(?,?)",params![new_id,name])?;
                    tx.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) SELECT ?,id FROM tags WHERE name=?",params![id,name])?;
                }
            }
            tx.commit()?;
        }
        self.get_paper(id)
    }

    pub fn append_note(&self,paper_id:&str,text:&str)->Result<Value>{
        anyhow::ensure!(text.len()<=512000,"笔记内容过长");
        self.conn().execute("UPDATE papers SET notes=CASE WHEN notes='' THEN ? ELSE notes||char(10)||char(10)||? END,updated_at=max(updated_at+1,?) WHERE id=?",params![text,text,now_ms(),paper_id])?;
        self.get_paper(paper_id)
    }

    pub fn trash(&self, paper_id: &str) -> Result<()> {
        self.conn().execute("UPDATE papers SET deleted_at=?,updated_at=? WHERE id=?", params![now_ms(),now_ms(),paper_id])?;
        let jobs:Vec<String>={let conn=self.conn();let mut st=conn.prepare("SELECT id FROM jobs WHERE paper_id=? AND status NOT IN ('completed','failed','cancelled')")?;let rows=st.query_map([paper_id],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        for id in jobs {self.cancel_job(&id)?;}
        Ok(())
    }

    pub fn restore(&self, paper_id: &str) -> Result<()> {
        self.conn().execute("UPDATE papers SET deleted_at=NULL,updated_at=? WHERE id=?", params![now_ms(),paper_id])?;
        Ok(())
    }

    pub fn purge(&self, paper_id: &str) -> Result<Value> {
        let _maintenance=self.maintenance.lock().unwrap();
        let conn = self.conn();
        let trashed:bool=conn.query_row("SELECT deleted_at IS NOT NULL FROM papers WHERE id=?",[paper_id],|r|r.get(0))?;
        anyhow::ensure!(trashed,"请先移到回收站再永久删除");
        let active:i64=conn.query_row("SELECT count(*) FROM jobs WHERE paper_id=? AND status NOT IN ('completed','failed','cancelled')",[paper_id],|r|r.get(0))?;
        anyhow::ensure!(active==0,"请等待该论文的任务停止后再删除");
        let paths:Vec<String>={let mut st=conn.prepare("SELECT rel_path FROM versions WHERE paper_id=? UNION SELECT rel_path FROM zotero_files WHERE paper_id=? AND status='copied' AND rel_path IS NOT NULL")?;let rows=st.query_map([paper_id,paper_id],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        let tx=conn.unchecked_transaction()?;
        tx.execute("DELETE FROM papers WHERE id=?",[paper_id])?;
        tx.execute("DELETE FROM jobs WHERE paper_id=?",[paper_id])?;
        // Commit first. A failed deletion must never remove a referenced file.
        tx.commit()?;
        let mut removed=Vec::new();
        let mut retained=Vec::new();
        for rel in paths {
            let p=Path::new(&rel);
            if p.is_absolute()||p.components().any(|c|!matches!(c,std::path::Component::Normal(_))){continue;}
            let shared:i64=conn.query_row("SELECT (SELECT count(*) FROM versions WHERE rel_path=?)+(SELECT count(*) FROM zotero_files WHERE rel_path=?)",params![rel,rel],|r|r.get(0))?;
            if shared>0{continue;}
            let full=self.root.join(p);
            // Symlink parents must never redirect a managed deletion outside the library.
            if let Ok(canonical)=full.canonicalize(){
                if !canonical.starts_with(self.root.canonicalize()?){retained.push(rel);continue;}
                match fs::remove_file(&full){Ok(())=>removed.push(rel),Err(_)=>retained.push(rel)}
            }
        }
        Ok(json!({"removed_files":removed,"retained_files":retained}))
    }

    // ---- taxonomy -------------------------------------------------------
    pub fn taxonomy(&self) -> Result<Value> {
        let conn = self.conn();
        let cats: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT id,name,color,parent_id FROM categories ORDER BY sort_order,name")?;
            let mapped = stmt.query_map([], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<String>>(2)?,"parent_id":r.get::<_,Option<String>>(3)?})))?;
            let collected: Vec<Value> = mapped.filter_map(Result::ok).collect();
            collected
        };
        let tags: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT id,name,color FROM tags ORDER BY name")?;
            let mapped = stmt.query_map([], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<String>>(2)?})))?;
            let collected: Vec<Value> = mapped.filter_map(Result::ok).collect();
            collected
        };
        Ok(json!({"categories": cats, "tags": tags}))
    }

    pub fn set_categories(&self, paper_id: &str, ids: Vec<String>) -> Result<()> {
        let guard = self.conn();
        let conn = guard.unchecked_transaction()?;
        conn.execute("DELETE FROM paper_categories WHERE paper_id=?", params![paper_id])?;
        for id in ids {
            conn.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)", params![paper_id, id])?;
        }
        conn.commit()?;
        Ok(())
    }

    pub fn set_tags(&self, paper_id: &str, names: Vec<String>) -> Result<()> {
        let guard = self.conn();
        let conn = guard.unchecked_transaction()?;
        conn.execute("DELETE FROM paper_tags WHERE paper_id=?", params![paper_id])?;
        for name in names {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let existing: Option<String> = conn.query_row("SELECT id FROM tags WHERE name=?", params![name], |r| r.get(0)).optional()?;
            let id = match existing {
                Some(id) => id,
                None => {
                    let id = Uuid::new_v4().to_string();
                    conn.execute("INSERT INTO tags(id,name) VALUES(?,?)", params![id, name])?;
                    id
                }
            };
            conn.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) VALUES(?,?)", params![paper_id, id])?;
        }
        conn.commit()?;
        Ok(())
    }

    pub fn add_category(&self, name: &str) -> Result<Value> {
        crate::organization::folder_save(self,&json!({"name":name}))
    }

    // ---- annotations ----------------------------------------------------
    pub fn list_annotations(&self, paper_id: &str) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM annotations WHERE paper_id=? ORDER BY page,created_at")?;
        let rows = stmt.query_map(params![paper_id], |r| {
            let rects = r.get::<_, String>("rects")?;
            Ok(json!({
                "id": r.get::<_, String>("id")?,
                "paper_id": r.get::<_, String>("paper_id")?,
                "version_kind": r.get::<_, String>("version_kind")?,
                "version_id": r.get::<_, Option<String>>("version_id")?,
                "page": r.get::<_, i64>("page")?,
                "rects": serde_json::from_str::<Value>(&rects).unwrap_or(Value::Array(vec![])),
                "quote": r.get::<_, String>("quote")?,
                "color": r.get::<_, String>("color")?,
                "comment": r.get::<_, String>("comment")?,
                "created_at": r.get::<_, i64>("created_at")?,
            }))
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn add_annotation(&self, paper_id: &str, page: i64, rects: Value, quote: &str, color: &str, comment: &str, version_kind: &str, version_id: Option<&str>) -> Result<Value> {
        if page < 0 || !matches!(version_kind, "source" | "translated") {
            return Err(anyhow!("invalid annotation page or version kind"));
        }
        if let Some(version) = version_id {
            let valid: bool = self.conn().query_row(
                "SELECT EXISTS(SELECT 1 FROM versions WHERE id=? AND paper_id=? AND kind=? AND pages>?)",
                params![version, paper_id, version_kind, page], |r| r.get(0))?;
            if !valid { return Err(anyhow!("annotation version does not belong to this paper/page")); }
        }
        let id = Uuid::new_v4().to_string();
        self.conn().execute(
            "INSERT INTO annotations(id,paper_id,version_kind,page,rects,quote,color,comment,created_at,updated_at,version_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![id, paper_id, version_kind, page, rects.to_string(), quote, color, comment, now_ms(), now_ms(), version_id],
        )?;
        Ok(json!({"id": id}))
    }

    pub fn update_annotation(&self, id: &str, fields: &Value) -> Result<()> {
        let mut sets: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        for key in ["comment", "color"] {
            if let Some(v) = fields.get(key) {
                sets.push(format!("{key}=?"));
                args.push(Box::new(v.as_str().unwrap_or_default().to_string()));
            }
        }
        if sets.is_empty() {
            return Ok(());
        }
        sets.push("updated_at=?".into());
        args.push(Box::new(now_ms()));
        args.push(Box::new(id.to_string()));
        let conn = self.conn();
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        conn.execute(&format!("UPDATE annotations SET {} WHERE id=?", sets.join(",")), refs.as_slice())?;
        Ok(())
    }

    pub fn delete_annotation(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM annotations WHERE id=?", params![id])?;
        Ok(())
    }

    // ---- export ---------------------------------------------------------
    pub fn export(&self, ids: Vec<String>, format: &str) -> Result<String> {
        let mut out = Vec::new();
        for id in ids {
            let paper = self.get_paper(&id)?;
            if format == "ris" {
                out.push(ris(&paper));
            } else {
                out.push(bibtex(&paper));
            }
        }
        Ok(out.join("\n\n"))
    }

    // ---- blocks ---------------------------------------------------------
    pub fn set_blocks(&self, paper_id: &str, version_id: &str, page: i64, blocks: Vec<Value>) -> Result<()> {
        anyhow::ensure!(blocks.len()<=10000,"too many text blocks on one page");
        anyhow::ensure!(blocks.iter().map(|b|b["text"].as_str().unwrap_or("").len()).sum::<usize>()<=2_000_000,"page text too large");
        let prepared: Vec<(String,i64,String,String,String)> = blocks.iter().enumerate().filter_map(|(i,block)| {
            let text=block.get("text").and_then(Value::as_str).unwrap_or("").trim();
            if text.is_empty() { return None; }
            let bbox=block.get("bbox").cloned().unwrap_or(json!([]));
            let kind=if block["kind"]=="ocr"{"ocr"}else{"text"};
            let id=format!("{:x}",Sha256::digest(format!("{version_id}:{page}:{i}:{bbox}:{text}:{kind}")));
            Some((id,i as i64,bbox.to_string(),text.to_string(),kind.into()))
        }).collect();
        let conn = self.conn();
        let pages:i64=conn.query_row("SELECT pages FROM versions WHERE id=? AND paper_id=?",params![version_id,paper_id],|r|r.get(0))?;
        anyhow::ensure!(page>=0&&page<pages,"page outside document");
        if prepared.is_empty(){return Ok(());}
        // Revisiting a scanned page must not replace cached OCR with a tiny native header.
        if prepared.iter().all(|row|row.4=="text") {
            let old:i64=conn.query_row("SELECT coalesce(sum(length(text)),0) FROM blocks WHERE paper_id=? AND version_id=? AND page=? AND kind='ocr'",params![paper_id,version_id,page],|r|r.get(0))?;
            if old>prepared.iter().map(|row|row.3.chars().count() as i64).sum::<i64>(){return Ok(());}
        }
        {
            let mut stmt=conn.prepare("SELECT id FROM blocks WHERE paper_id=? AND version_id=? AND page=? ORDER BY block_index")?;
            let old=stmt.query_map(params![paper_id,version_id,page],|r|r.get::<_,String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if old.iter().eq(prepared.iter().map(|row| &row.0)) { return Ok(()); }
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM blocks WHERE paper_id=? AND version_id=? AND page=?", params![paper_id, version_id, page])?;
        for (id,i,bbox,text,kind) in prepared {
            tx.execute(
                "INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,?,?,?,?,?)",
                params![id, paper_id, version_id, page, i, kind, bbox, text],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn blocks(&self, paper_id: &str, version_id: &str, page: i64) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id,page,block_index,kind,bbox,text FROM blocks WHERE paper_id=? AND version_id=? AND page=? ORDER BY block_index")?;
        let rows = stmt.query_map(params![paper_id, version_id, page], |r| {
            let bbox = r.get::<_, String>(4)?;
            Ok(json!({
                "id": r.get::<_, String>(0)?, "page": r.get::<_, i64>(1)?, "block_index": r.get::<_, i64>(2)?,
                "kind": r.get::<_, String>(3)?, "bbox": serde_json::from_str::<Value>(&bbox).unwrap_or(Value::Array(vec![])),
                "text": r.get::<_, String>(5)?,
            }))
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn search_blocks(&self, paper_id: &str, query: &str, limit: i64) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id,page,block_index,kind,bbox,text FROM blocks WHERE paper_id=? AND text LIKE ? LIMIT ?")?;
        let rows = stmt.query_map(params![paper_id, format!("%{query}%"), limit], |r| {
            let bbox = r.get::<_, String>(4)?;
            Ok(json!({
                "id": r.get::<_, String>(0)?, "page": r.get::<_, i64>(1)?, "block_index": r.get::<_, i64>(2)?,
                "kind": r.get::<_, String>(3)?, "bbox": serde_json::from_str::<Value>(&bbox).unwrap_or(Value::Array(vec![])),
                "text": r.get::<_, String>(5)?,
            }))
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    // ---- versions / jobs ------------------------------------------------
    pub fn version_path(&self, version_id: &str) -> Result<PathBuf> {
        let rel: String = self
            .conn()
            .query_row("SELECT rel_path FROM versions WHERE id=?", params![version_id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| anyhow!("version not found"))?;
        let p = PathBuf::from(rel);
        Ok(if p.is_absolute() { p } else { self.root.join(p) })
    }

    pub fn paper_pdf(&self, paper_id: &str, kind: &str, version_id: Option<&str>) -> Result<Value> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT id,rel_path,pages,bytes FROM versions WHERE paper_id=? AND kind=? AND (? IS NULL OR id=?) ORDER BY CASE WHEN kind='source' THEN created_at ELSE -created_at END,id LIMIT 1",
                params![paper_id, kind, version_id, version_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)),
            )
            .optional()?;
        let (id, rel, pages, bytes) = row.ok_or_else(|| anyhow!("no {kind} version"))?;
        let path = if Path::new(&rel).is_absolute() { PathBuf::from(rel) } else { self.root.join(rel) };
        Ok(json!({"version_id": id, "path": path.to_string_lossy(), "pages": pages, "bytes": bytes}))
    }

    pub fn source_version(&self, paper_id: &str) -> Result<(String, PathBuf)> {
        let row: (String, String) = self
            .conn()
            .query_row(
                "SELECT id,rel_path FROM versions WHERE paper_id=? AND kind='source' ORDER BY created_at,id LIMIT 1",
                params![paper_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| anyhow!("paper has no source PDF"))?;
        let p = PathBuf::from(&row.1);
        Ok((row.0, if p.is_absolute() { p } else { self.root.join(p) }))
    }

    pub fn start_translation(self: &Arc<Self>, paper_id: &str, pages: Option<String>) -> Result<Value> {
        if self.gateway.lock().unwrap().is_none() {self.ensure_gateway()?;}
        let (_, src) = self.source_version(paper_id)?;
        let job_id = Uuid::new_v4().to_string();
        {
            let conn=self.conn();
            let available:bool=conn.query_row("SELECT deleted_at IS NULL FROM papers WHERE id=?",[paper_id],|r|r.get(0))?;
            anyhow::ensure!(available,"回收站中的论文不能启动翻译");
            let active:i64=conn.query_row("SELECT count(*) FROM jobs WHERE paper_id=? AND status NOT IN ('completed','failed','cancelled')",[paper_id],|r|r.get(0))?;
            anyhow::ensure!(active==0,"该论文已有任务，请等待完成或先停止");
            conn.execute("INSERT INTO jobs(id,paper_id,status,pages,created_at,updated_at) VALUES(?,?,?,?,?,?)",params![job_id,paper_id,"queued",pages,now_ms(),now_ms()])?;
        }
        self.cancels.lock().unwrap().insert(job_id.clone(),Arc::new(AtomicBool::new(false)));
        if self.translation_tx.try_send((job_id.clone(),paper_id.into(),src,pages)).is_err(){
            self.set_job_status(&job_id,"failed",Some("翻译队列已满，请稍后重试"),None);
            self.clear_cancel(&job_id);
            return Err(anyhow!("翻译队列已满，请稍后重试"));
        }
        Ok(json!({"job_id":job_id}))
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<()> {
        let status={
            let conn=self.conn();
            let status:String=conn.query_row("SELECT status FROM jobs WHERE id=?",[job_id],|r|r.get(0))?;
            if matches!(status.as_str(),"completed"|"failed"|"cancelled"){return Ok(());}
            conn.execute("UPDATE jobs SET status='cancelling',updated_at=? WHERE id=?",params![now_ms(),job_id])?;
            status
        };
        if let Some(flag)=self.cancels.lock().unwrap().get(job_id){flag.store(true,Ordering::SeqCst);}
        self.emit(json!({"event":"job","jobId":job_id,"status":"cancelling"}));
        if status=="queued"{self.set_job_status(job_id,"cancelled",None,None);}
        Ok(())
    }

    pub fn cancel_flag(&self, job_id: &str) -> Arc<AtomicBool> {
        self.cancels
            .lock()
            .unwrap()
            .entry(job_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub fn clear_cancel(&self, job_id: &str) {
        self.cancels.lock().unwrap().remove(job_id);
    }

    pub fn set_job_status(&self, job_id: &str, status: &str, error: Option<&str>, version_id: Option<&str>) {
        let result=self.conn().execute(
            "UPDATE jobs SET status=?,updated_at=?,error=?,output_version_id=COALESCE(?,output_version_id) WHERE id=? AND status NOT IN ('completed','failed','cancelled') AND (status!='cancelling' OR ? IN ('cancelled','failed'))",
            params![status,now_ms(),error,version_id,job_id,status]);
        match result {
            Ok(0)=>{},
            Ok(_)=>self.emit(json!({"event":"job","jobId":job_id,"status":status,"error":error,"outputVersionId":version_id})),
            Err(e)=>self.emit(json!({"event":"job_error","jobId":job_id,"error":format!("任务状态保存失败：{e}")})),
        }
    }

    pub fn shutdown(&self)->Result<Value>{
        let ids:Vec<String>={let conn=self.conn();let mut st=conn.prepare("SELECT id FROM jobs WHERE status NOT IN ('completed','failed','cancelled')")?;let rows=st.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        for id in &ids{self.cancel_job(id)?;}
        Ok(json!({"stopping":ids.len()}))
    }

    pub fn list_jobs(&self) -> Result<Value> {
        let ids:Vec<String>={let conn=self.conn();let mut st=conn.prepare("SELECT id FROM jobs ORDER BY created_at DESC,id DESC LIMIT 100")?;let rows=st.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        Ok(Value::Array(ids.iter().map(|id|self.get_job(id)).collect::<Result<Vec<_>>>()?))
    }

    pub fn get_job(&self, job_id: &str) -> Result<Value> {
        let conn = self.conn();
        let row = conn
            .query_row("SELECT id,paper_id,status,pages,created_at,updated_at,error,output_version_id FROM jobs WHERE id=?", params![job_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "paper_id": r.get::<_, String>(1)?, "status": r.get::<_, String>(2)?,
                    "pages": r.get::<_, Option<String>>(3)?, "created_at": r.get::<_, i64>(4)?, "updated_at": r.get::<_, i64>(5)?,
                    "error": r.get::<_, Option<String>>(6)?, "output_version_id": r.get::<_, Option<String>>(7)?,
                }))
            })
            .optional()?;
        Ok(row.unwrap_or(Value::Null))
    }

    pub fn attach_translation(&self, paper_id: &str, output: &Path, job_id: &str) -> Result<String> {
        let pages=pdfmeta::page_count(output)?;
        anyhow::ensure!(pages>0,"翻译引擎输出不是有效的非空 PDF");
        let version_id=Uuid::new_v4().to_string();
        let dest_rel=format!("derived/{paper_id}-{version_id}.pdf");
        let dest=self.root.join(&dest_rel);
        let sha=sha256_file(output)?;
        let bytes=output.metadata()?.len() as i64;
        let tmp=self.root.join("tmp").join(format!("{version_id}.pdf"));
        fs::copy(output,&tmp)?;
        fs::File::open(&tmp)?.sync_all()?;
        let result=(||->Result<()>{
            let conn=self.conn();
            let tx=conn.unchecked_transaction()?;
            let available:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM papers p JOIN jobs j ON j.paper_id=p.id WHERE p.id=? AND p.deleted_at IS NULL AND j.id=? AND j.status NOT IN ('cancelling','cancelled','failed','completed'))",params![paper_id,job_id],|r|r.get(0))?;
            anyhow::ensure!(available,"cancelled");
            fs::rename(&tmp,&dest)?;
            tx.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![version_id,paper_id,"translated",sha,dest_rel,pages,bytes,"zh-CN","babeldoc",std::env::var("MOONLIGHT_MODEL").unwrap_or_default(),now_ms()])?;
            tx.execute("UPDATE papers SET updated_at=? WHERE id=?",params![now_ms(),paper_id])?;
            tx.execute("UPDATE jobs SET status='completed',updated_at=?,output_version_id=?,error=NULL WHERE id=?",params![now_ms(),version_id,job_id])?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(e)=result{let _=fs::remove_file(&dest);let _=fs::remove_file(&tmp);return Err(e);}
        self.emit(json!({"event":"job","jobId":job_id,"status":"completed","outputVersionId":version_id}));
        Ok(version_id)
    }

    // ---- generic external import (Zotero API path) ----------------------
    pub fn import_external(
        &self,
        pdf: Option<&Path>,
        title: &str,
        authors: &str,
        year: Option<&str>,
        venue: &str,
        doi: &str,
        arxiv: &str,
        abstract_text: Option<&str>,
        notes: &str,
    ) -> Result<Value> {
        if !doi.is_empty() {
            if let Some(id) = self
                .conn()
                .query_row("SELECT id FROM papers WHERE doi=? AND deleted_at IS NULL", params![doi], |r| r.get::<_, String>(0))
                .optional()?
            {
                return Ok(json!({"status": "duplicate_doi", "paper_id": id}));
            }
        }
        let paper_id = Uuid::new_v4().to_string();
        {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,notes,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    paper_id,
                    if title.is_empty() { "Untitled" } else { title },
                    authors,
                    year,
                    venue,
                    if doi.is_empty() { None } else { Some(doi) },
                    if arxiv.is_empty() { None } else { Some(arxiv) },
                    abstract_text,
                    notes,
                    now_ms(),
                    now_ms()
                ],
            )?;
        }
        let mut status = "imported_without_pdf";
        if let Some(path) = pdf {
            if path.exists() {
                let sha = sha256_file(path)?;
                let rel = format!("files/{sha}.pdf");
                let dest = self.root.join(&rel);
                let tmp = self.root.join("tmp").join(format!("api-{paper_id}.pdf"));
                fs::copy(path, &tmp)?;
                fs::rename(&tmp, &dest)?;
                let pages = pdfmeta::page_count(&dest).unwrap_or(0);
                let bytes = dest.metadata()?.len() as i64;
                let vid = Uuid::new_v4().to_string();
                self.conn().execute(
                    "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    params![vid, paper_id, "source", sha, rel, pages, bytes, "en", "zotero-api", Option::<String>::None, now_ms()],
                )?;
                status = "imported";
            }
        }
        Ok(json!({"status": status, "paper_id": paper_id}))
    }

    // ---- gateway --------------------------------------------------------
    pub fn ensure_gateway(&self) -> Result<()> {
        let key = std::env::var("MOONLIGHT_UPSTREAM_KEY").unwrap_or_default();
        if key.is_empty() {
            return Err(anyhow!("model credential is not configured"));
        }
        let upstream = std::env::var("MOONLIGHT_UPSTREAM").unwrap_or_else(|_| "https://opencode.ai/zen/go/v1".into());
        let model = std::env::var("MOONLIGHT_MODEL").unwrap_or_else(|_| "qwen3.8-flash".into());
        let gateway = engine::start_gateway(upstream, model, key, self.root.join("model-usage.jsonl"))?;
        *self.gateway.lock().unwrap() = Some(gateway);
        Ok(())
    }

    pub fn gateway(&self) -> Option<Gateway> {
        self.gateway.lock().unwrap().clone()
    }
}

fn bibtex(p: &Value) -> String {
    let title = p["title"].as_str().unwrap_or("Untitled");
    let authors = p["authors"].as_str().unwrap_or("");
    let first = authors.split([',', ';']).next().unwrap_or("anon").trim();
    let key: String = first.chars().filter(|c| c.is_alphanumeric()).take(20).collect::<String>() + p["year"].as_str().unwrap_or("");
    let mut fields = vec![format!("  title = {{{title}}}")];
    let joined = authors.split([',', ';']).map(|a| a.trim()).filter(|a| !a.is_empty()).collect::<Vec<_>>().join(" and ");
    if !joined.is_empty() {
        fields.push(format!("  author = {{{joined}}}"));
    }
    for (k, name) in [("year", "year"), ("venue", "journal"), ("doi", "doi"), ("arxiv", "eprint")] {
        if let Some(v) = p[k].as_str() {
            if !v.is_empty() {
                fields.push(format!("  {name} = {{{v}}}"));
            }
        }
    }
    format!("@article{{{key},\n{}\n}}", fields.join(",\n"))
}

fn ris(p: &Value) -> String {
    let mut lines = vec!["TY  - JOUR".to_string(), format!("TI  - {}", p["title"].as_str().unwrap_or(""))];
    for a in p["authors"].as_str().unwrap_or("").split([';', ',']) {
        if !a.trim().is_empty() {
            lines.push(format!("AU  - {}", a.trim()));
        }
    }
    for (tag, key) in [("PY", "year"), ("JO", "venue"), ("DO", "doi")] {
        if let Some(v) = p[key].as_str() {
            if !v.is_empty() {
                lines.push(format!("{tag}  - {v}"));
            }
        }
    }
    lines.push("ER  - ".into());
    lines.join("\n")
}
